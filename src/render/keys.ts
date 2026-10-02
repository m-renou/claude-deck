// Key images (144 × 144 SVG), one pure function per key, in the visual language of Elgato's ChatGPT & Codex plugin
// (DESIGN.md). Layout measured from the Codex marketplace screenshots:
//   corner icon  ~32 px at (16, 16)          body text  18 px semibold, x = 16, baselines 78 / 100 / 122
//   hero icon    ~64 px centred              time       17 px grey, right-aligned at x = 128, baseline 33
// Pure module (unit-tested with plain node).

import type { Chat, ChatStatus, Usage } from "../types.ts";
import { type IconName, icon } from "./icons.ts";
import { C, SIZE, bgRect, clamp, dimVeil, fadeDefs, fitPrefix, n, relTime, svg, text, textBlock, textWidth, titleCase, wrapLines } from "./kit.ts";

// ───────────────────────────────────────────────────────────────────────── layout

export const L = {
  pad: 16,
  /** Text is fully hidden from here on (the fade runs over the 16 px before it). */
  clipX: 131,
  /** Corner icon box: the 24-unit grid's ~2.5…21.5 content lands on 16…47. */
  corner: { x: 11, y: 11, size: 40, stroke: 2.75 },
  /** Hero icon box (centred). */
  hero: { size: 78, stroke: 5.5 },
  body: { size: 18, lineHeight: 22, baselines: [78, 100, 122] as const, maxLines: 3 },
  time: { size: 17, right: 128, baseline: 33 },
  /** Selected Activity chat: inner border. */
  border: 4,
} as const;

/** Width text may use before it starts fading. */
const TEXT_W = L.clipX - 2 - L.pad;

const doc = (body: string): string => svg(SIZE, SIZE, body);

const corner = (name: IconName, color: string, extra: { fill?: boolean } = {}): string =>
  icon(name, { x: L.corner.x, y: L.corner.y, size: L.corner.size, color, strokeWidth: L.corner.stroke, ...extra });

/** Centred hero icon; `dy` moves it down (to make room for text above it). */
const hero = (name: IconName, color: string, extra: { fill?: boolean; size?: number; dy?: number } = {}): string => {
  const size = extra.size ?? L.hero.size;
  const y = (SIZE - size) / 2 + (extra.dy ?? 0);
  return icon(name, { x: (SIZE - size) / 2, y, size, color, strokeWidth: (L.hero.stroke * size) / L.hero.size, fill: extra.fill });
};

/** Body text block (top-aligned or bottom-aligned on the 78 / 100 / 122 baseline grid). */
function body(content: string, bg: string, o: { align?: "top" | "bottom"; fill?: string } = {}): string {
  const lines = wrapLines(content, L.body.size, TEXT_W, L.body.maxLines);
  const first = o.align === "bottom" ? L.body.baselines[L.body.maxLines - lines.length]! : L.body.baselines[0];
  const block = textBlock(lines, { x: L.pad, y: first, size: L.body.size, lineHeight: L.body.lineHeight, clipX: L.clipX, bg, fill: o.fill });
  return (block.overflow ? fadeDefs(bg) : "") + block.svg;
}

/** One line of large text, shrunk (down to `min`) to fit, then clipped like body text. */
function headline(content: string, y: number, size: number, min: number, fill: string, bg: string): string {
  let s = size;
  while (s > min && textWidth(content, s) > TEXT_W) s -= 1;
  const line = fitPrefix(content, s, TEXT_W + 3 * s);
  const block = textBlock([line], { x: L.pad, y, size: s, lineHeight: s, clipX: L.clipX, bg, fill });
  return (block.overflow ? fadeDefs(bg) : "") + block.svg;
}

/** A black key with a centred hero icon. */
export const heroKey = (name: IconName, color: string = C.white, o: { fill?: boolean; dim?: boolean } = {}): string =>
  doc(bgRect(C.bg) + hero(name, color, { fill: o.fill }) + (o.dim ? dimVeil() : ""));

// ───────────────────────────────────────────────────────────────────────── Activity

export const STATUS_STYLE: Record<ChatStatus, { tile: string; icon: IconName; color: string }> = {
  working: { tile: C.tile.working, icon: "chat", color: C.white },
  done: { tile: C.tile.done, icon: "check", color: C.green },
  waiting: { tile: C.tile.waiting, icon: "clock", color: C.orange },
  idle: { tile: C.tile.idle, icon: "chat", color: C.greyDim },
};

