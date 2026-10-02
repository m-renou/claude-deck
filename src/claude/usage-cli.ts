// Plan usage from Claude Code itself: one long-lived Claude Code process (the CLI the Claude app installs, found by
// src/claude/paths.ts findClaudeCli) that answers the SDK control request "get_usage" — the numbers of the app's Usage
// page and of Claude Code's /usage, which Claude Code reads from Anthropic with its own sign-in. The plugin never sees
// a token and contacts no host itself. src/claude/usage-live.ts decides when to ask.
//   claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence
//          --strict-mcp-config --setting-sources user --settings '{"crossSessionInbound":"refuse"}'
//   stdin   {"type":"control_request","request_id":"deck-init-1","request":{"subtype":"initialize"}}
//           {"type":"control_request","request_id":"deck-usage-2","request":{"subtype":"get_usage","skip_behaviors":true}}
//   stdout  newline-delimited JSON. Ours: {"type":"control_response","response":{"subtype":"success",
//           "request_id":"deck-usage-2","response":{"subscription_type":"max","rate_limits_available":true,
//           "rate_limits":{"five_hour":{"utilization":15,"resets_at":"2026-10-02T22:39:59.847527+00:00",…},
//           "seven_day":{…},…},…}}} — or "subtype":"error" with an "error" string. Signed out: rate_limits_available
//           false, rate_limits null. Every other line (the large initialize answer too) is skipped unread.
// The request is experimental in Claude Code (usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET): an answer of
// another shape is an error, never a guess — the keys then show the Claude app's own numbers.
// The plugin writes only these two control requests: no prompt, no user message.
// Other sessions can't reach it either. Claude Code registers every process as a local session
// (~/.claude/sessions/<pid>.json) and normally opens an inbox there that the user's other Claude Code sessions can
// message (SendMessage) — a message would start a model turn the plugin never asked for, spending plan usage and
// running tools. So the process runs with CLAUDE_CODE_HARBOR_KITE=0, Claude Code's internal, undocumented switch for
// that inbox (measured on 2.1.286: no socket, not listed as a peer; get_usage still answers), and with the setting
// crossSessionInbound "refuse" (refuse such messages, should an inbox open anyway). And it fails closed: a session
// record that names a messaging socket (checked with every answer), or a turn's line on stdout (user / assistant /
// result, or a system init), ends the process at once, and that Claude Code isn't started again ("blocked") until the
// app installs another one. The process still leaves a session record while it runs (removed when it quits).
// Every start of Claude Code writes ~/.claude.json and ~/.claude/backups, so one process serves every request. It runs
// in a private empty folder (~/.config/claude-code-deck/usage-cli, 0700: no project settings or CLAUDE.md apply) and
// without the plugin's CLAUDE_CODE_* / ANTHROPIC_* / CLAUDECODE variables, so it always uses its own sign-in (--bare
// can't be used: it never reads the sign-in). Its stderr is drained; only its first line is kept (for an exit message).
// Spawn, clock, folder and session records are injectable: tests drive a fake process.

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { findClaudeCli } from "./paths.ts";
import type { PlanSample } from "./usage.ts";

/** Claude Code's setting for messages from the user's other sessions: refused. */
export const INBOX_SETTINGS = '{"crossSessionInbound":"refuse"}';

export const CLI_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "user", "--settings", INBOX_SETTINGS] as const;

/** Claude Code's internal switch for its inbox for other sessions' messages (CLAUDE_CODE_HARBOR_KITE, undocumented;
 *  measured on 2.1.286): off, so no socket opens and other sessions don't list the process as a peer. */
export const INBOX_OFF_ENV = { CLAUDE_CODE_HARBOR_KITE: "0" } as const;

/** The folder Claude Code runs in for the plugin. */
export const usageCliDir = (): string => path.join(os.homedir(), ".config", "claude-code-deck", "usage-cli");

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One line of outside text, without control characters, at most `max` characters. */
export const oneLine = (s: string, max = 200): string =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** "15 s" / "150 ms". */
export const duration = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);

