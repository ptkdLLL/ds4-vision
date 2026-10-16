// transform.ts — image-window 纯函数（无 IO / 无时钟 / 无随机；★单测目标）
//
// v4（2026-10-13，「Attached 镜像」修复）：恢复**请求序列化跨轮恒定**不变量。
// 背景（字节级根因，见 ds4vision-image-window-v4-计划-20261013.md §1）：
//   pi provider 对「含图的 toolResult」有两种结构——首轮（图未消费）把图**抽取**为独立
//   user 消息 `Attached image(s) from tool result:`（图=image_url 部件）；图被消费后
//   （v3 原位替换为 36B marker 文本）`hasImages=false`，抽取消失、marker 被 join 进
//   <tool_result> 内容——同一历史两轮序列化不同 ⇒ 服务器 walk 在 marker 绑定前一步
//   BYTE_MISMATCH ⇒ 锚点回退 ⇒ 大重灌（用户"疑似全量"）。
// v4 修法：toolResult 图被剥离时不原位替换，而是**镜像首轮抽取结构**——
//   ① 该连续 toolResult 运行段内全部 image 部件移出（stripped→marker 文本；kept→原图部件）；
//   ② 段后插入**一条**合成 user 消息，部件按**运行段序**排列：
//        text("Attached image(s) from tool result:" + 连续 stripped marker 文本)
//        [kept image 部件] [text(后续 marker)] ...  —— 渲染 = live 中 `prefix + vision(0B)×n` 的字节序
//   ③ 移出后无 text 部件的工具消息注入字面量 "(see attached image)"（对齐 provider 兜底）。
//   服务器 walk 对无字节 marker **结构绑定**（offset 等值，不比对指纹；连续 marker↔连续
//   vision offset 恒等，ds4_server.c:11437-11588），对 kept 真图走指纹绑定——两路皆验证。
// 确定性保证：同输入 ⇒ 逐字节同一输出（提示缓存前缀稳定的前提）。
// 回退：config.toolMirror=false 或 markerEmit=false ⇒ 走 v3 原位替换（占位符不可绑定）。
//
// v3（2026-10-12，M2-c）：消费剥离的替换文本从"占位文本"升级为**服务器同形 36B 图像 marker**
// （\x1e DS4_IMAGE_ <sha1 前 12 字节 hex> \x1f）——"已铸但不在铸"的第三种图像表示。
// 消费判定（v2）：图部件所在消息"之后出现过带【非空正文 text】的 assistant 响应" ⇒ 已消费。
//   —— thinking/toolCall-only 的决策轮不算消费（顺序多图时保证联合可见）。

import { createHash } from "node:crypto";

export interface ImageWindowConfig {
  keep: number;
  pins: string[];
  stripUserImages: boolean;
  /** v3: true ⇒ 消费剥离替换为服务器同形 marker 文本；false ⇒ v2 占位符 */
  markerEmit: boolean;
  /** v4: true/缺省 ⇒ toolResult 剥离镜像首轮 "Attached" 结构；false ⇒ v3 原位替换（回退开关） */
  toolMirror?: boolean;
}

export interface TransformResult {
  messages: any[];
  stripped: number;
  kept: number;
  overflowStripped: number;
  /** v4: 本次生成的合成 "Attached" 消息数（日志用） */
  toolAttached: number;
}

const MAX_NAME = 80;

/** pi provider 首轮抽取字面量（35B，逐字节同 openai-completions 源码） */
const ATTACHED_PREFIX = "Attached image(s) from tool result:";
/** pi provider 无文本有条时的工具内容兜底字面量（同源码） */
const SEE_ATTACHED = "(see attached image)";

function safeName(path: string | undefined): string | null {
  if (typeof path !== "string" || !path) return null;
  const base = path.split("/").pop() ?? path;
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_NAME);
  return clean || null;
}

function pinned(path: string | undefined, pins: string[]): boolean {
  if (typeof path !== "string" || !path) return false;
  for (const p of pins) {
    if (typeof p !== "string" || !p) continue;
    if (p.startsWith("/")) {
      if (path === p) return true;
    } else if (path === p || path.endsWith("/" + p)) {
      return true;
    }
  }
  return false;
}

export function placeholderText(name: string | null, mime: string): string {
  return `[image omitted from context: ${name ? name + " " : ""}(${mime}) — already viewed and analyzed; re-read the file if you need to inspect it again]`;
}

/** B5 (2026-10-12): 溢出剥离专用占位符——基础占位 + 固定后缀（单一事实来源） */
export function overflowPlaceholderText(name: string | null, mime: string): string {
  return placeholderText(name, mime) + " (window overflow — re-read to view)";
}

