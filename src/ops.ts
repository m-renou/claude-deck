// What each Stream Deck action does in the Claude desktop app. Every operation returns a short, honest result:
// ok only when the step ran. Model / effort changes return as soon as the keys went out (the key never waits on the
// app): the new value shows at once through the hub's optimistic overlay, and the chat's session file confirms it in
// the background — `onLate` hears about it when it doesn't within a few seconds.
//
// The selected chat is only re-opened (claude://code/continue) when the app isn't already showing it (or isn't running:
// the link launches it); when a step can't find what it needs (prompt box, effort slider, model menu) without opening,
// it opens the chat and tries once more. The first, no-open attempt never searches the window for the prompt box
// (seconds): only the retry, with the chat opened, does.

import { DEFAULT_EFFORT_CYCLE, DEFAULT_MODEL_SLOTS, EFFORT_LABEL, effortStopsFor, loadModels, modelInfo } from "./claude/catalog.ts";
import {
  type ChatOpts,
  type ControlError,
  dictation,
  type EffortResult,
  openNewChat,
  pickModel,
  pressKeys,
  type RunResult,
  setEffortSlider,
  shortcut,
  type ShortcutName,
  showChat,
  typeIntoPrompt,
} from "./claude/control.ts";
import type { DesktopChat } from "./claude/desktop-store.ts";
import { hub, type PendingPatch, sameModel } from "./hub.ts";
import type { ActionResult, Chat, ModelInfo } from "./types.ts";

const ok = (message: string): ActionResult => ({ ok: true, message, feedback: "ok" });
const fail = (message: string): ActionResult => ({ ok: false, message, feedback: "alert" });

// Defaults live in the pure catalog module (the keys and Property Inspectors use the very same lists):
//   DEFAULT_MODEL_SLOTS   Fable 5.1, then Opus 5.5 — what a Model key without slots cycles through
//   DEFAULT_EFFORT_CYCLE  low … max, then Ultracode — what an Effort key without a cycle steps through
export { DEFAULT_EFFORT_CYCLE, DEFAULT_MODEL_SLOTS };

/** How long the session file gets to confirm a model / effort change before `onLate` fires, and how often it's read.
 *  (An object so tests can shorten it.) */
export const timing = { confirmMs: 3000, pollMs: 200 };

export type LateHandler = (result: ActionResult) => void;

function selectedOrFail(): Chat | ActionResult {
  const s = hub.snapshot.selected;
  if (!s) return fail("No Claude Code chat found. Open the Code tab in the Claude app first.");
  return s;
}

function failed(r: RunResult): ActionResult {
  if (r.error === "accessibility") void hub.checkAccess().catch(() => undefined);
  return fail(r.message);
}

const short = (t: string): string => (t.length > 40 ? `${t.slice(0, 39)}…` : t);

/**
 * Run a step on the selected chat: open it first only when the app isn't showing it; when the step reports one of
 * `retryOn` without having opened the chat, open it and try once more.
 */
async function onChat<R extends RunResult>(chat: Chat | undefined, step: (opts: ChatOpts) => Promise<R>, retryOn: ControlError[] = []): Promise<R> {
  if (!chat) return step({});
  // (While Claude isn't running, the last focused chat still looks "shown": the link launches the app.)
  const open = !hub.snapshot.app.running || !hub.isShown(chat.id);
  let r = await step(open ? { openChat: chat.id } : { scan: false });
  if (open && r.error !== "failed") hub.noteShown(chat.id);
  if (!r.ok && !open && r.error && retryOn.includes(r.error)) {
    r = await step({ openChat: chat.id });
    hub.noteShown(chat.id);
  }
  return r;
}

// ── Chats ─────────────────────────────────────────────────────────────────────────────────────────────────

export async function openChatOp(chat: Chat): Promise<ActionResult> {
  hub.markSeen(chat.id);
  // Queued, with the app's switch time inside the job: the next key's keys can't reach the chat shown before.
  const r = await showChat(chat.id);
  if (r.ok) hub.noteShown(chat.id);
  return r.ok ? ok(`Opened “${chat.title}”`) : fail(r.message);
}

export async function newChat(opts: { folder?: string; prompt?: string } = {}): Promise<ActionResult> {
  const r = await openNewChat(opts);
  return r.ok ? ok("New chat") : fail(r.message);
}

// ── Prompting ───────────────────────────────────────────────────────────────────────────────────────────

const PROMPT_RETRY: ControlError[] = ["prompt-not-found", "focus-failed"];

/**
 * Send to the selected chat.
 *  • With text: paste it into the prompt box and press Return — refused when the box already holds a draft.
 *  • Without text (an empty Send Prompt / Steer key): press Return to send what the user typed in the box; fails
 *    when the box is empty.
 */
