// Driving the Claude desktop app.
//   • Open a chat:   claude://code/continue?session=<local id>   (the link the app's own Dock menu uses)
//   • New chat:      claude://code/new[?q=…&folder=…]            (documented: support.claude.com/en/articles/14729294)
//   • Everything else goes through macOS Accessibility (System Events) with the JXA program in ax.ts: the app's own
//     shortcuts (https://code.claude.com/docs/en/desktop#keyboard-shortcuts), its effort slider, and its prompt box,
//     found in the window's accessibility tree. The Claude app has no control API, so this needs Accessibility
//     permission for Stream Deck (macOS asks on first use).
//   • On Windows the same requests go to the UI Automation program in uia-win.ts (built once by win-helper.ts), with
//     the request on stdin. Shortcuts use Ctrl where macOS uses ⌘. Windows asks for no permission.
// All automation runs one job at a time (a single queue). Every keystroke first checks that Claude is the frontmost
// app (it is brought forward only when it isn't), so nothing is ever typed into another application. Esc is only ever
// sent by the Stop key (in the Claude app Esc stops a running response).
//
// The prompt box's place in the window's accessibility tree is cached (memory + ~/.config/claude-code-deck/
// ui-cache.json) because finding it takes seconds; warmUp() refreshes it in the background without touching the app.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JXA_SOURCE } from "./ax.ts";
import { CLAUDE_BUNDLE_ID, claudeWinExe } from "./paths.ts";
import { ensureHelper } from "./win-helper.ts";

export type Mod = "cmd" | "ctrl" | "shift" | "alt";
/** A key press: a named key ("return", "escape", "left") or a single character, with modifiers. */
export interface Key {
  key: string;
  mods?: Mod[];
}

export type ControlError =
  | "accessibility" // Stream Deck isn't allowed to use Accessibility
  | "automation" // … or to control System Events
  | "not-frontmost" // Claude didn't come to the front: nothing was typed
  | "not-running"
  | "no-window"
  | "prompt-not-found" // no prompt box in the front window (not a Code chat?)
  | "focus-failed"
  | "focus-lost" // the prompt box lost keyboard focus before Return: nothing was sent
  | "draft-not-empty" // configured text, but the user has a draft in the box
  | "prompt-empty" // nothing to send
  | "paste-failed"
  | "effort-not-open" // ⌘⇧E didn't open the effort slider
  | "effort-range" // the slider has a different number of stops than the model's catalog entry
  | "effort-unreadable"
  | "effort-stuck"
  | "model-menu-not-open" // ⌘⇧I didn't move focus into the model menu: no digit was typed
  | "menu-not-found"
  | "cancelled" // the job's own check (ChatOpts.guard) stopped it before any key went out
  | "failed";

export interface RunResult {
  ok: boolean;
  error?: ControlError;
  message: string;
}

export interface PromptResult extends RunResult {
  /** Text that was in the prompt box before (trailing newline removed; first 200 chars). */
  draft?: string;
  /** After Return: the box emptied (the app took the message). undefined when Return wasn't pressed. */
  cleared?: boolean;
}

export interface EffortResult extends RunResult {
  /** Slider stop before and after (AXValue). */
  from?: number;
  to?: number;
  /** The slider's last stop (AXMaxValue): stops-1 with an Ultracode stop, stops-2 without. */
  max?: number;
}

// ── Process runner (injectable: tests never run osascript / open / the Windows helper) ─────────────────────

/** Run a program; `input` (when given) is written to its stdin, which is then closed. */
export type Exec = (cmd: string, args: string[], timeoutMs: number, input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const realExec: Exec = (cmd, args, timeout, input) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: unknown; killed?: boolean }) | null;
      const code = e ? (typeof e.code === "number" ? e.code : 1) : 0;
      // (err.message repeats the whole command line — the script and the request with its text — so it's not used)
      const why = e ? (e.killed ? `${cmd} timed out` : typeof e.code === "string" ? `${cmd}: ${e.code}` : `${cmd} exited with ${code}`) : "";
      resolve({ code, stdout: String(stdout), stderr: String(stderr || why) });
    });
    if (input !== undefined) {
      child.stdin?.on("error", () => undefined); // it exited early: the callback reports why
      child.stdin?.end(input, "utf8");
    }
  });

let exec: Exec = realExec;
let platform: string = process.platform;
/** Windows: the UI Automation program's path (built on first use). */
let winHelper: () => Promise<string> = ensureHelper;