/** v3 (2026-10-12): 服务器同形 marker 文本（36B）。
 *  算法与 ds4_server.c server_image_inputs_push_base64 相同：sha1(图像字节) 的
 *  前 12 字节 → 24 位小写 hex，包裹 \x1e"DS4_IMAGE_"…\x1f。失败返回 null（调用方回退占位符）。 */
export function markerText(dataB64: unknown): string | null {
  if (typeof dataB64 !== "string" || !dataB64) return null;
  try {
    const sha = createHash("sha1").update(Buffer.from(dataB64, "base64")).digest("hex");
    return "\x1eDS4_IMAGE_" + sha.slice(0, 24) + "\x1f";
  } catch {
    return null;
  }
}

/** 消费/溢出剥离的单部件替换（v3 路径：仅用于 user 消息与降级回退）。 */
function stripImagePart(p: any, name: string | null, markerEmit: boolean,
                        overflowFallback: boolean): any {
  if (p?.type !== "image") return p;
  if (markerEmit) {
    const m = markerText(p.data);
    if (m) return { type: "text", text: m };
  }
  const mime = String(p.mimeType || "image");
  return { type: "text", text: overflowFallback
    ? overflowPlaceholderText(name, mime)
    : placeholderText(name, mime) };
}

const WINDOW_LIMIT = 16;

function collectCallPaths(msgs: any[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of msgs) {
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (!p || p.type !== "toolCall") continue;
      let args: any = p.arguments;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = null; }
      }
      const path = args && typeof args.path === "string" ? args.path : undefined;
      if (p.id && path) map.set(String(p.id), path);
    }
  }
  return map;
}

function countImages(content: any[]): number {
  let c = 0;
  for (const p of content) if (p?.type === "image") c++;
  return c;
}

/** 消费性 assistant：含至少一个非空 text 部件（thinking/toolCall-only 不算） */
function hasConsumingText(m: any): boolean {
  if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return false;
  for (const p of m.content) {
    if (p?.type === "text" && typeof p.text === "string" && p.text.trim() !== "") return true;
  }
  return false;
}

type Verdict = "keep" | "strip";