export async function sendText(text?: string): Promise<ActionResult> {
  const s = selectedOrFail();
  if ("ok" in s) return s;
  const t = text?.trim() || undefined;
  const r = await onChat(s, (o) => typeIntoPrompt(t, { submit: true, requireEmpty: true, ...o }), PROMPT_RETRY);
  if (!r.ok) return failed(r);
  const what = t ? `“${short(t)}”` : "the prompt box";
  return ok(r.cleared === false ? `Sent ${what} — Claude hasn't taken it yet` : `Sent ${what}`);
}

/** Steer: same delivery; while Claude works, the app takes it without stopping the turn (desktop docs). */
export const steer = (text?: string): Promise<ActionResult> => sendText(text);

export async function runSkill(skill: string, args?: string): Promise<ActionResult> {
  const name = skill.replace(/^\/+/, "").trim();
  if (!name) return fail("Pick a skill in the key's settings.");
  return sendText(`/${name}${args?.trim() ? ` ${args.trim()}` : ""}`);
}

/**
 * Esc in the selected chat — the only place the plugin ever sends Esc. Checked again inside the queued job, right
 * before Esc goes out: the chat must still be working (a job ahead of it may have taken seconds). Without opening the
 * chat, Esc is only sent while Claude shows a Code chat (the cached prompt box validates); else the chat is opened.
 */
export async function stop(): Promise<ActionResult> {
  const s = selectedOrFail();
  if ("ok" in s) return s;
  if (s.status !== "working") return fail(`“${s.title}” isn't working right now.`);
  const stillWorking = (): string | undefined =>
    hub.snapshot.chats.find((c) => c.id === s.id)?.status === "working" ? undefined : `“${s.title}” stopped working before Esc went out, so nothing was sent.`;
  const r = await onChat(s, (o) => pressKeys([shortcut("stop")], { ...o, guard: stillWorking, checkPrompt: true }), ["prompt-not-found"]);
  return r.ok ? ok("Stopped") : failed(r);
}

export async function dictate(): Promise<ActionResult> {
  const s = hub.snapshot.selected;
  const r = await onChat(s, (o) => dictation(o), PROMPT_RETRY);
  if (!r.ok && r.error === "menu-not-found") return fail("Turn on Dictation in System Settings → Keyboard → Dictation.");
  return r.ok ? ok("Dictation") : failed(r);
}

/** A panel's shortcut. (Never "stop": Esc is the Stop key's alone.) */
export async function togglePanel(panel: Exclude<ShortcutName, "stop">): Promise<ActionResult> {
  const s = hub.snapshot.selected;
  const r = await onChat(s, (o) => pressKeys([shortcut(panel)], o));
  return r.ok ? ok("sent") : failed(r);
}

// ── Background confirmation ─────────────────────────────────────────────────────────────────────────────

/** Latest press per chat and setting: an older press's confirmation stops when a newer one supersedes it. */
const generation = new Map<string, number>();
const bump = (key: string): number => {
  const g = (generation.get(key) ?? 0) + 1;
  generation.set(key, g);
  return g;
};

/** Stop every background confirmation (tests; nothing calls onLate afterwards). */
export function cancelConfirmations(): void {
  generation.clear();
}

/** How long a pending value is held while its job waits in the queue (the job's end re-arms or clears it). */
const PENDING_HOLD_MS = 60_000;

/**
 * The keys went out: show the pending value for `timing.confirmMs` more, and poll the chat's session file until it —
 * written after the press (`pressAt`), never the old file that happens to match — reports the value.
 */
function confirmLater(key: string, gen: number, chatId: string, pendingKeys: Array<keyof PendingPatch>, pressAt: number, check: (c: DesktopChat) => boolean, lateMessage: string, onLate?: LateHandler): void {
  if (generation.get(key) !== gen) return; // a newer press took over (its own confirmation re-arms the value)
  hub.armPending(chatId, pendingKeys, timing.confirmMs + 1000);
  const end = Date.now() + timing.confirmMs;
  const tick = (): void => {
    if (generation.get(key) !== gen) return; // a newer press took over
    const c = hub.store.readOne(chatId);
    if (c && c.mtimeMs > pressAt && check(c)) {
      hub.refresh(true);
      return;
    }
    if (Date.now() >= end) {
      hub.clearPending(chatId, pendingKeys);
      try {
        onLate?.(fail(lateMessage));
      } catch {
        // the key's handler must not break the poll
      }
      return;
    }
    const t = setTimeout(tick, timing.pollMs);
    t.unref?.();
  };
  const t = setTimeout(tick, timing.pollMs);
  t.unref?.();
}