/** Activity tile: status colour, status icon, time (or +added -removed) top-right, chat title on 3 lines. */
export function activityKey(chat: Chat | undefined, o: { selected?: boolean; now?: number } = {}): string {
  if (!chat) return doc(bgRect(C.bg) + hero("chat", C.empty));
  const st = STATUS_STYLE[chat.status] ?? STATUS_STYLE.idle;
  let out = bgRect(st.tile) + corner(st.icon, st.color);

  const { size, right, baseline } = L.time;
  const diff = chat.status === "done" && chat.diff && (chat.diff.added > 0 || chat.diff.removed > 0) ? chat.diff : undefined;
  if (diff) {
    const del = diff.removed > 0 ? `-${diff.removed}` : "";
    const add = diff.added > 0 ? `+${diff.added}` : "";
    if (del) out += text(right, baseline, del, { size, fill: C.red, anchor: "end" });
    if (add) out += text(del ? right - textWidth(del, size) - 5 : right, baseline, add, { size, fill: C.green, anchor: "end" });
  } else {
    const now = o.now ?? Date.now();
    out += text(right, baseline, relTime(now - (chat.lastActivityAt || now)), { size, fill: C.grey, anchor: "end" });
  }

  out += body(chat.title || "New chat", st.tile);
  if (o.selected) {
    const b = L.border;
    out += `<rect x="${n(b / 2)}" y="${n(b / 2)}" width="${n(SIZE - b)}" height="${n(SIZE - b)}" rx="18" fill="none" stroke="${C.white}" stroke-width="${n(b)}"/>`;
  }
  return doc(out);
}

// ───────────────────────────────────────────────────────────────────────── command keys

export const newChatKey = (): string => heroKey("compose");

/** Microphone; accent while dictating. */
export const dictateKey = (o: { active?: boolean } = {}): string => heroKey("mic", o.active ? C.accent : C.white);

/** Corner icon + text on the body grid; placeholder (grey) when the text is empty. */
function textKey(name: IconName, content: string, placeholder: string, align: "top" | "bottom" = "top"): string {
  const t = content.trim();
  return doc(bgRect(C.bg) + corner(name, C.white) + body(t || placeholder, C.bg, { align, fill: t ? C.white : C.grey }));
}

/** Up-arrow in a white disc + the prompt (3 lines, clipped). */
export const sendPromptKey = (prompt: string): string => textKey("send", prompt, "Send Prompt");

/** ↳ + the steering text. */
export const steerKey = (steer: string): string => textKey("steer", steer, "Steer");

/** Cube + the skill name bottom-left in Title Case ("Review Changes"). */
export function runSkillKey(label: string): string {
  const t = label.trim();
  // Raw skill names ("review-changes") become "Review Changes"; labels the user typed with capitals stay as they are.
  const shown = t && !/\p{Lu}/u.test(t) ? titleCase(t) : t;
  return textKey("skill", shown, "Run Skill", "bottom");
}

/** White disc with a black square; dim when the selected chat isn't working. */
export function stopKey(o: { enabled: boolean }): string {
  const size = 92; // disc Ø ≈ 84 px (22 of the 24 grid units)
  return doc(bgRect(C.bg) + icon("stop", { x: (SIZE - size) / 2, y: (SIZE - size) / 2, size, color: C.white, fill: true }) + (o.enabled ? "" : dimVeil()));
}

// ───────────────────────────────────────────────────────────────────────── model / effort / speed

/** Step pills for `count` entries across the text column, `index` in white. */
export function stepPills(index: number, count: number, y = 124): string {
  if (count < 1) return "";
  const width = SIZE - 2 * L.pad;
  const h = 7;
  let gap = 8;
  let w = (width - (count - 1) * gap) / count;
  if (w < 8) {
    gap = 4;
    w = Math.max(2, (width - (count - 1) * gap) / count);
  }
  let out = "";
  for (let i = 0; i < count; i++) {
    const x = L.pad + i * (w + gap);
    out += `<rect x="${n(x)}" y="${n(y - h / 2)}" width="${n(w)}" height="${h}" rx="${n(h / 2)}" fill="${i === index ? C.white : C.pill}"/>`;
  }
  return out;
}

