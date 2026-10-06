// KeepingYouAwake (KYA, keepingyouawake.app): the menu-bar app that keeps the Mac awake by running /usr/bin/caffeinate.
// The Keep Awake key drives it and never touches the Claude app.
//   • Acting: KYA's URL scheme, opened in the background (`open -g`; an activate link launches KYA when it isn't running)
//       keepingyouawake:///activate[?seconds=N]    on (indefinitely, or for N seconds)
//       keepingyouawake:///deactivate             off
//     A press reads the state first and sends activate / deactivate (never KYA's `toggle`), so the outcome is known.
//   • Reading: while KYA keeps the Mac awake it runs a child `/usr/bin/caffeinate -di [-t <seconds>] -w <KYA pid>`.
//     No such child (or no KYA) = off. A timed session ends at start + t, start = now − the child's elapsed time.
//     caffeinate processes of other apps (another parent) don't count.
// The process table is polled (~2 s) only while a Keep Awake key is visible. Everything goes through an injectable
// runner: tests never run ps or open.

import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KeepAwakeMode } from "../actions/settings.ts";
import type { ActionResult } from "../types.ts";

export const KYA_SCHEME = "keepingyouawake";
const NOT_INSTALLED = "KeepingYouAwake isn't installed (keepingyouawake.app)";
const NO_RESPONSE = "KeepingYouAwake didn't respond";
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const readFailed = (err: unknown): string => `Couldn't read KeepingYouAwake's state: ${errorText(err)}`;

/** Where KYA can be installed (its process, wherever it lives, counts too). */
export const kyaAppPaths = (home = os.homedir()): string[] => ["/Applications/KeepingYouAwake.app", path.posix.join(home, "Applications", "KeepingYouAwake.app")];

// ── Parsing (pure) ──────────────────────────────────────────────────────────────────────────────────────

/** ps elapsed time "[[dd-]hh:]mm:ss" → seconds; undefined for anything else. */
export function parseEtime(s: string): number | undefined {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(s);
  if (!m) return undefined;
  if (m[1] !== undefined && m[2] === undefined) return undefined; // "dd-" comes with hours
  const [d, h, min, sec] = [m[1], m[2], m[3], m[4]].map((v) => Number(v ?? 0)) as [number, number, number, number];
  if (min > 59 || sec > 59) return undefined;
  return ((d * 24 + h) * 60 + min) * 60 + sec;
}

/** What the process table says about KYA. */
export interface AwakeProcs {
  /** KYA is running. */
  running: boolean;
  /** KYA keeps the Mac awake (it has a caffeinate child). */
  active: boolean;
  /** End of a timed session (ms epoch); undefined while off or on indefinitely. */
  until?: number;
  /** The caffeinate child (a re-activation replaces it). */
  pid?: number;
}

/** The KYA executable, at the start of a ps args column (spaces inside folder names allowed, not " /"). */
const KYA_EXE_RE = /^\/(?:\S|\s(?!\/))*\/KeepingYouAwake\.app\/Contents\/MacOS\/KeepingYouAwake(?:\s|$)/;
const CAFFEINATE_RE = /^\/usr\/bin\/caffeinate(?:\s|$)/;
const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/;

/** Read `ps -axo pid=,ppid=,etime=,args=` output at time `now` (ms epoch). */
export function parseAwake(psOutput: string, now: number): AwakeProcs {
  const procs: Array<{ pid: number; ppid: number; etime: string; args: string }> = [];
  for (const line of psOutput.split("\n")) {
    const m = PS_LINE_RE.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), etime: m[3]!, args: m[4]!.trim() });
  }
  const kya = new Set(procs.filter((p) => KYA_EXE_RE.test(p.args)).map((p) => p.pid));
  const out: AwakeProcs = { running: kya.size > 0, active: false };
  // KYA runs one child at a time; should there be two, the one that lasts longest (indefinite first) counts.
  let end = -Infinity;
  for (const p of procs) {
    if (!kya.has(p.ppid) || !CAFFEINATE_RE.test(p.args)) continue;
    const t = /(?:^|\s)-t\s*(\d+)(?:\s|$)/.exec(p.args);
    const until = t ? now + Math.max(0, Number(t[1]) - (parseEtime(p.etime) ?? 0)) * 1000 : Infinity;
    if (until > end || !out.active) {
      end = until;
      out.pid = p.pid;
    }
    out.active = true;
  }
  if (out.active && end !== Infinity) out.until = end;
  return out;
}

