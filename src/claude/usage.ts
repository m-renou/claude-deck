// Usage for the Usage key / dial / infobar, per view:
//   weekly / 5-hour  the newest plan sample with that number, from two sources:
//                      • live: Claude Code's own usage request, asked every minute while a plan view shows
//                        (src/claude/usage-live.ts; the hub passes its latest sample in), with the windows' reset times;
//                      • the app: plan-usage-history.json ({t, u: {fh: 5-hour %, sd: weekly %}}), which the desktop
//                        app writes only now and then (every 15 min, and only while its menu-bar menu was opened in
//                        the last 24 h).
//                    A live sample up to 3 min old shows when the window resets ("resets 22:40", "resets Thu"); any
//                    older sample is shown with its time, "as of 12:39" (or the date when it's older than a day).
//                    No sample → kind "none".
//   context          the selected chat's context window: last assistant message's token usage from its transcript tail.
//   auto             weekly when a sample from the last 24 h exists (either source), else context (else the older
//                    sample).
// A plan view never silently turns into context.

import fs from "node:fs";
import path from "node:path";
import type { Chat, Usage } from "../types.ts";
import { claudeConfigDir, planUsageFile } from "./paths.ts";

export type UsageView = "auto" | "weekly" | "5-hour" | "context";

const DAY_MS = 24 * 60 * 60_000;
/** A live sample this recent shows the reset time instead of "as of …". */
export const FRESH_MS = 3 * 60_000;

export interface PlanSample {
  /** Percent of the 5-hour / weekly limit used. */
  fiveHour?: number;
  weekly?: number;
  /** When the window resets (ms epoch). Live samples only: the app's file has no reset times. */
  fiveHourResetsAt?: number;
  weeklyResetsAt?: number;
  at: number;
  /** "app" = the desktop app's plan-usage-history.json, "live" = Claude Code's usage request (live usage). */
  source: "app" | "live";
}

let planCache: { key: string; sample: PlanSample | undefined } | undefined;

/** Latest plan-usage sample, any age (re-read only when the file changed). */
export function readPlanUsage(file = planUsageFile()): PlanSample | undefined {
  let key: string;
  try {
    const st = fs.statSync(file);
    key = `${file}|${st.mtimeMs}|${st.size}`;
  } catch {
    planCache = undefined;
    return undefined;
  }
  if (planCache?.key === key) return planCache.sample;
  let sample: PlanSample | undefined;
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8")) as { samples?: Array<{ t?: unknown; u?: { fh?: unknown; sd?: unknown } }> };
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const last = (Array.isArray(d.samples) ? d.samples : [])
      .filter((s) => s && typeof s.t === "number" && Number.isFinite(s.t))
      .sort((a, b) => (b.t as number) - (a.t as number))[0];
    if (last) sample = { fiveHour: num(last.u?.fh), weekly: num(last.u?.sd), at: last.t as number, source: "app" };
  } catch {
    sample = undefined;
  }
  planCache = { key, sample };
  return sample;
}