// ── Model ───────────────────────────────────────────────────────────────────────────────────────────────

/** Next model in the app's whole menu (wraps). (The Model key cycles through its slots: nextModelSlot.) */
export function nextModel(current: string | undefined, list = loadModels()): string {
  const i = list.findIndex((m) => m.id === modelInfo(current, list)?.id);
  return list[(i + 1) % list.length]!.id;
}

/** Slot list to use: the key's slots (blank / "none" entries, models the app's menu doesn't have and repeats
 *  dropped), else DEFAULT_MODEL_SLOTS. */
export function modelSlots(slots: readonly (string | undefined | null)[] | undefined, models: ModelInfo[] = loadModels()): string[] {
  const out: string[] = [];
  for (const raw of slots ?? []) {
    const t = typeof raw === "string" ? raw.trim() : "";
    if (!t || t === "none") continue;
    const id = modelInfo(t, models)?.id;
    if (id && !out.includes(id)) out.push(id);
  }
  return out.length ? out : [...DEFAULT_MODEL_SLOTS];
}

/** The slot after the chat's current model; slot 1 when the current model isn't one of the slots. */
export function nextModelSlot(current: string | undefined, slots: readonly string[], models: ModelInfo[] = loadModels()): string {
  const list = modelSlots(slots, models);
  const i = list.findIndex((id) => sameModel(id, current));
  return i < 0 ? list[0]! : list[(i + 1) % list.length]!;
}

/**
 * Switch the selected chat's model: "next" = the slot after its current model (slots default to
 * DEFAULT_MODEL_SLOTS), or a model id. Picks it in the app's model menu (⌘⇧I + its row number) and returns once
 * the keys went out; the session file confirms it in the background (`onLate` on a miss).
 */
export async function setModel(target: string = "next", slots?: readonly string[], onLate?: LateHandler): Promise<ActionResult> {
  const s = selectedOrFail();
  if ("ok" in s) return s;
  const models = loadModels();
  const id = target === "next" ? nextModelSlot(s.model, slots ?? DEFAULT_MODEL_SLOTS, models) : (modelInfo(target, models)?.id ?? target);
  const idx = models.findIndex((m) => m.id === id);
  if (idx < 0 || idx > 8) return fail(`“${target === "next" ? id : target}” isn't in the app's model menu.`);
  const name = models[idx]!.name;
  if (sameModel(s.model, id) && !s.pending) return ok(`Already on ${name}`);
  const key = `model|${s.id}`;
  const gen = bump(key);
  const pressAt = Date.now();
  hub.setPending(s.id, { model: id }, PENDING_HOLD_MS);
  const r = await onChat(s, (o) => pickModel(idx, o), ["model-menu-not-open"]);
  if (!r.ok) {
    if (generation.get(key) === gen) hub.clearPending(s.id, ["model"]);
    return failed(r);
  }
  confirmLater(key, gen, s.id, ["model"], pressAt, (c) => sameModel(c.model, id), `Sent ⌘⇧I ${idx + 1}, but the chat didn't switch to ${name}.`, onLate);
  return ok(name);
}

// ── Effort ──────────────────────────────────────────────────────────────────────────────────────────────

/** Models whose effort slider turned out to have no Ultracode stop (learned from the app this session). */
const noUltracode = new Set<string>();

/** Tests: forget what was learned about Ultracode. */
export function resetEffortKnowledge(): void {
  noUltracode.clear();
}

const modelKey = (model: string | undefined, models: ModelInfo[]): string => modelInfo(model, models)?.id ?? model ?? "";

/**
 * Stops of the app's effort slider for a model, left to right: its effort levels from the catalog, then
 * "ultracode" (unless the app's slider showed it has none). Empty for a model without an effort setting (Haiku).
 */
export function effortStops(model: string | undefined, models: ModelInfo[] = loadModels()): string[] {
  const stops = effortStopsFor(modelInfo(model, models));
  return noUltracode.has(modelKey(model, models)) ? stops.filter((e) => e !== "ultracode") : stops;
}

/** The chat's stop: "ultracode" when its Ultracode flag is on, else its effort level ("" when unknown). */
export const currentEffort = (chat: Chat): string => (chat.ultracode ? "ultracode" : (chat.effort ?? ""));

/**
 * The cycle entry after the chat's current stop. Entries that aren't stops are skipped (when `stops` is given).
 * When the current stop isn't in the cycle: the first entry above it, else the first entry.
 */
