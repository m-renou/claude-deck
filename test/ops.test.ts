// ops.ts + hub.ts: cycling, what each key asks the control layer to do, early failures, skipping re-opening a chat
// that's already shown, the optimistic overlay and background confirmation. control.ts runs with a fake process
// runner (no osascript, no `open`), the process gets an empty PATH, and the Claude dirs are private temp dirs holding
// hand-written chat files. Nothing calls hub.start().

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Chat, ModelInfo, Snapshot } from "../src/types.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-ops-test-"));
process.env.PATH = path.join(tmp, "empty-bin");
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude-config");
process.env.CLAUDE_CODE_DECK_APP_DIR = path.join(tmp, "app-support");
process.env.CLAUDE_CODE_DECK_UI_CACHE = path.join(tmp, "cfg", "ui-cache.json");
const SESSIONS = path.join(tmp, "app-support", "claude-code-sessions", "acct", "org");

type Ops = typeof import("../src/ops.ts");
type HubModule = typeof import("../src/hub.ts");
type Control = typeof import("../src/claude/control.ts");
let ops: Ops;
let hubMod: HubModule;
let control: Control;

const MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", name: "Opus 5.5", shortName: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"], fast: false },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", shortName: "Sonnet", efforts: ["low", "medium", "high"], fast: false },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", shortName: "Haiku", efforts: [], fast: false },
];

const chat = (over: Partial<Chat> = {}): Chat => ({
  id: "local_test",
  title: "Test chat",
  status: "idle",
  lastActivityAt: 0,
  lastFocusedAt: 0,
  live: false,
  ...over,
});

/** Early-failure tests: a snapshot without chat files (refresh would replace it, so these never refresh). */
function setSelected(selected: Chat | undefined): void {
  const snap: Snapshot = { chats: selected ? [selected] : [], selected, models: MODELS, usage: { kind: "none" }, app: { installed: true, running: true } };
  hubMod.hub.snapshot = snap;
}

/** Make a chat file look older (written before the presses that follow). */
function age(id: string, ms = 60_000): void {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(path.join(SESSIONS, `${id}.json`), t, t);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Let the clock pass the press before the app "writes" the session file: only a file written after a press confirms it,
 *  and a file's mtime can trail Date.now() by a clock tick (a few ms on Linux, ~16 ms on Windows). */
const afterPress = () => sleep(40);

/** A chat file the way the desktop app writes it. */
function writeChat(id: string, over: Record<string, unknown> = {}): void {
  fs.mkdirSync(SESSIONS, { recursive: true });
  const file = path.join(SESSIONS, `${id}.json`);
  const prev = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  const now = Date.now();
  fs.writeFileSync(
    file,
    JSON.stringify({ sessionId: id, title: id, model: "claude-opus-5-5", effort: "high", createdAt: now - 60_000, lastActivityAt: now - 60_000, lastFocusedAt: now - 30_000, ...prev, ...over }),
  );
}

interface Call {
  cmd: string;
  args: string[];
  req?: Record<string, unknown>;
  at: number;
}

let calls: Call[] = [];
let reply: (req: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true });

const jxaCalls = () => calls.filter((c) => c.cmd === "osascript").map((c) => c.req!);
const opens = () => calls.filter((c) => c.cmd === "open").map((c) => c.args[0]);

before(async () => {
  control = await import("../src/claude/control.ts");
  ops = await import("../src/ops.ts");
  hubMod = await import("../src/hub.ts");
  control.setExec(async (cmd, args) => {
    const call: Call = { cmd, args, at: Date.now() };
    calls.push(call);
    if (cmd !== "osascript") return { code: 0, stdout: "", stderr: "" };
    call.req = JSON.parse(args[args.length - 1]!) as Record<string, unknown>;
    return { code: 0, stdout: JSON.stringify(reply(call.req)), stderr: "" };
  });
});

after(() => {
  control?.setExec();
  hubMod?.hub.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  reply = () => ({ ok: true });
  fs.rmSync(path.join(tmp, "app-support"), { recursive: true, force: true });
  ops.timing.confirmMs = 3000;
  ops.timing.pollMs = 200;
  ops.resetEffortKnowledge();
  hubMod.hub.snapshot = { ...hubMod.hub.snapshot, app: { installed: true, running: true } };
});

