// Stream Deck Neo infobar images (232 × 50 SVG), in the visual language of Elgato's ChatGPT & Codex plugin
// (DESIGN.md "Neo infobar"). Layout measured from the Codex marketplace screenshots (~1.29 screen px per canvas px):
//   Activity  two rows, 14 px semibold at baselines 17.5 / 39, x = 10: the selected chat in white, the next one
//             grey; ✓ / clock (22 px box) at the right end (centre x 215), text faded before it
//   Usage     label 13.5 px white at baseline 18.6, detail line grey at baseline 38.8, percentage 24 px
//             right-aligned at x = 220 (baseline 27), 4 px bar from x = 157 to 221 at y = 37.5
// The infobar has no touch input for plugins (its two touch points switch pages), so these are display only.
// Pure module (no @elgato/streamdeck import) so it can be unit-tested with plain node.

import type { Chat, Usage } from "../types.ts";
import { Lines, USAGE_LABEL, dimmed, rowStatusIcon, usageLines, usagePercent } from "./dial.ts";
import { icon } from "./icons.ts";
import { C, bgRect, clamp, n, svg, text, textWidth } from "./kit.ts";

/** Neo infobar canvas (px), per the layout schema: "Stream Deck Neo, 232 x 50 px". */
export const NEO_W = 232;
export const NEO_H = 50;

export const NEO = {
  left: 10,
  rows: { size: 14, baselines: [17.5, 39] as const },
  status: { box: 22, cx: 215, stroke: 1.9, clipIcon: 199, clipText: 224 },
  usage: { labelSize: 13.5, labelY: 18.6, lineSize: 13.5, lineY: 38.8, lineClip: 150, pctSize: 24, pctRight: 220, pctY: 27, bar: { x0: 157, x1: 221, y: 37.5, h: 4 } },
} as const;

const doc = (body: string): string => svg(NEO_W, NEO_H, body);

/** The selected chat (white) and the next most recent one (grey), each with ✓ / clock when it has one. */
export function activityNeo(primary: Chat | undefined, secondary?: Chat): string {
  const lines = new Lines(NEO_W);
  lines.raw(bgRect(C.bg, NEO_W, NEO_H));
  const { size, baselines } = NEO.rows;
  const s = NEO.status;
  if (!primary) {
    lines.add(NEO.left, baselines[0], "No chats yet", { size, fill: C.grey, clipX: s.clipText, fade: 12 });
    return doc(lines.toString());
  }
  const icons: string[] = [];
  const rows: Array<[Chat, boolean]> = [[primary, true]];
  if (secondary) rows.push([secondary, false]);
  rows.forEach(([chat, current], i) => {
    const y = baselines[i]!;
    const st = rowStatusIcon(chat.status);
    lines.add(NEO.left, y, chat.title || "New chat", { size, fill: current ? C.white : C.grey, clipX: st ? s.clipIcon : s.clipText, fade: 12 });
    if (st) icons.push(icon(st.icon, { x: s.cx - s.box / 2, y: y - 4.5 - s.box / 2, size: s.box, color: current ? st.color : dimmed(st.color), strokeWidth: s.stroke }));
  });
  lines.raw(icons.join(""));
  return doc(lines.toString());
}

/** "Weekly" over the detail line on the left; the percentage over a short bar on the right. */
export function usageNeo(u: Usage): string {
  const g = NEO.usage;
  const lines = new Lines(NEO_W);
  lines.raw(bgRect(C.bg, NEO_W, NEO_H));
  lines.add(NEO.left, g.labelY, USAGE_LABEL[u.kind] ?? "Usage", { size: g.labelSize, fill: C.white, clipX: g.lineClip, fade: 12 });

  // Detail: both lines on one row ("Aug 28   3 resets"), clipped before the bar.
  const [a, b] = usageLines(u);
  if (a) lines.add(NEO.left, g.lineY, a, { size: g.lineSize, fill: C.grey, clipX: g.lineClip, fade: 12 });
  const bx = NEO.left + (a ? textWidth(a, g.lineSize) + 14 : 0);
  if (b && bx < g.lineClip - 16) lines.add(bx, g.lineY, b, { size: g.lineSize, fill: C.grey, clipX: g.lineClip, fade: 12 });

  lines.raw(text(g.pctRight, g.pctY, usagePercent(u), { size: g.pctSize, fill: C.white, anchor: "end" }));
  const { x0, x1, y, h } = g.bar;
  lines.raw(`<rect x="${x0}" y="${y}" width="${x1 - x0}" height="${h}" rx="${n(h / 2)}" fill="${C.track}"/>`);
  if (typeof u.percent === "number" && Number.isFinite(u.percent) && u.percent > 0) {
    const fw = Math.max(h, (clamp(u.percent, 0, 100) / 100) * (x1 - x0));
    lines.raw(`<rect x="${x0}" y="${y}" width="${n(fw)}" height="${h}" rx="${n(h / 2)}" fill="${C.white}"/>`);
  }
  return doc(lines.toString());
}
