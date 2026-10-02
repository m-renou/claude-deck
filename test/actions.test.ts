// Action logic without Stream Deck: activity positions, model / effort / speed views and cycling, press
// de-duplication and render-on-change caching. Only pure modules are imported (no SDK, hub, ops or control).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import url from "node:url";
import { InstanceTable, lastResultFor, paintFeedback, paintImage, runExclusive, settle, type Surface } from "../src/actions/core.ts";
import {
  assignPositions,
  chatAt,
  DEFAULT_EFFORT_CYCLE,
  effortCycle,
  effortId,
  effortTarget,
  effortView,
  modelView,
  nextUsageView,
  parseCycle,
  type PlacedKey,
  pressText,
  skillLabel,
  speedState,
  USAGE_NO_DATA,
  usageFor,
} from "../src/actions/logic.ts";
import { activityPosition, DEFAULT_MODEL_SLOTS, modelPlan, modelSlots, panelId, slotDefault, type UsageView, usageView } from "../src/actions/settings.ts";
import * as catalog from "../src/claude/catalog.ts";
import type { ActionResult, Chat, ModelInfo, Usage } from "../src/types.ts";

const effortStops = catalog.effortStopsFor;

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

const MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", name: "Opus 5.5", shortName: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"], fast: true },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", shortName: "Sonnet", efforts: ["low", "medium", "high"], fast: false },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", shortName: "Haiku", efforts: [], fast: false },
];

const chat = (over: Partial<Chat> = {}): Chat => ({
  id: "local_1",
  title: "Refactor feature",
  status: "idle",
  lastActivityAt: 0,
  lastFocusedAt: 0,
  live: false,
  ...over,
});

const key = (id: string, row: number, column: number, position = 0, deviceId = "dev1"): PlacedKey => ({ id, deviceId, row, column, position });

// ── Activity positions ──────────────────────────────────────────────────────────────────────────────────

describe("assignPositions", () => {
  it("numbers auto keys in key order (row by row, left to right)", () => {
    const p = assignPositions([key("c", 1, 0), key("a", 0, 2), key("b", 0, 4), key("d", 1, 3)]);
    assert.deepEqual(Object.fromEntries(p), { a: 1, b: 2, c: 3, d: 4 });
  });

  it("keeps fixed positions and gives auto keys the remaining ones", () => {
    const p = assignPositions([key("fixed1", 2, 4, 1), key("x", 0, 0), key("y", 0, 1), key("fixed3", 0, 2, 3)]);
    assert.equal(p.get("fixed1"), 1);
    assert.equal(p.get("fixed3"), 3);
    assert.equal(p.get("x"), 2);
    assert.equal(p.get("y"), 4);
  });

  it("numbers each device on its own", () => {
    const p = assignPositions([key("a", 0, 0, 0, "d1"), key("b", 0, 1, 0, "d1"), key("c", 0, 0, 0, "d2")]);
    assert.deepEqual(Object.fromEntries(p), { a: 1, b: 2, c: 1 });
  });

  it("lets two keys share a fixed position", () => {
    const p = assignPositions([key("a", 0, 0, 2), key("b", 0, 1, 2), key("c", 0, 2)]);
    assert.deepEqual(Object.fromEntries(p), { a: 2, b: 2, c: 1 });
  });

  it("reads settings: 0, missing, negative and junk mean auto", () => {
    assert.equal(activityPosition({}), 0);
    assert.equal(activityPosition({ position: 0 }), 0);
    assert.equal(activityPosition({ position: -3 }), 0);
    assert.equal(activityPosition({ position: Number.NaN }), 0);
    assert.equal(activityPosition({ position: "4" as unknown as number }), 4);
    assert.equal(activityPosition({ position: 7 }), 7);
  });

  it("maps a position to the chat list (1 = first)", () => {
    const chats = [chat({ id: "local_a" }), chat({ id: "local_b" })];
    assert.equal(chatAt(chats, 1)?.id, "local_a");
    assert.equal(chatAt(chats, 2)?.id, "local_b");
    assert.equal(chatAt(chats, 3), undefined);
    assert.equal(chatAt(chats, 0), undefined);
  });
});

// ── Model / effort / speed / usage ──────────────────────────────────────────────────────────────────────