export function transformMessages(msgs: any[], cfg: ImageWindowConfig): TransformResult {
  const keep = Number.isFinite(cfg.keep) && cfg.keep >= 0 ? Math.floor(cfg.keep) : 0;
  const pins = Array.isArray(cfg.pins) ? cfg.pins : [];
  const mirror = cfg.markerEmit !== false && cfg.toolMirror !== false;
  const callPaths = collectCallPaths(msgs);

  // 后缀和：consumedAfter[i] = msgs[i] 之后的"消费性 assistant（含非空正文）"数量
  const n = msgs.length;
  const consumedAfter = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    consumedAfter[i] = consumedAfter[i + 1] + (hasConsumingText(msgs[i]) ? 1 : 0);
  }

  // ① 逐消息 verdict（消息粒度，整消息一致）+ ② B5 溢出（最旧先剥，消息粒度）
  const verdict: Verdict[] = new Array(n).fill("keep");
  const overflowFlag: boolean[] = new Array(n).fill(false);
  let keptCount = 0, consumedStripCount = 0, totalImages = 0;
  for (let i = 0; i < n; i++) {
    const m = msgs[i];
    if (!m || !Array.isArray(m.content)) continue;
    const imgs = countImages(m.content);
    if (!imgs) continue;
    totalImages += imgs;
    if (m.role === "user" && !cfg.stripUserImages) { keptCount += imgs; continue; }
    const path = m.role === "toolResult" && m.toolCallId ? callPaths.get(String(m.toolCallId)) : undefined;
    if (pinned(path, pins)) { keptCount += imgs; continue; }
    if (consumedAfter[i] <= keep) { keptCount += imgs; continue; }
    verdict[i] = "strip";
    consumedStripCount += imgs;
  }
  let overflow = keptCount - WINDOW_LIMIT;
  for (let i = 0; i < n && overflow > 0; i++) {
    const m = msgs[i];
    if (!m || !Array.isArray(m.content) || verdict[i] === "strip") continue;
    const imgs = countImages(m.content);
    if (!imgs) continue;
    verdict[i] = "strip";
    overflowFlag[i] = true;
    overflow -= imgs;
    keptCount -= imgs;
  }

  // 输出装配：out[i] 覆盖 + insertAfter[i] 插入表（合成消息），最后线性合并
  const out: any[] = new Array(n).fill(undefined);
  const insertAfter = new Map<number, any>();
  let stripped = 0, overflowStripped = 0, kept = 0, toolAttached = 0, changed = false;

  const stripOne = (p: any, path: string | undefined, isOverflow: boolean) =>
    stripImagePart(p, safeName(path), cfg.markerEmit, isOverflow);

  let i = 0;
  while (i < n) {
    const m = msgs[i];
    const content: any[] | null = m && Array.isArray(m.content) ? m.content : null;
    if (!content) { i++; continue; }

    // ── toolResult 运行段（连续 role==="toolResult"）──
    if (m.role === "toolResult") {
      let j = i;
      while (j < n && msgs[j] && msgs[j].role === "toolResult") j++;
      let runStrip = 0;
      let runHasImages = false;
      for (let k = i; k < j; k++) {
        const mc = msgs[k].content;
        if (Array.isArray(mc) && countImages(mc) > 0) {
          runHasImages = true;
          if (verdict[k] === "strip") runStrip += countImages(mc);
        }
      }
      if (runStrip > 0 && runHasImages && mirror) {
        // 收集：全部可解析 → 镜像重构；否则整段退化 v3 原位。
        let ok = true;
        interface Entry { kind: "marker" | "image"; marker?: string; block?: any; ov: boolean; }
        const entries: Entry[] = [];
        for (let k = i; k < j && ok; k++) {
          const mc = msgs[k].content;
          if (!Array.isArray(mc)) continue;
          for (const p of mc) {
            if (p?.type !== "image") continue;
            if (verdict[k] === "strip") {
              const mk = markerText(p?.data);
              if (!mk) { ok = false; break; }
              entries.push({ kind: "marker", marker: mk, ov: overflowFlag[k] });
            } else {
              entries.push({ kind: "image", block: p, ov: false });
            }
          }
        }
        if (ok) {
          // 逐消息重写 content：移出全部 image；无 text 且原有图 → 注入 SEE_ATTACHED
          for (let k = i; k < j; k++) {
            const mc = msgs[k].content;
            if (!Array.isArray(mc) || countImages(mc) === 0) continue; // 无图消息保持原样
            const newContent: any[] = [];
            let hasText = false;
            for (const p of mc) {
              if (p?.type === "image") continue; // 移出（内容进入合成消息）
              if (p?.type === "text" && typeof p.text === "string" && p.text.length > 0) hasText = true;
              newContent.push(p);
            }
            if (!hasText) newContent.push({ type: "text", text: SEE_ATTACHED });
            out[k] = { ...msgs[k], content: newContent };
            changed = true;
          }
          // 合成消息：按运行段序排列部件（text 缓冲 + kept 真图部件）
          const parts: any[] = [];
          let buf = ATTACHED_PREFIX;
          for (const en of entries) {
            if (en.kind === "marker") {
              buf += en.marker;
              if (en.ov) overflowStripped++; else stripped++;
            } else {
              if (buf) { parts.push({ type: "text", text: buf }); buf = ""; }
              parts.push(en.block);
              kept++;
            }
          }
          if (buf) parts.push({ type: "text", text: buf });
          insertAfter.set(j - 1, { role: "user", content: parts });
          toolAttached++;
          i = j;
          continue;
        }
        // ok=false → 落到下方 v3 逐消息剥离（整段退化）
      }
      // v3 路径：本段逐消息剥离（verdict==strip 的消息原位替换；其余原样）
      for (let k = i; k < j; k++) {
        const mk = msgs[k];
        const mc = mk.content;
        if (!Array.isArray(mc) || countImages(mc) === 0) continue;
        if (verdict[k] !== "strip") { kept += countImages(mc); continue; }
        const path = mk.toolCallId ? callPaths.get(String(mk.toolCallId)) : undefined;
        out[k] = { ...mk, content: mc.map((p: any) => stripOne(p, path, overflowFlag[k])) };
        const c = countImages(mc);
        if (overflowFlag[k]) overflowStripped += c; else stripped += c;
        changed = true;
      }
      i = j;
      continue;
    }

    // ── user 消息（图原位替换；v3 同款，服务器部件纯拼接已证字节安全）──
    if (m.role === "user") {
      const imgs = countImages(content);
      if (!imgs) { i++; continue; }
      if (verdict[i] !== "strip") { kept += imgs; i++; continue; }
      const path = m.toolCallId ? callPaths.get(String(m.toolCallId)) : undefined;
      out[i] = { ...m, content: content.map((p: any) => stripOne(p, path, overflowFlag[i])) };
      if (overflowFlag[i]) overflowStripped += imgs; else stripped += imgs;
      changed = true;
      i++;
      continue;
    }

    // ── 其他消息：原样 ──
    i++;
  }

  const result: any[] = new Array(n + insertAfter.size);
  let w = 0;
  for (let k = 0; k < n; k++) {
    result[w++] = out[k] !== undefined ? out[k] : msgs[k];
    const ins = insertAfter.get(k);
    if (ins !== undefined) result[w++] = ins;
  }
  return { messages: changed ? result : msgs, stripped, kept, overflowStripped, toolAttached };
}
