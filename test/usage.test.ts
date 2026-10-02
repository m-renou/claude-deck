// Usage per view: plan samples (any age, "as of …"), the context window, auto, and "none" without data — a plan view
// never silently turns into Context. Private temp dirs for the app's files and transcripts.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Chat } from "../src/types.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-usage-test-"));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude-config");
process.env.CLAUDE_CODE_DECK_APP_DIR = path.join(tmp, "app-support");

type UsageMod = typeof import("../src/claude/usage.ts");
let usage: UsageMod;

const PLAN = path.join(tmp, "app-support", "plan-usage-history.json");
const NOW = new Date(2026, 9, 2, 15, 0).getTime(); // Oct 2, 15:00 local
const at = (h: number, m: number, day = 2) => new Date(2026, 9, day, h, m).getTime();

function writePlan(samples: Array<{ t: number; u: { fh?: number; sd?: number } }>): void {
  fs.mkdirSync(path.dirname(PLAN), { recursive: true });
  fs.writeFileSync(PLAN, JSON.stringify({ version: 1, samples: samples.map((s) => ({ org: "o", ...s })) }));
  // A rewrite within the same mtime tick must still be re-read.
  const t = new Date(Date.now() + Math.random() * 1e6);
  fs.utimesSync(PLAN, t, t);
}

function writeTranscript(cliSessionId: string, tokens: number): void {
  const dir = path.join(tmp, "claude-config", "projects", "-proj");
  fs.mkdirSync(dir, { recursive: true });
  const rec = { type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: tokens - 1000, output_tokens: 1000 } } };
  fs.writeFileSync(path.join(dir, `${cliSessionId}.jsonl`), `${JSON.stringify({ type: "user" })}\n${JSON.stringify(rec)}\n`);
}

const chat = (over: Partial<Chat> = {}): Chat => ({ id: "local_x", cliSessionId: "cli-x", title: "My chat", status: "idle", lastActivityAt: 0, lastFocusedAt: 0, live: false, model: "claude-opus-5-5", ...over });

before(async () => {
  usage = await import("../src/claude/usage.ts");
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  fs.rmSync(path.join(tmp, "app-support"), { recursive: true, force: true });
  fs.rmSync(path.join(tmp, "claude-config"), { recursive: true, force: true });
});

describe("plan views", () => {
  it("weekly: the latest sample, however old the app's last write is, with its time", () => {
    writePlan([
      { t: at(9, 0), u: { fh: 0, sd: 0 } },
      { t: at(12, 39), u: { fh: 9, sd: 11 } },
    ]);
    const u = usage.computeUsage(chat(), "weekly", NOW);
    assert.equal(u.kind, "weekly");
    assert.equal(u.percent, 11);
    assert.equal(u.line1, "as of 12:39");
    assert.equal(u.line2, "5-hour 9%");
  });

  it("5-hour likewise", () => {
    writePlan([{ t: at(12, 39), u: { fh: 9.4, sd: 11 } }]);
    const u = usage.computeUsage(chat(), "5-hour", NOW);
    assert.equal(u.kind, "5-hour");
    assert.equal(u.percent, 9);
    assert.equal(u.line1, "as of 12:39");
    assert.equal(u.line2, "Weekly 11%");
  });

  it("says the date when the sample is more than a day old", () => {
    writePlan([{ t: at(8, 5, 1) - 24 * 3600_000, u: { fh: 3, sd: 40 } }]);
    const u = usage.computeUsage(chat(), "weekly", NOW);
    assert.equal(u.kind, "weekly");
    assert.equal(u.line1, "as of Sep 30");
  });

  it("no sample → none with a message, never Context", () => {
    writeTranscript("cli-x", 420_000);
    for (const view of ["weekly", "5-hour"] as const) {
      const u = usage.computeUsage(chat(), view, NOW);
      assert.equal(u.kind, "none");
      assert.equal(u.view, view);
      assert.equal(u.line1, "No usage recorded yet");
    }
  });

  it("a sample without the requested number → none", () => {
    writePlan([{ t: at(12, 0), u: { sd: 11 } }]);
    assert.equal(usage.computeUsage(chat(), "5-hour", NOW).kind, "none");
    assert.equal(usage.computeUsage(chat(), "weekly", NOW).kind, "weekly");
  });
});