/** 3-D box, model name, one pill per model in the app's menu (current one white). */
export function modelKey(o: { name: string; index: number; count: number }): string {
  return doc(bgRect(C.bg) + corner("model", C.white) + headline(o.name || "Model", 103, 23, 17, C.white, C.bg) + stepPills(o.index, o.count));
}

export const SLIDER = { x0: 16, x1: 128, y: 118, track: 16, knob: 11.5, p0: 26, p1: 117, dot: 1.8 } as const;

/**
 * Slider knob x for a level. `position` is the level's index on the slider (0 … steps-1, as the Effort view model
 * gives it); a non-integer value in (0, 1) is read as a fraction of the track. Negative = unknown (no knob).
 */
export function sliderX(position: number, steps: number): number | undefined {
  if (!Number.isFinite(position) || position < 0) return undefined;
  const frac = !Number.isInteger(position) && position < 1 ? position : steps > 1 ? clamp(position, 0, steps - 1) / (steps - 1) : 1;
  return SLIDER.p0 + clamp(frac, 0, 1) * (SLIDER.p1 - SLIDER.p0);
}

/** Gradient track with step dots and a white knob. */
export function slider(position: number, steps: number, o: { ultra?: boolean } = {}): string {
  const s = SLIDER;
  const kx = sliderX(position, steps);
  const r = s.track / 2;
  const top = s.y - r;
  let out =
    `<defs><linearGradient id="sl" gradientUnits="userSpaceOnUse" x1="${s.x0}" y1="0" x2="${s.x1}" y2="0">` +
    `<stop offset="0" stop-color="${o.ultra ? C.accentLight : C.sliderFrom}"/><stop offset="1" stop-color="${o.ultra ? C.accentDark : C.sliderTo}"/></linearGradient></defs>` +
    `<rect x="${s.x0}" y="${n(top)}" width="${s.x1 - s.x0}" height="${s.track}" rx="${n(r)}" fill="${C.track}"/>`;
  if (kx !== undefined) out += `<rect x="${s.x0}" y="${n(top)}" width="${n(kx - s.x0 + r)}" height="${s.track}" rx="${n(r)}" fill="url(#sl)"/>`;
  const count = Math.max(steps, 1);
  for (let i = 0; i < count; i++) {
    const cx = count > 1 ? s.p0 + (i * (s.p1 - s.p0)) / (count - 1) : s.p1;
    if (kx !== undefined && Math.abs(cx - kx) < s.knob) continue; // under the knob
    const lit = kx !== undefined && cx < kx;
    out += `<circle cx="${n(cx)}" cy="${s.y}" r="${s.dot}" fill="${lit ? C.white : C.dot}"${lit ? ` fill-opacity="0.7"` : ""}/>`;
  }
  if (kx !== undefined) out += `<circle cx="${n(kx)}" cy="${s.y}" r="${s.knob}" fill="${C.white}"/>`;
  return out;
}

/** Brain + level name in accent + slider. Disabled (no effort setting / no chat): dimmed. */
export function effortKey(o: { label: string; position: number; steps: number; ultra?: boolean; disabled?: boolean }): string {
  return doc(
    bgRect(C.bg) +
      corner("effort", C.accent) +
      headline(o.label || "Effort", 83, 23, 17, C.accent, C.bg) +
      slider(o.disabled ? -1 : o.position, o.steps, { ultra: o.ultra }) +
      (o.disabled ? dimVeil() : ""),
  );
}

export type SpeedKeyState = "on" | "off" | "na" | "unavailable";

/** Lightning bolt: accent filled when Fast is on, white outline when off, dim when the model has no fast mode. */
export function speedKey(o: { state: SpeedKeyState }): string {
  if (o.state === "on") return heroKey("bolt", C.accent, { fill: true });
  return heroKey("bolt", C.white, { fill: false, dim: o.state !== "off" });
}

// ───────────────────────────────────────────────────────────────────────── keep awake

export type KeepAwakeKeyState = "on" | "off" | "na";

/** How far the steaming cup moves down under a time, so the steam (tops at y ≈ 35 when centred) clears the time row. */
const KEEP_AWAKE_TIME_DY = 7;

