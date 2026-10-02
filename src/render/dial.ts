// Touch-strip images for Stream Deck + dials (one 200 × 100 SVG per dial), in the visual language of Elgato's
// ChatGPT & Codex plugin (DESIGN.md "Dials"). Layout measured from the Codex marketplace screenshots, where the strip
// is drawn at ~0.965 screen px per canvas px:
//   lists      3 rows, baselines 27 / 55 / 83, 16.5 px semibold; the row under the cursor white, the others grey
//              Activity: text x = 10, status icon (✓ / clock, 22 px box) at the right end, dimmed on grey rows
//              Run Skill: cube icon (20 px box) at x = 11, text x = 37
//   Power      "Opus 5.5" white + effort in accent at baseline 27, filled bolt top-right, 20 px gradient track
//              (centre y 49) with step dots and a white knob (r 12.4), "Faster" / "Smarter" grey at baseline 83
//   Usage      label 16 px at baseline 27, percentage 31 px at baseline 63, grey lines right-aligned at x = 188
//              (baselines 27 / 47), 8 px bar from x = 10 to 188 at y = 80
// Text is clipped like the keys: faded out before the edge (or before the icon), never ellipsised.
// Pure module (no @elgato/streamdeck import) so it can be unit-tested with plain node.

import type { Chat, ChatStatus, Usage } from "../types.ts";
import { type IconName, icon } from "./icons.ts";
import { STATUS_STYLE } from "./keys.ts";
import { C, FADE_ID, bgRect, clamp, dimVeil, fadeDefs, fitPrefix, n, squash, svg, text, textWidth } from "./kit.ts";

/** Touch-strip canvas of one dial (px), per the layout schema: "Stream Deck +, 200 x 100 px". */
export const DIAL_W = 200;
export const DIAL_H = 100;

/** Rows a list dial shows at once. */
export const DIAL_ROWS = 3;

export const D = {
  /** Left text edge and right content edge. */
  left: 10,
  right: 188,
  rows: { baselines: [27, 55, 83] as const, size: 16.5 },
  /** Activity status icon: box size, centre x; centred 5 px above the row's baseline. */
  status: { box: 22, cx: 177.5, stroke: 1.7, clipIcon: 163, clipText: 186 },
  /** Run Skill cube icon box and text start. */
  skill: { x: 11, box: 20, stroke: 1.6, textX: 37, clip: 190 },
  power: {
    titleSize: 16.5,
    titleY: 27,
    titleClip: 164,
    bolt: { x: 168.3, y: 11.2, size: 22 },
    track: { y: 49.2, h: 20 },
    /** Knob centre range (first / last step). */
    p0: 20.7,
    p1: 179.3,
    knob: 12.4,
    dot: 1.6,
    labelSize: 15,
    labelY: 83,
  },
  usage: { labelSize: 16, labelY: 27, pctSize: 31, pctY: 63, lineSize: 15.5, lineY: [27, 47] as const, bar: { y: 80, h: 8 } },
} as const;

const doc = (body: string): string => svg(DIAL_W, DIAL_H, body);

// ───────────────────────────────────────────────────────────────────────── shared helpers (also used by neo.ts)

/** `data:image/svg+xml;base64,…`: the form the layout schema documents for pixmap feedback values. */
export function feedbackUri(svgText: string): string {
  // Buffer encodes lone surrogates as U+FFFD instead of throwing.
  return `data:image/svg+xml;base64,${Buffer.from(svgText, "utf8").toString("base64")}`;
}

/** Linear blend of two #RRGGBB colours (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{6})$/i.exec(a)?.[1];
  const pb = /^#([0-9a-f]{6})$/i.exec(b)?.[1];
  if (!pa || !pb) return a;
  let out = "#";
  for (let i = 0; i < 3; i++) {
    const va = Number.parseInt(pa.slice(i * 2, i * 2 + 2), 16);
    const vb = Number.parseInt(pb.slice(i * 2, i * 2 + 2), 16);
    out += Math.round(va + (vb - va) * clamp(t, 0, 1))
      .toString(16)
      .padStart(2, "0");
  }
  return out.toUpperCase();
}

/** Colour of icons on grey (not current) rows: the status colour, greyed and dimmed like the row's text. */
export const dimmed = (color: string): string => mix(mix(color, C.grey, 0.4), C.bg, 0.35);

export interface LineOpts {
  size: number;
  fill?: string;
  /** Text is fully hidden from here on; the fade runs over the `fade` px before it. */
  clipX: number;
  fade?: number;
  /** Background colour (for the fade / cover). */
  bg?: string;
  /** Canvas width (the cover runs to its edge). */
  width: number;
}