/** Tests: replace the process runner (and pretend to be on macOS, or `platform`; on Windows the helper is
 *  "claude-deck-uia.exe" unless `helper` says otherwise). Pass nothing to restore the real ones. */
export function setExec(fn?: Exec, opts: { platform?: string; helper?: () => Promise<string> } = {}): void {
  exec = fn ?? realExec;
  platform = opts.platform ?? (fn ? "darwin" : process.platform);
  winHelper = opts.helper ?? (fn ? async () => "claude-deck-uia.exe" : ensureHelper);
}

/** The platform control.ts drives (tests may pretend). */
export const controlPlatform = (): string => platform;

const run = (cmd: string, args: string[], timeout = 10_000) => exec(cmd, args, timeout);

// One automation at a time, in order.
let chain: Promise<unknown> = Promise.resolve();
let queued = 0;
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  queued++;
  const p = chain.then(fn, fn).finally(() => queued--);
  chain = p.catch(() => undefined);
  return p;
}
/** Something is running or waiting in the queue. */
export const queueBusy = (): boolean => queued > 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open a link with its registered app (Windows: the shell's URL handler — no cmd.exe, so "&" in a link is safe). */
export const openUrl = (url: string) => (platform === "win32" ? run("rundll32.exe", ["url.dll,FileProtocolHandler", url]) : run("open", [url]));
export const activateClaude = () => (platform === "win32" ? openUrl("claude://") : run("open", ["-b", CLAUDE_BUNDLE_ID]));

export function chatLink(id: string): string {
  return `claude://code/continue?session=${encodeURIComponent(id)}`;
}

export function newChatLink(opts: { prompt?: string; folder?: string } = {}): string {
  const q = new URLSearchParams();
  if (opts.prompt) q.set("q", opts.prompt.slice(0, 14_000));
  if (opts.folder) q.set("folder", opts.folder);
  const s = q.toString().replace(/\+/g, "%20");
  return `claude://code/new${s ? `?${s}` : ""}`;
}

export async function isClaudeRunning(): Promise<boolean> {
  if (platform === "win32") {
    // The desktop app's Claude.exe, not a Claude Code CLI (also claude.exe): the helper tells them apart by folder.
    const r = await runUi({ op: "running" }, 5000);
    return r.ok && r.running === true;
  }
  const r = await run("pgrep", ["-f", "/Applications/Claude.app/Contents/MacOS/Claude"], 3000);
  return r.code === 0 && r.stdout.trim() !== "";
}

/** True when Stream Deck may send keystrokes (macOS Accessibility; Windows needs no permission). Doesn't prompt. */
export async function accessibilityGranted(): Promise<boolean> {
  if (platform === "win32") return true;
  const r = await run("osascript", ["-e", 'tell application "System Events" to return UI elements enabled'], 5000);
  return r.code === 0 && r.stdout.trim() === "true";
}

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────────────

export function classify(text: string): ControlError {
  if (/9001|not-frontmost/.test(text)) return "not-frontmost";
  if (/-1719|assistive access|-25211|not allowed to send keystrokes|\b1002\b/i.test(text)) return "accessibility";
  if (/-1743|not authori[sz]ed to send apple events/i.test(text)) return "automation";
  if (/-600\b|isn.t running/i.test(text)) return "not-running";
  return "failed";
}

export const MESSAGES: Record<ControlError, string> = {
  accessibility: "Allow Stream Deck under System Settings → Privacy & Security → Accessibility, then press again.",
  automation: "Allow Stream Deck to control “System Events” (System Settings → Privacy & Security → Automation).",
  "not-frontmost": "Claude didn't come to the front, so nothing was typed.",
  "not-running": "The Claude app isn't running.",
  "no-window": "The Claude app has no open window.",
  "prompt-not-found": "Couldn't find Claude's prompt box. Open a chat in the Code tab and press again.",
  "focus-failed": "Couldn't put the cursor in Claude's prompt box, so nothing was typed.",
  "focus-lost": "The cursor left Claude's prompt box before Return, so nothing was sent.",
  "draft-not-empty": "The prompt box already has text — send or clear it first.",
  "prompt-empty": "The prompt box is empty.",
  "paste-failed": "The text didn't arrive in Claude's prompt box, so nothing was sent.",
  "effort-not-open": "Claude's effort slider didn't open (⌘⇧E), so nothing was changed.",
  "effort-range": "Claude's effort slider has different levels than expected, so nothing was changed.",
  "effort-unreadable": "Couldn't read Claude's effort slider, so nothing was changed.",
  "effort-stuck": "Claude's effort slider didn't move to the new level.",
  "model-menu-not-open": "Claude's model menu didn't open (⌘⇧I), so nothing was changed.",
  "menu-not-found": "menu item not found",
  cancelled: "Nothing was sent.",
  failed: "Couldn't send the keys to Claude.",
};

/** Windows wording where it differs (shortcuts, and what blocks key presses there). */
export const WIN_MESSAGES: Partial<Record<ControlError, string>> = {
  accessibility: "Windows blocked the key presses: Claude runs as administrator. Run Claude normally (or Stream Deck as administrator too).",
  automation: "Windows blocked the key presses: Claude runs as administrator. Run Claude normally (or Stream Deck as administrator too).",
  "effort-not-open": "Claude's effort slider didn't open (Ctrl+Shift+E), so nothing was changed.",
  "model-menu-not-open": "Claude's model menu didn't open (Ctrl+Shift+I), so nothing was changed.",
};

/** The message for an error on the platform being driven. */
export const messageFor = (error: ControlError): string => (platform === "win32" ? (WIN_MESSAGES[error] ?? MESSAGES[error]) : MESSAGES[error]);

const result = (error: ControlError | undefined, detail?: string): RunResult =>
  error
    ? { ok: false, error, message: error === "failed" && detail ? `${messageFor("failed")} ${detail}` : messageFor(error) }
    : { ok: true, message: "ok" };

// ── Automation runner (JXA on macOS, the UI Automation helper on Windows) ───────────────────────────────

/** Reply of the automation program (see ax.ts / uia-win.ts). */
export interface UiReply {
  ok: boolean;
  error?: string;
  detail?: string;
  path?: number[] | null;
  /** The cached path pointed at a box that wouldn't take focus: drop it (the next attempt searches again). */
  stale?: boolean;
  rescanned?: boolean;
  draft?: string;
  hadDraft?: boolean;
  cleared?: boolean;
  from?: number;
  to?: number;
  max?: number;
  closed?: boolean;
  pressed?: number;
  visited?: number;
  ms?: number;
  /** Windows "running": the desktop app runs (and has a window). */
  running?: boolean;
  window?: boolean;
}

export type UiRequest = { op: string; [k: string]: unknown };

const KNOWN = new Set<string>(Object.keys(MESSAGES));

/** One run of the platform's automation program: osascript (the request as argv) or the Windows helper (the request
 *  on stdin). Never interpolated into a program's source. */
async function runProgram(req: UiRequest, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string } | RunResult> {
  if (platform === "darwin") return run("osascript", ["-l", "JavaScript", "-e", JXA_SOURCE, "--", JSON.stringify({ bundle: CLAUDE_BUNDLE_ID, ...req })], timeoutMs);
  if (platform === "win32") {
    let exe: string;
    try {
      exe = await winHelper();
    } catch (err) {
      return result("failed", (err as Error).message);
    }
    return exec(exe, [], timeoutMs, JSON.stringify({ exe: [claudeWinExe()], ...req }));
  }
  return { ok: false, error: "failed", message: "Keyboard control of the Claude app works on macOS and Windows only." };
}

/** Run one request. Errors from the program's host (osascript permissions, a helper that couldn't start) are
 *  classified like the program's own. */
export async function runUi(req: UiRequest, timeoutMs = 10_000): Promise<UiReply & { errorCode?: ControlError; message: string }> {
  const r = await runProgram(req, timeoutMs);
  if ("ok" in r) return { ok: false, errorCode: r.error ?? "failed", message: r.message };
  let reply: UiReply | undefined;
  if (r.code === 0) {
    try {
      reply = JSON.parse(r.stdout.trim()) as UiReply;
    } catch {
      reply = undefined;
    }
  }
  if (!reply) {
    const errorCode = classify(r.stderr);
    const detail = r.stderr.trim().split("\n").pop() ?? "";
    return { detail, ...result(errorCode, detail), errorCode };
  }
  if (reply.ok) return { ...reply, message: "ok" };
  const raw = reply.error ?? "failed";
  const errorCode: ControlError = raw === "exception" ? classify(reply.detail ?? "") : KNOWN.has(raw) ? (raw as ControlError) : "failed";
  return { ...reply, error: errorCode, errorCode, ...result(errorCode, reply.detail) };
}

// ── Prompt box location cache ───────────────────────────────────────────────────────────────────────────

export const uiCacheFile = (): string =>
  process.env.CLAUDE_CODE_DECK_UI_CACHE || path.join(os.homedir(), ".config", "claude-code-deck", "ui-cache.json");

let promptPath: number[] | null | undefined; // undefined = not loaded yet

const isPath = (v: unknown): v is number[] => Array.isArray(v) && v.length <= 80 && v.every((n) => Number.isInteger(n) && n >= 0);

export function cachedPromptPath(): number[] | null {
  if (promptPath === undefined) {
    try {
      const d = JSON.parse(fs.readFileSync(uiCacheFile(), "utf8")) as { prompt?: { path?: unknown } };
      promptPath = isPath(d.prompt?.path) ? d.prompt!.path : null;
    } catch {
      promptPath = null;
    }
  }
  return promptPath;
}

function storePromptPath(p: number[] | null): void {
  cachedPromptPath();
  if (JSON.stringify(p) === JSON.stringify(promptPath)) return;
  promptPath = p;
  try {
    const f = uiCacheFile();
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, JSON.stringify({ version: 1, prompt: { path: p, savedAt: Date.now() } }), { mode: 0o600 });
  } catch {
    // the memory copy still works
  }
}