describe("modelView", () => {
  it("without slots: the chat's model with its index in the app's menu", () => {
    assert.deepEqual(modelView(chat({ model: "claude-sonnet-5-5" }), MODELS), { name: "Sonnet 5.5", index: 1, count: 3 });
  });

  it("matches dated / suffixed ids", () => {
    assert.equal(modelView(chat({ model: "claude-opus-5-5[1m]" }), MODELS).index, 0);
  });

  it("unknown model: readable name, index -1", () => {
    assert.deepEqual(modelView(chat({ model: "claude-mythos-6-0" }), MODELS), { name: "Mythos 6.0", index: -1, count: 3 });
  });

  it("no chat: generic label", () => {
    assert.deepEqual(modelView(undefined, MODELS), { name: "Model", index: -1, count: 3 });
  });

  it("with slots: one dot per slot, the current slot highlighted", () => {
    const slots = ["claude-fable-5-1", "claude-opus-5-5"];
    assert.deepEqual(modelView(chat({ model: "claude-opus-5-5" }), MODELS, slots), { name: "Opus 5.5", index: 1, count: 2 });
    assert.deepEqual(modelView(chat({ model: "claude-opus-5-5[1m]" }), MODELS, slots).index, 1);
    // a slot that isn't in the catalog still matches the chat's raw id
    assert.deepEqual(modelView(chat({ model: "claude-fable-5-1" }), MODELS, slots), { name: "Fable 5.1", index: 0, count: 2 });
  });

  it("with slots: a model that isn't one of them highlights nothing", () => {
    assert.deepEqual(modelView(chat({ model: "claude-sonnet-5-5" }), MODELS, ["claude-fable-5-1", "claude-opus-5-5"]), { name: "Sonnet 5.5", index: -1, count: 2 });
    assert.deepEqual(modelView(undefined, MODELS, ["claude-opus-5-5"]), { name: "Model", index: -1, count: 1 });
  });
});

describe("Model key settings (modelSlots / modelPlan)", () => {
  it("defaults to Fable 5.1, then Opus 5.5", () => {
    assert.deepEqual(DEFAULT_MODEL_SLOTS, ["claude-fable-5-1", "claude-opus-5-5"]);
    assert.deepEqual(modelSlots({}), ["claude-fable-5-1", "claude-opus-5-5"]);
    assert.deepEqual(modelSlots(undefined), ["claude-fable-5-1", "claude-opus-5-5"]);
    assert.deepEqual(modelPlan({}), { target: "next", slots: ["claude-fable-5-1", "claude-opus-5-5"] });
    assert.deepEqual(modelPlan({ mode: "next" }), { target: "next", slots: ["claude-fable-5-1", "claude-opus-5-5"] });
  });

  it("reads the PI's slots in order; unsaved slots are their defaults, \"none\" and repeats drop out", () => {
    assert.deepEqual(modelSlots({ slot3: "claude-sonnet-5-5" }), ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);
    assert.deepEqual(modelSlots({ slot1: "claude-opus-5-5", slot2: "none", slot3: "none", slot4: "claude-haiku-4-5-20251001" }), [
      "claude-opus-5-5",
      "claude-haiku-4-5-20251001",
    ]);
    assert.deepEqual(modelSlots({ slot1: "claude-opus-5-5", slot2: "claude-opus-5-5" }), ["claude-opus-5-5"]);
    assert.deepEqual(modelSlots({ slot1: "", slot2: "none" }), ["claude-fable-5-1"], "an empty slot shows (and means) its default");
    assert.deepEqual(slotDefault(1), "claude-fable-5-1");
    assert.deepEqual(slotDefault(3), "none");
  });

  it("takes a slots array when the PI never saved a slot; the PI's slots win over it", () => {
    assert.deepEqual(modelSlots({ slots: ["claude-sonnet-5-5", " claude-opus-5-5 ", "none", 3 as never] }), ["claude-sonnet-5-5", "claude-opus-5-5"]);
    assert.deepEqual(modelSlots({ slots: ["claude-sonnet-5-5"], slot1: "claude-haiku-4-5-20251001", slot2: "none" }), ["claude-haiku-4-5-20251001"]);
    assert.deepEqual(modelSlots({ slots: "claude-opus-5-5" as never }), DEFAULT_MODEL_SLOTS, "junk = defaults");
  });

  it("nothing left = the defaults (a key always has a model to pick)", () => {
    assert.deepEqual(modelSlots({ slot1: "none", slot2: "none", slot3: "none", slot4: "none" }), ["claude-fable-5-1", "claude-opus-5-5"]);
    assert.deepEqual(modelSlots({ slots: [] }), ["claude-fable-5-1", "claude-opus-5-5"]);
  });

  it("keeps keys set to one model (\"fixed\" + model, the settings before slots) on that model", () => {
    assert.deepEqual(modelPlan({ mode: "fixed", model: "claude-sonnet-5-5" }), { target: "claude-sonnet-5-5", slots: ["claude-sonnet-5-5"] });
    assert.deepEqual(modelPlan({ mode: "fixed", model: " claude-opus-5-5 ", slot1: "claude-haiku-4-5-20251001" }), {
      target: "claude-opus-5-5",
      slots: ["claude-opus-5-5"],
    });
    // "fixed" without a model, or a model left over from an earlier "fixed" choice: the slots
    assert.deepEqual(modelPlan({ mode: "fixed" }), { target: "next", slots: ["claude-fable-5-1", "claude-opus-5-5"] });
    assert.deepEqual(modelPlan({ mode: "next", model: "claude-sonnet-5-5" }), { target: "next", slots: ["claude-fable-5-1", "claude-opus-5-5"] });
  });
});

