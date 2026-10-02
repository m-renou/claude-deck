// A fake Claude Code behind UsageCli's spawn, and a fake clock — nothing runs the real CLI. The fake records every
// spawn (file, args, cwd, env) and everything written to its stdin, answers initialize and get_usage like the real one
// (the answers are shaped like this Mac's real output, 2026-10-02: Max plan, a 31 KB initialize answer) in chunks that
// split lines anywhere, and can be told to answer with an error, say nothing, quit or print other lines first. Its
// session records (Claude Code's ~/.claude/sessions/<pid>.json) name a messaging socket only when told to. Anything
// written to it that isn't an initialize / get_usage control request is a violation (tests assert there are none).

import { EventEmitter } from "node:events";
import type { ChildLike, Clock, SpawnLike } from "../src/claude/usage-cli.ts";

export const CLI = "/Users/me/Library/Application Support/Claude/claude-code/2.1.286/f2326db61802/claude.app/Contents/MacOS/claude";
export const NEW_CLI = "/Users/me/Library/Application Support/Claude/claude-code/2.1.290/0a1b2c3d4e5f/claude.app/Contents/MacOS/claude";

const windowOf = (utilization: unknown, resets_at: unknown) => ({ utilization, resets_at, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null });

/** get_usage's inner `response` while signed in (Max plan), as the real one is shaped. */
export const USAGE_RESPONSE = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: windowOf(15, "2026-10-02T22:39:59.847527+00:00"),
    seven_day: windowOf(19, "2026-10-08T04:59:59.847554+00:00"),
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_cowork: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null, daily: null, weekly: null },
    limits: [],
    model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-10-08T05:00:00.295313+00:00" }],
    brand_new_key: { whatever: true },
  },
  behaviors: null,
};

/** Signed out: no plan, no limits. */
export const SIGNED_OUT_RESPONSE = { session: USAGE_RESPONSE.session, subscription_type: null, rate_limits_available: false, rate_limits: null, behaviors: null };

/** The initialize answer: large (commands, models, account …) — never looked at. */
function initResponse(): unknown {
  const commands = Array.from({ length: 240 }, (_, i) => ({ name: `command-${i}`, description: `What command ${i} does — “quoted”, ünïcödé, 🙂`, argumentHint: "[args]" }));
  return { commands, agents: [], output_style: "default", models: [{ value: "claude-opus-5-5", displayName: "Opus 5.5" }], account: { subscriptionType: "max" }, pid: 4242 };
}

/** How the fake answers one get_usage request. */
export type Reply =
  /** success with this inner response */
  | { response: unknown }
  /** subtype "error" */
  | { error: string }
  /** never answers */
  | "hang"
  /** quits (exit code, stderr) without answering */
  | { exit: number; stderr?: string }
  /** prints these lines before its answer (noise to skip) */
  | { noise: string[]; then: Reply };

let pids = 5000;

export class FakeProc extends EventEmitter {
  readonly pid = ++pids;
  readonly file: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Lines written to stdin, as written. */
  readonly lines: string[] = [];
  ended = false;
  readonly signals: NodeJS.Signals[] = [];
  exited = false;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: { write(data: string): boolean; end(): void; on(event: "error", fn: (err: Error) => void): unknown };
  private readonly claude: FakeClaude;
  private partial = "";

  constructor(claude: FakeClaude, file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
    super();
    this.claude = claude;
    this.file = file;
    this.args = args;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.stdin = {
      write: (data: string) => {
        if (this.ended) throw new Error("write after end");
        this.partial += data;
        for (let nl = this.partial.indexOf("\n"); nl >= 0; nl = this.partial.indexOf("\n")) {
          const line = this.partial.slice(0, nl);
          this.partial = this.partial.slice(nl + 1);
          this.lines.push(line);
          this.onLine(line);
        }
        return true;
      },
      end: () => {
        this.ended = true;
        if (this.claude.exitOnEnd) setImmediate(() => this.exit(0, null));
      },
      on: () => this.stdin,
    };
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (!(signal === "SIGTERM" && this.claude.ignoreSigterm)) setImmediate(() => this.exit(null, signal));
    return !this.exited;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }

  /** Print text on stdout, in chunks of claude.chunk bytes (lines and UTF-8 characters split anywhere). */
  print(text: string): void {
    const buf = Buffer.from(text, "utf8");
    for (let i = 0; i < buf.length; i += this.claude.chunk) this.stdout.emit("data", buf.subarray(i, i + this.claude.chunk));
  }

