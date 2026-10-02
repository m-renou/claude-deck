// Outline icons (Lucide-like: 24-unit grid, round caps and joins), hand-drawn for this plugin.
// icon(name, { x, y, size, color, strokeWidth }) returns an SVG <g> that draws the icon in the size × size box whose
// top-left corner is (x, y). strokeWidth is in output pixels (default: 2 grid units).
// Pure module (unit-tested with plain node).

import { n } from "./kit.ts";

export const ICON_NAMES = [
  "chat",
  "check",
  "clock",
  "compose",
  "mic",
  "send",
  "steer",
  "skill",
  "stop",
  "model",
  "effort",
  "bolt",
  "usage",
  "panel-bottom",
  "panel-side",
  "panel-review",
  "panel-terminal",
  "panel-browser",
  "panel-files",
  "panel-side-chat",
  "warning",
  "spark",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

export interface IconOpts {
  x: number;
  y: number;
  /** Box size in px (the icon is drawn on a 24-unit grid scaled to this box). */
  size: number;
  color: string;
  /** Stroke width in px; default 2 grid units. */
  strokeWidth?: number;
  /**
   * Solid variant where the icon has one: "send" and "stop" become a filled disc with the arrow / square cut out,
   * "bolt" and "spark" are filled. Default: send / stop / spark / warning filled, the rest outlined.
   */
  fill?: boolean;
  /** Colour of the parts drawn "cut out" of a solid shape that cannot use a hole (send's arrow, warning's "!"). */
  knockout?: string;
}

// ───────────────────────────────────────────────────────────────────────── geometry helpers

const p = (pts: Array<[number, number]>, close = true): string =>
  `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join("L")}${close ? "Z" : ""}`;

/** Full circle as a path (two arcs). */
const circlePath = (cx: number, cy: number, r: number): string =>
  `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`;

/** Rounded rectangle as a path. */
function roundRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const q = Math.min(r, w / 2, h / 2);
  return (
    `M${n(x + q)} ${n(y)}H${n(x + w - q)}A${n(q)} ${n(q)} 0 0 1 ${n(x + w)} ${n(y + q)}V${n(y + h - q)}` +
    `A${n(q)} ${n(q)} 0 0 1 ${n(x + w - q)} ${n(y + h)}H${n(x + q)}A${n(q)} ${n(q)} 0 0 1 ${n(x)} ${n(y + h - q)}` +
    `V${n(y + q)}A${n(q)} ${n(q)} 0 0 1 ${n(x + q)} ${n(y)}Z`
  );
}

/** Speech bubble: circle (cx, cy, r) with a short tail towards (tx, ty); the tail leaves the circle between angles a1 → a2 (deg). */
function bubblePath(cx: number, cy: number, r: number, a1: number, a2: number, tx: number, ty: number, sweep: 0 | 1): string {
  const pt = (a: number): [number, number] => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const [x1, y1] = pt(a1);
  const [x2, y2] = pt(a2);
  return `M${n(x1)} ${n(y1)}A${n(r)} ${n(r)} 0 1 ${sweep} ${n(x2)} ${n(y2)}L${n(tx)} ${n(ty)}Z`;
}

/** Pencil outline: capsule-ended body with a pointed tip at (tx, ty), pointing away along angle `deg` (0 = up, clockwise). */
function pencilPath(tx: number, ty: number, deg: number, length: number, half: number, cone: number): string {
  const a = (deg * Math.PI) / 180;
  const d: [number, number] = [Math.sin(a), -Math.cos(a)];
  const nn: [number, number] = [Math.cos(a), Math.sin(a)];
  const at = (along: number, side: number): [number, number] => [tx + d[0] * along + nn[0] * side, ty + d[1] * along + nn[1] * side];
  const b1 = at(cone, -half);
  const b2 = at(cone, half);
  const t1 = at(length - half, -half);
  const t2 = at(length - half, half);
  return (
    `M${n(tx)} ${n(ty)}L${n(b1[0])} ${n(b1[1])}L${n(t1[0])} ${n(t1[1])}` +
    `A${n(half)} ${n(half)} 0 0 1 ${n(t2[0])} ${n(t2[1])}L${n(b2[0])} ${n(b2[1])}Z`
  );
}

/**
 * The plugin mark: an 8-ray spark (Claude-style), as polygon points around (cx, cy) with outer radius r.
 * Rays alternate long / short and are slender; exported so the marketplace PNG rasteriser draws the same shape.
 */