describe("effortView", () => {
  it("labels with EFFORT_LABEL and places the knob on the model's stops (levels, then Ultracode)", () => {
    assert.deepEqual(effortView(chat({ model: "claude-opus-5-5", effort: "xhigh" }), MODELS), { label: "Extra", position: 3, steps: 6, ultra: false, disabled: false });
    assert.deepEqual(effortView(chat({ model: "claude-sonnet-5-5", effort: "low" }), MODELS), { label: "Low", position: 0, steps: 4, ultra: false, disabled: false });
  });

  it("ultracode shows Ultra at the end of the slider", () => {
    assert.deepEqual(effortView(chat({ model: "claude-opus-5-5", effort: "xhigh", ultracode: true }), MODELS), { label: "Ultra", position: 5, steps: 6, ultra: true, disabled: false });
  });

  it("the slider covers the key's cycle", () => {
    const cycle = ["high", "max", "ultracode"];
    assert.deepEqual(effortView(chat({ model: "claude-opus-5-5", effort: "max" }), MODELS, cycle), { label: "Max", position: 1, steps: 3, ultra: false, disabled: false });
    assert.deepEqual(effortView(chat({ model: "claude-opus-5-5", ultracode: true }), MODELS, cycle).position, 2);
    // a level outside the cycle: named, no knob
    assert.deepEqual(effortView(chat({ model: "claude-opus-5-5", effort: "low" }), MODELS, cycle), { label: "Low", position: -1, steps: 3, ultra: false, disabled: false });
    // levels the model doesn't offer are left out; none left = the model's own stops
    assert.equal(effortView(chat({ model: "claude-sonnet-5-5", effort: "high" }), MODELS, ["xhigh", "max", "high"]).steps, 1);
    assert.equal(effortView(chat({ model: "claude-sonnet-5-5", effort: "high" }), MODELS, ["xhigh"]).steps, 4);
  });

  it("a model without effort levels is disabled", () => {
    assert.equal(effortView(chat({ model: "claude-haiku-4-5-20251001" }), MODELS).disabled, true);
    assert.equal(effortView(undefined, MODELS).disabled, true);
    assert.deepEqual(effortStops(MODELS[2]), []);
  });

  it("unknown level: position -1", () => {
    const v = effortView(chat({ model: "claude-opus-5-5" }), MODELS);
    assert.equal(v.position, -1);
    assert.equal(v.disabled, false);
  });
});

describe("Effort key settings", () => {
  it("cycles every level and Ultracode by default", () => {
    assert.deepEqual(DEFAULT_EFFORT_CYCLE, ["low", "medium", "high", "xhigh", "max", "ultracode"]);
    assert.deepEqual(effortCycle(undefined), ["low", "medium", "high", "xhigh", "max", "ultracode"]);
    assert.deepEqual(effortCycle(""), [...DEFAULT_EFFORT_CYCLE]);
    assert.ok(effortCycle(undefined).includes("ultracode"));
  });

  it("uses the key's own cycle", () => {
    assert.deepEqual(effortCycle("high, Ultra"), ["high", "ultracode"]);
    assert.deepEqual(effortCycle("low, medium, high, xhigh, max"), ["low", "medium", "high", "xhigh", "max"]);
  });

  it("a press asks for the fixed level, else the next one", () => {
    assert.equal(effortTarget(true, "Ultra"), "ultracode");
    assert.equal(effortTarget(true, "xhigh"), "xhigh");
    assert.equal(effortTarget(true, ""), "next", "fixed without a level cycles");
    assert.equal(effortTarget(false, "max"), "next");
  });

  it("the stops for a model: its levels, then Ultracode", () => {
    assert.deepEqual(effortStops(MODELS[0]), ["low", "medium", "high", "xhigh", "max", "ultracode"]);
    assert.deepEqual(effortStops(MODELS[1]), ["low", "medium", "high", "ultracode"]);
    assert.deepEqual(effortStops(undefined), ["low", "medium", "high", "xhigh", "max", "ultracode"]);
  });
});