describe("context and auto", () => {
  it("context: tokens of the last assistant turn over the window", () => {
    writePlan([{ t: at(12, 39), u: { fh: 9, sd: 11 } }]);
    writeTranscript("cli-x", 420_000);
    const u = usage.computeUsage(chat(), "context", NOW);
    assert.equal(u.kind, "context");
    assert.equal(u.percent, 42);
    assert.equal(u.line1, "420k / 1M");
    assert.equal(u.line2, "My chat");
  });

  it("context without a transcript → none", () => {
    const u = usage.computeUsage(chat(), "context", NOW);
    assert.equal(u.kind, "none");
    assert.equal(u.view, "context");
  });

  it("auto: weekly when a sample from the last 24 h exists", () => {
    writePlan([{ t: at(12, 39), u: { fh: 9, sd: 11 } }]);
    writeTranscript("cli-x", 420_000);
    assert.equal(usage.computeUsage(chat(), "auto", NOW).kind, "weekly");
  });

  it("auto: context when the sample is older, the old sample when there's no context either", () => {
    writePlan([{ t: NOW - 3 * 24 * 3600_000, u: { fh: 1, sd: 50 } }]);
    writeTranscript("cli-x", 420_000);
    assert.equal(usage.computeUsage(chat(), "auto", NOW).kind, "context");
    assert.equal(usage.computeUsage(chat({ cliSessionId: "other" }), "auto", NOW).kind, "weekly");
  });

  it("auto with nothing at all → none", () => {
    assert.equal(usage.computeUsage(undefined, "auto", NOW).kind, "none");
  });
});

describe("readPlanUsage", () => {
  it("re-reads only when the file changed, and ignores junk", () => {
    writePlan([{ t: at(10, 0), u: { fh: 1, sd: 2 } }]);
    assert.equal(usage.readPlanUsage(PLAN)?.weekly, 2);
    writePlan([{ t: at(11, 0), u: { fh: 1, sd: 5 } }]);
    assert.equal(usage.readPlanUsage(PLAN)?.weekly, 5);
    fs.writeFileSync(PLAN, "{not json");
    fs.utimesSync(PLAN, new Date(), new Date(Date.now() + 5000));
    assert.equal(usage.readPlanUsage(PLAN), undefined);
    fs.rmSync(PLAN);
    assert.equal(usage.readPlanUsage(PLAN), undefined);
  });
});

// ── Live usage (Claude Code's usage request) next to the app's file ──────────────────────────────────────

describe("live samples", () => {
  type Sample = NonNullable<Parameters<UsageMod["computeUsage"]>[3]>;
  /** A live sample taken at `t` (local times, so the expected strings hold in any time zone). */
  const live = (t: number, over: Partial<Sample> = {}): Sample => ({
    at: t,
    source: "live",
    fiveHour: 3,
    weekly: 16,
    fiveHourResetsAt: at(17, 40),
    weeklyResetsAt: new Date(2026, 9, 8, 6, 59).getTime(), // Thursday
    ...over,
  });

  it("a fresh live sample wins over the app's file and shows when the window resets", () => {
    writePlan([{ t: at(12, 39), u: { fh: 9, sd: 11 } }]);
    const w = usage.computeUsage(chat(), "weekly", NOW, live(NOW - 60_000));
    assert.deepEqual([w.kind, w.percent, w.line1, w.line2, w.source], ["weekly", 16, "resets Thu", "5-hour 3%", "live"]);
    const f = usage.computeUsage(chat(), "5-hour", NOW, live(NOW - 60_000));
    assert.deepEqual([f.kind, f.percent, f.line1, f.line2, f.source], ["5-hour", 3, "resets 17:40", "Weekly 16%", "live"]);
  });

  it("an older live sample says how old it is, like the app's", () => {
    const u = usage.computeUsage(chat(), "weekly", NOW, live(NOW - usage.FRESH_MS - 1000));
    assert.equal(u.line1, "as of 14:56");
    assert.equal(usage.computeUsage(chat(), "weekly", NOW, live(NOW - usage.FRESH_MS)).line1, "resets Thu", "3 min is still fresh");
  });

  it("the newer source wins: the app's file when it's newer than the live sample", () => {
    writePlan([{ t: at(14, 50), u: { fh: 9, sd: 11 } }]);
    const u = usage.computeUsage(chat(), "weekly", NOW, live(at(14, 0)));
    assert.deepEqual([u.percent, u.line1, u.source], [11, "as of 14:50", "app"]);
    const v = usage.computeUsage(chat(), "weekly", NOW, live(at(14, 58)));
    assert.deepEqual([v.percent, v.line1, v.source], [16, "resets Thu", "live"]);
  });

  it("each view takes the newest sample that has its number", () => {
    writePlan([{ t: at(12, 39), u: { fh: 9, sd: 11 } }]);
    const noFiveHour = live(NOW - 30_000, { fiveHour: undefined, fiveHourResetsAt: undefined });
    const f = usage.computeUsage(chat(), "5-hour", NOW, noFiveHour);
    assert.deepEqual([f.percent, f.line1, f.source], [9, "as of 12:39", "app"]);
    const w = usage.computeUsage(chat(), "weekly", NOW, noFiveHour);
    assert.deepEqual([w.percent, w.line1, w.line2], [16, "resets Thu", undefined]);
  });

  it("without a reset time (or one already past) a fresh sample shows its time", () => {
    assert.equal(usage.computeUsage(chat(), "5-hour", NOW, live(NOW - 30_000, { fiveHourResetsAt: undefined })).line1, "as of 14:59");
    assert.equal(usage.computeUsage(chat(), "5-hour", NOW, live(NOW - 30_000, { fiveHourResetsAt: NOW - 1000 })).line1, "as of 14:59");
  });

  it("auto: weekly when either source has a sample from the last 24 h", () => {
    writeTranscript("cli-x", 420_000);
    writePlan([{ t: NOW - 3 * 24 * 3600_000, u: { fh: 1, sd: 50 } }]);
    assert.equal(usage.computeUsage(chat(), "auto", NOW).kind, "context");
    const u = usage.computeUsage(chat(), "auto", NOW, live(NOW - 60_000));
    assert.deepEqual([u.kind, u.percent, u.line1], ["weekly", 16, "resets Thu"]);
    assert.equal(usage.computeUsage(chat(), "auto", NOW, live(NOW - 2 * 24 * 3600_000)).kind, "context", "both too old");
    assert.equal(usage.computeUsage(chat({ cliSessionId: "other" }), "auto", NOW, live(NOW - 2 * 24 * 3600_000)).percent, 16, "the newer old sample");
  });

  it("context ignores live samples", () => {
    writeTranscript("cli-x", 420_000);
    assert.equal(usage.computeUsage(chat(), "context", NOW, live(NOW)).kind, "context");
  });
});

