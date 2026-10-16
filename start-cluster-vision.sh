#!/bin/bash
# ============================================================================
# start-cluster-vision.sh — Vision-Exp 双机集群一键启动（与生产脚本同款流程）
#
# 用法: ./start-cluster-vision.sh [server|cli]
#   server - 启动 ds4-server (API 模式，默认)
#   cli    - 启动 ds4 CLI (交互模式)
#   stop   - 停止两机进程（Ctrl+C 同样触发）
#   status - 查看两机进程与 API 状态
#
# 与现有集群完全隔离:
#   - coordinator 监听 192.0.2.1:9913
#   - API 端口 8002（生产 8000 / dspark-fork 8001）
#   - 磁盘 KV 缓存 /tmp/ds4-kv-vision（与其他后端严禁混用）
#   - 层分配: Coordinator 0:23 / Worker 24:output（红线: 任何单机不载入完整 145GB）
#   - 两机均加载 --vision sidecar；不启用 DSpark（双机实测净负）
#   - 任意 ds4 集群与任一其他 ds4 集群不能共驻（内存超出），本脚本与生产脚本
#     一样: 启动前自动停止两机的所有 ds4 进程。
#
# 环境变量可覆盖: DS4_VISION_LISTEN_PORT / DS4_VISION_API_PORT /
#                 DS4_VISION_CTX / DS4_VISION_KV_SPACE_MB
# ============================================================================
set -e

MODE="${1:-server}"
REMOTE_HOST="${DS4_VISION_WORKER_HOST:-192.0.2.2}"
REMOTE_USER="${DS4_VISION_REMOTE_USER:-$USER}"
REMOTE_DIR="/Users/${REMOTE_USER}/Desktop/ds4-vision"
LOCAL_DIR="${DS4_VISION_LOCAL_DIR:-${HOME}/Desktop/ds4-vision}"
COORD_IP="${DS4_VISION_COORD_IP:-192.0.2.1}"
COORD_PORT="${DS4_VISION_LISTEN_PORT:-9913}"
API_HOST="0.0.0.0"
API_PORT="${DS4_VISION_API_PORT:-8002}"
CTX="${DS4_VISION_CTX:-500000}"
KV_DIR="/tmp/ds4-kv-vision"
KV_SPACE_MB="${DS4_VISION_KV_SPACE_MB:-204800}"
KV_COLD_MAX=10000
KV_MIN_TOKENS=4
KV_CONTINUED_INTERVAL=10240
GGUF="ds4flash.gguf"
VISION_ENC="gguf/DeepSeek-V4-Flash-Vision-Encoder.gguf"
# 空闲内存释放（实测）：上游 9ab7053 起用 MTLResidencySet 请求全部模型视图驻留，
# 推理后 wired 恒压 88-90GB 不回落；关闭后模型页回归 file-backed 惰性页，
# 推理后秒级回落至 ~5GB；实测对冷 prefill（300-342 vs 346 t/s）与含图命中（98.3% vs 98.6%）无影响。
#
# 注意：ds4_metal.m 的判定是 getenv("DS4_METAL_NO_RESIDENCY") != NULL——
# 若 residency=1 时传"空字符串"（非 NULL）驻留实际从未开启；residency=1 必须用 `env -u`
# 真正取消变量。默认开启驻留：惰性页模式在大上下文会话下是稳定性负债，
# 且 ON 的命中/吞吐实测均 ≥ OFF（98.6% vs 98.3%、346 vs 300 t/s）。
# 需要临时关闭驻留时：export DS4_VISION_METAL_RESIDENCY=0 后再启动。
DS4_VISION_METAL_RESIDENCY="${DS4_VISION_METAL_RESIDENCY:-1}"
if [ "${DS4_VISION_METAL_RESIDENCY}" = "1" ]; then
    RESIDENCY_ENV=(env -u DS4_METAL_NO_RESIDENCY)
    RESIDENCY_ENV_REMOTE="env -u DS4_METAL_NO_RESIDENCY"
else
    RESIDENCY_ENV=(env DS4_METAL_NO_RESIDENCY=1)
    RESIDENCY_ENV_REMOTE="env DS4_METAL_NO_RESIDENCY=1"
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $1"; }
warn() { echo -e "${YELLOW}[$(date +%H:%M:%S)]${NC} $1"; }
err()  { echo -e "${RED}[$(date +%H:%M:%S)]${NC} $1"; }

# ---- 停止（与生产脚本一致: 只停 ds4 进程，不删模型与缓存）-------------------
cleanup() {
    warn "收到中断信号，正在停止..."
    ssh "${REMOTE_USER}@${REMOTE_HOST}" \
        "pkill -f './ds4' 2>/dev/null; pkill -f './ds4-server' 2>/dev/null" 2>/dev/null || true
    pkill -f './ds4' 2>/dev/null || true
    pkill -f './ds4-server' 2>/dev/null || true
    log "已停止所有进程"
    exit 0
}
trap cleanup INT TERM