afterEach(() => {
  ops.cancelConfirmations();
  hubMod.hub.stop();
  hubMod.hub.forget();
});

// ── Pure cycling ────────────────────────────────────────────────────────────────────────────────────────────

describe("model slots", () => {
  it("defaults to Fable 5.1, then Opus 5.5", async () => {
    assert.deepEqual(ops.DEFAULT_MODEL_SLOTS, ["claude-fable-5-1", "claude-opus-5-5"]);
    // the very lists the keys and Property Inspectors use (one source: the catalog)
    const catalog = await import("../src/claude/catalog.ts");
    const settings = await import("../src/actions/settings.ts");
    const logic = await import("../src/actions/logic.ts");
    assert.equal(ops.DEFAULT_MODEL_SLOTS, catalog.DEFAULT_MODEL_SLOTS);
    assert.equal(settings.DEFAULT_MODEL_SLOTS, catalog.DEFAULT_MODEL_SLOTS);
    assert.equal(ops.DEFAULT_EFFORT_CYCLE, catalog.DEFAULT_EFFORT_CYCLE);
    assert.equal(logic.DEFAULT_EFFORT_CYCLE, catalog.DEFAULT_EFFORT_CYCLE);
    assert.deepEqual(ops.modelSlots(undefined), ["claude-fable-5-1", "claude-opus-5-5"]);
    assert.deepEqual(ops.modelSlots(["", "  "]), ["claude-fable-5-1", "claude-opus-5-5"]);
  });

  it("cycles through the slots only, and starts at slot 1 from any other model", () => {
    const slots = ops.DEFAULT_MODEL_SLOTS;
    assert.equal(ops.nextModelSlot("claude-fable-5-1", slots), "claude-opus-5-5");
    assert.equal(ops.nextModelSlot("claude-opus-5-5", slots), "claude-fable-5-1");
    assert.equal(ops.nextModelSlot("claude-sonnet-5-5", slots), "claude-fable-5-1");
    assert.equal(ops.nextModelSlot(undefined, slots), "claude-fable-5-1");
    assert.equal(ops.nextModelSlot("claude-opus-5-5[1m]", slots), "claude-fable-5-1");
  });

  it("drops blank, unknown and repeated slots", () => {
    assert.deepEqual(ops.modelSlots(["claude-opus-5-5", "", "none", "claude-opus-5-5", "claude-gone-1", "claude-haiku-4-5-20251001"]), ["claude-opus-5-5", "claude-haiku-4-5-20251001"]);
    assert.deepEqual(ops.modelSlots(["none", "none"]), ["claude-fable-5-1", "claude-opus-5-5"]);
  });

  it("nextModel (whole menu) still steps and wraps", () => {
    assert.equal(ops.nextModel("claude-opus-5-5", MODELS), "claude-sonnet-5-5");
    assert.equal(ops.nextModel("claude-haiku-4-5-20251001", MODELS), "claude-opus-5-5");
    assert.equal(ops.nextModel(undefined, MODELS), "claude-opus-5-5");
  });
});

describe("effort stops and cycling", () => {
  it("stops = the model's levels, then Ultracode; none for Haiku", () => {
    assert.deepEqual(ops.effortStops("claude-opus-5-5", MODELS), ["low", "medium", "high", "xhigh", "max", "ultracode"]);
    assert.deepEqual(ops.effortStops("claude-sonnet-5-5", MODELS), ["low", "medium", "high", "ultracode"]);
    assert.deepEqual(ops.effortStops("claude-haiku-4-5-20251001", MODELS), []);
    assert.equal(ops.effortStops("claude-opus-5-5", MODELS).indexOf("ultracode"), 5);
  });

  it("the default cycle ends with Ultracode", () => {
    assert.deepEqual(ops.DEFAULT_EFFORT_CYCLE, ["low", "medium", "high", "xhigh", "max", "ultracode"]);
    const stops = ops.effortStops("claude-opus-5-5", MODELS);
    assert.equal(ops.nextEffort(chat({ effort: "max" }), ops.DEFAULT_EFFORT_CYCLE, stops), "ultracode");
    assert.equal(ops.nextEffort(chat({ effort: "xhigh", ultracode: true }), ops.DEFAULT_EFFORT_CYCLE, stops), "low");
    assert.equal(ops.nextEffort(chat({ effort: "low" }), ops.DEFAULT_EFFORT_CYCLE, stops), "medium");
  });

  it("the Ultracode flag wins over the effort level", () => {
    assert.equal(ops.currentEffort(chat({ effort: "xhigh", ultracode: true })), "ultracode");
    assert.equal(ops.currentEffort(chat({ effort: "xhigh" })), "xhigh");
  });

  it("skips cycle entries that aren't stops, and steps up from a level outside the cycle", () => {
    const sonnet = ops.effortStops("claude-sonnet-5-5", MODELS);
    assert.equal(ops.nextEffort(chat({ effort: "high" }), ["high", "max", "ultracode"], sonnet), "ultracode");
    assert.equal(ops.nextEffort(chat({ effort: "medium" }), ["high", "ultracode"], sonnet), "high");
    assert.equal(ops.nextEffort(chat({}), ["high", "max"]), "high");
    assert.equal(ops.nextEffort(chat({ effort: "low" }), ["high", "max"]), "high");
    assert.equal(ops.nextEffort(chat({ effort: "max", ultracode: true }), ["high", "max"]), "high");
  });
});

