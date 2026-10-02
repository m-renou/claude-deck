// Dial (Stream Deck +) and Neo infobar drawing: every touch strip / infobar of this plugin uses a custom layout with
// one full-canvas pixmap ("canvas") that receives our SVG, so the whole surface is drawn like a key image.
//   layouts/<id>-dial.json  Encoder, 200 × 100 — also set in the manifest
//   layouts/<id>-neo.json   Neo, 232 × 50 — the manifest has no Neo layout field, so it is set at runtime

import type { JsonObject } from "@elgato/utils";
import { feedbackUri } from "../render/dial.ts";
import type { Inst } from "./base.ts";
import type { Log } from "./core.ts";

export const dialLayout = (actionId: string): string => `layouts/${actionId}-dial.json`;
export const neoLayout = (actionId: string): string => `layouts/${actionId}-neo.json`;

/**
 * Make sure the instance shows `layout` (once per instance: a dial dropped before the layout existed keeps its old
 * one, and a Neo infobar starts without ours). Switching layouts clears the strip, so the next canvas is always sent.
 */
export function ensureLayout<S extends JsonObject>(inst: Inst<S>, layout: string, log: Log): void {
  if (inst.state.layout === layout) return;
  const a = inst.action;
  if (!a.isDial() && !a.isNeoInfobar()) return;
  inst.state.layout = layout;
  inst.feedback = undefined;
  a.setFeedbackLayout(layout).catch((err: unknown) => {
    if (inst.state.layout === layout) inst.state.layout = undefined; // retry on the next render
    log.warn(`setFeedbackLayout(${layout}) failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** Feedback payload for the layouts' single pixmap item. */
export const canvasPayload = (svg: string): Record<string, unknown> => ({ canvas: feedbackUri(svg) });