describe("Send Prompt / Steer press", () => {
  it("an empty key sends undefined: ops submits what is typed in Claude's prompt box", () => {
    const calls: Array<string | undefined> = [];
    const send = (text?: string) => {
      calls.push(text);
      return calls.length;
    };
    pressText(undefined, send);
    pressText("", send);
    pressText("   \n ", send);
    pressText(42, send);
    assert.deepEqual(calls, [undefined, undefined, undefined, undefined]);
    assert.equal(calls.length, 4);
  });

  it("a key with text sends it (trimmed)", () => {
    const calls: Array<string | undefined> = [];
    const r = pressText("  Review my changes \n", (text?: string) => {
      calls.push(text);
      return "sent";
    });
    assert.equal(r, "sent");
    assert.deepEqual(calls, ["Review my changes"]);
  });
});

describe("parseCycle / effortId", () => {
  it("accepts ids and labels, drops blanks and duplicates", () => {
    assert.deepEqual(parseCycle("low, Extra , ultra,,LOW"), ["low", "xhigh", "ultracode"]);
    assert.deepEqual(parseCycle("medium;max"), ["medium", "max"]);
  });

  it("empty means every level", () => {
    assert.equal(parseCycle(""), undefined);
    assert.equal(parseCycle(undefined), undefined);
    assert.equal(parseCycle(" , "), undefined);
  });

  it("maps a fixed level", () => {
    assert.equal(effortId("Extra"), "xhigh");
    assert.equal(effortId("Ultra"), "ultracode");
    assert.equal(effortId("high"), "high");
  });
});

describe("speedState", () => {
  it("follows the chat's fast flag when the model has fast mode", () => {
    assert.equal(speedState(chat({ model: "claude-opus-5-5", fast: true }), MODELS), "on");
    assert.equal(speedState(chat({ model: "claude-opus-5-5" }), MODELS), "off");
  });

  it("is unavailable without fast mode or without a chat", () => {
    assert.equal(speedState(chat({ model: "claude-sonnet-5-5", fast: true }), MODELS), "unavailable");
    assert.equal(speedState(undefined, MODELS), "unavailable");
  });
});

describe("usage view cycling", () => {
  it("auto → weekly → 5-hour → context → auto", () => {
    const seen = ["auto" as const];
    for (let i = 0; i < 4; i++) seen.push(nextUsageView(seen.at(-1)!) as never);
    assert.deepEqual(seen, ["auto", "weekly", "5-hour", "context", "auto"]);
  });

  it("normalises settings", () => {
    assert.equal(usageView({}), "auto");
    assert.equal(usageView({ view: "bogus" as never }), "auto");
    assert.equal(usageView({ view: "context" }), "context");
    assert.equal(panelId({}), "review");
    assert.equal(panelId({ panel: "sideChat" }), "sideChat");
    assert.equal(panelId({ panel: "nope" as never }), "review");
  });
});