/**
 * KeepingYouAwake's coffee cup: accent filled with steam while the Mac is kept awake, white outline when off, dimmed
 * when KeepingYouAwake isn't installed. A timed session's time left ("12m") sits top-right, like Activity's time, with
 * the cup moved down below it (steam tops ≈ 9 px under the baseline even for "4h 59m").
 */
export function keepAwakeKey(o: { state: KeepAwakeKeyState; remaining?: string }): string {
  if (o.state !== "on") return heroKey("cup", C.white, { fill: false, dim: o.state === "na" });
  if (!o.remaining) return doc(bgRect(C.bg) + hero("cup", C.accent, { fill: true }));
  const { size, right, baseline } = L.time;
  return doc(bgRect(C.bg) + hero("cup", C.accent, { fill: true, dy: KEEP_AWAKE_TIME_DY }) + text(right, baseline, o.remaining, { size, fill: C.grey, anchor: "end" }));
}

// ───────────────────────────────────────────────────────────────────────── usage

const USAGE_LABEL: Record<Usage["kind"], string> = { weekly: "Weekly", "5-hour": "5-hour", context: "Context", none: "Usage" };

/** Label, big percentage, two grey lines, vertical bar on the right (grey track, white fill from the bottom). */
export function usageKey(u: Usage): string {
  const bar = { x: 118, w: 8, top: 16, bottom: 128 };
  const textW = bar.x - 6 - L.pad;
  const pct = typeof u.percent === "number" && Number.isFinite(u.percent) ? u.percent : undefined;
  const line = (s: string | undefined, y: number, size: number, fill: string): string =>
    s ? text(L.pad, y, fitPrefix(s, size, textW), { size, fill }) : "";

  let out = bgRect(C.bg);
  out += line(USAGE_LABEL[u.kind] ?? "Usage", 33, 17, C.white);
  let big = 30;
  const pctText = pct === undefined ? "—" : `${Math.round(pct)}%`;
  while (big > 22 && textWidth(pctText, big) > textW) big -= 1;
  out += text(L.pad, 72, pctText, { size: big, fill: C.white });
  out += line(u.line1 ?? (pct === undefined ? "No data" : undefined), 101, 17, C.grey);
  out += line(u.line2, 123, 17, C.grey);

  const h = bar.bottom - bar.top;
  out += `<rect x="${bar.x}" y="${bar.top}" width="${bar.w}" height="${h}" rx="${bar.w / 2}" fill="${C.track}"/>`;
  if (pct !== undefined && pct > 0) {
    const fh = Math.max(bar.w, (clamp(pct, 0, 100) / 100) * h);
    out += `<rect x="${bar.x}" y="${n(bar.bottom - fh)}" width="${bar.w}" height="${n(fh)}" rx="${bar.w / 2}" fill="${C.white}"/>`;
  }
  return doc(out);
}

// ───────────────────────────────────────────────────────────────────────── panels

export type PanelId = "review" | "terminal" | "browser" | "files" | "sideChat";

export const PANEL_ICON: Record<PanelId, IconName> = {
  review: "panel-review",
  terminal: "panel-terminal",
  browser: "panel-browser",
  files: "panel-files",
  sideChat: "panel-side-chat",
};

export const panelKey = (panelId: PanelId | string): string => heroKey(PANEL_ICON[panelId as PanelId] ?? "panel-bottom");

// ───────────────────────────────────────────────────────────────────────── badges

/**
 * Overlay a small ⚠ (top-right) on a key image, e.g. while Accessibility permission is missing. The corner is first
 * painted in the key's background colour so the badge never sits on top of a time or diff.
 */
export function withBadge(keySvg: string, kind: "access"): string {
  if (kind !== "access") return keySvg;
  const at = keySvg.lastIndexOf("</svg>");
  if (at < 0) return keySvg;
  const bg = /<rect x="0" y="0" width="144" height="144" fill="(#[0-9A-Fa-f]{6})"/.exec(keySvg)?.[1] ?? C.bg;
  const badge = `<rect x="96" y="6" width="40" height="34" fill="${bg}"/>` + icon("warning", { x: 110, y: 6, size: 28, color: C.warn, knockout: bg === C.bg ? C.bg : "#000000" });
  return keySvg.slice(0, at) + badge + keySvg.slice(at);
}
