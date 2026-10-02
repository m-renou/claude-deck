// Pure view / cycling logic for the keys (no Stream Deck, hub or control imports — unit tested).

import { DEFAULT_EFFORT_CYCLE, EFFORT_LABEL, effortStopsFor, modelInfo, modelName } from "../claude/catalog.ts";
import { BUILTIN_SKILLS } from "../claude/extras.ts";
import type { Chat, ModelInfo, Usage } from "../types.ts";
import { str, USAGE_VIEWS, type UsageView } from "./settings.ts";

// ── Activity: which chat each key follows ───────────────────────────────────────────────────────────────

export interface PlacedKey {
  id: string;
  deviceId: string;
  row: number;
  column: number;
  /** 0 = auto, else the fixed position (1 = most recent chat). */
  position: number;
}

/**
 * Chat position (1-based, into the hub's newest-first chat list) for every Activity key.
 * Fixed keys keep their position. Auto keys take the remaining positions in key order on their device
 * (row by row, left to right), so three auto keys next to a key fixed on #1 follow chats #2, #3, #4.
 */
export function assignPositions(keys: PlacedKey[]): Map<string, number> {
  const out = new Map<string, number>();
  const byDevice = new Map<string, PlacedKey[]>();
  for (const k of keys) {
    if (k.position >= 1) out.set(k.id, Math.floor(k.position));
    const list = byDevice.get(k.deviceId) ?? [];
    list.push(k);
    byDevice.set(k.deviceId, list);
  }
  for (const list of byDevice.values()) {
    const taken = new Set(list.filter((k) => k.position >= 1).map((k) => Math.floor(k.position)));
    const auto = list.filter((k) => !(k.position >= 1)).sort((a, b) => a.row - b.row || a.column - b.column || a.id.localeCompare(b.id));
    let next = 1;
    for (const k of auto) {
      while (taken.has(next)) next++;
      out.set(k.id, next++);
    }
  }
  return out;
}

/** The chat shown at a 1-based position. */
export const chatAt = (chats: Chat[], position: number): Chat | undefined => (position >= 1 ? chats[position - 1] : undefined);

// ── Model ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ModelView {
  name: string;
  /** Index of the chat's model among the key's slots (one step dot each); -1 when it isn't one of them. */
  index: number;
  count: number;
}

/**
 * The Model key: the chat's model name and one step dot per slot, the current slot's dot highlighted. Without
 * `slots`, one dot per model in the app's menu.
 */
export function modelView(chat: Chat | undefined, models: ModelInfo[], slots?: readonly string[]): ModelView {
  const info = modelInfo(chat?.model, models);
  const ids = (slots ?? models.map((m) => m.id)).map((s) => modelInfo(s, models)?.id ?? s);
  const current = info?.id ?? chat?.model;
  return {
    name: modelName(chat?.model, models),
    index: current ? ids.indexOf(current) : -1,
    count: ids.length,
  };
}

// ── Effort ──────────────────────────────────────────────────────────────────────────────────────────────

// Every level an Effort key can step through, in slider order (Ultracode last), and a model's slider stops come
// from the catalog (DEFAULT_EFFORT_CYCLE, effortStopsFor) — the same ones ops.ts uses. An Effort key without a cycle of
// its own steps through all of DEFAULT_EFFORT_CYCLE.
export { DEFAULT_EFFORT_CYCLE };

export interface EffortView {
  label: string;
  /** Knob position on the slider (0 … steps-1); -1 when the chat's level isn't one of the key's stops. */
  position: number;
  steps: number;
  ultra: boolean;
  disabled: boolean;
}

const titleCase = (s: string): string => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export const effortLabel = (level: string): string => EFFORT_LABEL[level] ?? titleCase(level);

/**
 * The Effort key: the level name ("Extra", "Ultra" while Ultracode is on) and a slider over the key's stops — its
 * cycle (default: every level and Ultracode), limited to what the chat's model offers.
 */