/** Transcript path for a Claude Code session id (searches the projects dir). */
export function transcriptFor(cliSessionId: string): string | undefined {
  const root = path.join(claudeConfigDir(), "projects");
  try {
    for (const p of fs.readdirSync(root)) {
      const f = path.join(root, p, `${cliSessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {
    // none
  }
  return undefined;
}

/** Tokens in the context window after the latest assistant turn, from the transcript tail. */
export function contextTokens(file: string): { tokens: number; model?: string } | undefined {
  let fd: number | undefined;
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const l of lines) {
      if (!l.includes('"assistant"') || !l.includes('"usage"')) continue;
      try {
        const rec = JSON.parse(l) as { type?: string; isSidechain?: boolean; message?: { model?: string; usage?: Record<string, number> } };
        if (rec.type !== "assistant" || rec.isSidechain) continue;
        const u = rec.message?.usage;
        if (!u) continue;
        const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
        if (tokens > 0) return { tokens, model: rec.message?.model };
      } catch {
        // partial line
      }
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return undefined;
}

/** Context window size: 1M for current Opus / Sonnet / Fable models, 200k otherwise. */
export const contextWindow = (model: string | undefined): number => (model && /opus-5|sonnet-5|fable|\[1m\]/.test(model) ? 1_000_000 : 200_000);

const k = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);

const pad2 = (n: number): string => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "21:41" (local time). */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "as of 12:39" (local time); "as of Oct 1" when the sample is more than a day old. */
export function asOf(at: number, now = Date.now()): string {
  const d = new Date(at);
  return now - at > DAY_MS ? `as of ${MONTHS[d.getMonth()]} ${d.getDate()}` : `as of ${clockTime(at)}`;
}

/**
 * When a window resets, short enough for the key's grey line (17 px): "resets 22:40" within a day (the 5-hour window
 * always), else the weekday ("resets Thu"), else — a week ahead, on today's weekday — the date ("resets Oct 9").
 * undefined when the time is unknown or already past.
 */
export function resetsLabel(resetsAt: number | undefined, now = Date.now()): string | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= now) return undefined;
  const d = new Date(resetsAt);
  if (resetsAt - now <= DAY_MS) return `resets ${clockTime(resetsAt)}`;
  if (d.getDay() !== new Date(now).getDay()) return `resets ${WEEKDAYS[d.getDay()]}`;
  return `resets ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

const valueOf = (view: "weekly" | "5-hour", s: PlanSample | undefined): number | undefined => (view === "weekly" ? s?.weekly : s?.fiveHour);

/** The newest sample that has the view's number. */
function newest(view: "weekly" | "5-hour", samples: Array<PlanSample | undefined>): PlanSample | undefined {
  let best: PlanSample | undefined;
  for (const s of samples) if (s && valueOf(view, s) !== undefined && (!best || s.at > best.at)) best = s;
  return best;
}

function planUsage(view: "weekly" | "5-hour", plan: PlanSample | undefined, now: number): Usage {
  const value = valueOf(view, plan);
  if (!plan || value === undefined) return { kind: "none", view, line1: "No usage recorded yet" };
  const other = valueOf(view === "weekly" ? "5-hour" : "weekly", plan);
  const fresh = plan.source === "live" && now - plan.at <= FRESH_MS;
  const resets = fresh ? resetsLabel(view === "weekly" ? plan.weeklyResetsAt : plan.fiveHourResetsAt, now) : undefined;
  return {
    kind: view,
    view,
    percent: Math.round(value),
    line1: resets ?? asOf(plan.at, now),
    line2: other === undefined ? undefined : `${view === "weekly" ? "5-hour" : "Weekly"} ${Math.round(other)}%`,
    updatedAt: plan.at,
    source: plan.source,
  };
}

function contextUsage(selected: Chat | undefined, now: number): Usage | undefined {
  if (!selected?.cliSessionId) return undefined;
  const f = transcriptFor(selected.cliSessionId);
  const ctx = f ? contextTokens(f) : undefined;
  if (!ctx) return undefined;
  const win = contextWindow(ctx.model ?? selected.model);
  return {
    kind: "context",
    view: "context",
    percent: Math.min(100, Math.round((ctx.tokens / win) * 100)),
    line1: `${k(ctx.tokens)} / ${k(win)}`,
    line2: selected.title,
    updatedAt: now,
  };
}

/** `live` = the latest sample from Claude Code's usage request (usage-live.ts), when there is one. */
export function computeUsage(selected: Chat | undefined, view: UsageView = "auto", now = Date.now(), live?: PlanSample): Usage {
  if (view === "context") return contextUsage(selected, now) ?? { kind: "none", view: "context", line1: selected ? "No context data yet" : "No chat selected" };
  const samples = [live, readPlanUsage()];
  if (view === "weekly" || view === "5-hour") return planUsage(view, newest(view, samples), now);
  // auto
  const weekly = newest("weekly", samples);
  if (weekly && now - weekly.at <= DAY_MS) return planUsage("weekly", weekly, now);
  const ctx = contextUsage(selected, now);
  if (ctx) return ctx;
  if (weekly) return planUsage("weekly", weekly, now);
  return { kind: "none" };
}
