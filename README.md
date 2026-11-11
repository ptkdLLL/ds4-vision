# ds4-vision

**DeepSeek V4.1 Flash · dual-machine tensor-parallel vision · append-only image history · server-side image-embedding cache**

> **English summary.** This fork replaces the previous *image-window / drop-after-reading*
> design with an **append-only image history** plus a **server-side image-embedding cache**
> (RAM + SSD). Images stay available to the model instead of being replaced by markers, so
> implicit references such as “this screenshot” no longer force the model to guess. The
> prompt/KV prefix cache is preserved across turns; each image is encoded once and reused
> from the embedding cache afterwards. The repository is a fork of
> [DwarfStar 4 (`ds4.c`)](https://github.com/antirez/ds4), MIT licensed.
>
> **中文摘要。** 本仓库是 `ds4.c` 的 fork。旧版 `image-window` 在图片看过一轮后把它替换成
> 36 字节 marker，后续轮次模型看不到像素，遇到“这张图/刚才的截图”这类隐式指代只能幻觉
> 作答。本版改为 **图片历史只增不减（append-only）**，并在服务端增加 **图像 embedding 缓存**
> （RAM + SSD）：图片只编码一次，后续轮次直接命中缓存；prompt/KV 前缀缓存继续工作。旧的
> `image-window` 已移除。

---

## 1. 为什么重做

### 1.1 旧设计：读完即弃

旧 fork 的 `pi-extensions/image-window` 会在图片“看过一轮”后，把历史里的 image part 替换成
一个固定 36 字节的 marker，目的是让后续请求的序列化字节保持稳定、继续命中 KV 前缀缓存。
这个设计在“每轮只讨论刚看过的图”时工作得很好，但有一个致命缺陷：

- 后续轮次里，模型只看到 marker，看不到图片像素；
- 用户说“这张图”“刚才那个截图”“左边那个门”时，模型没有视觉证据；
- 模型只能根据文字上下文猜，**隐式提及图片时会幻觉回答**；
- 一旦猜错，后续推理会建立在错误前提上，且很难从日志里发现。

问题的本质不是缓存，而是**把图片从模型的可见上下文里删掉了**。

### 1.2 新设计：图片只增不减 + 服务端图像缓存

本版不再删除或替换历史图片：

1. **append-only 图片历史**：图片一旦进入会话，就一直留在 prompt 里；
2. **服务端图像 embedding 缓存**：每张图只在第一次出现时跑 vision encoder，之后从
   RAM/SSD 缓存加载 embedding，避免“每轮开头重算所有历史图”；
3. **prompt/KV 前缀缓存**：图片 marker 与 fingerprint 稳定，历史前缀可复用，只 prefill
   新文本/新图片；
4. **数量与字节上限**：`SERVER_MAX_IMAGES=256`，HTTP body 上限在本 fork 为 128 MiB；
   大图仍建议客户端降采样或提高上限。

这样模型始终能看到全部图片，同时不必为历史图片反复付编码成本。

---

## 2. 架构

```text
Pi / OpenAI-compatible client
        │  full history every turn (images stay in history)
        ▼
Coordinator  (Apple Silicon, HTTP 8005, TP 9916)
  ├─ image embedding cache
  │    ├─ RAM: 64 entries / 512 MiB, LRU
  │    └─ SSD: <cache-dir>/v<version>/xx/<fingerprint>.emb, 2 GiB default
  ├─ prompt / KV prefix cache (500K context)
  └─ vision encoder sidecar
        │  tensor-parallel, TCP, 50/50 expert ownership
        ▼
Worker  (Apple Silicon, TP client)
```

- 双机 **tensor parallel**（不是旧的 layer-sliced pipeline），`--transport tcp`；
- `--ctx 500000`，`DS4_METAL_V41_PREFILL_CHUNK=256`；
- coordinator 承担 HTTP、vision encoder、图像缓存与 prompt cache；
- worker 只做 TP 计算，不参与 HTTP/图片缓存。

---

## 3. 关键机制

### 3.1 图片身份稳定

图片在渲染文本里是确定性的 marker，身份由图片字节的 fingerprint 决定。相同图片在不同轮次
产生相同 marker；图片位置/顺序不变时，历史前缀可复用。

**不要在两轮之间改写旧图片**：降采样、转码、重新压缩都会改变图片字节，从而改变缓存身份。
如果必须换图，把它当成一次新的图片进入历史，接受一次冷启动。

### 3.2 图像 embedding 缓存

`server_encode_image()` 的顺序：

1. RAM cache（按图片字节精确匹配，LRU）；
2. SSD `.emb` cache（按 32 字节 fingerprint，带 header/checksum）；
3. 都没有才跑 vision encoder，并把结果写回 RAM/SSD。

缓存的是 **编码后的 embedding**，不是原始图片。HTTP body 仍然包含图片 base64；因此
“图片字节数”和“embedding 缓存”是两个独立的约束。

### 3.3 prompt/KV 前缀缓存

Pi 等 agent 每轮重发完整历史。服务端比较 live KV 与请求前缀：

- 图片 fingerprint 序列一致时，`multimodal live kv hit`；
- 只 prefill 新增的文本/图片 token；
- 前缀不一致时回退到全量/部分 prefill，不会错误复用。

### 3.4 图片数量与 body 上限

- `SERVER_MAX_IMAGES=256`（单请求历史图片总数）；
- `max_body=128 MiB`（本 fork；原版为 64 MiB）；
- 128 MiB 只解决 HTTP 准入，不等于“无限图片”：100 张 1.9–3.3 MB 截图仍可能超过；
  100 张 960×640 小图（约 39 MB）则很宽裕。

---

## 4. 实测数据

### 4.1 120 张 960×640 小图

| 指标 | 结果 |
|---|---:|
| 图片数 / body | 120 张 / 46.5 MB |
| 首次编码 | 120 次（每张一次） |
| 后续轮次 | 648 次 RAM 命中、1512 次 SSD 命中、0 次重复编码 |
| prompt cache | 35 次 `multimodal live kv hit`、1 次冷启动 miss，整体 98.91% |
| 文本轮耗时 | 3.5–14 s；图片批 44–83 s |

### 4.2 35 张 1.9 MB 级截图

| 轮次 | prompt | prompt cache | prefill | 图像 embedding |
|---|---:|---|---:|---|
| T1 冷启动 | 348,236 | miss（预期） | 995.7 s | 19 编码 + 16 磁盘命中 |
| T2 首轮工具后 | 358,336 | 一次性 `common=6639` 前缀切换 | 1,035.5 s | 35 磁盘命中、0 编码 |
| T3 新图 36 | 360,505 | `multimodal live kv hit` | 46 tokens / 1.19 s | 新图 1 次编码 |
| T4 新图 37 | 361,373 | `multimodal live kv hit` | 823 tokens / 6.71 s | 新图 1 次编码 |

结论：历史图在 T2 已全部命中、0 编码；T3/T4 只为新读入的图各编码一次。T2 的一次性 miss
来自恢复会话后的前缀变化（系统/工具前缀），不是 `max_body`；T3/T4 已恢复命中。

### 4.3 128 MiB 边界

- `Content-Length: 134217729`（128 MiB+1）→ 立即 `400 bad HTTP request`；
- `Content-Length: 134000000` → body 读完，进入 JSON 解析；
- 约 67 MB 的真实 Pi session 请求通过并完成冷启动 prefill。

按当前 1.9–3.3 MB/张，128 MiB 大约支持 **65–70 张**；100 张全分辨率需要更大上限或先降采样。
100 张 960×640 小图不受此限。

---

## 5. 快速开始

### 5.1 构建

```sh
git clone https://github.com/ptkdLLL/ds4-vision.git
cd ds4-vision
make -j
```

构建产物：`ds4`（worker/CLI）与 `ds4-server`（coordinator）。

模型权重 **不包含** 在本仓库。请自行获取 DeepSeek V4.1 Flash 的 GGUF 与 vision sidecar
（Q2 量化 + vision encoder），并遵守模型自身的许可。

```sh
export MODEL=/path/to/DeepSeek-V4.1-Flash-Q2.gguf
export VISION=/path/to/DeepSeek-V4.1-Flash-Vision.gguf
```

### 5.2 启动 worker（先）

```sh
DS4_METAL_V41_PREFILL_CHUNK=256 \
./ds4 -m "$MODEL" --vision "$VISION" \
  --tensor-parallel --role worker \
  --coordinator <COORDINATOR_IP> 9916 --transport tcp \
  --ctx 500000 --power 100
```

### 5.3 启动 coordinator（后）

```sh
DS4_METAL_V41_PREFILL_CHUNK=256 \
DS4_IMAGE_EMBED_CACHE_DIR="$HOME/.cache/ds4-image-embed" \
DS4_IMAGE_EMBED_CACHE_BYTES=2147483648 \
DS4_IMAGE_EMBED_CACHE_VERSION=1 \
./ds4-server -m "$MODEL" --vision "$VISION" \
  --tensor-parallel --role coordinator \
  --listen <COORDINATOR_IP> 9916 --transport tcp \
  --ctx 500000 --power 100 \
  --host 127.0.0.1 --port 8005 --cors
```

API：`http://127.0.0.1:8005/v1`，模型 id 为 `deepseek-v4.1-flash`。

> 两台机器的模型路径、vision 路径、commit 必须一致；worker 必须先启动。
> 不要使用 `--ssd-streaming`；本部署是 resident + TP。

---

## 6. 配置

| 项 | 默认/说明 |
|---|---|
| `--ctx` | `500000` |
| `DS4_METAL_V41_PREFILL_CHUNK` | `256` |
| `SERVER_MAX_IMAGES` | `256`（源码常量） |
| `max_body` | `128 MiB`（本 fork；原版 64 MiB） |
| `DS4_IMAGE_EMBED_CACHE_DIR` | 缓存目录，必须可写；建议 700 权限 |
| `DS4_IMAGE_EMBED_CACHE_BYTES` | 默认 2 GiB；100 张大图建议 4–8 GiB |
| `DS4_IMAGE_EMBED_CACHE_VERSION` | 缓存版本目录；换模型/编码器时递增 |
| RAM image cache | 64 项 / 512 MiB，LRU（源码常量） |
| TP | 50/50 expert ownership，TCP |

SSD `.emb` 缓存**满即跳过新写入、不自动淘汰**。长期运行请定期清理旧版本/旧图片，或提高
缓存配额；否则未写进缓存的图片会在后续轮次重新编码。

---

## 7. 客户端契约

为了同时保住“模型看得见图”和“prompt cache 命中”：

1. **每轮发送完整历史**（OpenAI Chat Completions 语义）；
2. **不要删除/替换历史图片**：不要使用旧的 `image-window`/drop-oldest；
3. **不要在两轮之间改写旧图片**：降采样/转码/重新压缩会改变缓存身份；
4. 图片先用 PNG/JPEG；WebP/GIF 可在首次发送前转成 PNG；
5. 如果使用 Pi：`read` 工具返回的 image toolResult 会随历史重发；服务端负责 embedding 缓存，
   不需要旧的 image-window 扩展；
6. 客户端 compaction 如果摘要/丢弃图片，模型会失去像素——这是“隐式提及幻觉”的来源，
   图片密集会话应避免在任务中途丢掉旧图。

---

## 8. 与旧 fork/上游的关系

- 上游：`antirez/ds4`（DwarfStar 4），MIT；
- 旧 fork：distributed vision + layer-sliced pipeline + `image-window`/`webp-to-png`；
- 本版：V4.1 Flash、双机 TP/TCP、500K、vision、append-only 图片历史、服务端图像 embedding
  缓存、128 MiB body；
- 旧 `image-window` 已移除；`webp-to-png` 不再是必需组件（需要时在客户端先转 PNG）；
- 旧 `start-cluster-vision.sh`（layer-sliced）不再适用；使用上面的 TP worker/coordinator
  命令。

上游的大型 QA/训练数据集未包含在本 fork；需要时请到上游仓库获取。

---

## 9. 已知限制

- 模型权重、vision sidecar 不随仓库分发；
- 双机内存/带宽是硬约束；500K ctx + resident 权重需要足够统一内存；
- 128 MiB body 对 100 张 1.9–3.3 MB 截图仍不够；请降采样、提高上限或使用更大的 body 预算；
- 冷启动首轮需要全量 prefill + 缺失图片编码；本实测 348K tokens 约 16.6 min；
- SSD 图像缓存无自动淘汰；需要手工清理/提高配额；
- 单驻留槽推理；并发大请求会叠加内存，生产环境应限制并发；
- 旧设计的历史会话如果已经被替换成 marker，重新启用 append-only 需要从头恢复图片历史；
- 本项目是实验性 fork，不提供任何保证。

---

## 10. 许可与致谢

MIT License，与上游一致。见 `LICENSE` 与 `NOTICE`。

- 上游：[DwarfStar 4 / ds4.c](https://github.com/antirez/ds4)，MIT；
- 模型：DeepSeek V4.1 Flash 及其 vision encoder，权重与许可由模型发布方提供；
- 本项目与 DeepSeek、Apple、DwarfStar 上游均无隶属关系。

没有 `llama.cpp`/GGML 打开的道路，就不会有 `ds4.c`；感谢上游与 GGML 社区。