export function effortView(chat: Chat | undefined, models: ModelInfo[], cycle: readonly string[] = DEFAULT_EFFORT_CYCLE): EffortView {
  const stops = effortStopsFor(modelInfo(chat?.model, models));
  const mine = cycle.filter((l) => stops.includes(l));
  const shown = mine.length ? mine : stops;
  const steps = Math.max(shown.length, 1);
  if (!chat || !stops.length) return { label: "Effort", position: -1, steps, ultra: false, disabled: true };
  if (chat.ultracode) return { label: effortLabel("ultracode"), position: shown.indexOf("ultracode"), steps, ultra: true, disabled: false };
  const level = chat.effort ?? "";
  return { label: level ? effortLabel(level) : "Default", position: level ? shown.indexOf(level) : -1, steps, ultra: false, disabled: false };
}

const EFFORT_ALIASES: Record<string, string> = {
  extra: "xhigh",
  "extra high": "xhigh",
  "x-high": "xhigh",
  "x high": "xhigh",
  ultra: "ultracode",
  med: "medium",
};

/** "low, Extra, ultra" → ["low", "xhigh", "ultracode"]; undefined when the list is empty (= every level). */
export function parseCycle(text: string | undefined): string[] | undefined {
  const out: string[] = [];
  for (const raw of (text ?? "").split(/[,;\n]+/)) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    const byLabel = Object.entries(EFFORT_LABEL).find(([, label]) => label.toLowerCase() === t)?.[0];
    const id = EFFORT_ALIASES[t] ?? byLabel ?? t;
    if (!out.includes(id)) out.push(id);
  }
  return out.length ? out : undefined;
}

/** A fixed level from the PI ("Extra" or "xhigh") as the id ops.ts expects. */
export const effortId = (level: string): string => parseCycle(level)?.[0] ?? level;

/** The levels an Effort key steps through: its own cycle, else every level incl. Ultracode. */
export const effortCycle = (cycle: unknown, fallback: readonly string[] = DEFAULT_EFFORT_CYCLE): string[] =>
  parseCycle(str(cycle)) ?? [...fallback];

/** What an Effort key press asks for: the fixed level, or "next" through the cycle. */
export function effortTarget(fixed: boolean, level: unknown): string {
  const l = fixed ? str(level) : "";
  return l ? effortId(l) : "next";
}

// ── Send Prompt / Steer ─────────────────────────────────────────────────────────────────────────────────

/**
 * Send Prompt / Steer press: the key's text, or — when the key has none — undefined, which tells ops.ts to submit
 * what is typed in Claude's prompt box.
 */
export function pressText<R>(text: unknown, send: (text?: string) => R): R {
  return send(str(text) || undefined);
}

// ── Speed ───────────────────────────────────────────────────────────────────────────────────────────────

export type SpeedState = "on" | "off" | "unavailable";

export function speedState(chat: Chat | undefined, models: ModelInfo[]): SpeedState {
  if (!chat) return "unavailable";
  const info = modelInfo(chat.model, models);
  if (info && !info.fast) return "unavailable";
  return chat.fast ? "on" : "off";
}

// ── Usage ───────────────────────────────────────────────────────────────────────────────────────────────

export function nextUsageView(view: UsageView): UsageView {
  const i = USAGE_VIEWS.indexOf(view);
  return USAGE_VIEWS[(i + 1) % USAGE_VIEWS.length]!;
}

/** Placeholder line when a view has nothing to show yet. */
export const USAGE_NO_DATA = "No data yet";

/**
 * What a Usage key / dial / infobar with view `view` shows: usage computed for that view. A chosen view never shows
 * another kind (no "Context" on a Weekly key): when the result isn't that kind, the key keeps its label and says
 * there's no data yet (grey). Auto shows whatever there is.
 */
export function usageFor(view: UsageView, compute: (view: UsageView) => Usage): Usage {
  const u = compute(view);
  if (view !== "auto" && u.kind !== view) return { kind: view, line1: u.kind === "none" && u.line1 ? u.line1 : USAGE_NO_DATA };
  if (u.kind === "none") return { ...u, line1: u.line1 ?? USAGE_NO_DATA };
  return u;
}

// ── Run Skill ───────────────────────────────────────────────────────────────────────────────────────────

/** "code-review" → "Review Changes" (built-in label), "/write-tests" → "Write Tests"; "" when none is set (the key
 * then shows its grey "Run Skill" placeholder, like an empty Send Prompt / Steer key). */
export function skillLabel(skill: string | undefined): string {
  const name = (skill ?? "").replace(/^\/+/, "").trim();
  if (!name) return "";
  return BUILTIN_SKILLS.find((s) => s.name === name)?.label ?? titleCase(name);
}