export function sparkPoints(cx: number, cy: number, r: number): Array<[number, number]> {
  const rays = 8;
  const lengths = [1, 0.84, 0.97, 0.86, 1, 0.82, 0.95, 0.88];
  const inner = 0.2;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < rays; i++) {
    const a = ((i * 360) / rays - 90 + 6) * (Math.PI / 180);
    const b = (((i + 0.5) * 360) / rays - 90 + 6) * (Math.PI / 180);
    pts.push([cx + Math.cos(a) * r * lengths[i]!, cy + Math.sin(a) * r * lengths[i]!]);
    pts.push([cx + Math.cos(b) * r * inner, cy + Math.sin(b) * r * inner]);
  }
  return pts;
}

/** Rounded-join width (grid units) of the spark outline that softens its ray tips. */
export const SPARK_ROUND = 1.6;

// ───────────────────────────────────────────────────────────────────────── icon bodies (24-unit grid)

/** Hand-drawn left half of the brain; the right half is its mirror image. */
const BRAIN_HALF =
  "M12 5.2A2.9 2.9 0 0 0 6.7 4.6A3.1 3.1 0 0 0 4.4 9.1A3.3 3.3 0 0 0 4.2 14.9A3.4 3.4 0 0 0 7.2 19.4A2.9 2.9 0 0 0 12 19.6Z" +
  "M12 11.6C10.2 11.6 8.9 10.4 8.7 8.6" +
  "M4.4 9.1C5.2 9.6 6 9.7 6.8 9.6" +
  "M12 15.4C10.6 15.1 9.3 15.6 8.6 16.8" +
  "M4.2 14.9C5 14.3 5.9 14 6.9 14.2";

const BOLT: Array<[number, number]> = [
  [15.2, 2.2],
  [3.6, 13.9],
  [11, 13.9],
  [8.8, 21.8],
  [20.4, 10.1],
  [13, 10.1],
];

type Body = (o: { stroke: string; sw: number; fill: boolean; ko: string; color: string }) => string;

const stroked = (d: string, a: { stroke: string; sw: number }): string => `<path d="${d}" fill="none" stroke="${a.stroke}" stroke-width="${n(a.sw)}"/>`;