describe("usageFor (Usage key / dial / infobar)", () => {
  const weekly: Usage = { kind: "weekly", percent: 11, line1: "plan limit" };
  const context: Usage = { kind: "context", percent: 42, line1: "420k / 1M" };

  it("computes usage for the key's own view", () => {
    const asked: UsageView[] = [];
    const compute = (v: UsageView): Usage => {
      asked.push(v);
      return v === "weekly" ? weekly : v === "context" ? context : { kind: "5-hour", percent: 9 };
    };
    assert.deepEqual(usageFor(usageView({ view: "weekly" }), compute), weekly);
    assert.deepEqual(usageFor(usageView({ view: "5-hour" }), compute), { kind: "5-hour", percent: 9 });
    assert.deepEqual(usageFor(usageView({ view: "context" }), compute), context);
    assert.deepEqual(usageFor(usageView({}), compute), { kind: "5-hour", percent: 9 });
    assert.deepEqual(asked, ["weekly", "5-hour", "context", "auto"]);
  });

  it("a Weekly / 5-hour key never shows Context: it keeps its label and says there's no data yet", () => {
    assert.deepEqual(usageFor("weekly", () => context), { kind: "weekly", line1: USAGE_NO_DATA });
    assert.deepEqual(usageFor("5-hour", () => weekly), { kind: "5-hour", line1: USAGE_NO_DATA });
    assert.deepEqual(usageFor("weekly", () => ({ kind: "none", line1: "Open Usage in Claude" })), { kind: "weekly", line1: "Open Usage in Claude" });
  });

  it("nothing at all: a short grey message", () => {
    assert.deepEqual(usageFor("auto", () => ({ kind: "none" })), { kind: "none", line1: USAGE_NO_DATA });
    assert.deepEqual(usageFor("context", () => ({ kind: "none" })), { kind: "context", line1: USAGE_NO_DATA });
    assert.deepEqual(usageFor("auto", () => context), context, "auto shows whatever there is");
  });
});

describe("skillLabel", () => {
  it("uses built-in labels, else Title Case", () => {
    assert.equal(skillLabel("code-review"), "Review Changes");
    assert.equal(skillLabel("/write-tests"), "Write Tests");
    assert.equal(skillLabel(""), "", "unset → the key's grey placeholder");
  });
});

// ── Core: press de-duplication, render caching ──────────────────────────────────────────────────────────

class FakeSurface implements Surface {
  readonly id: string;
  images: (string | undefined)[] = [];
  feedbacks: unknown[] = [];
  alerts = 0;
  failNextImage = false;
  constructor(id: string) {
    this.id = id;
  }
  setImage(image?: string): Promise<void> {
    this.images.push(image);
    if (this.failNextImage) {
      this.failNextImage = false;
      return Promise.reject(new Error("socket closed"));
    }
    return Promise.resolve();
  }
  setFeedback(payload: never): Promise<void> {
    this.feedbacks.push(payload);
    return Promise.resolve();
  }
  showAlert(): Promise<void> {
    this.alerts++;
    return Promise.resolve();
  }
}

