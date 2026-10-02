// Live plan usage for the Usage keys, every minute, from Claude Code on this Mac (src/claude/usage-cli.ts: one
// long-lived Claude Code process answering "get_usage" with its own sign-in) — the Claude app itself writes
// plan-usage-history.json only every 15 min, and only while its menu-bar menu was opened in the last 24 h.
//
// Polling runs only while a Usage key / dial / infobar shows a plan view (weekly, 5-hour or auto): Claude Code starts
// then and is asked at once, then every minute. Claude Code answers get_usage from its own cache for a minute after it
// asked Anthropic (measured: asked again 60 s later it repeats the answer in 2 ms, 65 s later it asks anew), so the
// next request goes out 61 s after the last answer with usage — every answer is new, and its time is honest. A Usage
// dial push / touch re-reads at once, but asks Claude Code only when its last answer is over a minute old (after a
// failure, say) and no request went out in the last 10 s: while polling works, the next minute's request is the
// refresh. One request at a time. Two minutes after the last plan view went away the process is ended; plugin.ts ends
// it on exit too.
// Outcomes (state.status):
//   live        five_hour / seven_day utilization + resets_at → a sample (source "live")
//   signed-out  Claude Code isn't signed in: its process is ended (a new one reads a new sign-in) and a new one asks
//               every minute — every 5 min after ten tries (the Usage page, while open, still checks every minute)
//   no-cli      the Claude app hasn't installed Claude Code (yet): looked for again every minute
//   no-answer   no answer within 15 s (the process is killed) or it quit: a new one after 5 s, 10 s, 20 s … 5 min
//   error       an error answer, or one of another shape (the request is experimental): asked again next minute
//   blocked     other sessions could reach the process (usage-cli.ts: an open inbox, a turn of its own): it was
//               killed, and nothing runs until the Claude app installs another Claude Code (looked for every minute)
// Every failure keeps the last sample — the keys show the newer of it and the app's own numbers, with "as of".
// Process and clock are injectable (tests use fakes); never throws out of its timers — a "change" listener that throws
// (a render error) is reported as "listenerError" and changes nothing here: the other listeners still run and polling
// goes on.

import { EventEmitter } from "node:events";
import type { PlanSample } from "./usage.ts";
import { CliError, type Clock, loginCommand, oneLine, readUsageAnswer, realClock, UsageCli } from "./usage-cli.ts";

/**
 *   idle        not asked yet
 *   starting    the first request is on its way
 *   live        the last request answered with usage
 *   signed-out  Claude Code isn't signed in (message: the command that signs it in)
 *   no-cli      Claude Code isn't installed in the Claude app yet
 *   no-answer   Claude Code didn't answer in time, quit or couldn't start — a new one at `retryAt`
 *   error       Claude Code answered with an error, or without usage numbers
 *   blocked     other sessions could reach Claude Code's process: stopped until the app installs another Claude Code
 */
export type LiveStatus = "idle" | "starting" | "live" | "signed-out" | "no-cli" | "no-answer" | "error" | "blocked";

export interface LiveUsageState {
  status: LiveStatus;
  /** The latest good answer (kept through every failure). */
  sample?: PlanSample;
  /** What went wrong, in Claude Code's words where it said any. */
  message?: string;
  /** Last request (ms epoch). */
  checkedAt?: number;
  /** no-answer: the next try (ms epoch). */
  retryAt?: number;
  /** The Claude Code that was asked (the sign-in command names it). */
  cli?: string;
}

/** What the poller needs of a usage source (src/claude/usage-cli.ts UsageCli). */
export interface UsageSource {
  request(): Promise<unknown>;
  stop(): void;
  shutdown(): void;
  readonly running: boolean;
  readonly cli: string | undefined;
}

export interface LiveUsageOptions {
  /** Interval between requests while watched. */
  pollMs?: number;
  /** How long Claude Code repeats its last usage answer (its cache, plus a second): no request that soon after one. */
  cacheMs?: number;
  /** A refresh-now within this long after the last request does nothing. */
  refreshGapMs?: number;
  /** The process is ended this long after the last plan view went away. */
  idleStopMs?: number;
  /** First and longest wait before a new process after one didn't answer. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Signed out: this many tries a pollMs apart, then one per maxBackoffMs. */
  signedOutTries?: number;
}

