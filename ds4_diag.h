#ifndef DS4_DIAG_H
#define DS4_DIAG_H

#include <stdbool.h>
#include <stdint.h>

/* Diagnostic black box for TP sync/gate. Enabled only when DS4_DIAG=1.
 * The hot path writes fixed-size events to a pre-faulted mmap ring; dumps
 * happen only on an error/exit. No prompt text is ever recorded. */

enum {
    DS4_DIAG_SYNC_BEGIN = 1,
    DS4_DIAG_SYNC_END,
    DS4_DIAG_SYNC_FAIL,
    DS4_DIAG_GATE_BEGIN,
    DS4_DIAG_GATE_END,
    DS4_DIAG_GATE_FAIL,
    DS4_DIAG_TCP_TIMEOUT,
    DS4_DIAG_LAYER_FAIL,
    DS4_DIAG_WORKER_FAIL,
    DS4_DIAG_OVER_CONTEXT,
    DS4_DIAG_EXIT
};

void ds4_diag_init(int rank);
bool ds4_diag_enabled(void);
uint64_t ds4_diag_now_ns(void);
uint64_t ds4_diag_new_req(void);

/* Set the request context read by the gate service thread. */
void ds4_diag_request(uint64_t req_id, uint64_t session_id,
                      uint32_t prompt_len, uint32_t checkpoint_len,
                      uint32_t suffix, uint32_t images);

/* One summary line per request boundary. result: 0 ok, non-zero error. */
void ds4_diag_summary(const char *phase, int result, int err);

/* Fixed-size event; safe to call from the gate service thread. */
void ds4_diag_event(uint16_t phase, uint8_t ok, int16_t err,
                    uint64_t seq, uint32_t layer, uint32_t gate,
                    uint32_t pos, uint32_t bytes, uint32_t wait_us);

/* Dump the tail of the ring to a text file and mark the process fatal. */
void ds4_diag_dump(const char *reason);
void ds4_diag_mark_fatal(const char *reason);
void ds4_diag_exit(int rc);

#endif