/**
 * One line of left-aligned text, clipped like the keys: when it runs past `clipX` a fade in the background colour
 * hides the last few pixels and a solid strip the rest. The caller adds `fadeDefs(bg)` once when `overflow` is true.
 */
export function clippedLine(x: number, y: number, content: string, o: LineOpts): { svg: string; overflow: boolean } {
  const fade = o.fade ?? 14;
  const shown = fitPrefix(squash(content), o.size, Math.max(0, o.clipX - x) + 3 * o.size);
  let out = text(x, y, shown, { size: o.size, fill: o.fill });
  const overflow = x + textWidth(shown, o.size) > o.clipX - 2;
  if (overflow) {
    const top = y - o.size * 0.95;
    const h = o.size * 1.25;
    out +=
      `<rect x="${n(o.clipX - fade)}" y="${n(top)}" width="${n(fade)}" height="${n(h)}" fill="url(#${FADE_ID})"/>` +
      `<rect x="${n(o.clipX)}" y="${n(top)}" width="${n(o.width + 8 - o.clipX)}" height="${n(h)}" fill="${o.bg ?? C.bg}"/>`;
  }
  return { svg: out, overflow };
}

/** Collects clipped lines and adds the fade gradient once when any of them overflowed. */
export class Lines {
  private body = "";
  private fades = false;
  private readonly width: number;
  private readonly bg: string;

  constructor(width: number, bg: string = C.bg) {
    this.width = width;
    this.bg = bg;
  }

  add(x: number, y: number, content: string, o: Omit<LineOpts, "width" | "bg">): void {
    const r = clippedLine(x, y, content, { ...o, width: this.width, bg: this.bg });
    this.body += r.svg;
    this.fades ||= r.overflow;
  }

  raw(s: string): void {
    this.body += s;
  }

  toString(): string {
    return (this.fades ? fadeDefs(this.bg) : "") + this.body;
  }
}

/** First visible row of a list of `count` items: the cursor stays on the top row until the list end is in view. */
export function listStart(cursor: number, count: number, rows = DIAL_ROWS): number {
  if (count <= rows) return 0;
  return clamp(Math.floor(cursor), 0, count - rows);
}

/** Status icon (✓ / clock) for a chat row; working and idle chats show none (as on the Codex dial). */
export function rowStatusIcon(status: ChatStatus): { icon: IconName; color: string } | undefined {
  if (status !== "done" && status !== "waiting") return undefined;
  const st = STATUS_STYLE[status];
  return { icon: st.icon, color: st.color };
}

/** Small ⚠ in the strip's top-right corner (macOS Accessibility missing), over a patch of the background. */
export function withDialBadge(dialSvg: string, w = DIAL_W): string {
  const at = dialSvg.lastIndexOf("</svg>");
  if (at < 0) return dialSvg;
  // The patch also hides the Power dial's bolt, which sits in the same corner.
  const badge = `<rect x="${n(w - 34)}" y="0" width="34" height="36" fill="${C.bg}"/>` + icon("warning", { x: w - 27, y: 5, size: 22, color: C.warn, knockout: C.bg });
  return dialSvg.slice(0, at) + badge + dialSvg.slice(at);
}

// ───────────────────────────────────────────────────────────────────────── Activity

/** Up to three chats; the one under the cursor in white, the others grey, ✓ / clock at the right end. */
export function activityDial(chats: readonly Chat[], cursor: number): string {
  const lines = new Lines(DIAL_W);
  lines.raw(bgRect(C.bg, DIAL_W, DIAL_H));
  const { size, baselines } = D.rows;
  if (!chats.length) {
    lines.add(D.left, baselines[0], "No chats yet", { size, fill: C.grey, clipX: D.status.clipText });
    return doc(lines.toString());
  }
  const cur = clamp(Math.floor(cursor), 0, chats.length - 1);
  const start = listStart(cur, chats.length);
  const icons: string[] = [];
  for (let row = 0; row < DIAL_ROWS && start + row < chats.length; row++) {
    const chat = chats[start + row]!;
    const y = baselines[row]!;
    const current = start + row === cur;
    const st = rowStatusIcon(chat.status);
    lines.add(D.left, y, chat.title || "New chat", { size, fill: current ? C.white : C.grey, clipX: st ? D.status.clipIcon : D.status.clipText });
    if (st) {
      const b = D.status.box;
      icons.push(icon(st.icon, { x: D.status.cx - b / 2, y: y - 5 - b / 2, size: b, color: current ? st.color : dimmed(st.color), strokeWidth: D.status.stroke }));
    }
  }
  lines.raw(icons.join("")); // after the text and its fade covers
  return doc(lines.toString());
}