const quietLog = () => {
  const lines: string[] = [];
  return { lines, info: (m: string) => lines.push(`I ${m}`), warn: (m: string) => lines.push(`W ${m}`), error: (m: string) => lines.push(`E ${m}`) };
};

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("runExclusive", () => {
  it("ignores presses while the previous operation runs", async () => {
    const table = new InstanceTable<Record<string, never>, FakeSurface>();
    const inst = table.upsert({ action: new FakeSurface("ctx1"), controller: "Keypad", deviceId: "d" });
    const gate = deferred<ActionResult>();
    let calls = 0;
    const op = () => {
      calls++;
      return gate.promise;
    };
    const log = quietLog();
    const first = runExclusive(inst, op, { actionId: "send-prompt", log });
    const second = await runExclusive(inst, op, { actionId: "send-prompt", log });
    assert.equal(second, undefined);
    assert.equal(calls, 1);
    gate.resolve({ ok: true, message: "sent", feedback: "ok" });
    const r = await first;
    assert.equal(r?.ok, true);
    assert.equal(inst.busy, false);
    // the next press runs again
    const again = await runExclusive(inst, () => ({ ok: true, message: "again" }), { actionId: "send-prompt", log });
    assert.equal(again?.message, "again");
    assert.equal(inst.lastResult?.message, "again");
    assert.ok(log.lines.some((l) => l.includes("press ignored")));
  });

  it("keeps the last result per key, shows ⚠ and logs failures", async () => {
    const table = new InstanceTable<Record<string, never>, FakeSurface>();
    const inst = table.upsert({ action: new FakeSurface("ctx2"), controller: "Keypad", deviceId: "d" });
    const log = quietLog();
    let pushed: unknown;
    const r = await runExclusive(inst, () => ({ ok: false, message: "No chat", feedback: "alert" }), {
      actionId: "stop",
      log,
      now: () => 42,
      onResult: (x) => (pushed = x),
    });
    assert.deepEqual(r, { ok: false, message: "No chat", feedback: "alert", action: "stop", at: 42 });
    assert.equal(inst.action.alerts, 1);
    assert.deepEqual(inst.lastResult, r);
    assert.deepEqual(lastResultFor("ctx2"), r);
    assert.deepEqual(pushed, r);
    assert.ok(log.lines.some((l) => l.startsWith("W stop: failed — No chat")));
    // survives the key scrolling away and back
    table.delete("ctx2");
    assert.deepEqual(table.upsert({ action: new FakeSurface("ctx2"), controller: "Keypad", deviceId: "d" }).lastResult, r);
  });

  it("turns a throwing operation into a failure and frees the key", async () => {
    const table = new InstanceTable<Record<string, never>, FakeSurface>();
    const inst = table.upsert({ action: new FakeSurface("ctx3"), controller: "Keypad", deviceId: "d" });
    const r = await runExclusive(
      inst,
      async () => {
        throw new Error("boom");
      },
      { actionId: "model", log: quietLog() },
    );
    assert.equal(r?.ok, false);
    assert.match(r!.message, /boom/);
    assert.equal(inst.action.alerts, 1);
    assert.equal(inst.busy, false);
  });

  it("a locally handled press (undefined) shows nothing", async () => {
    const table = new InstanceTable<Record<string, never>, FakeSurface>();
    const inst = table.upsert({ action: new FakeSurface("ctx4"), controller: "Keypad", deviceId: "d" });
    assert.equal(await runExclusive(inst, () => undefined, { actionId: "usage" }), undefined);
    assert.equal(inst.action.alerts, 0);
  });

  it("a success shows no mark on the key (also when the result asks for \"ok\" feedback)", async () => {
    const table = new InstanceTable<Record<string, never>, FakeSurface & { showOk?: () => Promise<void> }>();
    let oks = 0;
    const surface = Object.assign(new FakeSurface("ctx5"), { showOk: () => (oks++, Promise.resolve()) });
    const inst = table.upsert({ action: surface, controller: "Keypad", deviceId: "d" });
    await runExclusive(inst, () => ({ ok: true, message: "Opus 5.5", feedback: "ok" }), { actionId: "model" });
    await runExclusive(inst, () => ({ ok: true, message: "sent" }), { actionId: "send-prompt" });
    assert.equal(oks, 0);
    assert.equal(inst.action.alerts, 0);
    assert.equal(inst.lastResult?.message, "sent");
  });

  it("surfaces without showAlert (dials) don't crash", async () => {
    const table = new InstanceTable<Record<string, never>, Surface>();
    const inst = table.upsert({ action: { id: "dial1" }, controller: "Encoder", deviceId: "d" });
    assert.equal((await runExclusive(inst, () => ({ ok: true, message: "ok" }), { actionId: "power" }))?.ok, true);
    assert.equal((await runExclusive(inst, () => ({ ok: false, message: "no" }), { actionId: "power" }))?.ok, false);
  });
});

describe("late results (ops' onLate)", () => {
  it("a failure that arrives after the press returned: ⚠ on the key, kept as its last result, logged", async () => {
    const table = new InstanceTable<Record<string, never>, FakeSurface>();
    const inst = table.upsert({ action: new FakeSurface("late1"), controller: "Keypad", deviceId: "d" });
    const log = quietLog();
    const pushed: unknown[] = [];
    const opts = { actionId: "model", log, now: () => 7, onResult: (r: unknown) => pushed.push(r) };
    await runExclusive(inst, () => ({ ok: true, message: "Fable 5.1" }), opts);
    assert.equal(inst.action.alerts, 0);
    const late = settle(inst, { ok: false, message: "The chat still reports Opus 5.5." }, opts);
    assert.deepEqual(late, { ok: false, message: "The chat still reports Opus 5.5.", action: "model", at: 7 });
    assert.equal(inst.action.alerts, 1);
    assert.deepEqual(inst.lastResult, late);
    assert.deepEqual(lastResultFor("late1"), late);
    assert.equal(pushed.length, 2);
    assert.ok(log.lines.some((l) => l === "W model: failed — The chat still reports Opus 5.5."));
  });

  it("a late confirmation is recorded without a mark", () => {
    const table = new InstanceTable<Record<string, never>, FakeSurface>();
    const inst = table.upsert({ action: new FakeSurface("late2"), controller: "Keypad", deviceId: "d" });
    settle(inst, { ok: true, message: "Opus 5.5 confirmed", feedback: "ok" }, { actionId: "model" });
    assert.equal(inst.action.alerts, 0);
    assert.equal(inst.lastResult?.message, "Opus 5.5 confirmed");
  });
});