/** "5 min", "30 min", "1 hour", "2 hours", "1 h 30 min" (a timed session in the key's result). */
export function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (rest) return `${h} h ${rest} min`;
  return h === 1 ? "1 hour" : `${h} hours`;
}

/** KYA link for a press: on (optionally for `seconds`) or off. */
export const kyaLink = (on: boolean, seconds = 0): string =>
  on ? `${KYA_SCHEME}:///activate${seconds > 0 ? `?seconds=${Math.floor(seconds)}` : ""}` : `${KYA_SCHEME}:///deactivate`;

// ── Runner (injectable) ─────────────────────────────────────────────────────────────────────────────────

export interface KeepAwakeRunner {
  /** Run a program; resolves with its stdout, rejects when it fails or times out. */
  exec(file: string, args: string[]): Promise<string>;
  exists(path: string): boolean;
  now(): number;
}

const EXEC_TIMEOUT_MS = 5000;

export const realRunner: KeepAwakeRunner = {
  exec: (file, args) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        const e = err as (Error & { code?: unknown; killed?: boolean }) | null;
        if (e) reject(new Error(e.killed ? `${path.basename(file)} timed out` : `${path.basename(file)} failed (${String(e.code ?? e.message)})`));
        else resolve(String(stdout));
      });
    }),
  exists: (p) => fs.existsSync(p),
  now: () => Date.now(),
};

// ── Controller ──────────────────────────────────────────────────────────────────────────────────────────

export interface KeepAwakeState {
  /** KYA is installed (or running from wherever it lives). */
  installed: boolean;
  running: boolean;
  /** The Mac is kept awake. While `pending`, this is what a press asked for (not confirmed yet). */
  active: boolean;
  /** End of a timed session (ms epoch); undefined = off or indefinitely. */
  until?: number;
  /** A press is on its way: the key already shows its outcome. */
  pending?: boolean;
  /** The last read failed (the rest is the last known state). */
  error?: string;
}

export interface KeepAwakeOptions {
  /** Poll interval while a key is visible. */
  pollMs?: number;
  /** How often / how long a press re-reads the state until KYA confirms it. */
  confirmEveryMs?: number;
  confirmMs?: number;
}

type Read = AwakeProcs & { installed: boolean };

/** A timed session's end moves by up to a second between reads (ps etime has 1 s steps): don't call that a change. */
const UNTIL_JITTER_MS = 1500;

