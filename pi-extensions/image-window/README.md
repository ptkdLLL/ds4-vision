# image-window — 读图即弃（LLM 侧窗口化）

## 为什么存在
ds4-vision 服务端"每请求 ≤16 图"＋客户端每轮重发全历史 ⇒ 主会话累计 16 张即哑；
图片随行还带来 486KB/轮 payload、位置敏感块、冷路径重编码。本扩展把**已消费**的图片
从发给 LLM 的副本中剥离为确定性占位文本。

## 语义（消费判定 v2 + B4/B5）
- 图死后出现"**含非空正文的 assistant 响应**" ⇒ 已消费 ⇒ 下一轮起剥离为占位符；
- thinking/toolCall-only 的**决策轮不算消费**——顺序多图收集期全部保留（联合比对可用）；
- `keep=N`：消费后还可多活 N 个"正文轮"；`pins`：钉住名单永不剥离；
- **`stripUserImages:true`（现行默认，B4）**：user 附图与工具图同语义"消费即弃"
  （首轮端到端可见；跨轮需重贴，或设 `keep=1` 缓冲）；
- **溢出硬保证（B5）**：消费剥离后仍在窗的图数 >16（静默批量等）时，从最旧消息起
  强制剥离至 ≤16（消息粒度；占位符加后缀 " (window overflow — re-read to view)"；
  覆盖 pins 与 user 图——16 上限的最后防线）；恰 ≤16 时零行为变化；
- **非破坏性**：session jsonl 原件永久保留；重新 read 即可再看（实测 2-3s、零重编码）。

## 效果（活体实测）
- 读图轮：完整像素（端到端理解不受影响）；
- 剥离轮：一次性近尾重算 ≈204 tokens（0.3s），payload 486KB→50KB，**16 累计死限消失**；
- 剥离后：纯文本历史，预填 ≈7 tokens，缓存与纯文本会话同级。

## 配置（同目录 config.json；缺失/损坏均安全回退默认）
```json
{ "keep": 0, "pins": [], "stripUserImages": true }
```

## 验证与文档
- mock 状态矩阵 34/34（S1-S19）+ 溢出用例 S20-S23；活体指纹 7/7；
- 完整背景/目标/风险/矩阵：见仓库 VISION_FORK.md；
  服务端配套（多模态磁盘快照 + 边界检查点）：见仓库 VISION_FORK.md

## 禁用
目录改名 `image-window.disabled` 即可。

## v3（2026-10-12，M2-c）：marker 发射
- 消费剥离的替换文本升级为**服务器同形 36B 图像 marker**
  （`\x1e DS4_IMAGE_ <sha1(图像字节) 前 12 字节 hex> \x1f`）——第三种图像表示：
  服务器凭结构绑定复用会话内既有图块，剥离轮不再文本失配（实测 walk 直通至 live 99.6%）。
- `config.json` 新增 `markerEmit`（true=marker；false=回退 v2 占位符）。
- marker 哈希对象 = 图部件字节（webp-to-png 在 read 前已转换 → 与服务器收到字节一致）；
  取不到 data 时 fail-safe 回退占位符。
- 自测：`node --experimental-strip-types mock-v3.ts`（9 项，含与服务器日志 key 的交叉验证）。

## v4（2026-10-13）「Attached 镜像」修复
- 根因：pi provider 对含图 toolResult 有"抽取（首轮）/内嵌（v3 消费后）"双形态 → 同一历史
  两轮序列化不同 → 服务器 walk 拒绝 → 锚点回退 → 大重灌（用户"疑似全量"）。
- v4：toolResult 图剥离时**镜像首轮抽取结构**——运行段内全部 image 移出，段后插入合成
  `Attached image(s) from tool result:` 消息（被剥 marker 文本 + 被留真图按段序排列）。
  服务器 walk 对 marker 结构绑定（offset 等值）、对 kept 真图指纹绑定。
- 回退开关：config `toolMirror:false` → v3 原位替换；`markerEmit:false` 同 v3。
- 验证：对拍矩阵 52/52（含真实 176 消息会话 1.07MB 渲染前缀逐字节恒定）+ node DAP 现场检视。
- 证据：对拍矩阵 52/52（首轮形态 ≡ 消费轮形态逐字节）。