// ───────────────────────────────────────────────────────────────────────── Run Skill

/** Skill names with a cube before each; the one under the cursor in white. */
export function runSkillDial(labels: readonly string[], cursor: number): string {
  const lines = new Lines(DIAL_W);
  lines.raw(bgRect(C.bg, DIAL_W, DIAL_H));
  const { size, baselines } = D.rows;
  const k = D.skill;
  if (!labels.length) {
    lines.raw(icon("skill", { x: k.x, y: baselines[0] - 5 - k.box / 2, size: k.box, color: C.grey, strokeWidth: k.stroke }));
    lines.add(k.textX, baselines[0], "No skills", { size, fill: C.grey, clipX: k.clip });
    return doc(lines.toString());
  }
  const cur = clamp(Math.floor(cursor), 0, labels.length - 1);
  const start = listStart(cur, labels.length);
  for (let row = 0; row < DIAL_ROWS && start + row < labels.length; row++) {
    const y = baselines[row]!;
    const color = start + row === cur ? C.white : C.grey;
    lines.raw(icon("skill", { x: k.x, y: y - 5 - k.box / 2, size: k.box, color, strokeWidth: k.stroke }));
    lines.add(k.textX, y, labels[start + row] || "Skill", { size, fill: color, clipX: k.clip });
  }
  return doc(lines.toString());
}

// ───────────────────────────────────────────────────────────────────────── Power

export interface PowerDialView {
  /** Model name ("Opus 5.5"). */
  model: string;
  /** Effort label in accent ("Extra", "Ultra"); omitted for models without an effort setting. */
  effort?: string;
  /** Knob step (0 … steps-1); -1 = unknown (no knob, track unfilled). */
  position: number;
  steps: number;
  /** Step the chat is on when the knob shows a pending (not yet applied) choice; -1 / omitted = none. */
  current?: number;
  /** Ultracode colours (lighter → darker accent), as on the Effort key. */
  ultra?: boolean;
  /** No chat / no models: dimmed. */
  disabled?: boolean;
}

/** x of step `i` of `steps` on the Power track. */
export function powerStepX(i: number, steps: number): number {
  const p = D.power;
  if (steps <= 1) return p.p1;
  return p.p0 + (clamp(i, 0, steps - 1) / (steps - 1)) * (p.p1 - p.p0);
}

/** "Opus 5.5 Extra" + bolt, gradient track with dots and a white knob, "Faster" / "Smarter". */
export function powerDial(v: PowerDialView): string {
  const p = D.power;
  const lines = new Lines(DIAL_W);
  lines.raw(bgRect(C.bg, DIAL_W, DIAL_H));

  // Title: model in white, effort in accent; shrinks a little before it clips (before the bolt).
  const model = squash(v.model) || "Model";
  const effort = v.effort ? squash(v.effort) : "";
  const width = (s: number) => textWidth(model, s) + (effort ? textWidth(` ${effort}`, s) : 0);
  let size: number = p.titleSize;
  while (size > 13 && D.left + width(size) > p.titleClip - 2) size -= 0.5;
  if (effort && D.left + textWidth(`${model} `, size) < p.titleClip - 16) {
    lines.raw(text(D.left, p.titleY, model, { size, fill: C.white }));
    lines.add(D.left + textWidth(`${model} `, size), p.titleY, effort, { size, fill: C.accent, clipX: p.titleClip });
  } else {
    lines.add(D.left, p.titleY, model, { size, fill: C.white, clipX: p.titleClip });
  }
  lines.raw(icon("bolt", { x: p.bolt.x, y: p.bolt.y, size: p.bolt.size, color: C.accent, fill: true }));

  // Track, gradient fill up to the knob, step dots, knob.
  const steps = Math.max(1, Math.floor(v.steps));
  const r = p.track.h / 2;
  const top = p.track.y - r;
  const x0 = p.p0 - r;
  const x1 = p.p1 + r;
  const known = Number.isFinite(v.position) && v.position >= 0;
  const kx = known ? powerStepX(v.position, steps) : undefined;
  let s =
    `<defs><linearGradient id="pw" gradientUnits="userSpaceOnUse" x1="${n(x0)}" y1="0" x2="${n(x1)}" y2="0">` +
    `<stop offset="0" stop-color="${v.ultra ? C.accentLight : C.sliderFrom}"/><stop offset="1" stop-color="${v.ultra ? C.accentDark : C.sliderTo}"/></linearGradient></defs>` +
    `<rect x="${n(x0)}" y="${n(top)}" width="${n(x1 - x0)}" height="${n(p.track.h)}" rx="${n(r)}" fill="${C.track}"/>`;
  if (kx !== undefined) s += `<rect x="${n(x0)}" y="${n(top)}" width="${n(kx + r - x0)}" height="${n(p.track.h)}" rx="${n(r)}" fill="url(#pw)"/>`;
  const current = v.current !== undefined && v.current >= 0 && v.current !== v.position ? Math.floor(v.current) : -1;
  for (let i = 0; i < steps; i++) {
    const cx = powerStepX(i, steps);
    if (kx !== undefined && Math.abs(cx - kx) < p.knob) continue; // under the knob
    if (i === current) {
      // Where the chat is now, while the knob shows a choice that isn't applied yet.
      s += `<circle cx="${n(cx)}" cy="${n(p.track.y)}" r="3.4" fill="${C.white}"/>`;
      continue;
    }
    const lit = kx !== undefined && cx < kx;
    s += `<circle cx="${n(cx)}" cy="${n(p.track.y)}" r="${n(p.dot)}" fill="${lit ? C.white : C.dot}"${lit ? ` fill-opacity="0.55"` : ""}/>`;
  }
  if (kx !== undefined) s += `<circle cx="${n(kx)}" cy="${n(p.track.y)}" r="${n(p.knob)}" fill="${C.white}"/>`;
  lines.raw(s);

  lines.raw(text(D.left, p.labelY, "Faster", { size: p.labelSize, fill: C.grey }));
  lines.raw(text(D.right, p.labelY, "Smarter", { size: p.labelSize, fill: C.grey, anchor: "end" }));
  if (v.disabled) lines.raw(dimVeil(DIAL_W, DIAL_H));
  return doc(lines.toString());
}

