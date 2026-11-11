#define _POSIX_C_SOURCE 200809L
#include "ds4_diag.h"

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define DS4_DIAG_RING_EVENTS (512u * 1024u)
#define DS4_DIAG_DUMP_EVENTS (16u * 1024u)

struct ds4_diag_ev {
    uint64_t t_ns;
    uint64_t req_id;
    uint64_t session_id;
    uint64_t seq;
    uint32_t prompt_len;
    uint32_t checkpoint_len;
    uint32_t suffix;
    uint32_t layer;
    uint32_t gate;
    uint32_t pos;
    uint32_t bytes;
    uint32_t wait_us;
    uint16_t phase;
    uint8_t rank;
    uint8_t ok;
    int16_t err;
    uint8_t pad[6];
};

static struct ds4_diag_ev *g_ring;
static size_t g_ring_bytes;
static volatile uint64_t g_head;
static int g_rank = -1;
static int g_enabled;
static int g_fatal;
static int g_dumped;
static FILE *g_summary;
static pthread_mutex_t g_summary_mu = PTHREAD_MUTEX_INITIALIZER;

static volatile uint64_t g_req_id;
static volatile uint64_t g_session_id;
static volatile uint32_t g_prompt_len;
static volatile uint32_t g_checkpoint_len;
static volatile uint32_t g_suffix;
static volatile uint32_t g_images;

static const char *rank_name(int rank) {
    return rank == 0 ? "coordinator" : "worker";
}

static void diag_close_summary(void) {
    if (g_summary) {
        fclose(g_summary);
        g_summary = NULL;
    }
}

void ds4_diag_dump(const char *reason) {
    if (!g_enabled || g_dumped || !g_ring) return;
    char path[512];
    const time_t now = time(NULL);
    snprintf(path, sizeof(path), "%s/diag-dump-%s-%ld.txt",
             getenv("DS4_DIAG_DIR") ? getenv("DS4_DIAG_DIR") : "/tmp/ds4-diag",
             rank_name(g_rank), (long)getpid());
    FILE *f = fopen(path, "a");
    if (!f) return;
    const uint64_t head = __atomic_load_n(&g_head, __ATOMIC_RELAXED);
    const uint64_t start = head > DS4_DIAG_DUMP_EVENTS ? head - DS4_DIAG_DUMP_EVENTS : 0;
    fprintf(f, "# ds4 diag dump rank=%s pid=%ld reason=%s time=%ld head=%llu start=%llu\n",
            rank_name(g_rank), (long)getpid(), reason ? reason : "?", (long)now,
            (unsigned long long)head, (unsigned long long)start);
    fprintf(f, "# req=%llu session=%llu prompt=%u checkpoint=%u suffix=%u images=%u\n",
            (unsigned long long)__atomic_load_n(&g_req_id, __ATOMIC_RELAXED),
            (unsigned long long)__atomic_load_n(&g_session_id, __ATOMIC_RELAXED),
            __atomic_load_n(&g_prompt_len, __ATOMIC_RELAXED),
            __atomic_load_n(&g_checkpoint_len, __ATOMIC_RELAXED),
            __atomic_load_n(&g_suffix, __ATOMIC_RELAXED),
            __atomic_load_n(&g_images, __ATOMIC_RELAXED));
    fprintf(f, "# t_ns\treq\tsession\tseq\tphase\tok\terr\tlayer\tgate\tpos\tbytes\twait_us\tprompt\tcheckpoint\tsuffix\n");
    for (uint64_t i = start; i < head; i++) {
        const struct ds4_diag_ev *e = &g_ring[i & (DS4_DIAG_RING_EVENTS - 1u)];
        fprintf(f, "%llu\t%llu\t%llu\t%llu\t%u\t%u\t%d\t%u\t%u\t%u\t%u\t%u\t%u\t%u\t%u\n",
                (unsigned long long)e->t_ns, (unsigned long long)e->req_id,
                (unsigned long long)e->session_id, (unsigned long long)e->seq,
                (unsigned)e->phase, (unsigned)e->ok, (int)e->err,
                e->layer, e->gate, e->pos, e->bytes, e->wait_us,
                e->prompt_len, e->checkpoint_len, e->suffix);
    }
    fclose(f);
    g_dumped = 1;
}

static void ds4_diag_atexit(void) {
    if (g_fatal && !g_dumped) ds4_diag_dump("atexit");
    diag_close_summary();
    if (g_ring) msync(g_ring, g_ring_bytes, MS_ASYNC);
}