export interface LiveUsageDeps {
  source?: UsageSource;
  clock?: Clock;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Emits "change" (no arguments) when the sample or the status changed, and "listenerError" (the error) when a
 *  "change" listener threw. */
export class LiveUsage extends EventEmitter {
  state: LiveUsageState = { status: "idle" };
  private readonly source: UsageSource;
  private readonly clock: Clock;
  private readonly opts: Required<LiveUsageOptions>;
  private watchingNow = false;
  /** When the last plan view went away (ms epoch). */
  private unwatchedAt: number | undefined;
  private timer: unknown;
  private idleTimer: unknown;
  private inFlight: Promise<void> | undefined;
  /** When the next request is due after the last one (ms epoch). */
  private due: number | undefined;
  /** Failed starts / requests in a row (no answer), and signed-out answers in a row. */
  private failures = 0;
  private signedOut = 0;
  /** The last answer with usage, from the process that runs now (its cache holds it for a minute). */
  private liveAt: number | undefined;
  /** When the next request is due (ms epoch; undefined = none scheduled). */
  nextAt: number | undefined;

  constructor(deps: LiveUsageDeps = {}, opts: LiveUsageOptions = {}) {
    super();
    this.clock = deps.clock ?? realClock;
    this.source = deps.source ?? new UsageCli({ clock: this.clock });
    this.opts = { pollMs: 60_000, cacheMs: 61_000, refreshGapMs: 10_000, idleStopMs: 2 * 60_000, minBackoffMs: 5000, maxBackoffMs: 5 * 60_000, signedOutTries: 10, ...opts };
  }

  get watching(): boolean {
    return this.watchingNow;
  }

  /** Poll while at least one Usage key / dial / infobar shows a plan view (the action passes whether it has any). */
  setWatching(on: boolean): void {
    if (on === this.watchingNow) return;
    this.watchingNow = on;
    if (!on) this.unwatchedAt = this.clock.now();
    this.schedule();
  }

  /** A Usage dial push / touch (or the Usage page while signed out, with a longer gap): ask now — unless a request is
   *  on its way, went out less than `gapMs` ago, or Claude Code would only repeat its last answer (so while polling
   *  works this does nothing: the next minute's request comes as soon as a new answer can). */
  refreshNow(gapMs = this.opts.refreshGapMs): void {
    if (this.inFlight) return;
    const now = this.clock.now();
    const last = this.state.checkedAt;
    if (last !== undefined && now - last < gapMs) return;
    if (this.liveAt !== undefined && now - this.liveAt < this.opts.cacheMs) return;
    void this.poll();
  }

  /** Stop polling and end the process (tests). */
  stop(): void {
    this.watchingNow = false;
    this.clearTimers();
    this.endProcess();
  }

  /** Plugin exit: end the process now (synchronous), and don't start another. */
  shutdown(): void {
    this.watchingNow = false;
    this.clearTimers();
    this.source.shutdown();
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────

  /** End the process: a new one starts with an empty cache. */
  private endProcess(): void {
    this.liveAt = undefined;
    this.source.stop();
  }

  private clearTimers(): void {
    this.clock.clearTimeout(this.timer);
    this.clock.clearTimeout(this.idleTimer);
    this.timer = undefined;
    this.idleTimer = undefined;
    this.nextAt = undefined;
  }

  /** Changes other than the attempt time count (a failing request every minute isn't news). Never throws. */
  private set(next: LiveUsageState): void {
    const key = (s: LiveUsageState) => JSON.stringify({ ...s, checkedAt: undefined });
    const changed = key(next) !== key(this.state);
    this.state = next;
    if (changed) this.announce();
  }

  /** "change" to every listener on its own: one that throws doesn't keep the others from hearing it, nor stop polling
   *  (its error goes to "listenerError" — plugin.ts logs it). */
  private announce(): void {
    for (const listener of this.rawListeners("change") as Array<() => void>) {
      try {
        listener.call(this);
      } catch (err) {
        try {
          this.emit("listenerError", err);
        } catch {
          // nothing more to tell
        }
      }
    }
  }

  /** (Re)arm the timers. Watched: the next request when it's due (at once when there was none). Unwatched: the
   *  process ends idleStopMs after the last plan view went away (or the last request, when that was later). */
  private schedule(): void {
    this.clearTimers();
    const now = this.clock.now();
    if (!this.watchingNow) {
      if (!this.source.running) return;
      const at = Math.max(this.unwatchedAt ?? now, this.state.checkedAt ?? -Infinity) + this.opts.idleStopMs;
      this.idleTimer = this.clock.setTimeout(() => {
        this.idleTimer = undefined;
        if (!this.watchingNow && !this.inFlight) this.endProcess();
      }, at - now);
      return;
    }
    if (this.inFlight) return; // poll() schedules once it's done
    const due = Math.max(this.due ?? now, now);
    this.nextAt = due;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, due - now);
  }