// ── Clock (injectable) ──────────────────────────────────────────────────────────────────────────────────

export interface Clock {
  now(): number;
  /** Run `fn` after `ms`; the handle goes to clearTimeout. */
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** setTimeout's limit: longer delays fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Real time; its timers don't keep the plugin alive. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, Math.max(0, Math.min(ms, MAX_TIMER_MS)));
    t.unref?.();
    return t;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout | undefined),
};

// ── Commands and answers (pure) ─────────────────────────────────────────────────────────────────────────

/** A word for a shell command line: as it is when it's plain, else in single quotes ("Application Support"). */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The Terminal command that signs Claude Code in (once: it keeps and refreshes its sign-in itself). The Claude app's
 * copy isn't on PATH, so plain `claude auth login` would say "command not found": the command names the CLI the
 * plugin found, and is plain `claude auth login` only when there is none.
 */
export function loginCommand(cli: string | undefined): string {
  return `${cli ? shellQuote(cli) : "claude"} auth login`;
}

/** The process's environment: the plugin's, without anything that would hand Claude Code another sign-in or make it
 *  think it runs inside a session (CLAUDE_CODE_*, ANTHROPIC_*, CLAUDECODE) — then with its inbox for other sessions
 *  switched off (INBOX_OFF_ENV, set after the stripping). */
export function cliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^(?:CLAUDE_CODE_|ANTHROPIC_)|^CLAUDECODE$/i.test(k)) out[k] = v;
  return { ...out, ...INBOX_OFF_ENV };
}

/** The messaging socket a Claude Code session record (~/.claude/sessions/<pid>.json) names: its inbox for other
 *  sessions is open. */
export function messagingSocketOf(record: unknown): string | undefined {
  return isObject(record) && typeof record.messagingSocketPath === "string" && record.messagingSocketPath.trim() ? record.messagingSocketPath : undefined;
}

/** A line of a model turn (the start of one, a message in it, or its result): a turn nobody here asked for. */
export function isTurnLine(msg: unknown): boolean {
  if (!isObject(msg)) return false;
  return msg.type === "user" || msg.type === "assistant" || msg.type === "result" || (msg.type === "system" && msg.subtype === "init");
}

/** Lines that may be a turn's (JSON.parse only runs on these, and on our answer). */
const TURN_HINT = /"type"\s*:\s*"(?:user|assistant|result|system)"/;

/** The only requests ever written to the process. */
export type ControlRequest = { subtype: "initialize" } | { subtype: "get_usage"; skip_behaviors: true };

export const controlLine = (id: string, request: ControlRequest): string => `${JSON.stringify({ type: "control_request", request_id: id, request })}\n`;

/**
 * Newline-delimited output → whole lines. A chunk may end anywhere (inside a line, inside a UTF-8 character). A line
 * longer than `maxLine` characters is dropped, up to its newline, instead of growing without end.
 */
export class LineBuffer {
  private readonly decoder = new StringDecoder("utf8");
  private readonly maxLine: number;
  private rest = "";
  /** The start of an over-long line was dropped: its end (up to the next newline) goes too. */
  private skipping = false;

  constructor(maxLine = 32 * 1024 * 1024) {
    this.maxLine = maxLine;
  }

  /** The lines this chunk completes (without "\r\n" / "\n"; blank ones left out). */
  push(chunk: Buffer | string): string[] {
    const parts = (this.rest + (typeof chunk === "string" ? chunk : this.decoder.write(chunk))).split("\n");
    this.rest = parts.pop() ?? "";
    if (this.skipping && parts.length) {
      parts.shift();
      this.skipping = false;
    }
    if (this.rest.length > this.maxLine) {
      this.rest = "";
      this.skipping = true;
    }
    return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)).filter((l) => l.trim());
  }
}

