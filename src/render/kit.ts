// Render kit: SVG primitives, colour tokens and text layout shared by every key / dial image.
// Pure module (no @elgato/streamdeck import) so it can be unit-tested with plain node.
//
// The Stream Deck SVG rasteriser is SVG-Tiny-ish, so images only use rect/circle/path/text/g/linearGradient with
// presentation attributes, explicit baselines and no CSS, filters, masks or clip paths. Text that runs past the
// right edge is "clipped" the way the ChatGPT & Codex keys do it: a gradient overlay in the tile colour fades the
// last few pixels out and a solid strip hides the rest.

/** Key canvas (px). */
export const SIZE = 144;

/** System UI font, bold/semibold (DESIGN.md); Segoe UI on Windows. Unquoted names: some rasterisers take the attribute
 *  verbatim. */
export const FONT = "-apple-system, system-ui, SF Pro Display, SF Pro Text, Segoe UI, Helvetica Neue, Helvetica, Arial, sans-serif";
export const WEIGHT = "600";

/** Colour tokens (DESIGN.md). */
export const C = {
  bg: "#000000",
  white: "#FFFFFF",
  /** Secondary text: times, usage detail lines. */
  grey: "#9B9B9F",
  /** Inactive step dots, idle icon. */
  greyDim: "#8E8E93",
  /** Slider / usage bar track. */
  track: "#2C2C2E",
  /** Inactive model step pills. */
  pill: "#2C2C2E",
  /** Dots on an unfilled slider track. */
  dot: "#636366",
  /** Empty Activity slot icon. */
  empty: "#48484A",
  accent: "#D97757",
  accentLight: "#E8A27F",
  accentDark: "#C15F3C",
  sliderFrom: "#F2C4A8",
  sliderTo: "#D97757",
  green: "#34C759",
  red: "#FF5B5B",
  orange: "#FF8A3D",
  warn: "#FFB224",
  tile: {
    working: "#2C2C2E",
    done: "#173B26",
    waiting: "#4A2618",
    idle: "#1C1C1E",
  },
} as const;

/** Disabled / not available: everything at 35 % opacity (drawn as a black veil over a black key). */
export const DIM_OPACITY = 0.35;

// ───────────────────────────────────────────────────────────────────────── XML / SVG

const XML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/** Escape text for XML content or attribute values; drops control characters XML 1.0 forbids. */
export function esc(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "").replace(/[&<>"']/g, (ch) => XML_ESC[ch]!);
}

/** Lone UTF-16 surrogates (half an emoji) make encodeURIComponent throw; replace them with U+FFFD. */
const wellFormed = (s: string): string => s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");

/** `data:image/svg+xml,…` form accepted by setImage / setFeedback. */
export const dataUri = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(wellFormed(svg))}`;

/** Number formatting for attributes: at most 2 decimals, no trailing zeros. */
export const n = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

/** A complete SVG document. */
export const svg = (width: number, height: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}">${body}</svg>`;

/** Full-canvas background rectangle. */
export const bgRect = (fill: string, w = SIZE, h = SIZE): string => `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" fill="${fill}"/>`;

/** Veil that makes everything under it look 35 % opaque (on a black key). */
export const dimVeil = (w = SIZE, h = SIZE): string =>
  `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" fill="#000000" fill-opacity="${n(1 - DIM_OPACITY)}"/>`;

export interface TextOpts {
  size: number;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  weight?: string;
  opacity?: number;
}

/** One line of text with an explicit baseline. */
export function text(x: number, y: number, content: string, o: TextOpts): string {
  const attrs = [`x="${n(x)}"`, `y="${n(y)}"`, `font-family="${FONT}"`, `font-size="${n(o.size)}"`, `font-weight="${o.weight ?? WEIGHT}"`, `fill="${o.fill ?? C.white}"`];
  if (o.anchor && o.anchor !== "start") attrs.push(`text-anchor="${o.anchor}"`);
  if (o.opacity !== undefined && o.opacity < 1) attrs.push(`fill-opacity="${n(o.opacity)}"`);
  return `<text ${attrs.join(" ")}>${esc(content)}</text>`;
}

// ───────────────────────────────────────────────────────────────────────── text metrics

// Advance widths of SF Pro Semibold (the weight keys use) for ASCII 32…126, in 1/1000 em (measured with AppKit).
// Helvetica Neue Bold, the usual fallback, is ~8 % wider: such text simply runs into the right-edge fade.
const ASCII_W = [
  200, 298, 436, 626, 631, 860, 690, 264, 360, 360, 431, 631, 231, 436, 231, 294, 638, 467, 589, 616, 632, 610, 639, 563, 631, 639, 231, 231, 631, 631,
  631, 517, 883, 671, 627, 703, 692, 565, 541, 719, 718, 250, 535, 634, 536, 850, 709, 745, 603, 745, 625, 617, 594, 703, 661, 950, 667, 646, 626, 360,
  294, 360, 631, 558, 500, 531, 581, 529, 580, 539, 337, 577, 568, 228, 227, 519, 228, 841, 558, 557, 577, 577, 343, 497, 335, 558, 512, 763, 506, 520,
  491, 360, 232, 360, 631,
];