  /** One request (concurrent callers share it), then the next one is scheduled — always. Never rejects. */
  private async poll(): Promise<void> {
    if (!this.inFlight) {
      const p = this.attempt().catch((err: unknown) => {
        this.due = this.clock.now() + this.opts.pollMs;
        this.set({ ...this.state, status: "error", message: oneLine(errorText(err)) });
      });
      this.inFlight = p;
      const done = () => {
        if (this.inFlight === p) this.inFlight = undefined;
      };
      p.then(done, done);
    }
    try {
      await this.inFlight;
    } catch {
      // attempt() reports its own failures (and set() never throws)
    } finally {
      this.schedule();
    }
  }

  private async attempt(): Promise<void> {
    const at = this.clock.now();
    if (this.state.status === "idle") this.set({ ...this.state, status: "starting", checkedAt: at });
    let response: unknown;
    try {
      response = await this.source.request();
    } catch (err) {
      const e = err instanceof CliError ? err : new CliError("answer", oneLine(errorText(err)));
      if (e.kind === "stopped") {
        this.due = at + this.opts.pollMs; // ended on purpose (no plan view, exit): nothing went wrong
        return;
      }
      if (e.kind === "blocked") {
        this.liveAt = undefined; // its process was killed
        this.failures = 0;
        this.due = at + this.opts.pollMs; // nothing starts: the next request only looks for another Claude Code
        this.fail("blocked", e.message, at);
        return;
      }
      if (e.kind === "no-cli" || e.kind === "answer") {
        this.failures = 0;
        this.due = at + this.opts.pollMs;
        this.fail(e.kind === "no-cli" ? "no-cli" : "error", e.kind === "no-cli" ? undefined : e.message, at);
        return;
      }
      // spawn / exited / timeout: a new process after a growing wait
      this.liveAt = undefined;
      this.failures++;
      const wait = Math.min(this.opts.minBackoffMs * 2 ** Math.min(this.failures - 1, 30), this.opts.maxBackoffMs);
      this.due = this.clock.now() + wait;
      this.fail("no-answer", e.message, at, this.due);
      return;
    }
    this.failures = 0;
    const answeredAt = this.clock.now();
    const answer = readUsageAnswer(response, answeredAt);
    if (answer.kind === "usage") {
      this.signedOut = 0;
      this.liveAt = answeredAt;
      this.due = Math.max(at + this.opts.pollMs, answeredAt + this.opts.cacheMs);
      const cli = this.source.cli;
      this.set({ status: "live", sample: answer.sample, checkedAt: at, ...(cli ? { cli } : {}) });
      return;
    }
    if (answer.kind === "signed-out") {
      this.signedOut++;
      this.endProcess(); // a running Claude Code may never notice a sign-in made in Terminal: the next try is a new one
      this.due = at + (this.signedOut < this.opts.signedOutTries ? this.opts.pollMs : this.opts.maxBackoffMs);
      this.fail("signed-out", `Claude Code isn't signed in — run ${loginCommand(this.source.cli)} in Terminal once`, at);
      return;
    }
    this.due = at + this.opts.pollMs;
    this.fail("error", answer.message, at);
  }

  /** A failed request: the last good sample stays. */
  private fail(status: LiveStatus, message: string | undefined, at: number, retryAt?: number): void {
    const next: LiveUsageState = { status, checkedAt: at };
    if (this.state.sample) next.sample = this.state.sample;
    if (message) next.message = message;
    if (retryAt !== undefined) next.retryAt = retryAt;
    const cli = this.source.cli;
    if (cli) next.cli = cli;
    this.set(next);
  }
}

/** The plugin's live-usage poller (one for all Usage keys: the plan is account-wide). */
export const usageLive = new LiveUsage();
