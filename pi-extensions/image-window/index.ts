/**
 * image-window — 读图即弃（LLM 侧）：图片被消费后从请求中剥离为确定性文本占位
 *
 * v4（2026-10-13，"Attached 镜像"修复；背景见仓库 VISION_FORK.md）：
 *   pi provider 对含图 toolResult 有"抽取（首轮）/内嵌（消费后）"双形态 —— 同一历史两轮
 *   序列化不同 ⇒ 服务器 walk 拒绝 ⇒ 锚点回退 ⇒ 大重灌（用户"疑似全量"）。v4 修复 =
 *   toolResult 剥离时**镜像首轮抽取结构**（合成 "Attached image(s) from tool result:" 消息，
 *   marker 文本 + kept 真图按运行段序排列）；config.toolMirror=false 可回退 v3 原位替换。
 *
 * 消费判定（v2，经状态矩阵模拟修正）：其后出现过"含非空 text 的 assistant 响应"才算消费；
 *   thinking/toolCall-only 的决策轮不算——顺序多图收集期保证联合可见。
 *
 * 验证：v3 mock 34/34 + 活体指纹 7/7；v4 对拍矩阵见 tests/（落码前全绿）。
 * 失败安全：任何异常 → 原样放行，绝不炸请求。
 * 禁用：目录改名 image-window.disabled 即可。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { transformMessages, type ImageWindowConfig } from "./transform.ts";

const DIR = join(homedir(), ".pi/agent/extensions/image-window");
const CONFIG_PATH = join(DIR, "config.json");
const LOG = join(DIR, "image-window.log");

const DEFAULTS: ImageWindowConfig = {
  keep: 0, pins: [], stripUserImages: false, markerEmit: false, toolMirror: true,
};

function loadConfig(): ImageWindowConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return {
      keep: typeof raw?.keep === "number" ? raw.keep : DEFAULTS.keep,
      pins: Array.isArray(raw?.pins) ? raw.pins.filter((x: unknown) => typeof x === "string") : DEFAULTS.pins,
      stripUserImages: raw?.stripUserImages === true,
      markerEmit: raw?.markerEmit === true,
      toolMirror: raw?.toolMirror !== false, // 缺省/旧配置 → true（v4 默认开启）
    };
  } catch {
    return DEFAULTS; // 缺失/损坏 → 全默认
  }
}

function logLine(line: string) {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`); } catch { /* ignore */ }
}

export default function imageWindow(pi: ExtensionAPI) {
  const cfg = loadConfig();
  let cfgLogged = false;

  pi.on("context", async (event: any) => {
    try {
      if (!cfgLogged) {
        logLine(`loaded: keep=${cfg.keep} pins=[${cfg.pins.join(",")}] stripUserImages=${cfg.stripUserImages} markerEmit=${cfg.markerEmit} toolMirror=${cfg.toolMirror}`);
        cfgLogged = true;
      }
      const msgs: any[] = event.messages ?? [];
      const r = transformMessages(msgs, cfg);
      if (r.stripped || r.overflowStripped || r.toolAttached) {
        logLine(`stripped=${r.stripped} overflow=${r.overflowStripped} kept=${r.kept} toolAttached=${r.toolAttached} msgs=${msgs.length}`);
        return { messages: r.messages };
      }
      return undefined; // 无剥离 → 原样
    } catch (e: any) {
      logLine(`context error (fail-safe, request unchanged): ${e?.message}`);
      return undefined;
    }
  });
}
