// Pure dial logic (no Stream Deck, hub, ops or control imports — unit tested): list cursors for the Activity and
// Run Skill dials, and the Power dial's single scale of model × effort, from "Faster" to "Smarter".

import { modelInfo, modelName } from "../claude/catalog.ts";
import type { PowerDialView } from "../render/dial.ts";
import type { ActionResult, Chat, ModelInfo } from "../types.ts";
import { effortLabel } from "./logic.ts";

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ── Lists ───────────────────────────────────────────────────────────────────────────────────────────────

/** Move a list cursor by dial ticks (positive = clockwise = down the list), clamped to the list — no wrap-around. */
export function moveCursor(index: number, ticks: number, count: number): number {
  if (count <= 0) return 0;
  const i = Number.isFinite(index) ? Math.floor(index) : 0;
  const t = Number.isFinite(ticks) ? Math.trunc(ticks) : 0;
  return clamp(i + t, 0, count - 1);
}

/**
 * Where a list cursor is now: the item it was left on (by key, so it follows the item when the list reorders), else
 * the remembered index (clamped), else `fallback`.
 */
export function cursorIndex(keys: readonly string[], key: unknown, index: unknown, fallback = 0): number {
  if (!keys.length) return 0;
  if (typeof key === "string") {
    const i = keys.indexOf(key);
    if (i >= 0) return i;
  }
  const raw = typeof index === "number" && Number.isFinite(index) ? index : fallback;
  return clamp(Math.floor(raw), 0, keys.length - 1);
}

// ── Power: one scale of model × effort ──────────────────────────────────────────────────────────────────

export interface PowerStep {
  /** "<model id>|<effort>" — stable across catalog reloads (the dial remembers it, not an index). */
  key: string;
  /** Model id. */
  model: string;
  /** Model name ("Opus 5.5"). */
  name: string;
  /** Effort level id; undefined for models without an effort setting (Haiku). */
  effort?: string;
}

/** Families from fastest to smartest; a model of an unknown family sits between Sonnet and Opus. */
const FAMILY: Array<[RegExp, number]> = [
  [/haiku/i, 0],
  [/sonnet/i, 1],
  [/opus/i, 2],
  [/fable/i, 3],
];
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

function familyRank(m: ModelInfo): number {
  for (const [re, rank] of FAMILY) if (re.test(m.shortName) || re.test(m.name) || re.test(m.id)) return rank;
  return 1.5;
}

function modelVersion(m: ModelInfo): number {
  const v = /(\d+(?:\.\d+)?)/.exec(m.name)?.[1] ?? /-(\d+)-(\d+)(?:-|$)/.exec(m.id)?.slice(1, 3).join(".");
  const num = v ? Number.parseFloat(v) : Number.NaN;
  return Number.isFinite(num) ? num : 0;
}

const effortRank = (e: string, catalogIndex: number): number => {
  const i = EFFORT_ORDER.indexOf(e);
  return i >= 0 ? i : EFFORT_ORDER.length + catalogIndex;
};

/**
 * The Power scale, Faster → Smarter: models by family (Haiku, Sonnet, Opus, Fable) and version, each model's effort
 * levels from low to max. A model without an effort setting is one step. Ultracode is a separate setting (Effort key),
 * not a level, so it isn't on the scale.
 */
export function powerScale(models: readonly ModelInfo[]): PowerStep[] {
  const sorted = models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => familyRank(a.m) - familyRank(b.m) || modelVersion(a.m) - modelVersion(b.m) || a.i - b.i)
    .map((x) => x.m);
  const out: PowerStep[] = [];
  for (const m of sorted) {
    const efforts = m.efforts
      .map((e, i) => ({ e, i }))
      .filter((x) => x.e !== "ultracode")
      .sort((a, b) => effortRank(a.e, a.i) - effortRank(b.e, b.i))
      .map((x) => x.e);
    if (!efforts.length) out.push({ key: `${m.id}|`, model: m.id, name: m.name });
    for (const e of efforts) out.push({ key: `${m.id}|${e}`, model: m.id, name: m.name, effort: e });
  }
  return out;
}