/** Tests: forget the in-memory copy (the next use re-reads the file). */
export function resetUiCache(): void {
  promptPath = undefined;
  warming = undefined;
  warmMissAt = 0;
}

/** Keep the cache in step with what the automation program found (a miss keeps the old path: it seeds the next search;
 *  a cached box that wouldn't take focus is dropped, so the retry searches again). */
function learn(reply: UiReply): void {
  if (reply.stale) storePromptPath(null);
  else if (isPath(reply.path)) storePromptPath(reply.path);
}

let warming: Promise<void> | undefined;
let warmMissAt = 0;
const WARM_BACKOFF_MS = 30 * 60_000;

/**
 * Find (or re-check) the prompt box in the background: accessibility reads only — no activation, no focus change,
 * no keystrokes. Skipped while a key's job is queued; a prompt-box job (Send Prompt, Steer, Run Skill, Dictate) waits
 * for a running warm-up instead of searching twice. Other jobs (Model, Effort, Stop, panels) don't wait for it.
 * `periodic` warm-ups pause for a while after one found no prompt box (Claude showing something else: a full search
 * every few minutes would only cost CPU).
 */
export function warmUp(opts: { periodic?: boolean } = {}): Promise<void> {
  if (platform !== "darwin" && platform !== "win32") return Promise.resolve();
  if (warming) return warming;
  if (queueBusy()) return Promise.resolve();
  if (opts.periodic && Date.now() - warmMissAt < WARM_BACKOFF_MS) return Promise.resolve();
  warming = (async () => {
    try {
      const r = await runUi({ op: "locate", path: cachedPromptPath() }, 30_000);
      learn(r);
      warmMissAt = r.error === "prompt-not-found" ? Date.now() : 0;
    } finally {
      warming = undefined;
    }
  })();
  return warming;
}