describe("resetsLabel", () => {
  const fri = (h: number, m: number) => new Date(2026, 9, 2, h, m).getTime(); // Oct 2, 2026 is a Friday
  const now = fri(15, 0);

  it("time of day within a day, else the weekday, else (a week ahead) the date", () => {
    assert.equal(usage.resetsLabel(fri(22, 40), now), "resets 22:40");
    assert.equal(usage.resetsLabel(new Date(2026, 9, 3, 6, 59).getTime(), now), "resets 06:59", "tomorrow morning, < 24 h");
    assert.equal(usage.resetsLabel(new Date(2026, 9, 3, 15, 0).getTime(), now), "resets 15:00", "exactly a day");
    assert.equal(usage.resetsLabel(new Date(2026, 9, 4, 9, 0).getTime(), now), "resets Sun");
    assert.equal(usage.resetsLabel(new Date(2026, 9, 8, 6, 59).getTime(), now), "resets Thu");
    assert.equal(usage.resetsLabel(new Date(2026, 9, 9, 6, 59).getTime(), now), "resets Oct 9", "next Friday on a Friday");
    assert.equal(usage.resetsLabel(new Date(2026, 9, 16, 6, 59).getTime(), now), "resets Oct 16");
  });

  it("nothing for unknown or past times", () => {
    assert.equal(usage.resetsLabel(undefined, now), undefined);
    assert.equal(usage.resetsLabel(now, now), undefined);
    assert.equal(usage.resetsLabel(now - 60_000, now), undefined);
    assert.equal(usage.resetsLabel(Number.NaN, now), undefined);
  });

  it("fits the key's grey line at 17 px (shrunk at most 2 px)", async () => {
    const { usageKey } = await import("../src/render/keys.ts");
    const texts = (s: string) => [...s.matchAll(/<text [^>]*font-size="([\d.]+)"[^>]*>([^<]*)<\/text>/g)].map((m) => [m[2], Number(m[1])] as const);
    for (const line1 of ["resets 22:40", "resets 00:00", "resets Wed", "resets Oct 28", "as of May 30"]) {
      const [, , l1, l2] = texts(usageKey({ kind: "weekly", percent: 16, line1, line2: "5-hour 100%" }));
      assert.equal(l1?.[0], line1, "not clipped");
      assert.ok(l1![1] >= 15 && l1![1] <= 17, `${line1} at ${l1![1]} px`);
      assert.equal(l2?.[0], "5-hour 100%");
    }
  });
});