const BODIES: Record<IconName, Body> = {
  chat: (a) => stroked(bubblePath(12.4, 11.6, 9.1, 104, 166, 2.7, 21.3, 0), a),
  check: (a) => stroked("M3.5 12.6L9.1 18.2L20.5 5.8", a),
  clock: (a) => stroked(`${circlePath(12, 12, 9.6)}M12 6.6V12L15.6 14.1`, a),
  compose: (a) =>
    stroked(
      // Square open at the top (the pencil passes through the gap), pencil leaning right with its tip inside.
      "M8.6 7.5H6.5A3 3 0 0 0 3.5 10.5V18A3 3 0 0 0 6.5 21H17.5A3 3 0 0 0 20.5 18V10.5A3 3 0 0 0 18.3 7.6" +
        pencilPath(10.4, 16.6, 20, 15, 2, 4.2),
      a,
    ),
  mic: (a) => stroked(`${roundRectPath(9, 2.5, 6, 12, 3)}M18.6 10.6V11.6A6.6 6.6 0 0 1 5.4 11.6V10.6M12 18.2V21.5M8.6 21.5H15.4`, a),
  send: (a) =>
    a.fill
      ? `<path d="${circlePath(12, 12, 10.8)}" fill="${a.color}"/>` +
        `<path d="M12 17.3V7.2M7.6 11.5L12 7.1L16.4 11.5" fill="none" stroke="${a.ko}" stroke-width="${n(Math.min(a.sw, 1.7))}"/>`
      : stroked(`${circlePath(12, 12, 9.8)}M12 16.6V7.6M8.2 11.4L12 7.6L15.8 11.4`, a),
  steer: (a) => stroked("M5 4.2V10.6A4 4 0 0 0 9 14.6H19.2M15 10.4L19.2 14.6L15 18.8", a),
  skill: (a) =>
    stroked(
      // A tall cube split by a band: hexagon, top face, middle band and the front edge.
      `${p([
        [12, 2.4],
        [19.8, 6.7],
        [19.8, 17.3],
        [12, 21.6],
        [4.2, 17.3],
        [4.2, 6.7],
      ])}M4.2 6.7L12 11L19.8 6.7M4.2 12L12 16.3L19.8 12M12 11V21.6`,
      a,
    ),
  stop: (a) =>
    a.fill
      ? `<path d="${circlePath(12, 12, 11)}${roundRectPath(7.25, 7.25, 9.5, 9.5, 1.7)}" fill="${a.color}" fill-rule="evenodd"/>`
      : `${stroked(circlePath(12, 12, 9.8), a)}<path d="${roundRectPath(8.6, 8.6, 6.8, 6.8, 1.2)}" fill="${a.color}"/>`,
  model: (a) =>
    stroked(
      `${p([
        [12, 2.5],
        [20.4, 7.2],
        [20.4, 16.8],
        [12, 21.5],
        [3.6, 16.8],
        [3.6, 7.2],
      ])}M3.6 7.2L12 12L20.4 7.2M12 12V21.5`,
      a,
    ),
  effort: (a) => `${stroked(BRAIN_HALF, a)}<g transform="matrix(-1 0 0 1 24 0)">${stroked(BRAIN_HALF, a)}</g>`,
  bolt: (a) =>
    a.fill
      ? `<path d="${p(BOLT)}" fill="${a.color}" stroke="${a.color}" stroke-width="${n(Math.max(a.sw, 2.6))}"/>`
      : stroked(p(BOLT), a),
  usage: (a) => stroked("M3.9 17.2A8.6 8.6 0 1 1 20.1 17.2M12 14.4L16 9.6M12 14.4V14.4", a),
  "panel-bottom": (a) => stroked(`${roundRectPath(2.6, 4.2, 18.8, 15.6, 3.4)}M2.6 15H21.4`, a),
  "panel-side": (a) => stroked(`${roundRectPath(2.6, 4.2, 18.8, 15.6, 3.4)}M13.6 4.2V19.8`, a),
  "panel-review": (a) => stroked(`${roundRectPath(4.2, 3, 15.6, 18, 3)}M12 7V12M9.5 9.5H14.5M9.5 15.6H14.5`, a),
  "panel-terminal": (a) => stroked(`${roundRectPath(2.6, 4.2, 18.8, 15.6, 3.2)}M7 9.4L9.8 12L7 14.6M12.4 14.8H17`, a),
  "panel-browser": (a) => stroked(`${circlePath(12, 12, 9.6)}M12 2.4A14.2 14.2 0 0 0 12 21.6A14.2 14.2 0 0 0 12 2.4M2.4 12H21.6`, a),
  "panel-files": (a) =>
    stroked(
      "M2.8 10.2A1.8 1.8 0 0 1 4.6 8.4H7.6L9.4 10.2H15.4A1.8 1.8 0 0 1 17.2 12V18.4A1.8 1.8 0 0 1 15.4 20.2H4.6A1.8 1.8 0 0 1 2.8 18.4Z" +
        "M6.6 6.2V5.6A1.8 1.8 0 0 1 8.4 3.8H11.2L13 5.6H19.4A1.8 1.8 0 0 1 21.2 7.4V14.2A1.8 1.8 0 0 1 19.4 16",
      a,
    ),
  "panel-side-chat": (a) => stroked(`${bubblePath(11.6, 11.6, 9.1, 14, 76, 21.3, 21.3, 0)}M11.6 8.1V15.1M8.1 11.6H15.1`, a),
  warning: (a) =>
    `<path d="M12 3.2L22 20.4H2Z" fill="${a.color}" stroke="${a.color}" stroke-width="3"/>` +
    `<path d="M12 9.6V14.2" fill="none" stroke="${a.ko}" stroke-width="2.4"/>` +
    `<path d="${circlePath(12, 17.4, 1.3)}" fill="${a.ko}"/>`,
  spark: (a) =>
    a.fill
      ? `<path d="${p(sparkPoints(12, 12, 11))}" fill="${a.color}" stroke="${a.color}" stroke-width="${n(SPARK_ROUND)}"/>`
      : stroked(p(sparkPoints(12, 12, 10.5)), a),
};

const DEFAULT_FILL: Partial<Record<IconName, boolean>> = { send: true, stop: true, spark: true, warning: true };

/** SVG group drawing `name` in the box (x, y, size). */
export function icon(name: IconName, o: IconOpts): string {
  const k = o.size / 24;
  const sw = (o.strokeWidth ?? 2 * k) / k;
  const body = BODIES[name]({ stroke: o.color, sw, fill: o.fill ?? DEFAULT_FILL[name] ?? false, ko: o.knockout ?? "#000000", color: o.color });
  return `<g transform="translate(${n(o.x)} ${n(o.y)}) scale(${Math.round(k * 10000) / 10000})" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}

export const isIconName = (s: string): s is IconName => (ICON_NAMES as readonly string[]).includes(s);