// ── Operations (each one queued) ────────────────────────────────────────────────────────────────────────

const OPEN_SETTLE_MS = 400;

/** Bring a chat to the front in the Claude app (no queue: used inside queued jobs). */
export async function openChat(id: string): Promise<RunResult> {
  const r = await openUrl(chatLink(id));
  return r.code === 0 ? { ok: true, message: "ok" } : { ok: false, error: "failed", message: `Couldn't open the chat: ${r.stderr.trim()}` };
}

/** Open a chat as a queued job, including the moment the app needs to switch — so the next queued job (Stop's Esc,
 *  a prompt) can't reach the chat that was shown before. */
export function showChat(id: string): Promise<RunResult> {
  return serial(async () => {
    const r = await openChat(id);
    if (r.ok) await sleep(OPEN_SETTLE_MS);
    return r;
  });
}

/** New chat (claude://code/new…), queued like every other switch so it can't land in the middle of a job. */
export function openNewChat(opts: { prompt?: string; folder?: string } = {}): Promise<RunResult> {
  return serial(async () => {
    const r = await openUrl(newChatLink(opts));
    return r.code === 0 ? { ok: true, message: "ok" } : { ok: false, error: "failed", message: `Couldn't open a new chat: ${r.stderr.trim()}` };
  });
}

/** Options shared by the chat operations. */
export interface ChatOpts {
  /** Open this chat first (and give the app a moment to switch). */
  openChat?: string;
  /** Prompt-box jobs: false = only try the cached path (fail fast with "prompt-not-found" instead of a search of the
   *  window, which takes seconds — the caller opens the chat and tries again). Default: search. */
  scan?: boolean;
  /** Checked inside the queued job, right before anything is sent: a message stops the job ("cancelled"). */
  guard?: () => string | undefined;
}

