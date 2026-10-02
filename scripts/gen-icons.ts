// Generates the static images referenced by the manifest, from the same renderers the plugin uses at runtime:
//   imgs/actions/<icon>.svg          20×20 white-on-transparent action-list icons (one per icon used in src/catalog.ts)
//   imgs/keys/<actionId>.svg         144×144 default key image per action (key renderers with sample content)
//   imgs/dials/<actionId>.svg        72×72 white icon for every action with an Encoder controller
//   imgs/plugin/category-icon.svg    28×28 white spark
//   imgs/plugin/marketplace.png      256×256 black rounded square with a coral spark (+ marketplace@2x.png 512×512)
// Run with plain `node scripts/gen-icons.ts`. The PNGs are rasterised here (anti-aliased polygon fill) and written by
// the tiny pure-Node encoder in scripts/png.ts.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { ACTIONS, PLUGIN_UUID } from "../src/catalog.ts";
import { SPARK_ROUND, icon, isIconName, sparkPoints } from "../src/render/icons.ts";
import {
  activityKey,
  dictateKey,
  effortKey,
  heroKey,
  modelKey,
  newChatKey,
  panelKey,
  runSkillKey,
  sendPromptKey,
  speedKey,
  steerKey,
  stopKey,
  usageKey,
} from "../src/render/keys.ts";
import { C, svg } from "../src/render/kit.ts";
import { encodePng } from "./png.ts";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const imgs = path.resolve(here, `../${PLUGIN_UUID}.sdPlugin/imgs`);

function write(rel: string, data: string | Uint8Array): void {
  const file = path.join(imgs, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? `${data}\n` : data);
}

const WHITE = "#FFFFFF";

// ───────────────────────────────────────────────────────────────────────── SVG images

/** Monochrome variants: the send arrow is outlined (no black knockout on a transparent icon). */
const mono = (name: string, size: number, stroke?: number): string => {
  if (!isIconName(name)) throw new Error(`unknown icon "${name}" in src/catalog.ts`);
  const pad = size / 6;
  return svg(size, size, icon(name, { x: pad, y: pad, size: size - 2 * pad, color: WHITE, strokeWidth: stroke, fill: name === "send" ? false : undefined }));
};

const actionIcon = (name: string): string => {
  if (!isIconName(name)) throw new Error(`unknown icon "${name}" in src/catalog.ts`);
  return svg(20, 20, icon(name, { x: 0, y: 0, size: 20, color: WHITE, fill: name === "send" ? false : undefined }));
};

const now = Date.now();
const SAMPLE_KEYS: Record<string, () => string> = {
  activity: () =>
    activityKey({ id: "sample", title: "Refactor feature and review our recent changes", status: "working", lastActivityAt: now - 60_000, lastFocusedAt: now, live: true }, { now }),
  "new-chat": () => newChatKey(),
  dictate: () => dictateKey(),
  "send-prompt": () => sendPromptKey("Review my changes and suggest improvements"),
  steer: () => steerKey("Focus on the settings panel first"),
  "run-skill": () => runSkillKey("Review Changes"),
  stop: () => stopKey({ enabled: true }),
  model: () => modelKey({ name: "Opus 5.5", index: 0, count: 4 }),
  effort: () => effortKey({ label: "Extra", position: 3, steps: 5 }),
  speed: () => speedKey({ state: "on" }),
  usage: () => usageKey({ kind: "context", percent: 42, line1: "420k / 1M" }),
  "toggle-panel": () => panelKey("review"),
  power: () => heroKey("bolt", C.accent, { fill: true }),
};

const iconNames = [...new Set(ACTIONS.map((a) => a.icon))];
for (const name of iconNames) write(`actions/${name}.svg`, actionIcon(name));

for (const a of ACTIONS) {
  const sample = SAMPLE_KEYS[a.id] ?? (() => heroKey(isIconName(a.icon) ? a.icon : "spark"));
  write(`keys/${a.id}.svg`, sample());
  if (a.controllers.includes("Encoder")) write(`dials/${a.id}.svg`, mono(a.icon, 72, 4));
}

write("plugin/category-icon.svg", svg(28, 28, icon("spark", { x: 0, y: 0, size: 28, color: WHITE })));

// ───────────────────────────────────────────────────────────────────────── marketplace icon raster

type Pt = [number, number];

function insidePolygon(x: number, y: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(x: number, y: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** Polygon grown by `grow` px (round joins), like an SVG fill + stroke of width 2 × grow. */
function insideRounded(x: number, y: number, pts: Pt[], grow: number): boolean {
  if (insidePolygon(x, y, pts)) return true;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) if (distToSegment(x, y, pts[j]!, pts[i]!) <= grow) return true;
  return false;
}

function insideRoundRect(x: number, y: number, size: number, r: number): boolean {
  const qx = Math.abs(x - size / 2) - (size / 2 - r);
  const qy = Math.abs(y - size / 2) - (size / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= r;
}

const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Black rounded square, coral spark; 4×4 supersampling per pixel. */
function marketplaceIcon(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const box = size * 0.66; // spark icon box (24-unit grid)
  const k = box / 24;
  const pts = sparkPoints(size / 2, size / 2, 11 * k);
  const grow = (SPARK_ROUND / 2) * k;
  const radius = size * 0.225;
  const [sr, sg, sb] = hex(C.accent);
  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let sparkHits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = px + (sx + 0.5) / S;
          const y = py + (sy + 0.5) / S;
          if (!insideRoundRect(x, y, size, radius)) continue;
          bgHits++;
          if (insideRounded(x, y, pts, grow)) sparkHits++;
        }
      }
      const o = (py * size + px) * 4;
      if (!bgHits) continue;
      // Spark over black: colour scales with the share of covered samples; alpha = rounded-square coverage.
      const t = sparkHits / bgHits;
      rgba[o] = Math.round(sr * t);
      rgba[o + 1] = Math.round(sg * t);
      rgba[o + 2] = Math.round(sb * t);
      rgba[o + 3] = Math.round((255 * bgHits) / (S * S));
    }
  }
  return rgba;
}

write("plugin/marketplace.png", encodePng(256, 256, marketplaceIcon(256)));
write("plugin/marketplace@2x.png", encodePng(512, 512, marketplaceIcon(512)));

console.log(
  `wrote imgs/actions (${iconNames.length}), imgs/keys (${ACTIONS.length}), imgs/dials (${ACTIONS.filter((a) => a.controllers.includes("Encoder")).length}), category icon, marketplace PNGs`,
);