stop_all() {
    warn "正在停止旧集群进程..."
    ssh "${REMOTE_USER}@${REMOTE_HOST}" \
        "pkill -f './ds4' 2>/dev/null; pkill -f './ds4-server' 2>/dev/null" 2>/dev/null || true
    pkill -f './ds4' 2>/dev/null || true
    pkill -f './ds4-server' 2>/dev/null || true
    # pkill 对长 argv 偶发失配 → 按端口兜底（9913 本机/对端）
    for pid in $(lsof -tiTCP:${COORD_PORT} -sTCP:LISTEN 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
    ssh "${REMOTE_USER}@${REMOTE_HOST}" \
        'for pid in $(lsof -tiTCP:9913 2>/dev/null); do kill "$pid" 2>/dev/null || true; done' || true
    sleep 2
}

# ---- status ----------------------------------------------------------------
show_status() {
    log "=== 本机 (M5 Max, ${COORD_IP}) ==="
    pgrep -f "listen ${COORD_IP} ${COORD_PORT}" >/dev/null 2>&1 \
        && { echo -e "${GREEN}coordinator ds4-server: 运行中 ✓${NC}"; } \
        || err "coordinator ds4-server: 未运行"
    curl -s --max-time 3 "http://127.0.0.1:${API_PORT}/v1/models" >/dev/null 2>&1 \
        && log "API http://127.0.0.1:${API_PORT} 就绪 ✓" \
        || warn "API http://127.0.0.1:${API_PORT} 不可达"
    log "=== 对端 (M3 Ultra, ${REMOTE_HOST}) ==="
    ssh -o ConnectTimeout=8 "${REMOTE_USER}@${REMOTE_HOST}" \
        'pgrep -f "coordinator 192.0.2.1 9913" >/dev/null 2>&1 \
            && echo "worker ds4: 运行中 ✓" || echo "worker ds4: 未运行"' \
        || err "对端 ssh 不可达"
}

# ---- 主流程 -----------------------------------------------------------------
if [ "${MODE}" = "stop" ]; then stop_all; exit 0; fi
if [ "${MODE}" = "status" ]; then show_status; exit 0; fi
if [ "${MODE}" != "server" ] && [ "${MODE}" != "cli" ]; then
    err "用法: $0 [server|cli|stop|status]"; exit 1
fi

# ====== Step 1: 环境检查 ======
log "=== Step 1: 环境检查 ==="
WIRED=$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo 0)
if [ "${WIRED}" -lt 100000 ]; then
    warn "本机 GPU 线缆内存 = ${WIRED}MB (< 100GB), 正在设置..."
    sudo sysctl iogpu.wired_limit_mb=120000
    log "本机 GPU 线缆内存已设为 120000 MB"
else
    log "本机 GPU 线缆内存 = ${WIRED}MB ✓"
fi
if ! ping -c 1 -W 2000 "${REMOTE_HOST}" > /dev/null 2>&1; then
    err "对端 ${REMOTE_HOST} 不可达"; exit 1
fi
log "对端 ${REMOTE_HOST} 可达 (bridge0) ✓"
if ! ssh "${REMOTE_USER}@${REMOTE_HOST}" true 2>/dev/null; then
    err "对端 SSH 不可达"; exit 1
fi
log "SSH ${REMOTE_USER}@${REMOTE_HOST} 可达 ✓"
RWIRED=$(ssh "${REMOTE_USER}@${REMOTE_HOST}" 'sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo 0')
if [ "${RWIRED}" -lt 80000 ]; then
    warn "对端 GPU 线缆内存 = ${RWIRED}MB (< 80GB), 正在设置..."
    ssh -t "${REMOTE_USER}@${REMOTE_HOST}" 'sudo sysctl iogpu.wired_limit_mb=90112' || \
        { err "对端 wired 设置失败"; exit 1; }
    log "对端 GPU 线缆内存已设为 90112 MB"
else
    log "对端 GPU 线缆内存 = ${RWIRED}MB ✓"
fi
[ -f "${LOCAL_DIR}/${GGUF}" ] || { err "本机 GGUF 缺失: ${LOCAL_DIR}/${GGUF}"; exit 1; }
[ -f "${LOCAL_DIR}/${VISION_ENC}" ] || { err "本机 encoder 缺失: ${LOCAL_DIR}/${VISION_ENC}"; exit 1; }
log "本机 GGUF 就绪 ✓"
ssh "${REMOTE_USER}@${REMOTE_HOST}" \
    "[ -f '${REMOTE_DIR}/${GGUF}' ] && [ -f '${REMOTE_DIR}/${VISION_ENC}' ]" || \
    { err "对端 GGUF/encoder 缺失"; exit 1; }
log "对端 GGUF 就绪 ✓"