/** A percentage: a finite number ≥ 0 (above 100 once over the limit), also when sent as a string ("16"). */
function percent(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(v) ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** A point in time: an ISO 8601 string (or epoch seconds / ms as a number). */
function instant(v: unknown): number | undefined {
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v;
  return undefined;
}

function usageWindow(v: unknown): { used?: number; resetsAt?: number } {
  if (!isObject(v)) return {};
  return { used: percent(v.utilization), resetsAt: instant(v.resets_at) };
}

export type UsageAnswer =
  | { kind: "usage"; sample: PlanSample }
  /** Claude Code isn't signed in to a Claude plan. */
  | { kind: "signed-out" }
  /** Another shape (the request is experimental): `message` says what was missing. */
  | { kind: "invalid"; message: string };

/** get_usage's answer (the control_response's inner `response`) → a sample taken at `at`. */
export function readUsageAnswer(response: unknown, at: number): UsageAnswer {
  if (!isObject(response)) return { kind: "invalid", message: "Claude Code's usage answer was empty" };
  const plan = typeof response.subscription_type === "string" && response.subscription_type.trim() ? oneLine(response.subscription_type, 40) : undefined;
  if (response.rate_limits_available === false) {
    // A plan without numbers is no sign-in problem: don't send the user to sign in again.
    return plan ? { kind: "invalid", message: `Claude Code has no usage numbers for this ${plan} plan right now` } : { kind: "signed-out" };
  }
  const limits = response.rate_limits;
  if (!isObject(limits)) return { kind: "invalid", message: "Claude Code's usage answer had no rate limits" };
  const fh = usageWindow(limits.five_hour);
  const sd = usageWindow(limits.seven_day);
  if (fh.used === undefined && sd.used === undefined) return { kind: "invalid", message: "Claude Code's usage answer had no 5-hour or weekly number" };
  const sample: PlanSample = { at, source: "live" };
  if (fh.used !== undefined) sample.fiveHour = fh.used;
  if (sd.used !== undefined) sample.weekly = sd.used;
  if (fh.used !== undefined && fh.resetsAt !== undefined) sample.fiveHourResetsAt = fh.resetsAt;
  if (sd.used !== undefined && sd.resetsAt !== undefined) sample.weeklyResetsAt = sd.resetsAt;
  return { kind: "usage", sample };
}

// ── The process (spawn injectable) ──────────────────────────────────────────────────────────────────────

/** The part of a ChildProcess this module uses. */
export interface ChildLike {
  readonly pid?: number;
  readonly stdin: { write(data: string): unknown; end(): unknown; on(event: "error", fn: (err: Error) => void): unknown } | null;
  readonly stdout: { on(event: "data", fn: (chunk: Buffer | string) => void): unknown } | null;
  readonly stderr: { on(event: "data", fn: (chunk: Buffer | string) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
}

export type SpawnLike = (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildLike;

const realSpawn: SpawnLike = (file, args, opts) => nodeSpawn(file, args, { ...opts, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

/** Claude Code's session record for a pid (~/.claude/sessions/<pid>.json, or under $CLAUDE_CONFIG_DIR, which the
 *  process keeps): parsed, or undefined when there is none. */
const readSessionRecord =
  (env: NodeJS.ProcessEnv) =>
  (pid: number): unknown => {
    const dir = path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude"), "sessions");
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), "utf8"));
    } catch {
      return undefined;
    }
  };

/** The private folder, created 0700 (and kept 0700). */
function prepareDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 *   no-cli   Claude Code isn't installed (nothing ran)
 *   spawn    it couldn't be started
 *   exited   it quit before answering
 *   timeout  no answer in time (the process was killed)
 *   answer   it answered with an error
 *   stopped  stop() / shutdown() ended it while a request was on its way
 *   blocked  other sessions could reach it (an open inbox, a turn of its own): killed, and this Claude Code isn't
 *            started again until the app installs another one
 */
export type CliFailure = "no-cli" | "spawn" | "exited" | "timeout" | "answer" | "stopped" | "blocked";

export class CliError extends Error {
  readonly kind: CliFailure;
  constructor(kind: CliFailure, message: string) {
    super(message);
    this.name = "CliError";
    this.kind = kind;
  }
}

export interface UsageCliDeps {
  spawn?: SpawnLike;
  /** The Claude Code to run, looked up for every request (the Claude app updates it). */
  findCli?: () => string | undefined;
  clock?: Clock;
  /** The folder to run in (default: usageCliDir(), created 0700). */
  workDir?: () => string;
  /** The environment it starts from (default: process.env); cliEnv() strips it. */
  env?: NodeJS.ProcessEnv;
  /** Claude Code's session record for a pid (default: read from ~/.claude/sessions). */
  sessionRecord?: (pid: number) => unknown;
}

export interface UsageCliOptions {
  /** A request gives up (and the process is killed) after this long. */
  timeoutMs?: number;
  /** stop(): SIGTERM this long after stdin was closed, SIGKILL after twice as long; a timeout: SIGKILL this long after
   *  SIGTERM. */
  killAfterMs?: number;
}

interface Running {
  proc: ChildLike;
  cli: string;
  lines: LineBuffer;
  /** The start of its stderr (the rest is read and dropped). */
  stderr: string;
  exited: boolean;
  /** Ended for safety (block()). */
  blocked: boolean;
  timers: unknown[];
}

interface Pending {
  id: string;
  child: Running;
  timer: unknown;
  promise: Promise<unknown>;
  resolve(response: unknown): void;
  reject(err: CliError): void;
}

/** Kept of a process's stderr: enough for its first line. */
const STDERR_KEEP = 4096;

/** The first non-blank line of a process's stderr, short. */
const firstLine = (s: string): string => oneLine(s.split(/\r?\n/).find((l) => l.trim()) ?? "", 160);

/** Why a process was blocked (the PI shows it). */
export const INBOX_OPEN = "Claude Code opened an inbox for messages from other sessions";
export const TURN_STARTED = "Claude Code started a turn of its own (a message from another session?)";

/**
 * One Claude Code process for get_usage, started on the first request and kept for the next ones. One request at a
 * time (a second caller gets the same answer). Never throws: every failure is a rejected CliError.
 */
export class UsageCli {
  private readonly spawnFn: SpawnLike;
  private readonly findCli: () => string | undefined;
  private readonly clock: Clock;
  private readonly workDir: () => string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessionRecord: (pid: number) => unknown;
  private readonly opts: Required<UsageCliOptions>;
  private child: Running | undefined;
  private pending: Pending | undefined;
  /** Processes that haven't exited yet: the current one and any being stopped (shutdown() ends them all). */
  private readonly alive = new Set<Running>();
  private seq = 0;
  private lastCli: string | undefined;
  /** The Claude Code that isn't started again, and why (block()). */
  private blocked: { cli: string; why: string } | undefined;

  constructor(deps: UsageCliDeps = {}, opts: UsageCliOptions = {}) {
    this.spawnFn = deps.spawn ?? realSpawn;
    this.findCli = deps.findCli ?? findClaudeCli;
    this.clock = deps.clock ?? realClock;
    this.workDir = deps.workDir ?? (() => prepareDir(usageCliDir()));
    this.env = deps.env ?? process.env;
    this.sessionRecord = deps.sessionRecord ?? readSessionRecord(this.env);
    this.opts = { timeoutMs: 15_000, killAfterMs: 2000, ...opts };
  }

  /** A process is running (it may be idle). */
  get running(): boolean {
    return !!this.child;
  }

  /** The Claude Code that runs, else the one the last request found. */
  get cli(): string | undefined {
    return this.child?.cli ?? this.lastCli;
  }

  /** The running process's pid. */
  get pid(): number | undefined {
    return this.child?.proc.pid;
  }

  /**
   * Ask for usage: resolves with get_usage's answer (the inner `response` object), rejects with a CliError. Starts the
   * process when none runs, and replaces it when the Claude Code it runs isn't the one installed now. A blocked Claude
   * Code fails at once (nothing runs) until the app installs another one.
   */
  request(): Promise<unknown> {
    if (this.pending) return this.pending.promise;
    let cli: string | undefined;
    try {
      cli = this.findCli();
    } catch {
      cli = undefined;
    }
    this.lastCli = cli;
    if (!cli) {
      this.stop();
      return Promise.reject(new CliError("no-cli", "Claude Code isn't installed in the Claude app yet"));
    }
    if (this.blocked && this.blocked.cli !== cli) this.blocked = undefined; // the app installed another Claude Code
    if (this.blocked) {
      this.stop(); // one of the same Claude Code started meanwhile goes too
      return Promise.reject(new CliError("blocked", this.blocked.why));
    }
    if (this.child && this.child.cli !== cli) this.stop(); // the app updated Claude Code: run the new one
    if (!this.child) {
      try {
        this.child = this.start(cli);
      } catch (err) {
        return Promise.reject(new CliError("spawn", `Couldn't start Claude Code: ${oneLine(errorText(err))}`));
      }
    }
    const child = this.child;
    let resolve!: (response: unknown) => void;
    let reject!: (err: CliError) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const p: Pending = { id: `deck-usage-${++this.seq}`, child, timer: undefined, promise, resolve, reject };
    this.pending = p;
    p.timer = this.clock.setTimeout(() => {
      if (this.pending !== p) return;
      this.settle(p, new CliError("timeout", `no answer within ${duration(this.opts.timeoutMs)}`));
      this.kill(child);
    }, this.opts.timeoutMs);
    this.write(child, controlLine(p.id, { subtype: "get_usage", skip_behaviors: true }));
    return promise;
  }

  /**
   * End the process (no plan view for a while, a new Claude Code, signed out): its stdin closes, which makes Claude
   * Code quit within a second; SIGTERM follows after killAfterMs, SIGKILL after twice that. A request on its way fails
   * ("stopped").
   */
  stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    if (this.pending?.child === child) this.settle(this.pending, new CliError("stopped", "Claude Code was stopped"));
    this.endInput(child);
    child.timers.push(
      this.clock.setTimeout(() => this.signal(child, "SIGTERM"), this.opts.killAfterMs),
      this.clock.setTimeout(() => this.signal(child, "SIGKILL"), 2 * this.opts.killAfterMs),
    );
  }

  /** Plugin exit: every process not gone yet gets its stdin closed and SIGTERM, now (exit handlers can't wait). */
  shutdown(): void {
    const child = this.child;
    this.child = undefined;
    if (child && this.pending?.child === child) this.settle(this.pending, new CliError("stopped", "Claude Code was stopped"));
    for (const c of this.alive) {
      this.endInput(c);
      this.signal(c, "SIGTERM");
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────

  private start(cli: string): Running {
    const proc = this.spawnFn(cli, [...CLI_ARGS], { cwd: this.workDir(), env: cliEnv(this.env) });
    const child: Running = { proc, cli, lines: new LineBuffer(), stderr: "", exited: false, blocked: false, timers: [] };
    this.alive.add(child);
    proc.on("error", (err) => this.gone(child, "spawn", `Couldn't start Claude Code: ${oneLine(errorText(err))}`));
    proc.on("exit", (code, signal) => {
      const why = firstLine(child.stderr);
      this.gone(child, "exited", `Claude Code quit (${signal ?? `exit ${code ?? "?"}`})${why ? `: ${why}` : ""}`);
    });
    proc.stdout?.on("data", (chunk) => this.onStdout(child, chunk));
    // Drained, so a chatty Claude Code never blocks on a full pipe; only the start is kept.
    proc.stderr?.on("data", (chunk) => {
      if (child.stderr.length < STDERR_KEEP) child.stderr = (child.stderr + String(chunk)).slice(0, STDERR_KEEP);
    });
    proc.stdin?.on("error", () => undefined); // EPIPE once it's gone: its exit says why
    this.write(child, controlLine(`deck-init-${++this.seq}`, { subtype: "initialize" }));
    return child;
  }

  private write(child: Running, line: string): void {
    try {
      child.proc.stdin?.write(line);
    } catch {
      // closed: the exit (or the timeout) reports it
    }
  }

  private endInput(child: Running): void {
    try {
      child.proc.stdin?.end();
    } catch {
      // already closed
    }
  }

  private signal(child: Running, signal: NodeJS.Signals): void {
    if (child.exited) return;
    try {
      child.proc.kill(signal);
    } catch {
      // gone meanwhile
    }
  }

  /** No answer in time, or blocked: SIGTERM now, SIGKILL if it's still there after killAfterMs. */
  private kill(child: Running): void {
    if (this.child === child) this.child = undefined;
    this.endInput(child);
    this.signal(child, "SIGTERM");
    child.timers.push(this.clock.setTimeout(() => this.signal(child, "SIGKILL"), this.opts.killAfterMs));
  }

  /** Fail closed: other sessions could reach this process. It's killed now (a turn on its way ends with it), a request
   *  on its way fails ("blocked"), and its Claude Code isn't started again until the app installs another one. */
  private block(child: Running, why: string): void {
    if (child.blocked) return;
    child.blocked = true;
    this.blocked = { cli: child.cli, why };
    if (this.pending?.child === child) this.settle(this.pending, new CliError("blocked", why));
    this.kill(child);
  }

  /** Its session record names a messaging socket: its inbox for other sessions is open. */
  private inboxOpen(child: Running): boolean {
    const pid = child.proc.pid;
    if (pid === undefined) return false;
    try {
      return messagingSocketOf(this.sessionRecord(pid)) !== undefined;
    } catch {
      return false;
    }
  }

  private gone(child: Running, kind: "spawn" | "exited", why: string): void {
    if (child.exited) return;
    child.exited = true;
    this.alive.delete(child);
    for (const t of child.timers) this.clock.clearTimeout(t);
    if (this.child === child) this.child = undefined;
    if (this.pending?.child === child) this.settle(this.pending, new CliError(kind, why));
  }

  private settle(p: Pending, err: CliError | undefined, response?: unknown): void {
    if (this.pending !== p) return;
    this.pending = undefined;
    this.clock.clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(response);
  }

  private onStdout(child: Running, chunk: Buffer | string): void {
    try {
      for (const line of child.lines.push(chunk)) this.onLine(child, line);
    } catch {
      // a bad chunk never throws out of here
    }
  }

  /**
   * Our answer settles the request — a good one only while the process's inbox for other sessions is shut. A turn's
   * line, at any time, blocks the process. Any other line is skipped (lines without our id or a turn's type aren't even
   * parsed).
   */
  private onLine(child: Running, line: string): void {
    if (child.blocked) return;
    const p = this.pending;
    const ours = !!p && p.child === child && line.includes(p.id);
    if (!ours && !TURN_HINT.test(line)) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (isTurnLine(msg)) {
      this.block(child, TURN_STARTED);
      return;
    }
    if (!ours || !p) return;
    const r = isObject(msg) && msg.type === "control_response" && isObject(msg.response) ? msg.response : undefined;
    if (!r || r.request_id !== p.id) return;
    if (r.subtype !== "success") {
      this.settle(p, new CliError("answer", typeof r.error === "string" && oneLine(r.error) ? oneLine(r.error) : "Claude Code answered with an error"));
    } else if (this.inboxOpen(child)) this.block(child, INBOX_OPEN);
    else this.settle(p, undefined, r.response);
  }
}
