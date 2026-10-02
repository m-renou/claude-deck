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