const failed = (message: string): ActionResult => ({ ok: false, message, feedback: "alert" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * KYA's state for the keys, and pressing it. Emits "change" (no arguments) whenever `state` changed. Never throws out
 * of its timers: a failed read is kept in `state.error`.
 */
export class KeepAwake extends EventEmitter {
  state: KeepAwakeState;
  private readonly runner: KeepAwakeRunner;
  private readonly opts: Required<KeepAwakeOptions>;
  private timer: NodeJS.Timeout | undefined;
  private reading: Promise<Read> | undefined;
  /** Presses run one after the other (two keys pressed together). */
  private chain: Promise<unknown> = Promise.resolve();
  /** A press is between its optimistic state and KYA's confirmation: polls don't overwrite what the key shows. */
  private pressing = false;

  constructor(runner: KeepAwakeRunner = realRunner, opts: KeepAwakeOptions = {}) {
    super();
    this.runner = runner;
    this.opts = { pollMs: 2000, confirmEveryMs: 150, confirmMs: 4000, ...opts };
    this.state = { installed: this.appInstalled(), running: false, active: false };
  }

  private appInstalled(): boolean {
    try {
      return kyaAppPaths().some((p) => this.runner.exists(p));
    } catch {
      return false;
    }
  }

  /** Poll while at least one Keep Awake key is visible (the action passes whether it has any); reads at once on start. */
  setWatching(on: boolean): void {
    if (on && !this.timer) {
      this.timer = setInterval(() => void this.refresh(), this.opts.pollMs);
      this.timer.unref?.();
      void this.refresh();
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get watching(): boolean {
    return !!this.timer;
  }

  /** One read of the process table (concurrent callers share it). Rejects when ps fails. */
  private read(): Promise<Read> {
    if (!this.reading) {
      const p = (async (): Promise<Read> => {
        const procs = parseAwake(await this.runner.exec("/bin/ps", ["-axww", "-o", "pid=,ppid=,etime=,args="]), this.runner.now());
        return { ...procs, installed: procs.running || this.appInstalled() };
      })();
      this.reading = p;
      const done = () => {
        if (this.reading === p) this.reading = undefined;
      };
      p.then(done, done);
    }
    return this.reading;
  }

  private set(next: KeepAwakeState): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (changed) this.emit("change");
  }

  /** Show a read — unless a press is pending (its optimistic state stays until the press settles). */
  private apply(r: Read): void {
    if (this.pressing) return;
    const prev = this.state.until;
    const until = r.until !== undefined && prev !== undefined && Math.abs(prev - r.until) < UNTIL_JITTER_MS ? prev : r.until;
    this.set({ installed: r.installed, running: r.running, active: r.active, ...(r.active && until !== undefined ? { until } : {}) });
  }

  /** Re-read KYA's state now. Never rejects: a failed read keeps the last state and sets `error`. */
  async refresh(): Promise<KeepAwakeState> {
    try {
      this.apply(await this.read());
    } catch (err) {
      if (!this.pressing) this.set({ ...this.state, error: errorText(err) });
    }
    return this.state;
  }

  /**
   * A key press: "on" (for `seconds`, 0 = indefinitely), "off", or "toggle" (the opposite of what KYA does now). The
   * key flips at once (pending); the result comes once KYA confirmed it (re-read every ~150 ms, for up to ~4 s).
   */
  press(mode: KeepAwakeMode, seconds = 0): Promise<ActionResult> {
    const p = this.chain.then(() => this.pressNow(mode, seconds));
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async pressNow(mode: KeepAwakeMode, seconds: number): Promise<ActionResult> {
    let cur: Read;
    try {
      cur = await this.read();
    } catch (err) {
      await this.refresh();
      return failed(readFailed(err));
    }
    this.apply(cur);
    if (!cur.installed) return failed(NOT_INSTALLED);
    const target = mode === "on" ? true : mode === "off" ? false : !cur.active;
    if (!target && !cur.running) return { ok: true, message: "Keep awake is off" }; // already off: nothing to send

    // The key shows the outcome at once.
    const until = target && seconds > 0 ? { until: this.runner.now() + seconds * 1000 } : {};
    this.set({ installed: true, running: true, active: target, ...until, pending: true });
    this.pressing = true;
    /** The last good read since the open, and the error of the latest read when it failed. */
    let last: Read | undefined;
    let readError: unknown;
    try {
      try {
        await this.runner.exec("/usr/bin/open", ["-g", kyaLink(target, seconds)]);
      } catch (err) {
        return failed(`Couldn't open KeepingYouAwake: ${errorText(err)}`);
      }
      // On while already on (a new duration): KYA replaces its caffeinate child, so wait for the new one. Should it
      // keep the old one, KYA is still on — what the press asked for — once the wait is over.
      const replaces = target && cur.active;
      const deadline = this.runner.now() + this.opts.confirmMs;
      const tries = Math.max(1, Math.ceil(this.opts.confirmMs / Math.max(1, this.opts.confirmEveryMs)));
      for (let i = 0; i < tries && this.runner.now() < deadline; i++) {
        await sleep(this.opts.confirmEveryMs);
        try {
          last = await this.read();
          readError = undefined;
        } catch (err) {
          readError = err;
        }
        if (last?.active === target && (!replaces || last.pid !== cur.pid)) break;
      }
      // Unconfirmed: blame the read when ps failed last (KYA may well have followed), else KYA.
      if (last?.active !== target) return failed(readError !== undefined ? readFailed(readError) : NO_RESPONSE);
      if (!target) return { ok: true, message: "Keep awake is off" };
      return { ok: true, message: seconds > 0 ? `Keeping your Mac awake for ${durationLabel(seconds)}` : "Keeping your Mac awake" };
    } finally {
      // Never leave the optimistic state up: show what KYA confirmed, else read again.
      this.pressing = false;
      if (last?.active === target) this.apply(last);
      else await this.refresh();
      if (this.state.pending) {
        // That read failed too: back to the last state ps showed (not the unconfirmed target), keeping the error.
        const known = last ?? cur;
        const { error } = this.state;
        this.set({
          installed: known.installed,
          running: known.running,
          active: known.active,
          ...(known.active && known.until !== undefined ? { until: known.until } : {}),
          ...(error !== undefined ? { error } : {}),
        });
      }
    }
  }
}