/** Step the chat is on now; -1 when its model isn't in the catalog or its effort level is unknown. */
export function powerIndex(scale: readonly PowerStep[], chat: Chat | undefined, models: readonly ModelInfo[]): number {
  const info = modelInfo(chat?.model, [...models]);
  if (!chat || !info) return -1;
  return scale.findIndex((s) => s.model === info.id && (s.effort === undefined || s.effort === chat.effort));
}

/** Where the first turn of the dial starts from when the chat's step is unknown: its model's first step, else 0. */
export function powerStart(scale: readonly PowerStep[], chat: Chat | undefined, models: readonly ModelInfo[]): number {
  const cur = powerIndex(scale, chat, models);
  if (cur >= 0) return cur;
  const info = modelInfo(chat?.model, [...models]);
  const first = info ? scale.findIndex((s) => s.model === info.id) : -1;
  return Math.max(0, first);
}

/** "Opus 5.5 Extra" / "Haiku 4.5". */
export const powerLabel = (s: PowerStep): string => (s.effort ? `${s.name} ${effortLabel(s.effort)}` : s.name);

/**
 * What the Power dial shows: the pending choice (when the dial was turned and not applied yet) or the chat's own
 * model and effort. `current` marks the chat's step while a different pending one is shown.
 */
export function powerView(scale: readonly PowerStep[], chat: Chat | undefined, models: readonly ModelInfo[], pendingKey?: string): PowerDialView {
  const steps = Math.max(scale.length, 1);
  const current = powerIndex(scale, chat, models);
  const pending = pendingKey ? scale.findIndex((s) => s.key === pendingKey) : -1;
  if (!chat || !scale.length) return { model: chat ? modelName(chat.model, [...models]) : "Model", position: -1, steps, disabled: true };
  if (pending >= 0 && pending !== current) {
    const s = scale[pending]!;
    return { model: s.name, effort: s.effort ? effortLabel(s.effort) : undefined, position: pending, steps, current };
  }
  const info = modelInfo(chat.model, [...models]);
  const hasEffort = info ? info.efforts.length > 0 : !!chat.effort;
  const effort = chat.ultracode ? "Ultra" : hasEffort && chat.effort ? effortLabel(chat.effort) : undefined;
  return { model: modelName(chat.model, [...models]), effort, position: current, steps, ultra: !!chat.ultracode };
}

/** What applying a step has to change in the chat: its model, its effort, both or nothing. */
export function powerPlan(step: PowerStep, chat: Chat | undefined, models: readonly ModelInfo[]): { model?: string; effort?: string } {
  const cur = modelInfo(chat?.model, [...models])?.id;
  const switchModel = cur !== step.model;
  return {
    model: switchModel ? step.model : undefined,
    effort: step.effort && (switchModel || chat?.effort !== step.effort) ? step.effort : undefined,
  };
}

export interface PowerOps {
  setModel(model: string): Promise<ActionResult>;
  setEffort(level: string): Promise<ActionResult>;
}

/**
 * Apply a Power step: switch the model first, then the effort level (each confirmed by ops.ts), stopping at the first
 * failure and saying honestly what did and didn't change.
 */
export async function applyPower(step: PowerStep, chat: Chat | undefined, models: readonly ModelInfo[], ops: PowerOps): Promise<ActionResult> {
  if (!chat) return { ok: false, message: "No Claude Code chat found. Open the Code tab in the Claude app first.", feedback: "alert" };
  const label = powerLabel(step);
  const plan = powerPlan(step, chat, models);
  if (!plan.model && !plan.effort) return { ok: true, message: `Already on ${label}`, feedback: "ok" };
  if (plan.model) {
    const r = await ops.setModel(plan.model);
    if (!r.ok) return r;
  }
  if (plan.effort) {
    const r = await ops.setEffort(plan.effort);
    if (!r.ok) return plan.model ? { ...r, message: `Switched to ${step.name}, but the effort didn't change: ${r.message}` } : r;
  }
  return { ok: true, message: label, feedback: "ok" };
}
