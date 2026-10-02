// Per-key settings (exact keys the Property Inspectors bind to). Pure types + normalisers: no Stream Deck import,
// so tests and the PI handler can use them.
//
// All fields are optional on the wire (a freshly dropped key has `{}`); the normalisers below give the defaults.

import { PANELS } from "../catalog.ts";
import { DEFAULT_MODEL_SLOTS } from "../claude/catalog.ts";

/** Activity: which chat the key follows. 1..12 = the n-th most recent chat; 0 / missing = auto (key order on the device). */
export type ActivitySettings = { position?: number };
export type NewChatSettings = { folder?: string; prompt?: string };
export type SendPromptSettings = { prompt?: string };
export type SteerSettings = { text?: string };
export type RunSkillSettings = { skill?: string; args?: string };
/**
 * Model: the ordered model slots a press cycles through (`modelSlots`).
 *   • slot1 … slot4  what the PI binds (one dropdown each; "none" = empty slot). A slot the PI never saved means its
 *                    default (DEFAULT_MODEL_SLOTS, padded with "none") — exactly what the PI shows for it.
 *   • slots          the resulting list as an array of model ids. The PI keeps it in sync (ui/pi.js data-array-of);
 *                    it is what a key without slotN uses (profiles, settings written elsewhere).
 *   • mode "fixed" + model   one model: a press always picks it (keys set up that way before slots existed).
 */
export type ModelSettings = {
  mode?: "next" | "fixed";
  model?: string;
  slots?: string[];
  slot1?: string;
  slot2?: string;
  slot3?: string;
  slot4?: string;
};
/**
 * Effort: "next" steps through `cycle` (comma list of levels, e.g. "low, high, ultracode"; empty = every level incl.
 * Ultracode); "fixed" picks `level`.
 */
export type EffortSettings = { mode?: "next" | "fixed"; level?: string; cycle?: string };
export type SpeedSettings = Record<string, never>;
export type UsageView = "auto" | "weekly" | "5-hour" | "context";
export type UsageSettings = { view?: UsageView };
export type PanelId = (typeof PANELS)[number]["id"];
export type TogglePanelSettings = { panel?: PanelId };
export type DictateSettings = Record<string, never>;
export type StopSettings = Record<string, never>;
/** Power (dial only): settings are defined by the dial implementation. */
export type PowerSettings = Record<string, string | number | boolean | undefined>;
export type KeepAwakeMode = "toggle" | "on" | "off";
/**
 * Keep Awake: what a press does (`mode`, default "toggle") and how long "on" lasts (`duration`: seconds as a string,
 * "0" / missing = indefinitely — the PI offers KeepingYouAwake's own menu durations, KEEP_AWAKE_DURATIONS).
 */
export type KeepAwakeSettings = { mode?: KeepAwakeMode; duration?: string };

export const USAGE_VIEWS: readonly UsageView[] = ["auto", "weekly", "5-hour", "context"];
export const KEEP_AWAKE_MODES: readonly KeepAwakeMode[] = ["toggle", "on", "off"];
/** The Keep Awake PI's durations (KeepingYouAwake's menu: 5, 10, 15, 30 min, 1, 2, 5 h), "0" = indefinitely. */
export const KEEP_AWAKE_DURATIONS: readonly string[] = ["0", "300", "600", "900", "1800", "3600", "7200", "18000"];

export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 0 = auto, else a positive integer position (1 = most recent chat). */
export function activityPosition(s: ActivitySettings | undefined): number {
  const p = Number(s?.position ?? 0);
  return Number.isFinite(p) && p >= 1 ? Math.floor(p) : 0;
}

export function usageView(s: UsageSettings | undefined): UsageView {
  return USAGE_VIEWS.includes(s?.view as UsageView) ? (s!.view as UsageView) : "auto";
}

export function panelId(s: TogglePanelSettings | undefined): PanelId {
  return PANELS.some((p) => p.id === s?.panel) ? s!.panel! : "review";
}

export const isFixed = (s: { mode?: string } | undefined): boolean => s?.mode === "fixed";

export function keepAwakeMode(s: KeepAwakeSettings | undefined): KeepAwakeMode {
  return KEEP_AWAKE_MODES.includes(s?.mode as KeepAwakeMode) ? s!.mode! : "toggle";
}

/** Seconds a Keep Awake press turns it on for; 0 = indefinitely (also for junk, negatives and fractions of a second). */
export function keepAwakeSeconds(s: KeepAwakeSettings | undefined): number {
  const raw: unknown = s?.duration;
  const v = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : 0;
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 0;
}

// ── Model slots ─────────────────────────────────────────────────────────────────────────────────────────

/** Default slots: Fable 5.1, then Opus 5.5 (the catalog's DEFAULT_MODEL_SLOTS, which ops.ts uses too; the Model PI
 *  shows the same defaults — scripts/check-pi.ts checks that). */
export { DEFAULT_MODEL_SLOTS };
/** Slots on the Model PI. */
export const MODEL_SLOT_COUNT = 4;
/** Value of an empty slot in the PI's dropdowns (sdpi-select can't show "" over a non-empty default). */
export const NO_MODEL = "none";

/** What the PI shows for slot n (1-based) before it was ever saved. */
export const slotDefault = (n: number): string => DEFAULT_MODEL_SLOTS[n - 1] ?? NO_MODEL;

function cleanSlots(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const v of list) {
    const id = str(v);
    if (id && id !== NO_MODEL && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The model ids a Model key cycles through, in order: the PI's slot1…slot4 when any is set (unsaved ones = their
 * default), else a `slots` array, else the defaults. Empty / "none" slots and repeats are dropped; a list that ends
 * up empty means the defaults (a key always has something to pick).
 */
export function modelSlots(s: ModelSettings | undefined): string[] {
  const picked: unknown[] = [s?.slot1, s?.slot2, s?.slot3, s?.slot4];
  let list: string[] = [];
  const array: unknown = s?.slots;
  // A slot the PI never saved (or saved empty) shows its default in the PI's dropdown, so it means its default here.
  if (picked.some((v) => typeof v === "string")) list = cleanSlots(picked.map((v, i) => (str(v) ? v : slotDefault(i + 1))));
  else if (Array.isArray(array)) list = cleanSlots(array);
  return list.length ? list : [...DEFAULT_MODEL_SLOTS];
}

/**
 * What a Model key press does: "next" through its slots, or — for a key set to one model ("fixed" + model, also the
 * pre-slots settings) — that model, shown as a single slot.
 */
export function modelPlan(s: ModelSettings | undefined): { target: string; slots: string[] } {
  const fixed = isFixed(s) ? str(s?.model) : "";
  if (fixed) return { target: fixed, slots: [fixed] };
  return { target: "next", slots: modelSlots(s) };
}