export function nextEffort(chat: Chat, cycle: readonly string[] = DEFAULT_EFFORT_CYCLE, stops?: readonly string[]): string {
  const order = stops ?? DEFAULT_EFFORT_CYCLE;
  const list = stops ? cycle.filter((e) => stops.includes(e)) : [...cycle];
  if (!list.length) return order[0] ?? cycle[0] ?? "";
  const cur = currentEffort(chat);
  const i = list.indexOf(cur);
  if (i >= 0) return list[(i + 1) % list.length]!;
  const at = order.indexOf(cur);
  if (at >= 0) {
    const up = list.find((e) => order.indexOf(e) > at);
    if (up) return up;
  }
  return list[0]!;
}

const effortName = (level: string): string => EFFORT_LABEL[level] ?? level;

/**
 * Set the selected chat's effort: "next" = the following stop of `cycle` (default DEFAULT_EFFORT_CYCLE), or a
 * level id ("low" … "max", "ultracode"). Moves the app's effort slider (⌘⇧E, arrows, ⌘⇧E) and returns once it
 * moved; the session file confirms it in the background (`onLate` on a miss).
 */
export async function setEffort(target: string = "next", cycle?: readonly string[], onLate?: LateHandler): Promise<ActionResult> {
  const s = selectedOrFail();
  if ("ok" in s) return s;
  const models = loadModels();
  const modelName = modelInfo(s.model, models)?.name;
  const order = cycle?.length ? cycle : DEFAULT_EFFORT_CYCLE;
  let stops = effortStops(s.model, models);
  if (!stops.length) return fail(`${modelName ?? "This model"} has no effort setting.`);
  let level = target === "next" ? nextEffort(s, order, stops) : target;
  if (stops.indexOf(level) < 0) {
    if (level === "ultracode" && noUltracode.has(modelKey(s.model, models))) return fail(`The app doesn't offer Ultracode for ${modelName ?? "this model"}.`);
    return fail(`${effortName(level)} isn't available for ${modelName ?? "this model"}.`);
  }
  if (currentEffort(s) === level && !s.pending) return ok(`Already on ${effortName(level)}`);
  let r = await moveEffort(s, level, stops, onLate);
  // The app's slider has no Ultracode stop for this model (its last stop is Max): remember that, and let "next" go on
  // to the following level (wrapping to the first) instead of failing at Max on every press.
  if (!r.ok && r.error === "effort-range" && level === "ultracode" && r.max === stops.length - 2) {
    noUltracode.add(modelKey(s.model, models));
    if (target !== "next") return fail(`The app doesn't offer Ultracode for ${modelName ?? "this model"}.`);
    stops = effortStops(s.model, models);
    level = nextEffort(s, order, stops);
    if (!level || level === "ultracode" || stops.indexOf(level) < 0) return fail(`The app doesn't offer Ultracode for ${modelName ?? "this model"}.`);
    if (currentEffort(s) === level && !s.pending) return ok(`Already on ${effortName(level)}`);
    r = await moveEffort(s, level, stops, onLate);
  }
  if (!r.ok) return failed(r);
  return ok(effortName(level));
}

/** One effort change: optimistic value, the slider (opening the chat when needed), background confirmation. */
async function moveEffort(s: Chat, level: string, stops: string[], onLate?: LateHandler): Promise<EffortResult> {
  const idx = stops.indexOf(level);
  const key = `effort|${s.id}`;
  const gen = bump(key);
  const pressAt = Date.now();
  const patch: PendingPatch = level === "ultracode" ? { ultracode: true, effort: undefined } : { effort: level, ultracode: false };
  hub.setPending(s.id, patch, PENDING_HOLD_MS);
  const r = await onChat(s, (o) => setEffortSlider(idx, stops.length, o), ["effort-not-open"]);
  if (!r.ok) {
    if (generation.get(key) === gen) hub.clearPending(s.id, ["effort", "ultracode"]);
    return r;
  }
  const check = level === "ultracode" ? (c: DesktopChat) => c.ultracode === true : (c: DesktopChat) => c.effort === level && c.ultracode !== true;
  confirmLater(key, gen, s.id, ["effort", "ultracode"], pressAt, check, `The slider moved, but the chat didn't report ${effortName(level)}.`, onLate);
  return r;
}

// ── Speed ───────────────────────────────────────────────────────────────────────────────────────────────

export async function toggleFast(): Promise<ActionResult> {
  const s = selectedOrFail();
  if ("ok" in s) return s;
  const m = modelInfo(s.model);
  if (m && !m.fast) return fail(`Fast mode isn't available for ${m.name}.`);
  const r = await onChat(s, (o) => pressKeys([shortcut("fast")], o));
  return r.ok ? ok("sent") : failed(r);
}