describe("no success mark anywhere", () => {
  it("nothing under src/actions calls (or declares) showOk", () => {
    const dir = path.join(ROOT, "src", "actions");
    const hits = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) =>
        fs
          .readFileSync(path.join(dir, f), "utf8")
          .split("\n")
          .map((line, i) => ({ where: `src/actions/${f}:${i + 1}`, line }))
          .filter((x) => /showOk/.test(x.line)),
      );
    assert.deepEqual(hits, []);
  });
});

describe("defaults have one source (the catalog), shared with ops.ts", () => {
  it("the keys' defaults are the catalog's lists", () => {
    assert.equal(DEFAULT_MODEL_SLOTS, catalog.DEFAULT_MODEL_SLOTS);
    assert.equal(DEFAULT_EFFORT_CYCLE, catalog.DEFAULT_EFFORT_CYCLE);
    assert.deepEqual([...catalog.DEFAULT_MODEL_SLOTS], ["claude-fable-5-1", "claude-opus-5-5"]);
    assert.deepEqual([...catalog.DEFAULT_EFFORT_CYCLE], ["low", "medium", "high", "xhigh", "max", "ultracode"]);
  });

  it("ops.ts re-exports them instead of keeping its own copies (read from its source: ops.ts isn't imported here)", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "ops.ts"), "utf8");
    for (const name of ["DEFAULT_MODEL_SLOTS", "DEFAULT_EFFORT_CYCLE"]) {
      assert.doesNotMatch(src, new RegExp(`export\\s+const\\s+${name}\\b`), `ops.ts declares its own ${name}`);
      assert.match(src, new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`), `ops.ts doesn't re-export ${name}`);
    }
  });
});

describe("render caching", () => {
  it("sends an image only when it changed", async () => {
    const table = new InstanceTable<Record<string, never>, FakeSurface>();
    const inst = table.upsert({ action: new FakeSurface("k1"), controller: "Keypad", deviceId: "d" });
    assert.equal(paintImage(inst, "data:a"), true);
    assert.equal(paintImage(inst, "data:a"), false);
    assert.equal(paintImage(inst, "data:b"), true);
    assert.equal(paintImage(inst, "data:b"), false);
    assert.deepEqual(inst.action.images, ["data:a", "data:b"]);
    // a re-appearing key forgets what it showed
    inst.image = undefined;
    assert.equal(paintImage(inst, "data:b"), true);
    assert.deepEqual(inst.action.images, ["data:a", "data:b", "data:b"]);
  });

  it("re-sends after a failed setImage", async () => {
    const table = new InstanceTable<Record<string, never>, FakeSurface>();
    const inst = table.upsert({ action: new FakeSurface("k2"), controller: "Keypad", deviceId: "d" });
    inst.action.failNextImage = true;
    const log = quietLog();
    assert.equal(paintImage(inst, "data:x", log), true);
    await tick();
    assert.equal(inst.image, undefined);
    assert.equal(paintImage(inst, "data:x", log), true);
    assert.equal(inst.action.images.length, 2);
    assert.ok(log.lines.some((l) => l.includes("setImage failed")));
  });

  it("caches dial feedback by value", () => {
    const table = new InstanceTable<Record<string, never>, FakeSurface>();
    const inst = table.upsert({ action: new FakeSurface("d1"), controller: "Encoder", deviceId: "d" });
    assert.equal(paintFeedback(inst, { title: "Weekly", value: "61%" }), true);
    assert.equal(paintFeedback(inst, { title: "Weekly", value: "61%" }), false);
    assert.equal(paintFeedback(inst, { title: "Weekly", value: "62%" }), true);
    assert.equal(inst.action.feedbacks.length, 2);
  });

  it("keeps per-instance bookkeeping across settings updates", () => {
    const table = new InstanceTable<{ prompt?: string }, FakeSurface>();
    const a = new FakeSurface("k3");
    const inst = table.upsert({ action: a, settings: { prompt: "one" }, controller: "Keypad", deviceId: "d", coordinates: { row: 0, column: 1 } });
    inst.image = "data:cached";
    const again = table.upsert({ action: a, settings: { prompt: "two" }, controller: "Keypad", deviceId: "d" });
    assert.equal(again, inst);
    assert.equal(again.settings.prompt, "two");
    assert.equal(again.image, "data:cached");
    assert.deepEqual(again.coordinates, { row: 0, column: 1 });
    assert.equal(table.size, 1);
  });
});
