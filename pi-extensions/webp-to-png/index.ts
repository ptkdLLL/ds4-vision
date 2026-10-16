/**
 * webp-to-png — 模型读图前自动把 webp/gif/bmp 转成 png
 *
 * 背景（2026-10-11 事故调查结论）：
 *   ds4-vision 服务端解析器只接受 data:image/png|jpeg|jpg 三种 data URI
 *   （ds4_server.c:543-560 server_image_inputs_push_data_uri），webp/gif/bmp
 *   在解析层直接被拒，且掉进兜底分支报出误导性的 "invalid JSON request"。
 *   某 ComfyUI 输出帧恰好全是 webp → "读图必炸"。
 *
 * 方案（pi 扩展官方 API）：
 *   利用 tool_call 钩子（docs/extensions.md: "event.input is mutable. Mutate
 *   it in place to patch tool arguments before execution."）在 read 真正执行
 *   之前，把 .webp/.gif/.bmp 路径原地改写为转换后的 .png 缓存路径。
 *
 * 设计约束（严格遵循）：
 *   - 不改 messages / 不注入上下文 / 不改系统提示 —— 对模型唯一可见的影响
 *     是"读到的图片字节从 webp 变成等价 png"（像素一致，仅编码格式不同）
 *   - 转换用 macOS 自带 sips：解码后像素无损重编码为 png，不做有损再压缩
 *   - 缓存键 = 源文件 realpath+mtime+size 的 sha1 → 同一文件只转一次；
 *     路径与字节全程稳定（保护 ds4 提示缓存的前缀命中）
 *   - 失败安全：sips 缺失 / 源不存在 / 超限 / 任何异常 → 原样放行，
 *     行为退化为未安装本插件（绝不炸 read）
 *   - 纯拦截改写：不返回 block，只改 input.path
 *
 * 局限：动图（animated webp/gif）只取第一帧（sips 行为）；>32MiB 源文件与
 *       >60MiB 转换产物跳过（服务端 encoded 上限 64MiB）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { homedir } from "node:os";

/** 服务端不认、需要转换的图片扩展名（png/jpg/jpeg 直接放行） */
const CONVERT_EXTENSIONS = new Set([".webp", ".gif", ".bmp"]);

const CACHE_DIR = join(homedir(), ".pi/agent/cache/webp-to-png");
const LOG = join(homedir(), ".pi/agent/extensions/webp-to-png/conversions.log");

const MAX_SRC_BYTES = 32 * 1024 * 1024; // 源文件超限不转
const MAX_PNG_BYTES = 60 * 1024 * 1024; // 产物超限不转（服务端 64MiB 上限留余量）

function log(line: string) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* ignore */
  }
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** 转换（带缓存）。成功返回 png 缓存路径；任何失败返回 null（调用方原样放行）。 */
function convertToPng(src: string): string | null {
  try {
    const real = realpathSync(src);
    const st = statSync(real);
    if (!st.isFile() || st.size === 0 || st.size > MAX_SRC_BYTES) return null;

    const key = createHash("sha1")
      .update(`${real}:${st.mtimeMs}:${st.size}`)
      .digest("hex")
      .slice(0, 16);
    const safeBase = basename(real).replace(/[^A-Za-z0-9._-]/g, "_");
    const dst = join(CACHE_DIR, `${key}-${safeBase}.png`);

    if (existsSync(dst)) return dst; // 缓存命中：同源文件只转一次

    mkdirSync(CACHE_DIR, { recursive: true });
    execFileSync("/usr/bin/sips", ["-s", "format", "png", real, "--out", dst], {
      stdio: "ignore",
      timeout: 30_000,
    });
    if (!existsSync(dst)) return null;

    const outSize = statSync(dst).size;
    if (outSize === 0 || outSize > MAX_PNG_BYTES) {
      log(`skip: converted png too large (${outSize}B) for ${real}`);
      return null;
    }
    log(`converted ${real} (${st.size}B) -> ${dst} (${outSize}B)`);
    return dst;
  } catch (e: any) {
    log(`convert failed for ${src}: ${e?.message ?? e}`);
    return null;
  }
}

export default function webpToPng(pi: ExtensionAPI) {
  // read 工具执行前拦截：webp/gif/bmp → 原地改写为 png 缓存路径
  pi.on("tool_call", async (event) => {
    try {
      if (!isToolCallEventType("read", event)) return undefined;
      const p = (event.input as any)?.path;
      if (typeof p !== "string" || !p) return undefined;

      const lower = p.toLowerCase();
      const dot = lower.lastIndexOf(".");
      if (dot < 0 || !CONVERT_EXTENSIONS.has(lower.slice(dot))) return undefined;

      const src = expandHome(p);
      if (!existsSync(src)) return undefined; // 文件不存在：交给 read 自己报错

      const dst = convertToPng(src);
      if (dst) (event.input as any).path = dst; // 原地改写 → 实际执行读取 png
      return undefined;
    } catch (e: any) {
      // 失败安全：钩子异常绝不炸掉 read 本身
      log(`hook error: ${e?.message ?? e}`);
      return undefined;
    }
  });
}
