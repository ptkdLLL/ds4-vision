# webp-to-png — read 前自动转换插件（2026-10-11）

## 为什么存在
ds4-vision 服务端解析器只接受 `data:image/png|jpeg|jpg`（`ds4_server.c:543-560`），
webp/gif/bmp 会被拒且报误导性的 `"invalid JSON request"`（400）。
某目录输出帧全是 webp → 读图必炸。本插件在 read 执行前把这类路径原地改写为
转换后的 png 缓存路径，全程自动，无需模型或用户干预。

## 行为
- 拦截 `read` 工具，仅当路径扩展名为 `.webp` / `.gif` / `.bmp`（大小写不敏感）。
- 用 macOS 自带 `sips -s format png` 转换（解码像素无损重编码，不做有损再压缩）。
- 缓存：`~/.pi/agent/cache/webp-to-png/<sha1(realpath+mtime+size) 前16位>-<原文件名>.png`
  - 同源文件只转一次；**路径与字节稳定** → 保护 ds4 提示缓存前缀命中。
- 转换日志：`~/.pi/agent/extensions/webp-to-png/conversions.log`
- 失败安全：sips 缺失 / 源不存在 / 超限 / 异常 → 原样放行（等价于没装插件）。

## 对模型的影响（用户问"完全不影响 LLM 吧？"的诚实版）
- 图像内容：像素完全一致，只是编码换成 png——对推理无影响。
- 可见差异（3 处，均无害）：
  1. 工具结果标签 `[image/webp]` → `[image/png]`；
  2. 请求体变大（png 无损，base64 更长；本地集群无成本影响，token 数不变——
     图像 token 由服务端按解码分辨率计算，与格式无关）；
  3. 缓存目录 + 磁盘占用。
- 不改 messages / 不注入上下文 / 不改系统提示。

## 局限
- 动图（animated webp/gif）只取第一帧（sips 行为）。
- 源文件 >32MiB 或产物 >60MiB 时跳过（服务端 encoded 上限 64MiB）。
- 目前-running 的 pi 会话需重启（或 /reload）后才生效。

## 禁用
把本目录改名即可（如 `webp-to-png.disabled`）。
服务端原生支持 webp 后（修复计划 A1：ImageIO 解码），本插件即可退役。