// ── Early failures ──────────────────────────────────────────────────────────────────────────────────────────

describe("early failures (nothing is sent)", () => {
  it("run skill needs a skill", async () => {
    setSelected(chat());
    assert.match((await ops.runSkill("/")).message, /Pick a skill/);
    assert.equal(calls.length, 0);
  });

  it("everything that targets a chat fails without one", async () => {
    setSelected(undefined);
    for (const r of [await ops.sendText("hi"), await ops.sendText(), await ops.stop(), await ops.setModel("next"), await ops.setEffort("next"), await ops.toggleFast()]) {
      assert.equal(r.ok, false);
      assert.equal(r.feedback, "alert");
      assert.match(r.message, /No Claude Code chat found/);
    }
    assert.equal(calls.length, 0);
  });

  it("stop refuses a chat that isn't working", async () => {
    setSelected(chat({ status: "done", title: "Idle one" }));
    const r = await ops.stop();
    assert.equal(r.ok, false);
    assert.match(r.message, /isn't working/);
    assert.equal(calls.length, 0);
  });

  it("setModel refuses a model that isn't in the menu", async () => {
    setSelected(chat({ model: "claude-opus-5-5" }));
    const r = await ops.setModel("claude-nonexistent-1");
    assert.equal(r.ok, false);
    assert.match(r.message, /isn't in the app's model menu/);
  });

  it("setEffort refuses a model without effort levels", async () => {
    setSelected(chat({ model: "claude-haiku-4-5-20251001" }));
    const r = await ops.setEffort("next");
    assert.equal(r.ok, false);
    assert.match(r.message, /no effort setting/);
  });

  it("setEffort refuses a level the model doesn't have", async () => {
    setSelected(chat({ model: "claude-opus-5-5", effort: "low" }));
    const r = await ops.setEffort("turbo");
    assert.equal(r.ok, false);
    assert.match(r.message, /isn't available/);
  });

  it("toggleFast refuses a model without fast mode", async () => {
    setSelected(chat({ model: "claude-opus-5-5" }));
    const r = await ops.toggleFast();
    assert.equal(r.ok, false);
    assert.match(r.message, /Fast mode isn't available/);
  });
});

// ── With chat files ─────────────────────────────────────────────────────────────────────────────────────────

/** Pretend the live roster reports this chat as working (until the next refresh). */
function markWorking(id: string, working = true): void {
  const snap = hubMod.hub.snapshot;
  const set = (c: Chat): Chat => (c.id === id ? { ...c, status: working ? "working" : "idle" } : c);
  hubMod.hub.snapshot = { ...snap, chats: snap.chats.map(set), selected: snap.selected ? set(snap.selected) : undefined };
}

/** One chat, focused in the app (so it is the selected and the shown one). */
function oneChat(over: Record<string, unknown> = {}): string {
  writeChat("local_a", { lastFocusedAt: Date.now() - 1000, ...over });
  hubMod.hub.refresh(true);
  assert.equal(hubMod.hub.snapshot.selected?.id, "local_a");
  return "local_a";
}

describe("send prompt / steer / run skill", () => {
  it("an empty key submits the prompt box (Return only, no text)", async () => {
    oneChat();
    const r = await ops.sendText("");
    assert.equal(r.ok, true, r.message);
    const [req] = jxaCalls();
    assert.equal(req!.op, "prompt");
    assert.equal(req!.text, undefined);
    assert.equal(req!.submit, true);
    assert.match(r.message, /prompt box/);
  });

  it("an empty key with an empty box says so", async () => {
    oneChat();
    reply = () => ({ ok: false, error: "prompt-empty" });
    const r = await ops.steer(undefined);
    assert.equal(r.ok, false);
    assert.equal(r.message, "The prompt box is empty.");
  });

  it("configured text requires an empty box, and refuses a draft", async () => {
    oneChat();
    reply = () => ({ ok: false, error: "draft-not-empty", draft: "my half-written idea" });
    const r = await ops.sendText("  Run the tests  ");
    assert.equal(r.ok, false);
    assert.match(r.message, /already has text/);
    const [req] = jxaCalls();
    assert.equal(req!.text, "Run the tests");
    assert.equal(req!.requireEmpty, true);
  });

  it("run skill types /skill args", async () => {
    oneChat();
    await ops.runSkill("/code-review", " src ");
    assert.equal(jxaCalls()[0]!.text, "/code-review src");
    assert.equal(jxaCalls()[0]!.requireEmpty, true);
  });

  it("doesn't re-open the chat the app already shows", async () => {
    oneChat();
    await ops.sendText("hi");
    assert.deepEqual(opens(), []);
  });

  it("opens the chat when the app shows another one, and remembers that it's shown", async () => {
    writeChat("local_a", { lastFocusedAt: Date.now() - 5000 });
    writeChat("local_b", { lastFocusedAt: Date.now() - 1000 });
    hubMod.hub.refresh(true);
    hubMod.hub.markSeen("local_a"); // picked on the deck, the app still shows local_b
    assert.equal(hubMod.hub.snapshot.selected?.id, "local_a");
    assert.equal(hubMod.hub.isShown("local_a"), false);
    await ops.sendText("hi");
    assert.deepEqual(opens(), ["claude://code/continue?session=local_a"]);
    assert.equal(hubMod.hub.isShown("local_a"), true);
    calls = [];
    await ops.sendText("again");
    assert.deepEqual(opens(), []);
  });

  it("an Activity key's open counts as shown", async () => {
    writeChat("local_a", { lastFocusedAt: Date.now() - 5000 });
    writeChat("local_b", { lastFocusedAt: Date.now() - 1000 });
    hubMod.hub.refresh(true);
    const a = hubMod.hub.snapshot.chats.find((c) => c.id === "local_a")!;
    await ops.openChatOp(a);
    calls = [];
    await ops.sendText("hi");
    assert.deepEqual(opens(), []);
  });

  it("when the prompt box isn't there, opens the chat and tries once more", async () => {
    oneChat();
    let n = 0;
    reply = () => (n++ === 0 ? { ok: false, error: "prompt-not-found" } : { ok: true, cleared: true });
    const r = await ops.sendText("hi");
    assert.equal(r.ok, true, r.message);
    assert.equal(jxaCalls().length, 2);
    assert.deepEqual(opens(), ["claude://code/continue?session=local_a"]);
  });

  it("the first, no-open attempt never searches the window; only the retry (chat opened) does", async () => {
    oneChat();
    let n = 0;
    reply = () => (n++ === 0 ? { ok: false, error: "prompt-not-found" } : { ok: true, cleared: true });
    await ops.sendText("hi");
    const [first, retry] = jxaCalls();
    assert.equal(first!.scan, false);
    assert.equal("scan" in retry!, false);
  });

  it("a chat that is opened right away may search (no scan: false)", async () => {
    writeChat("local_a", { lastFocusedAt: Date.now() - 5000 });
    writeChat("local_b", { lastFocusedAt: Date.now() - 1000 });
    hubMod.hub.refresh(true);
    hubMod.hub.markSeen("local_a");
    await ops.sendText("hi");
    assert.equal("scan" in jxaCalls()[0]!, false);
  });

  it("with Claude quit, the chat link is sent (it launches the app) even for the last shown chat", async () => {
    oneChat();
    hubMod.hub.snapshot = { ...hubMod.hub.snapshot, app: { installed: true, running: false } };
    await ops.sendText("hi");
    assert.deepEqual(opens(), ["claude://code/continue?session=local_a"]);
  });

  it("an Activity key's open keeps the app's switch time inside the queue", async () => {
    writeChat("local_a", { lastFocusedAt: Date.now() - 5000 });
    writeChat("local_b", { lastFocusedAt: Date.now() - 1000 });
    hubMod.hub.refresh(true);
    const a = hubMod.hub.snapshot.chats.find((c) => c.id === "local_a")!;
    const opened = ops.openChatOp(a);
    const sent = ops.sendText("hi"); // pressed right after
    await Promise.all([opened, sent]);
    const link = calls.find((c) => c.cmd === "open")!;
    const jxa = calls.find((c) => c.cmd === "osascript")!;
    assert.ok(jxa.at - link.at >= 390, `the prompt job started ${jxa.at - link.at} ms after the link`);
  });

  it("New Chat waits for a job already running (it can't switch the app mid-job)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = control.serial(() => gate);
    const fresh = ops.newChat();
    await sleep(20);
    assert.deepEqual(opens(), []);
    release();
    const r = await fresh;
    await job;
    assert.equal(r.ok, true);
    assert.deepEqual(opens(), ["claude://code/new"]);
  });

  it("stop is Esc, and the only key that sends it", async () => {
    oneChat();
    markWorking("local_a");
    const r = await ops.stop();
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(jxaCalls()[0]!.keys, [{ code: 53 }]);
  });

  it("stop re-checks inside the queue: a chat that stopped working meanwhile gets no Esc", async () => {
    oneChat();
    markWorking("local_a");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = control.serial(() => gate); // a slow job ahead of Stop
    const stopping = ops.stop();
    await sleep(10);
    markWorking("local_a", false); // the turn ended while Stop waited
    release();
    await job;
    const r = await stopping;
    assert.equal(r.ok, false);
    assert.match(r.message, /stopped working before Esc/);
    assert.deepEqual(jxaCalls(), []);
  });

  it("stop only sends Esc while a Code chat is shown; otherwise it opens the chat first", async () => {
    oneChat();
    markWorking("local_a");
    reply = (req) => (req.op === "prompt" ? { ok: true, path: [7, 7] } : req.checkPath ? { ok: false, error: "prompt-not-found" } : { ok: true });
    await control.focusPrompt(); // caches the prompt box's path
    calls = [];
    const r = await ops.stop();
    assert.equal(r.ok, true, r.message);
    const [first, retry] = jxaCalls();
    assert.deepEqual(first!.checkPath, [7, 7]);
    assert.equal("checkPath" in retry!, false);
    assert.deepEqual(opens(), ["claude://code/continue?session=local_a"]);
  });
});

describe("model key", () => {
  it("cycles the slots: Opus → Fable is row 2 of the app's menu (⌘⇧I 2)", async () => {
    oneChat({ model: "claude-opus-5-5" });
    const r = await ops.setModel("next");
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, "Fable 5.1");
    assert.deepEqual(jxaCalls(), [{ bundle: "com.anthropic.claudefordesktop", op: "model", index: 1 }]);
  });

  it("shows the new model at once, and a quick second press steps on from it", async () => {
    oneChat({ model: "claude-opus-5-5" });
    await ops.setModel("next");
    const sel = hubMod.hub.snapshot.selected!;
    assert.equal(sel.model, "claude-fable-5-1");
    assert.equal(sel.pending, true);
    await ops.setModel("next"); // the file still says Opus
    assert.deepEqual(
      jxaCalls().map((r) => r.index),
      [1, 0],
    );
    assert.equal(hubMod.hub.snapshot.selected!.model, "claude-opus-5-5");
  });

  it("a model outside the slots goes to slot 1", async () => {
    oneChat({ model: "claude-sonnet-5-5" });
    await ops.setModel("next", ["claude-opus-5-5", "claude-fable-5-1"]);
    assert.equal(jxaCalls()[0]!.index, 0);
  });

  it("returns right away and confirms from the session file in the background", async () => {
    oneChat({ model: "claude-opus-5-5" });
    ops.timing.pollMs = 10;
    let late: unknown;
    const r = await ops.setModel("claude-fable-5-1", undefined, (x) => (late = x));
    assert.equal(r.ok, true);
    await afterPress();
    writeChat("local_a", { model: "claude-fable-5-1" }); // the app wrote it
    await new Promise((res) => setTimeout(res, 60));
    hubMod.hub.refresh();
    assert.equal(late, undefined);
    assert.equal(hubMod.hub.snapshot.selected!.model, "claude-fable-5-1");
    assert.equal(hubMod.hub.snapshot.selected!.pending, undefined);
  });

  it("calls onLate when the file never confirms, and drops the optimistic value", async () => {
    oneChat({ model: "claude-opus-5-5" });
    ops.timing.confirmMs = 60;
    ops.timing.pollMs = 10;
    const late = await new Promise<{ ok: boolean; message: string }>((resolve) => {
      void ops.setModel("claude-fable-5-1", undefined, resolve);
    });
    assert.equal(late.ok, false);
    assert.match(late.message, /didn't switch to Fable 5\.1/);
    assert.equal(hubMod.hub.snapshot.selected!.model, "claude-opus-5-5");
  });

  it("three quick presses alternate even while the file still holds the old model (Opus → Fable → Opus → Fable)", async () => {
    oneChat({ model: "claude-opus-5-5" });
    age("local_a");
    hubMod.hub.refresh(true);
    await ops.setModel("next"); // P1: Fable
    await ops.setModel("next"); // P2: back to Opus — the old file says Opus too, but that's not a confirmation
    assert.equal(hubMod.hub.snapshot.selected!.model, "claude-opus-5-5");
    assert.equal(hubMod.hub.snapshot.selected!.pending, true);
    await afterPress();
    writeChat("local_a", { model: "claude-fable-5-1" }); // P1's switch lands
    hubMod.hub.refresh(true);
    assert.equal(hubMod.hub.snapshot.selected!.model, "claude-opus-5-5", "P2's value is still the one shown");
    await ops.setModel("next"); // P3: Fable
    assert.deepEqual(
      jxaCalls().map((r) => r.index),
      [1, 0, 1],
    );
  });

  it("the old file doesn't confirm a press in the background either", async () => {
    oneChat({ model: "claude-opus-5-5" });
    age("local_a");
    hubMod.hub.refresh(true);
    ops.timing.pollMs = 10;
    ops.timing.confirmMs = 80;
    const late = await new Promise<{ ok: boolean; message: string }>((resolve) => {
      void (async () => {
        await ops.setModel("next", undefined, resolve); // Fable
        await ops.setModel("next", undefined, resolve); // Opus: the file says Opus, but from before the press
      })();
    });
    assert.equal(late.ok, false);
    assert.match(late.message, /didn't switch to Opus 5\.5/);
  });

  it("when the model menu didn't open, opens the chat and tries once more", async () => {
    oneChat({ model: "claude-opus-5-5" });
    let n = 0;
    reply = () => (n++ === 0 ? { ok: false, error: "model-menu-not-open" } : { ok: true });
    const r = await ops.setModel("next");
    assert.equal(r.ok, true, r.message);
    assert.equal(jxaCalls().length, 2);
    assert.deepEqual(opens(), ["claude://code/continue?session=local_a"]);
  });

  it("a menu that never opens types nothing and says so", async () => {
    oneChat({ model: "claude-opus-5-5" });
    reply = () => ({ ok: false, error: "model-menu-not-open" });
    const r = await ops.setModel("next");
    assert.equal(r.ok, false);
    assert.match(r.message, /model menu didn't open/);
    assert.equal(hubMod.hub.snapshot.selected!.model, "claude-opus-5-5");
  });

  it("the app's other models aren't taken for the main ones (Fable 5 isn't Fable 5.1)", async () => {
    const catalog = await import("../src/claude/catalog.ts");
    const all: ModelInfo[] = [
      { id: "claude-opus-5-5", name: "Opus 5.5", shortName: "Opus", efforts: ["low"], fast: false },
      { id: "claude-fable-5-1", name: "Fable 5.1", shortName: "Fable", efforts: ["low"], fast: false },
      { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", shortName: "Haiku", efforts: [], fast: false },
    ];
    assert.equal(catalog.modelInfo("claude-fable-5", all), undefined);
    assert.equal(catalog.modelInfo("claude-opus-5", all), undefined);
    assert.equal(catalog.modelInfo("claude-opus-4-8", all), undefined);
    assert.equal(catalog.modelInfo("claude-opus-5-5[1m]", all)?.id, "claude-opus-5-5");
    assert.equal(catalog.modelInfo("claude-haiku-4-5", all)?.id, "claude-haiku-4-5-20251001");
    assert.equal(catalog.modelInfo("claude-haiku-4-5-20251001[1m]", all)?.id, "claude-haiku-4-5-20251001");
    assert.equal(catalog.modelName("claude-fable-5", all), "Fable 5");
    assert.equal(hubMod.sameModel("claude-fable-5", "claude-fable-5-1"), false);
    // a chat on Fable 5 goes to slot 1 (Fable 5.1), and a Fable 5.1 key doesn't say "Already on"
    assert.equal(ops.nextModelSlot("claude-fable-5", ops.DEFAULT_MODEL_SLOTS), "claude-fable-5-1");
    oneChat({ model: "claude-fable-5" });
    const r = await ops.setModel("claude-fable-5-1");
    assert.equal(r.message, "Fable 5.1");
    assert.equal(jxaCalls().length, 1);
  });

  it("a failed press drops the optimistic value at once", async () => {
    oneChat({ model: "claude-opus-5-5" });
    reply = () => ({ ok: false, error: "not-frontmost" });
    const r = await ops.setModel("next");
    assert.equal(r.ok, false);
    assert.match(r.message, /didn't come to the front/);
    assert.equal(hubMod.hub.snapshot.selected!.model, "claude-opus-5-5");
  });
});

describe("effort key", () => {
  it("Ultracode → next = Low: slider stop 0 of 6", async () => {
    oneChat({ effort: "xhigh", sessionSettings: { ultracode: true } });
    reply = () => ({ ok: true, from: 5, to: 0 });
    const r = await ops.setEffort("next");
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(jxaCalls(), [{ bundle: "com.anthropic.claudefordesktop", op: "effort", target: 0, stops: 6 }]);
    const sel = hubMod.hub.snapshot.selected!;
    assert.equal(sel.effort, "low");
    assert.equal(sel.ultracode, false);
  });

  it("Max → next = Ultracode: stop 5, shown as Ultracode at once", async () => {
    oneChat({ effort: "max" });
    reply = () => ({ ok: true, from: 4, to: 5 });
    const r = await ops.setEffort("next");
    assert.equal(r.message, "Ultra");
    assert.equal(jxaCalls()[0]!.target, 5);
    assert.equal(hubMod.hub.snapshot.selected!.ultracode, true);
  });

  it("a fixed level: Ultracode → Max is stop 4", async () => {
    oneChat({ effort: "xhigh", sessionSettings: { ultracode: true } });
    await ops.setEffort("max");
    assert.equal(jxaCalls()[0]!.target, 4);
  });

  it("quick presses step from the pending value", async () => {
    oneChat({ effort: "high" });
    await ops.setEffort("next");
    await ops.setEffort("next");
    await ops.setEffort("next");
    assert.deepEqual(
      jxaCalls().map((r) => r.target),
      [3, 4, 5],
    );
  });

  it("a key's own cycle", async () => {
    oneChat({ effort: "high" });
    await ops.setEffort("next", ["high", "ultracode"]);
    assert.equal(jxaCalls()[0]!.target, 5);
  });

  it("when the slider doesn't open, opens the chat and tries once more", async () => {
    oneChat({ effort: "high" });
    let n = 0;
    reply = () => (n++ === 0 ? { ok: false, error: "effort-not-open" } : { ok: true, from: 2, to: 3 });
    const r = await ops.setEffort("next");
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(opens(), ["claude://code/continue?session=local_a"]);
  });

  it("a slider without an Ultracode stop: next from Max wraps to Low (and remembers it)", async () => {
    oneChat({ model: "claude-fable-5-1", effort: "max" });
    reply = (req) => (req.target === 5 ? { ok: false, error: "effort-range", from: 4, max: 4 } : { ok: true, from: 4, to: Number(req.target), max: 4 });
    const r = await ops.setEffort("next");
    assert.equal(r.ok, true, r.message);
    assert.equal(r.message, "Low");
    assert.deepEqual(
      jxaCalls().map((q) => [q.target, q.stops]),
      [
        [5, 6],
        [0, 5],
      ],
    );
    assert.deepEqual(ops.effortStops("claude-fable-5-1"), ["low", "medium", "high", "xhigh", "max"]);
    calls = [];
    writeChat("local_a", { effort: "max" });
    hubMod.hub.clearPending("local_a");
    hubMod.hub.refresh(true);
    await ops.setEffort("next");
    assert.deepEqual(
      jxaCalls().map((q) => q.target),
      [0],
    );
    const fixed = await ops.setEffort("ultracode");
    assert.equal(fixed.ok, false);
    assert.match(fixed.message, /doesn't offer Ultracode for Fable 5\.1/);
  });

  it("confirms Ultracode from the session file", async () => {
    oneChat({ effort: "max" });
    ops.timing.pollMs = 10;
    ops.timing.confirmMs = 200;
    let late: unknown;
    await ops.setEffort("ultracode", undefined, (x) => (late = x));
    await afterPress();
    writeChat("local_a", { effort: "xhigh", sessionSettings: { ultracode: true } });
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(late, undefined);
  });
});

describe("hub: optimistic values", () => {
  it("overlays until the file agrees", async () => {
    const id = oneChat({ effort: "high" });
    hubMod.hub.setPending(id, { effort: "max", ultracode: false });
    assert.equal(hubMod.hub.snapshot.selected!.effort, "max");
    assert.equal(hubMod.hub.snapshot.selected!.pending, true);
    await afterPress();
    writeChat(id, { effort: "max" });
    hubMod.hub.refresh();
    assert.equal(hubMod.hub.snapshot.selected!.effort, "max");
    assert.equal(hubMod.hub.snapshot.selected!.pending, undefined);
    assert.equal(hubMod.hub.pendingFor(id), undefined);
  });

  it("expires after its TTL", async () => {
    const id = oneChat({ effort: "high" });
    hubMod.hub.setPending(id, { effort: "low" }, 30);
    assert.equal(hubMod.hub.snapshot.selected!.effort, "low");
    await new Promise((res) => setTimeout(res, 60));
    hubMod.hub.refresh();
    assert.equal(hubMod.hub.snapshot.selected!.effort, "high");
  });

  it("merges patches; undefined removes a pending key", () => {
    const id = oneChat({ effort: "high" });
    hubMod.hub.setPending(id, { effort: "max", ultracode: false });
    hubMod.hub.setPending(id, { ultracode: true, effort: undefined });
    assert.deepEqual(hubMod.hub.pendingFor(id), { ultracode: true });
    hubMod.hub.clearPending(id);
    assert.equal(hubMod.hub.pendingFor(id), undefined);
  });

  it("a file from before the press doesn't confirm it, even when it holds the same value", async () => {
    const id = oneChat({ model: "claude-opus-5-5" });
    age(id);
    hubMod.hub.refresh(true);
    hubMod.hub.setPending(id, { model: "claude-opus-5-5" });
    assert.equal(hubMod.hub.snapshot.selected!.pending, true);
    await afterPress();
    writeChat(id, { model: "claude-opus-5-5" }); // written after the press
    hubMod.hub.refresh();
    assert.equal(hubMod.hub.snapshot.selected!.pending, undefined);
  });

  it("each pending value keeps its own TTL; armPending restarts it once the keys went out", async () => {
    const id = oneChat({ effort: "high", model: "claude-opus-5-5" });
    age(id);
    hubMod.hub.refresh(true);
    hubMod.hub.setPending(id, { model: "claude-fable-5-1" }, 60_000);
    hubMod.hub.setPending(id, { effort: "max" }, 60_000);
    hubMod.hub.armPending(id, ["model"], 30);
    await sleep(60);
    hubMod.hub.refresh();
    assert.deepEqual(hubMod.hub.pendingFor(id), { effort: "max" });
    assert.equal(hubMod.hub.snapshot.selected!.model, "claude-opus-5-5");
    assert.equal(hubMod.hub.snapshot.selected!.effort, "max");
  });

  it("matches suffixed model ids", async () => {
    const id = oneChat({ model: "claude-opus-5-5" });
    hubMod.hub.setPending(id, { model: "claude-fable-5-1" });
    await afterPress();
    writeChat(id, { model: "claude-fable-5-1[1m]" });
    hubMod.hub.refresh();
    assert.equal(hubMod.hub.pendingFor(id), undefined);
  });
});