# ====== Step 2: 停止旧进程 ======
log "=== Step 2: 停止旧进程 ==="
stop_all
LOCAL_RES=$(pgrep -f './ds4' | wc -l | tr -d ' ')
REMOTE_RES=$(ssh "${REMOTE_USER}@${REMOTE_HOST}" 'pgrep -f "./ds4" | wc -l | tr -d " "')
log "旧进程已清理 (本机残留: ${LOCAL_RES}, 对端残留: ${REMOTE_RES})"

# ====== Step 3: 启动 Worker (对端 M3 Ultra) ======
log "=== Step 3: 启动 Worker (对端 M3 Ultra) ==="
ssh "${REMOTE_USER}@${REMOTE_HOST}" "cd ${REMOTE_DIR} && \
    nohup ${RESIDENCY_ENV_REMOTE} \
      ./ds4 \
      -m ${GGUF} \
      --vision ${VISION_ENC} \
      --role worker \
      --layers 24:output \
      --ctx ${CTX} \
      --coordinator ${COORD_IP} ${COORD_PORT} \
      > ~/ds4-vision-worker.log 2>&1 &"
sleep 8
ssh "${REMOTE_USER}@${REMOTE_HOST}" \
    'grep -m1 "memory:" ~/ds4-vision-worker.log 2>/dev/null || tail -3 ~/ds4-vision-worker.log' || true

# ====== Step 4: 启动 Coordinator (本机 M5 Max) ======
log "=== Step 4: 启动 Coordinator (本机 M5 Max) ==="
cd "${LOCAL_DIR}"
if [ "${MODE}" = "cli" ]; then
    "${RESIDENCY_ENV[@]}" \
      ./ds4 -m ${GGUF} --vision ${VISION_ENC} \
      --role coordinator --layers 0:23 \
      --listen ${COORD_IP} ${COORD_PORT} --ctx ${CTX}
else
    log "启动 Server 模式"
    LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")"
    nohup "${RESIDENCY_ENV[@]}" \
      ./ds4-server -m ${GGUF} --vision ${VISION_ENC} \
      --role coordinator --layers 0:23 \
      --listen ${COORD_IP} ${COORD_PORT} \
      --host ${API_HOST} --port ${API_PORT} --ctx ${CTX} \
      --kv-disk-dir ${KV_DIR} --kv-disk-space-mb ${KV_SPACE_MB} \
      --kv-cache-cold-max-tokens ${KV_COLD_MAX} \
      --kv-cache-min-tokens ${KV_MIN_TOKENS} \
      --kv-cache-continued-interval-tokens ${KV_CONTINUED_INTERVAL} \
      --cors --debug \
      > /tmp/ds4-vision-server.log 2>&1 &
    SERVER_PID=$!
    log "  本地访问: http://127.0.0.1:${API_PORT}"
    [ -n "${LAN_IP}" ] && log "  LAN 访问: http://${LAN_IP}:${API_PORT}"
    log "  API 端点: http://127.0.0.1:${API_PORT}/v1/chat/completions"
    log "Coordinator 已后台启动 (PID=${SERVER_PID})"
fi

# ====== Step 5: 等待 Worker 连接 ======
log "=== Step 5: 等待 Worker 连接 ==="
for i in $(seq 1 120); do
    if grep -qa "registered worker ${REMOTE_HOST}:" /tmp/ds4-vision-server.log \
       && curl -s --max-time 2 "http://127.0.0.1:${API_PORT}/v1/models" >/dev/null 2>&1; then
        RES_GIB="$(grep -ao 'resident model [0-9.]* GiB' /tmp/ds4-vision-server.log | tail -1 | awk '{print $3}')"
        if [ -n "${RES_GIB}" ] && ! awk -v v="${RES_GIB}" 'BEGIN{exit !(v < 100)}'; then
            err "本机 resident model=${RES_GIB}GiB ≥ 100GiB（疑似载入完整权重），停止集群"
            stop_all; exit 1
        fi
        log "Worker 已连接到 Coordinator ✓ (等待了 $((i*2)) 秒)"
        log "=== 集群就绪 ==="
        log "  Worker:      M3 Ultra (${REMOTE_HOST})"
        log "  Coordinator: M5 Max (${COORD_IP}:${COORD_PORT})"
        log "  API:         http://127.0.0.1:${API_PORT}"
        log "  KV 缓存:     ${KV_DIR}（配额 ${KV_SPACE_MB}MB）"
        log "  日志:        /tmp/ds4-vision-server.log（本机）、~/ds4-vision-worker.log（对端）"
        log "按 Ctrl+C 停止集群（仅停止本机与对端的 ds4 进程，不删除模型与缓存）"
        wait "${SERVER_PID}" || true
        exit 0
    fi
    sleep 2
done
err "Worker 未在 240 秒内连接（见 /tmp/ds4-vision-server.log）"
stop_all
exit 1
