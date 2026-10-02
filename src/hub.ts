// State hub: merges the Claude app's chat files with live process status, picks the selected chat, computes
// usage, and notifies actions when anything visible changed. Everything is local and read-only. Live usage comes from
// src/claude/usage-live.ts (Claude Code's own usage request, every minute); the hub only takes its latest sample.
//
// Optimistic values: a Model / Effort press shows its new value at once (setPending) — the snapshot overlays it on the
// chat until the chat's session file, written after the press, reports the same value, or the TTL runs out. Cycling
// reads the overlaid values, so quick repeated presses step correctly. (A file that still holds the old value doesn't
// count even when it equals the new one: with two slots every second press goes back to it.)

import { EventEmitter } from "node:events";
import { DesktopStore, type DesktopChat } from "./claude/desktop-store.ts";
import { accessibilityGranted, isClaudeRunning, warmUp } from "./claude/control.ts";
import { loadModels, modelInfo } from "./claude/catalog.ts";
import { diffStat } from "./claude/extras.ts";
import { LiveRoster, type LiveSession } from "./claude/live.ts";
import { computeUsage, transcriptFor, type UsageView } from "./claude/usage.ts";
import { usageLive } from "./claude/usage-live.ts";
import fs from "node:fs";
import type { Chat, ChatStatus, Snapshot, Usage } from "./types.ts";

export function chatStatus(d: DesktopChat, live: LiveSession | undefined, seenAt = 0): ChatStatus {
  if (live?.status === "busy") return "working";
  if (live?.status === "waiting") return "waiting";
  // The app's own turn summary says the turn ended waiting on you, and you haven't replied since.
  if (d.summary?.category === "blocked" && d.latestUserFrameAt <= d.lastActivityAt) return "waiting";
  if (d.completedTurns > 0 && d.lastActivityAt > Math.max(d.lastFocusedAt, seenAt) + 1500) return "done";
  return "idle";
}

export function toChat(d: DesktopChat, live: LiveSession | undefined, seenAt = 0): Chat {
  const status = chatStatus(d, live, seenAt);
  return {
    id: d.id,
    cliSessionId: d.cliSessionId,
    title: d.title,
    cwd: d.cwd,
    status,
    detail: status === "waiting" ? (d.summary?.needsAction ?? d.summary?.detail ?? live?.waitingFor) : d.summary?.detail,
    lastActivityAt: d.lastActivityAt,
    lastFocusedAt: d.lastFocusedAt,
    live: !!live?.pid,
    model: d.model,
    effort: d.effort,
    ultracode: d.ultracode,
    fast: d.fast,
    permissionMode: d.permissionMode,
  };
}

/** Values a press just sent. A key set to undefined in a patch removes that pending value. */
export interface PendingPatch {
  model?: string;
  effort?: string;
  ultracode?: boolean;
}

export const PENDING_TTL_MS = 4000;
const PENDING_KEYS = ["model", "effort", "ultracode"] as const;
type PendingKey = (typeof PENDING_KEYS)[number];

/** One pending value: what was sent, when (press time), and until when it is shown. */
interface PendingEntry {
  value: unknown;
  since: number;
  expires: number;
}

/** Same model, allowing for suffixed ids ("claude-opus-5-5[1m]"). */
export function sameModel(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return a === b;
  if (a === b) return true;
  const ma = modelInfo(a)?.id;
  return !!ma && ma === modelInfo(b)?.id;
}

/** Does the chat's own (file) value already match a pending one? */
function matches(key: PendingKey, fileValue: unknown, pending: unknown): boolean {
  if (key === "model") return sameModel(fileValue as string | undefined, pending as string);
  if (key === "ultracode") return (fileValue === true) === (pending === true);
  return fileValue === pending;
}

export class Hub extends EventEmitter {
  store = new DesktopStore();
  roster = new LiveRoster();
  snapshot: Snapshot = { chats: [], models: loadModels(), usage: { kind: "none" }, app: { installed: true, running: false } };
  /** Chats the user opened from the deck: id → time (counts as "seen"). */
  private seen = new Map<string, number>();
  /** Chat picked on the deck (wins over the app's focus until the app focuses another chat later). */
  private picked: { id: string; at: number } | undefined;
  /** Chat the plugin last brought to the front with its claude:// link. */
  private shown: { id: string; at: number } | undefined;
  private pending = new Map<string, { entries: Map<PendingKey, PendingEntry>; timer?: NodeJS.Timeout }>();
  private usagePref: UsageView = "auto";
  private usageByView = new Map<UsageView, Usage>();
  private timers: NodeJS.Timeout[] = [];
  private last = "";
  private live = new Map<string, LiveSession>();
  private transcripts = new Map<string, string | undefined>();
  private warmTimer: NodeJS.Timeout | undefined;
  /** New live usage (or its status): recompute at once. */
  private readonly onLiveUsage = (): void => this.refresh(true);

