// Keep Awake on Windows (src/system/keep-awake-win.ts) behind a fake helper process: nothing is started, no execution
// state is changed. The fake prints "on" like the real helper once it holds the PC awake, and exits when it is
// stopped or its time is up.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { type AwakeChild, type WinAwakeRunner, WinKeepAwake } from "../src/system/keep-awake-win.ts";

class FakeChild extends EventEmitter implements AwakeChild {
  readonly stdout = new EventEmitter();
  ended = false;
  killed = false;
  exited = false;
  readonly stdin = {
    end: () => {
      this.ended = true;
      this.exit();
    },
    on: () => undefined,
  };
  kill(): boolean {
    this.killed = true;
    this.exit();
    return true;
  }
  exit(): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => this.emit("exit", 0));
  }
}

class FakeRunner implements WinAwakeRunner {
  t = 1_000_000;
  started: Array<{ seconds: number; child: FakeChild }> = [];
  /** The helper answers "on" (else it says nothing, or fails to start). */
  answers: "on" | "silent" | "throws" = "on";
  async start(seconds: number): Promise<AwakeChild> {
    if (this.answers === "throws") throw new Error("Couldn't build the Windows helper: no compiler");
    const child = new FakeChild();
    this.started.push({ seconds, child });
    if (this.answers === "on") setImmediate(() => child.stdout.emit("data", "on\r\n"));
    return child;
  }
  now(): number {
    return this.t;
  }
}

const settle = () => new Promise((r) => setImmediate(r));

describe("Keep Awake on Windows", () => {
  it("is always available (no app to install), off at first", () => {
    const k = new WinKeepAwake(new FakeRunner());
    assert.deepEqual(k.state, { installed: true, running: false, active: false });
  });

  it("toggle on: starts the helper and confirms once it holds the PC awake; toggle off stops it", async () => {
    const run = new FakeRunner();
    const k = new WinKeepAwake(run);
    let changes = 0;
    k.on("change", () => changes++);
    const on = await k.press("toggle", 0);
    assert.deepEqual(on, { ok: true, message: "Keeping your PC awake" });
    assert.deepEqual(k.state, { installed: true, running: true, active: true });
    assert.equal(run.started.length, 1);
    assert.equal(run.started[0]!.seconds, 0);
    const off = await k.press("toggle", 0);
    assert.deepEqual(off, { ok: true, message: "Keep awake is off" });
    assert.deepEqual(k.state, { installed: true, running: false, active: false });
    assert.equal(run.started[0]!.child.ended, true, "stdin closed");
    assert.ok(changes >= 3);
  });

  it("a timed session shows its end, and goes off when the helper exits at the end of it", async () => {
    const run = new FakeRunner();
    const k = new WinKeepAwake(run);
    const r = await k.press("on", 1800);
    assert.equal(r.message, "Keeping your PC awake for 30 min");
    assert.equal(k.state.until, run.t + 1_800_000);
    run.started[0]!.child.exit(); // time's up
    await settle();
    await settle();
    assert.deepEqual(k.state, { installed: true, running: false, active: false });
  });

  it("on while on: a new session replaces the old one (new duration), without flickering off", async () => {
    const run = new FakeRunner();
    const k = new WinKeepAwake(run);
    await k.press("on", 300);
    const states: boolean[] = [];
    k.on("change", () => states.push(k.state.active));
    await k.press("on", 3600);
    await settle();
    assert.equal(run.started.length, 2);
    assert.equal(run.started[0]!.child.killed, true);
    assert.equal(k.state.until, run.t + 3_600_000);
    assert.ok(!states.includes(false), `went off in between: ${JSON.stringify(states)}`);
  });

  it("off while off sends nothing", async () => {
    const run = new FakeRunner();
    const k = new WinKeepAwake(run);
    assert.deepEqual(await k.press("off"), { ok: true, message: "Keep awake is off" });
    assert.equal(run.started.length, 0);
  });

  it("a helper that can't start: ⚠ with the reason, and the key stays off", async () => {
    const run = new FakeRunner();
    run.answers = "throws";
    const k = new WinKeepAwake(run);
    const r = await k.press("on");
    assert.equal(r.ok, false);
    assert.equal(r.feedback, "alert");
    assert.match(r.message, /no compiler/);
    assert.equal(k.state.active, false);
  });

  it("shutdown() ends the session (the plugin quits)", async () => {
    const run = new FakeRunner();
    const k = new WinKeepAwake(run);
    await k.press("on");
    k.shutdown();
    assert.equal(run.started[0]!.child.ended, true);
  });
});