async function prepare(opts: ChatOpts, waitForWarmUp = false): Promise<RunResult | undefined> {
  // Only prompt-box jobs use the warm-up's result; the others never wait behind its search.
  if (waitForWarmUp && warming) await warming.catch(() => undefined);
  if (opts.openChat) {
    const o = await openChat(opts.openChat);
    if (!o.ok) return o;
    await sleep(OPEN_SETTLE_MS);
  }
  const why = opts.guard?.();
  if (why) return { ok: false, error: "cancelled", message: why };
  return undefined;
}

const PROMPT_TIMEOUT_MS = 30_000; // a cache miss searches the window (up to ~15 s)

async function promptJob(req: Record<string, unknown>, opts: ChatOpts): Promise<PromptResult> {
  return serial(async () => {
    const early = await prepare(opts, true);
    if (early) return early;
    const r = await runUi({ op: "prompt", path: cachedPromptPath(), ...(opts.scan === false ? { scan: false } : {}), ...req }, PROMPT_TIMEOUT_MS);
    learn(r);
    return { ok: r.ok, error: r.errorCode, message: r.message, draft: r.draft, cleared: r.cleared };
  });
}

/** Put the cursor in the prompt box. `draft` = what the box holds. */
export function focusPrompt(opts: ChatOpts = {}): Promise<PromptResult> {
  return promptJob({ submit: false, requireEmpty: false }, opts);
}

/**
 * Type into the prompt box.
 *  • text given: paste it (clipboard text saved and restored), then Return when `submit`. With `requireEmpty`, a draft
 *    in the box makes it fail ("draft-not-empty") without touching anything.
 *  • text undefined / blank: press Return to send what's in the box; fails with "prompt-empty" when the box is empty.
 */
export function typeIntoPrompt(text: string | undefined, opts: { submit: boolean; requireEmpty?: boolean } & ChatOpts): Promise<PromptResult> {
  const t = text?.trim() ? text : undefined;
  return promptJob({ text: t, submit: opts.submit, requireEmpty: !!opts.requireEmpty }, opts);
}

const EFFORT_TIMEOUT_MS = 20_000; // a slow app must not get the program killed with the slider still open

/** Move the effort slider (⌘⇧E … arrows … ⌘⇧E) to stop `targetIndex` of `stops`. */
export function setEffortSlider(targetIndex: number, stops?: number, opts: ChatOpts = {}): Promise<EffortResult> {
  return serial(async () => {
    const early = await prepare(opts);
    if (early) return early;
    const r = await runUi({ op: "effort", target: targetIndex, stops }, EFFORT_TIMEOUT_MS);
    return { ok: r.ok, error: r.errorCode, message: r.message, from: r.from, to: r.to, max: r.max };
  });
}

/** Pick row `menuIndex` (0-based) of the app's model menu: ⌘⇧I, then its digit. */
export function pickModel(menuIndex: number, opts: ChatOpts = {}): Promise<RunResult> {
  return serial(async () => {
    if (!(Number.isInteger(menuIndex) && menuIndex >= 0 && menuIndex <= 8)) return { ok: false, error: "failed", message: "That model isn't in the first nine rows of the app's model menu." };
    const early = await prepare(opts);
    if (early) return early;
    const r = await runUi({ op: "model", index: menuIndex });
    return { ok: r.ok, error: r.errorCode, message: r.message };
  });
}

const KEY_CODES: Record<string, number> = { return: 36, enter: 36, escape: 53, esc: 53, tab: 48, space: 49, delete: 51, up: 126, down: 125, left: 123, right: 124 };

/** A modifier on Windows: ⌘ is Ctrl there (the app's shortcuts), the others keep their names. */
export type WinMod = "ctrl" | "shift" | "alt" | "win";
const WIN_MOD: Record<Mod, WinMod> = { cmd: "ctrl", ctrl: "ctrl", shift: "shift", alt: "alt" };

/** The automation program's form of a key. JXA: a key code for named keys, else the character. Windows: the key's
 *  name or character, with ⌘ as Ctrl. */