  printErr(text: string): void {
    this.stderr.emit("data", Buffer.from(text, "utf8"));
  }

  /** The get_usage requests it got. */
  get usageRequests(): number {
    return this.lines.filter((l) => l.includes('"get_usage"')).length;
  }

  private onLine(line: string): void {
    let msg: { type?: unknown; request_id?: unknown; request?: { subtype?: unknown; skip_behaviors?: unknown } } | undefined;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = undefined;
    }
    const keys = msg && typeof msg === "object" ? Object.keys(msg).sort().join() : "";
    const sub = msg?.request?.subtype;
    const reqKeys = msg?.request && typeof msg.request === "object" ? Object.keys(msg.request).sort().join() : "";
    const ok =
      msg?.type === "control_request" &&
      keys === "request,request_id,type" &&
      typeof msg.request_id === "string" &&
      ((sub === "initialize" && reqKeys === "subtype") || (sub === "get_usage" && msg.request?.skip_behaviors === true && reqKeys === "skip_behaviors,subtype"));
    if (!ok) {
      this.claude.violations.push(line);
      return;
    }
    const id = msg!.request_id as string;
    if (sub === "initialize") {
      setImmediate(() => this.answer(id, { response: initResponse() }));
      return;
    }
    this.claude.usageTimes.push(this.claude.now());
    const reply = this.claude.replies.length ? this.claude.replies.shift()! : this.claude.fallback;
    setImmediate(() => this.answer(id, reply));
  }

  private answer(id: string, reply: Reply): void {
    if (this.exited) return;
    if (reply === "hang") return;
    if ("noise" in reply) {
      for (const l of reply.noise) this.print(`${l.replace(/\{id\}/g, id)}\n`);
      this.answer(id, reply.then);
      return;
    }
    if ("exit" in reply) {
      if (reply.stderr) this.printErr(reply.stderr);
      this.exit(reply.exit, null);
      return;
    }
    const response = "error" in reply ? { subtype: "error", request_id: id, error: reply.error } : { subtype: "success", request_id: id, response: reply.response };
    this.print(`${JSON.stringify({ type: "control_response", response })}\n`);
  }
}

export class FakeClaude {
  readonly procs: FakeProc[] = [];
  /** When each get_usage request came in (by `now`). */
  readonly usageTimes: number[] = [];
  readonly now: () => number;
  /** Answers to the next get_usage requests (any process), then `fallback`. */
  replies: Reply[] = [];
  fallback: Reply = { response: USAGE_RESPONSE };
  /** Lines written to any process that weren't an initialize / get_usage control request. */
  readonly violations: string[] = [];
  /** stdout chunk size (bytes). */
  chunk = 997;
  /** Quit when stdin closes (the real one does, within a second). */
  exitOnEnd = true;
  ignoreSigterm = false;
  /** Throw from spawn itself (instead of an "error" event). */
  spawnThrows: Error | undefined;
  /** Its processes' session records name a messaging socket (an inbox other sessions can message). */
  inbox = false;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  readonly spawn: SpawnLike = (file, args, opts) => {
    if (this.spawnThrows) throw this.spawnThrows;
    const p = new FakeProc(this, file, args, opts);
    this.procs.push(p);
    return p as unknown as ChildLike;
  };

  get last(): FakeProc | undefined {
    return this.procs[this.procs.length - 1];
  }

  /** Claude Code's session record for a pid, as the real one is shaped (UsageCli's sessionRecord). */
  readonly sessionRecord = (pid: number): unknown => {
    if (!this.procs.some((p) => p.pid === pid && !p.exited)) return undefined;
    return { pid, kind: "interactive", entrypoint: "sdk-cli", status: "idle", ...(this.inbox ? { messagingSocketPath: `/tmp/cc-socks/${pid}.sock` } : {}) };
  };

  /** get_usage requests over all processes. */
  get usageRequests(): number {
    return this.procs.reduce((n, p) => n + p.usageRequests, 0);
  }
}

/** Let fake I/O (setImmediate) and the promises behind it run. */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** Time that only moves when a test says so; timers fire in order, with fake I/O settling in between. */
export class FakeClock implements Clock {
  t: number;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private seq = 0;

  constructor(t: number) {
    this.t = t;
  }

  now = (): number => this.t;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Due times of the armed timers. */
  get armed(): number[] {
    return [...this.timers.values()].map((x) => x.at).sort((a, b) => a - b);
  }

  /** Move on by `ms`, firing every timer due on the way. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await settle();
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}