// ───────────────────────────────────────────────────────────────────────── Usage

export const USAGE_LABEL: Record<Usage["kind"], string> = { weekly: "Weekly", "5-hour": "5-hour", context: "Context", none: "Usage" };

/** Percentage text ("61%", "—"). */
export const usagePercent = (u: Usage): string =>
  typeof u.percent === "number" && Number.isFinite(u.percent) ? `${Math.round(u.percent)}%` : "—";

/** Detail lines; "No data" when there is nothing to show. */
export function usageLines(u: Usage): string[] {
  const out = [u.line1, u.line2].map((s) => squash(s ?? "")).filter(Boolean);
  if (!out.length && usagePercent(u) === "—") out.push("No data");
  return out;
}

/** A grey line right-aligned at `right`; when it doesn't fit after `minX` it starts there and fades at the edge. */
function rightLine(lines: Lines, content: string, y: number, size: number, minX: number, right: number): void {
  const w = textWidth(content, size);
  if (minX + w <= right) lines.raw(text(right, y, content, { size, fill: C.grey, anchor: "end" }));
  else lines.add(minX, y, content, { size, fill: C.grey, clipX: right + 2, fade: 12 });
}

/** "Weekly" / "61%" left, detail lines right-aligned, horizontal bar along the bottom. */
export function usageDial(u: Usage): string {
  const g = D.usage;
  const lines = new Lines(DIAL_W);
  lines.raw(bgRect(C.bg, DIAL_W, DIAL_H));
  const label = USAGE_LABEL[u.kind] ?? "Usage";
  lines.raw(text(D.left, g.labelY, label, { size: g.labelSize, fill: C.white }));
  const pct = usagePercent(u);
  let big: number = g.pctSize;
  while (big > 24 && textWidth(pct, big) > 90) big -= 1;
  lines.raw(text(D.left, g.pctY, pct, { size: big, fill: C.white }));

  const detail = usageLines(u);
  const gap = 14;
  if (detail[0]) rightLine(lines, detail[0], g.lineY[0], g.lineSize, D.left + textWidth(label, g.labelSize) + gap, D.right);
  if (detail[1]) rightLine(lines, detail[1], g.lineY[1], g.lineSize, D.left + textWidth(pct, big) + gap, D.right);

  const { y, h } = g.bar;
  const w = D.right - D.left;
  lines.raw(`<rect x="${D.left}" y="${y}" width="${n(w)}" height="${h}" rx="${n(h / 2)}" fill="${C.track}"/>`);
  if (typeof u.percent === "number" && Number.isFinite(u.percent) && u.percent > 0) {
    const fw = Math.max(h, (clamp(u.percent, 0, 100) / 100) * w);
    lines.raw(`<rect x="${D.left}" y="${y}" width="${n(fw)}" height="${h}" rx="${n(h / 2)}" fill="${C.white}"/>`);
  }
  return doc(lines.toString());
}
