// Keep Awake on Windows: no third-party app. The plugin keeps the PC (and its display) awake itself, the way
// KeepingYouAwake does on a Mac with caffeinate -di: it runs `claude-deck-uia.exe keepawake <seconds>` (the Windows
// helper, src/claude/win-helper.ts), which calls SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED |
// ES_DISPLAY_REQUIRED) and holds it until its time is up, it is stopped, or its stdin closes (the plugin quit) —
// Windows drops the request as soon as that process ends, so nothing outlives the plugin.
// Same surface as the macOS controller (state, setWatching, refresh, press, "change"), so the key and its PI don't
// care which one runs. The spawner is injectable: tests never start the helper.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { KeepAwakeMode } from "../actions/settings.ts";
import { ensureHelper } from "../claude/win-helper.ts";
import type { ActionResult } from "../types.ts";
import { durationLabel, type KeepAwakeState } from "./keep-awake.ts";

/** The part of a ChildProcess this module uses. */
export interface AwakeChild {
  readonly stdout: { on(event: "data", fn: (chunk: Buffer | string) => void): unknown } | null;
  readonly stdin: { end(): unknown; on(event: "error", fn: (err: Error) => void): unknown } | null;
  kill(): boolean;
  on(event: "exit", fn: (code: number | null) => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
}

export interface WinAwakeRunner {
  /** Start the helper's keep-awake mode for `seconds` (0 = until stopped). */
  start(seconds: number): Promise<AwakeChild>;
  now(): number;
}

export const realWinRunner: WinAwakeRunner = {
  start: async (seconds) => {
    const exe = await ensureHelper();
    return spawn(exe, ["keepawake", String(Math.max(0, Math.floor(seconds)))], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  },
  now: () => Date.now(),
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const failed = (message: string): ActionResult => ({ ok: false, message, feedback: "alert" });
const CONFIRM_MS = 5000;

export class WinKeepAwake extends EventEmitter {
  state: KeepAwakeState = { installed: true, running: false, active: false };
  private readonly runner: WinAwakeRunner;
  private child: AwakeChild | undefined;
  private watchingKeys = false;
  /** Presses run one after the other (two keys pressed together). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(runner: WinAwakeRunner = realWinRunner) {
    super();
    this.runner = runner;
  }

  private set(next: KeepAwakeState): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (changed) this.emit("change");
  }

  /** Nothing to poll (the plugin owns the state); kept for the key's sake. */
  setWatching(on: boolean): void {
    this.watchingKeys = on;
  }

  get watching(): boolean {
    return this.watchingKeys;
  }

  /** The state as it is (a timed session that ran out is off). */
  async refresh(): Promise<KeepAwakeState> {
    if (this.state.active && this.state.until !== undefined && this.runner.now() >= this.state.until && !this.child) this.set({ installed: true, running: false, active: false });
    return this.state;
  }

  press(mode: KeepAwakeMode, seconds = 0): Promise<ActionResult> {
    const p = this.chain.then(() => this.pressNow(mode, seconds));
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** End the running session (the plugin quits: its stdin closes anyway). */
  shutdown(): void {
    this.stopChild();
  }

  private stopChild(): void {
    const c = this.child;
    this.child = undefined;
    if (!c) return;
    try {
      c.stdin?.end();
    } catch {
      // gone already
    }
    try {
      c.kill();
    } catch {
      // gone already
    }
  }

  private async pressNow(mode: KeepAwakeMode, seconds: number): Promise<ActionResult> {
    const target = mode === "on" ? true : mode === "off" ? false : !this.state.active;
    if (!target) {
      this.stopChild();
      this.set({ installed: true, running: false, active: false });
      return { ok: true, message: "Keep awake is off" };
    }
    // On (again): a new session replaces the old one (a new duration).
    const until = seconds > 0 ? { until: this.runner.now() + seconds * 1000 } : {};
    this.set({ installed: true, running: true, active: true, ...until, pending: true });
    this.stopChild();
    let child: AwakeChild;
    try {
      child = await this.runner.start(seconds);
    } catch (err) {
      this.set({ installed: true, running: false, active: false, error: errorText(err) });
      return failed(`Couldn't keep the PC awake: ${errorText(err)}`);
    }
    this.child = child;
    const confirmed = await new Promise<boolean>((resolve) => {
      let out = "";
      const timer = setTimeout(() => resolve(false), CONFIRM_MS);
      timer.unref?.();
      child.stdout?.on("data", (d) => {
        out += String(d);
        if (/^on\b/m.test(out)) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      child.stdin?.on("error", () => undefined);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(false);
        // The session ended (its time was up, or it was stopped): off, unless a newer one took over.
        if (this.child === child) {
          this.child = undefined;
          this.set({ installed: true, running: false, active: false });
        }
      });
    });
    if (!confirmed || this.child !== child) {
      if (this.child === child) this.stopChild();
      this.set({ installed: true, running: false, active: false, error: "the keep-awake helper didn't start" });
      return failed("Couldn't keep the PC awake (the helper didn't start).");
    }
    this.set({ installed: true, running: true, active: true, ...until });
    return { ok: true, message: seconds > 0 ? `Keeping your PC awake for ${durationLabel(seconds)}` : "Keeping your PC awake" };
  }
}