  /** The app stamps lastActivityAt when a turn ends; while a chat works its transcript is the live activity clock. */
  private transcriptMtime(cliSessionId: string): number {
    if (!this.transcripts.has(cliSessionId)) this.transcripts.set(cliSessionId, transcriptFor(cliSessionId));
    const f = this.transcripts.get(cliSessionId);
    if (!f) return 0;
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      this.transcripts.delete(cliSessionId);
      return 0;
    }
  }

  start(): void {
    const every = (ms: number, fn: () => unknown) => {
      void fn();
      const t = setInterval(() => void fn(), ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(1000, () => this.refresh());
    every(2000, async () => {
      this.live = await this.roster.poll();
      this.refresh();
    });
    every(5000, async () => {
      const was = this.snapshot.app.running;
      this.snapshot.app.running = await isClaudeRunning();
      if (this.snapshot.app.running && !was) this.warmSoon(5000); // launched (or first check): find the prompt box
      this.refresh();
    });
    every(20_000, () => this.checkAccess());
    // Ages on keys ("1m", "2h") move on even when nothing else changes.
    every(30_000, () => this.refresh(true));
    // Keep the prompt box's location fresh (a quick check when it's still valid).
    every(10 * 60_000, () => this.warmSoon(0, true));
    usageLive.on("change", this.onLiveUsage);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    usageLive.off("change", this.onLiveUsage);
    clearTimeout(this.warmTimer);
    this.warmTimer = undefined;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  /**
   * Find Claude's prompt box in the background (accessibility reads only: no activation, no keystrokes), debounced.
   * Called on start, when Claude launches, and every few minutes; plugin.ts may call it on app launch / wake too.
   */
  warmSoon(delayMs = 3000, periodic = false): void {
    if (periodic && this.warmTimer) return; // a launch / start warm-up is already on its way
    clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => {
      this.warmTimer = undefined;
      if (!this.snapshot.app.running || this.snapshot.accessibility === false) return;
      void warmUp({ periodic }).catch(() => undefined);
    }, delayMs);
    this.warmTimer.unref?.();
  }

  async checkAccess(): Promise<boolean> {
    const ok = await accessibilityGranted();
    if (this.snapshot.accessibility !== ok) {
      this.snapshot.accessibility = ok;
      this.refresh(true);
    }
    return ok;
  }

  markSeen(id: string): void {
    this.seen.set(id, Date.now());
    this.picked = { id, at: Date.now() };
    this.refresh(true);
  }

  /** Forget deck picks, opened chats and pending values (tests). */
  forget(): void {
    this.seen.clear();
    this.picked = undefined;
    this.shown = undefined;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  /** The plugin just opened this chat in the app (claude://code/continue). */
  noteShown(id: string, at = Date.now()): void {
    this.shown = { id, at };
  }

  /**
   * Is this chat the one the Claude app shows? The latest of: the app's own focus (the chat with the newest
   * lastFocusedAt) and the chat the plugin last opened. Keys skip re-opening a chat that is already shown.
   */
  isShown(id: string): boolean {
    let focused: Chat | undefined;
    for (const c of this.snapshot.chats) if (!focused || c.lastFocusedAt > focused.lastFocusedAt) focused = c;
    if (this.shown && (!focused || this.shown.at >= focused.lastFocusedAt)) return this.shown.id === id;
    return !!focused && focused.id === id && !(this.picked && this.picked.id !== id && this.picked.at > focused.lastFocusedAt);
  }

  setUsagePreference(p: UsageView): void {
    this.usagePref = p;
  }

  /** Usage for one view (Usage keys with different views each ask for theirs). Cached until the next refresh. */
  usageFor(view: UsageView): Usage {
    let u = this.usageByView.get(view);
    if (!u) {
      u = computeUsage(this.snapshot.selected, view, Date.now(), usageLive.state.sample);
      this.usageByView.set(view, u);
    }
    return u;
  }

  // ── optimistic values ─────────────────────────────────────────────────────────────────────────────────

  /** Re-render when the chat's next pending value expires; forget the chat when nothing is pending any more. */
  private schedule(chatId: string, now = Date.now()): void {
    const p = this.pending.get(chatId);
    if (!p) return;
    clearTimeout(p.timer);
    p.timer = undefined;
    for (const [k, e] of p.entries) if (e.expires <= now) p.entries.delete(k);
    if (!p.entries.size) {
      this.pending.delete(chatId);
      return;
    }
    const next = Math.min(...[...p.entries.values()].map((e) => e.expires));
    p.timer = setTimeout(() => this.refresh(true), next - now + 20);
    p.timer.unref?.();
  }

  /** Show these values on the chat right away, until its session file — written after this press — agrees, or
   *  `ttlMs` passes. Merges with what's already pending for the chat (each value keeps its own press time and TTL). */
  setPending(chatId: string, patch: PendingPatch, ttlMs = PENDING_TTL_MS): void {
    const now = Date.now();
    const p = this.pending.get(chatId) ?? { entries: new Map<PendingKey, PendingEntry>() };
    this.pending.set(chatId, p);
    for (const k of PENDING_KEYS) {
      if (!(k in patch)) continue;
      if (patch[k] === undefined) p.entries.delete(k);
      else p.entries.set(k, { value: patch[k], since: now, expires: now + ttlMs });
    }
    this.schedule(chatId, now);
    this.refresh(true);
  }

  /** Restart the TTL of pending values (the keys just went out: give the app `ttlMs` to write the file). */
  armPending(chatId: string, keys: readonly PendingKey[], ttlMs: number): void {
    const p = this.pending.get(chatId);
    if (!p) return;
    const now = Date.now();
    for (const k of keys) {
      const e = p.entries.get(k);
      if (e) e.expires = now + ttlMs;
    }
    this.schedule(chatId, now);
  }

  /** Drop pending values (all, or the given keys) — the press failed. */
  clearPending(chatId: string, keys?: Array<keyof PendingPatch>): void {
    const p = this.pending.get(chatId);
    if (!p) return;
    for (const k of keys ?? PENDING_KEYS) p.entries.delete(k);
    if (!p.entries.size) {
      clearTimeout(p.timer);
      this.pending.delete(chatId);
    }
    this.refresh(true);
  }

  /** What's still pending for a chat (undefined when nothing is). */
  pendingFor(chatId: string): PendingPatch | undefined {
    const p = this.pending.get(chatId);
    if (!p) return undefined;
    const now = Date.now();
    const out: Record<string, unknown> = {};
    for (const [k, e] of p.entries) if (e.expires > now) out[k] = e.value;
    return Object.keys(out).length ? (out as PendingPatch) : undefined;
  }

  /** Overlay pending values on a chat (dropping expired ones, and the ones its file — written after the press —
   *  already confirms). `fileMtime` = the session file's mtime. */
  private overlay(c: Chat, now: number, fileMtime: number): Chat {
    const p = this.pending.get(c.id);
    if (!p) return c;
    const values: Record<string, unknown> = {};
    for (const [k, e] of p.entries) {
      if (e.expires <= now || (fileMtime > e.since && matches(k, c[k], e.value))) p.entries.delete(k);
      else values[k] = e.value;
    }
    if (!p.entries.size) {
      clearTimeout(p.timer);
      this.pending.delete(c.id);
      return c;
    }
    return { ...c, ...values, pending: true };
  }

  refresh(force = false): void {
    const raw = this.store.read();
    const now = Date.now();
    const chats = raw.map((d) => {
      let c = toChat(d, d.cliSessionId ? this.live.get(d.cliSessionId) : undefined, this.seen.get(d.id) ?? 0);
      if (c.status === "working" && c.cliSessionId) c.lastActivityAt = Math.max(c.lastActivityAt, this.transcriptMtime(c.cliSessionId));
      if (c.status === "done" || c.status === "idle") c.diff = diffStat(c.cwd);
      c = this.overlay(c, now, d.mtimeMs);
      return c;
    });
    for (const [id, p] of this.pending) {
      for (const [k, e] of p.entries) if (e.expires <= now) p.entries.delete(k);
      if (p.entries.size) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
    }
    // Selected = the chat open in the app (latest focus), unless the deck picked one more recently.
    const focused = [...chats].sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)[0];
    let selected = focused;
    if (this.picked) {
      const p = chats.find((c) => c.id === this.picked!.id);
      if (p && (!focused || this.picked.at >= focused.lastFocusedAt)) selected = p;
    }
    this.usageByView.clear();
    const usage: Usage = computeUsage(selected, this.usagePref, now, usageLive.state.sample);
    this.usageByView.set(this.usagePref, usage);
    this.snapshot = {
      ...this.snapshot,
      chats,
      selected,
      models: loadModels(),
      usage,
      error: this.roster.error,
    };
    const key = JSON.stringify(this.snapshot, (k, v) => (k === "updatedAt" ? undefined : v));
    if (force || key !== this.last) {
      this.last = key;
      this.emit("change", this.snapshot);
    }
  }
}

export const hub = new Hub();
