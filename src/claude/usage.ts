// Usage for the Usage key / dial / infobar, per view:
//   weekly / 5-hour  the latest plan sample the desktop app recorded in plan-usage-history.json
//                    ({t, u: {fh: 5-hour %, sd: weekly %}}). The app writes it only now and then, so any age is
//                    shown, with "as of 12:39" (or the date when it's older than a day). No sample → kind "none".
//   context          the selected chat's context window: last assistant message's token usage from its transcript tail.
//   auto             weekly when a sample from the last 24 h exists, else context (else the older sample).
// A plan view never silently turns into context.

import fs from "node:fs";
import path from "node:path";
import type { Chat, Usage } from "../types.ts";
import { claudeConfigDir, planUsageFile } from "./paths.ts";

export type UsageView = "auto" | "weekly" | "5-hour" | "context";

const DAY_MS = 24 * 60 * 60_000;

export interface PlanSample {
  fiveHour?: number;
  weekly?: number;
  at: number;
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
    if (last) sample = { fiveHour: num(last.u?.fh), weekly: num(last.u?.sd), at: last.t as number };
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

/** "as of 12:39" (local time); "as of Oct 1" when the sample is more than a day old. */
export function asOf(at: number, now = Date.now()): string {
  const d = new Date(at);
  return now - at > DAY_MS ? `as of ${MONTHS[d.getMonth()]} ${d.getDate()}` : `as of ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function planUsage(view: "weekly" | "5-hour", plan: PlanSample | undefined, now: number): Usage {
  const value = view === "weekly" ? plan?.weekly : plan?.fiveHour;
  if (!plan || value === undefined) return { kind: "none", view, line1: "No usage recorded yet" };
  const other = view === "weekly" ? plan.fiveHour : plan.weekly;
  return {
    kind: view,
    view,
    percent: Math.round(value),
    line1: asOf(plan.at, now),
    line2: other === undefined ? undefined : `${view === "weekly" ? "5-hour" : "Weekly"} ${Math.round(other)}%`,
    updatedAt: plan.at,
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

export function computeUsage(selected: Chat | undefined, view: UsageView = "auto", now = Date.now()): Usage {
  if (view === "context") return contextUsage(selected, now) ?? { kind: "none", view: "context", line1: selected ? "No context data yet" : "No chat selected" };
  const plan = readPlanUsage();
  if (view === "weekly" || view === "5-hour") return planUsage(view, plan, now);
  // auto
  if (plan && plan.weekly !== undefined && now - plan.at <= DAY_MS) return planUsage("weekly", plan, now);
  const ctx = contextUsage(selected, now);
  if (ctx) return ctx;
  if (plan && plan.weekly !== undefined) return planUsage("weekly", plan, now);
  return { kind: "none" };
}