export function keySpec(k: Key): { code?: number; key?: string; mods?: Mod[] | WinMod[] } {
  if (platform === "win32") {
    const mods = k.mods ? [...new Set(k.mods.map((m) => WIN_MOD[m]))] : undefined;
    return mods ? { key: k.key.length === 1 ? k.key : k.key.toLowerCase(), mods } : { key: k.key.length === 1 ? k.key : k.key.toLowerCase() };
  }
  const code = KEY_CODES[k.key.toLowerCase()];
  return code !== undefined ? { code, mods: k.mods } : { key: k.key, mods: k.mods };
}

const MAC_GLYPH: Record<Mod, string> = { cmd: "⌘", ctrl: "⌃", shift: "⇧", alt: "⌥" };
const WIN_ORDER: WinMod[] = ["ctrl", "win", "alt", "shift"];
const WIN_NAME: Record<WinMod, string> = { ctrl: "Ctrl", win: "Win", alt: "Alt", shift: "Shift" };

/** A shortcut as people read it on this platform: "⌘⇧I" on macOS, "Ctrl+Shift+I" on Windows. */
export function keyLabel(k: Key): string {
  const key = k.key.length === 1 ? k.key.toUpperCase() : k.key.charAt(0).toUpperCase() + k.key.slice(1);
  if (platform !== "win32") return `${(k.mods ?? []).map((m) => MAC_GLYPH[m]).join("")}${key}`;
  const mods = new Set((k.mods ?? []).map((m) => WIN_MOD[m]));
  return [...WIN_ORDER.filter((m) => mods.has(m)).map((m) => WIN_NAME[m]), key].join("+");
}

/** Press shortcuts in Claude (frontmost-guarded). `checkPrompt`: unless the chat is being opened, press nothing when the
 *  cached prompt-box path no longer validates ("prompt-not-found": Claude shows another view) — a quick check. */
export function pressKeys(keys: Key[], opts: ChatOpts & { checkPrompt?: boolean } = {}): Promise<RunResult> {
  return serial(async () => {
    const early = await prepare(opts);
    if (early) return early;
    const check = opts.checkPrompt && !opts.openChat ? cachedPromptPath() : null;
    const r = await runUi({ op: "keys", keys: keys.map(keySpec), ...(check ? { checkPath: check } : {}) });
    return { ok: r.ok, error: r.errorCode, message: r.message };
  });
}

/** Put the cursor in the prompt box, then click Edit ▸ Start / Stop Dictation (Windows: Win+H, voice typing). */
export function dictation(opts: ChatOpts = {}): Promise<RunResult> {
  return serial(async () => {
    const early = await prepare(opts, true);
    if (early) return early;
    const how = platform === "win32" ? { keys: DICTATION_KEYS_WIN } : { menu: "Edit", items: DICTATION_ITEMS };
    const r = await runUi({ op: "dictate", path: cachedPromptPath(), ...(opts.scan === false ? { scan: false } : {}), ...how }, PROMPT_TIMEOUT_MS);
    learn(r);
    return { ok: r.ok, error: r.errorCode, message: r.message };
  });
}

// ── Documented Code-tab shortcuts ───────────────────────────────────────────────────────────────────────
export const SHORTCUTS = {
  stop: { key: "escape" }, // only ever used by the Stop key
  newChat: { key: "n", mods: ["cmd"] as Mod[] },
  modelMenu: { key: "i", mods: ["cmd", "shift"] as Mod[] },
  effortMenu: { key: "e", mods: ["cmd", "shift"] as Mod[] },
  modeMenu: { key: "m", mods: ["cmd", "shift"] as Mod[] },
  fast: { key: "f", mods: ["cmd", "alt"] as Mod[] }, // shown in the app's ⌘/ list when the model supports fast mode
  review: { key: "d", mods: ["cmd", "shift"] as Mod[] },
  browser: { key: "b", mods: ["cmd", "shift"] as Mod[] },
  terminal: { key: "`", mods: ["ctrl"] as Mod[] },
  files: { key: "f", mods: ["cmd", "shift"] as Mod[] },
  sideChat: { key: ";", mods: ["cmd"] as Mod[] },
  sidebar: { key: "b", mods: ["cmd"] as Mod[] },
} as const;

export type ShortcutName = keyof typeof SHORTCUTS;

export const shortcut = (name: ShortcutName): Key => ({ ...SHORTCUTS[name] }) as Key;

export const DICTATION_ITEMS = ["Start Dictation", "Stop Dictation", "Rozpocznij dyktowanie", "Zatrzymaj dyktowanie"];

/** Windows voice typing (Win+H) starts — and a second press stops — dictation into the focused box. */
export const DICTATION_KEYS_WIN = [{ key: "h", mods: ["win"] as WinMod[] }];