/** Approximate advance of one character (em units). */
function charEm(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp >= 32 && cp <= 126) return ASCII_W[cp - 32]! / 1000;
  if (cp === 0x2026) return 0.85; // …
  if (cp === 0x2014) return 0.9; // —
  if (cp === 0x2013 || cp === 0x2212) return 0.55; // – −
  if (cp >= 0x2190 && cp <= 0x21ff) return 0.75; // arrows
  if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60)))
    return 1; // CJK / full width
  if (cp >= 0x1f000) return 1.2; // emoji
  if (cp < 0x0300) return 0.6; // Latin-1 / Latin Extended
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining marks
  return 0.65;
}

/** Approximate rendered width of `s` at font size `size` (px). */
export function textWidth(s: string, size: number): number {
  let em = 0;
  for (const ch of s) em += charEm(ch);
  return em * size;
}

/** Longest prefix of `s` (whole code points) whose width is ≤ `max`. */
export function fitPrefix(s: string, size: number, max: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    w += charEm(ch) * size;
    if (w > max) break;
    out += ch;
  }
  return out;
}

/** Collapse whitespace (newlines included) into single spaces. */
export const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** "review-changes" / "/review_changes" → "Review Changes" (only first letters change). */
export const titleCase = (s: string): string =>
  squash(s.replace(/^\/+/, "").replace(/[-_]+/g, " ")).replace(/(^|\s)(\p{Ll})/gu, (_m, sp: string, c: string) => sp + c.toUpperCase());

/**
 * Word wrap for left-aligned key text: greedy fill of lines 1 … maxLines-1 (over-long words are split where they
 * stop fitting), then the last line takes everything that is left — it is clipped at the key edge, not ellipsised,
 * like the ChatGPT & Codex keys. The last line is shortened to what can possibly be visible (keeps SVGs small).
 */
export function wrapLines(input: string, size: number, width: number, maxLines: number): string[] {
  const s = squash(input);
  if (!s || maxLines < 1) return [];
  const lines: string[] = [];
  let rest = s;
  while (lines.length < maxLines - 1 && rest) {
    if (textWidth(rest, size) <= width) {
      lines.push(rest);
      rest = "";
      break;
    }
    const words = rest.split(" ");
    let line = "";
    let used = 0;
    for (const w of words) {
      const cand = line ? `${line} ${w}` : w;
      if (textWidth(cand, size) > width) break;
      line = cand;
      used++;
    }
    if (!used) {
      // First word alone is too wide: break it inside (after a separator when there is one).
      const head = fitPrefix(words[0]!, size, width) || [...words[0]!][0]!;
      const sep = Math.max(head.lastIndexOf("-"), head.lastIndexOf("/"), head.lastIndexOf("_"), head.lastIndexOf("."));
      line = sep > 0 && sep < head.length - 1 ? head.slice(0, sep + 1) : head;
      rest = rest.slice(line.length).trimStart();
    } else {
      rest = words.slice(used).join(" ");
    }
    lines.push(line);
  }
  if (rest) lines.push(fitPrefix(rest, size, width + 3 * size));
  return lines;
}

// ───────────────────────────────────────────────────────────────────────── clipped text blocks

/** Id of the fade gradient a key defines with `fadeDefs()`. */
export const FADE_ID = "fd";

/** Gradient (transparent → tile colour, left to right) used to fade clipped text out. */
export const fadeDefs = (bg: string): string =>
  `<defs><linearGradient id="${FADE_ID}" x1="0" y1="0" x2="1" y2="0">` +
  `<stop offset="0" stop-color="${bg}" stop-opacity="0"/><stop offset="1" stop-color="${bg}" stop-opacity="1"/></linearGradient></defs>`;

export interface BlockOpts {
  x?: number;
  /** Baseline of the first line. */
  y: number;
  size: number;
  lineHeight: number;
  /** Right edge where text is fully hidden (the fade runs over the `fade` px before it). */
  clipX?: number;
  fade?: number;
  fill?: string;
  /** Tile colour, for the fade overlay. */
  bg: string;
}

/**
 * Lines of left-aligned text; a line that is wider than the space before `clipX` gets the fade + cover overlay.
 * Returns the SVG; the caller must include `fadeDefs(bg)` once when `overflow` is true.
 */
export function textBlock(lines: string[], o: BlockOpts): { svg: string; overflow: boolean } {
  const x = o.x ?? 16;
  const clipX = o.clipX ?? 131;
  const fade = o.fade ?? 16;
  let out = "";
  let overflow = false;
  lines.forEach((line, i) => {
    const y = o.y + i * o.lineHeight;
    out += text(x, y, line, { size: o.size, fill: o.fill });
    if (x + textWidth(line, o.size) > clipX - 2) {
      overflow = true;
      const top = y - o.size * 0.95;
      const h = o.size * 1.25;
      out +=
        `<rect x="${n(clipX - fade)}" y="${n(top)}" width="${n(fade)}" height="${n(h)}" fill="url(#${FADE_ID})"/>` +
        `<rect x="${n(clipX)}" y="${n(top)}" width="${n(SIZE + 64 - clipX)}" height="${n(h)}" fill="${o.bg}"/>`;
    }
  });
  return { svg: out, overflow };
}

// ───────────────────────────────────────────────────────────────────────── time

/** Compact elapsed time: "now", "1m", "2h", "3d". */
export function relTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Compact time left, counting down (rounded up, so a fresh 30-minute session reads "30m"): "45s", "12m", "1h 5m", "2h". */
export function countdown(ms: number): string {
  const s = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Clamp to [lo, hi] (NaN → lo). */
export const clamp = (v: number, lo: number, hi: number): number => (Number.isNaN(v) ? lo : Math.min(hi, Math.max(lo, v)));