void ds4_diag_init(int rank) {
    if (g_rank >= 0) return;
    g_rank = rank;
    const char *en = getenv("DS4_DIAG");
    if (!en || !en[0] || !strcmp(en, "0")) return;
    const char *dir = getenv("DS4_DIAG_DIR");
    if (!dir || !dir[0]) dir = "/tmp/ds4-diag";
    if (mkdir(dir, 0700) != 0 && errno != EEXIST) return;
    g_ring_bytes = (size_t)DS4_DIAG_RING_EVENTS * sizeof(struct ds4_diag_ev);
    char ring_path[512], sum_path[512];
    snprintf(ring_path, sizeof(ring_path), "%s/diag-%s-%ld.ring", dir,
             rank_name(rank), (long)getpid());
    snprintf(sum_path, sizeof(sum_path), "%s/diag-%s-%ld.summary.log", dir,
             rank_name(rank), (long)getpid());
    int fd = open(ring_path, O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return;
    if (ftruncate(fd, (off_t)g_ring_bytes) != 0) { close(fd); return; }
    g_ring = mmap(NULL, g_ring_bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (g_ring == MAP_FAILED) { g_ring = NULL; return; }
    /* Pre-fault the ring so the first gate does not pay page-fault latency. */
    memset(g_ring, 0, g_ring_bytes);
    g_summary = fopen(sum_path, "a");
    if (g_summary) setvbuf(g_summary, NULL, _IOLBF, 0);
    __atomic_store_n(&g_head, 0, __ATOMIC_RELAXED);
    g_enabled = 1;
    atexit(ds4_diag_atexit);
    fprintf(stderr, "ds4-diag: enabled rank=%s ring=%s (%zu MiB)\n",
            rank_name(rank), ring_path, g_ring_bytes / (1024u * 1024u));
}

bool ds4_diag_enabled(void) { return g_enabled != 0; }

uint64_t ds4_diag_now_ns(void) {
    struct timespec ts;
#ifdef CLOCK_MONOTONIC_RAW
    if (clock_gettime(CLOCK_MONOTONIC_RAW, &ts) != 0)
        clock_gettime(CLOCK_MONOTONIC, &ts);
#else
    clock_gettime(CLOCK_MONOTONIC, &ts);
#endif
    return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

uint64_t ds4_diag_new_req(void) {
    static volatile uint64_t next = 1;
    return __atomic_fetch_add(&next, 1, __ATOMIC_RELAXED);
}

void ds4_diag_request(uint64_t req_id, uint64_t session_id,
                      uint32_t prompt_len, uint32_t checkpoint_len,
                      uint32_t suffix, uint32_t images) {
    if (!g_enabled) return;
    __atomic_store_n(&g_req_id, req_id, __ATOMIC_RELAXED);
    __atomic_store_n(&g_session_id, session_id, __ATOMIC_RELAXED);
    __atomic_store_n(&g_prompt_len, prompt_len, __ATOMIC_RELAXED);
    __atomic_store_n(&g_checkpoint_len, checkpoint_len, __ATOMIC_RELAXED);
    __atomic_store_n(&g_suffix, suffix, __ATOMIC_RELAXED);
    __atomic_store_n(&g_images, images, __ATOMIC_RELAXED);
}

void ds4_diag_summary(const char *phase, int result, int err) {
    if (!g_enabled || !g_summary) return;
    const uint64_t req = __atomic_load_n(&g_req_id, __ATOMIC_RELAXED);
    const uint64_t session = __atomic_load_n(&g_session_id, __ATOMIC_RELAXED);
    const uint32_t prompt = __atomic_load_n(&g_prompt_len, __ATOMIC_RELAXED);
    const uint32_t checkpoint = __atomic_load_n(&g_checkpoint_len, __ATOMIC_RELAXED);
    const uint32_t suffix = __atomic_load_n(&g_suffix, __ATOMIC_RELAXED);
    const uint32_t images = __atomic_load_n(&g_images, __ATOMIC_RELAXED);
    pthread_mutex_lock(&g_summary_mu);
    fprintf(g_summary, "%llu rank=%s req=%llu session=%llu phase=%s result=%d err=%d prompt=%u checkpoint=%u suffix=%u images=%u\n",
            (unsigned long long)ds4_diag_now_ns(), rank_name(g_rank),
            (unsigned long long)req, (unsigned long long)session,
            phase ? phase : "?", result, err, prompt, checkpoint, suffix, images);
    fflush(g_summary);
    pthread_mutex_unlock(&g_summary_mu);
}

void ds4_diag_event(uint16_t phase, uint8_t ok, int16_t err,
                    uint64_t seq, uint32_t layer, uint32_t gate,
                    uint32_t pos, uint32_t bytes, uint32_t wait_us) {
    if (!g_enabled || !g_ring) return;
    const uint64_t i = __atomic_fetch_add(&g_head, 1, __ATOMIC_RELAXED);
    struct ds4_diag_ev *e = &g_ring[i & (DS4_DIAG_RING_EVENTS - 1u)];
    e->t_ns = ds4_diag_now_ns();
    e->req_id = __atomic_load_n(&g_req_id, __ATOMIC_RELAXED);
    e->session_id = __atomic_load_n(&g_session_id, __ATOMIC_RELAXED);
    e->seq = seq;
    e->prompt_len = __atomic_load_n(&g_prompt_len, __ATOMIC_RELAXED);
    e->checkpoint_len = __atomic_load_n(&g_checkpoint_len, __ATOMIC_RELAXED);
    e->suffix = __atomic_load_n(&g_suffix, __ATOMIC_RELAXED);
    e->layer = layer;
    e->gate = gate;
    e->pos = pos;
    e->bytes = bytes;
    e->wait_us = wait_us;
    e->phase = phase;
    e->rank = (uint8_t)(g_rank < 0 ? 255 : g_rank);
    e->ok = ok;
    e->err = err;
}

void ds4_diag_mark_fatal(const char *reason) {
    if (!g_enabled) return;
    g_fatal = 1;
    ds4_diag_dump(reason);
}

void ds4_diag_exit(int rc) {
    if (!g_enabled) return;
    ds4_diag_summary(rc ? "worker_exit_error" : "worker_exit_ok", rc, 0);
    if (rc && !g_dumped) ds4_diag_dump("worker exit");
}
