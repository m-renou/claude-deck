// Windows end-to-end: the real UI Automation helper (built from src/claude/uia-win.ts) drives a stand-in for the Claude
// app (fake-claude/, an Electron window with the same prompt box, effort slider, model menu and shortcuts) through
// control.ts — real key presses, the real clipboard. Every assertion reads what the page saw (its event log).
//   npm run test:e2e:win      (Windows only; needs `npm install` in test/e2e-win once, for Electron)
// The window takes the foreground while it runs: don't type meanwhile. Nothing is sent to any other window — every key
// press checks that the stand-in is the foreground window first.

import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

const HERE = import.meta.dirname;
const ELECTRON = path.join(HERE, "node_modules", "electron", "dist", "electron.exe");
const skip = process.platform !== "win32" ? "Windows only" : !fs.existsSync(ELECTRON) ? "run `npm install` in test/e2e-win first" : false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-deck-e2e-"));
const LOG = path.join(tmp, "events.jsonl");
process.env.CLAUDE_CODE_DECK_APP_EXE = "electron.exe";
process.env.CLAUDE_CODE_DECK_UI_CACHE = path.join(tmp, "ui-cache.json");
process.env.CLAUDE_CODE_DECK_WIN_HELPER_DIR ||= path.join(os.tmpdir(), "claude-deck-e2e-helper");

type Control = typeof import("../../src/claude/control.ts");
let control: Control;
let app: ChildProcess | undefined;

interface Ev {
  type: string;
  [k: string]: unknown;
}
const events = (): Ev[] =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ev)
    : [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(50);
  }
}
let mark = 0;
/** Events since the last mark(). */
const since = (): Ev[] => events().slice(mark);
const markNow = () => (mark = events().length);

const ps = (script: string): string => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });

/** A shortcut another app registered system-wide (RegisterHotKey) never reaches any window: tests that need it are
 *  skipped on such a machine (the Claude app couldn't get it there either). "" when it's free. */
function hotkeyTaken(name: string, vk: number): string {
  if (process.platform !== "win32") return "";
  const out = ps(
    `Add-Type -Name H -Namespace D -MemberDefinition '[DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint m, uint vk); [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);'; if ([D.H]::RegisterHotKey([IntPtr]::Zero, 0x7001, 6, ${vk})) { [void][D.H]::UnregisterHotKey([IntPtr]::Zero, 0x7001); 'free' } else { 'taken' }`,
  ).trim();
  return out === "taken" ? `${name} is a global hotkey of another app on this machine` : "";
}
const effortKeyTaken = hotkeyTaken("Ctrl+Shift+E", 0x45);
const modelKeyTaken = hotkeyTaken("Ctrl+Shift+I", 0x49);

/** Effort / model through control.ts; where another app holds the shortcut, the same program run with Ctrl+Shift+F7 / F8
 *  instead (the stand-in takes both), so the slider and menu logic is still exercised. */
async function effort(target: number, stops: number) {
  if (!effortKeyTaken) return control.setEffortSlider(target, stops);
  const r = await control.runUi({ op: "effort", target, stops, toggleKey: { key: "f7", mods: ["ctrl", "shift"] } }, 20_000);
  return { ...r, error: r.errorCode };
}
async function model(index: number) {
  if (!modelKeyTaken) return control.pickModel(index);
  const r = await control.runUi({ op: "model", index, menuKey: { key: "f8", mods: ["ctrl", "shift"] } });
  return { ...r, error: r.errorCode };
}
const setClipboard = (s: string) => ps(`Set-Clipboard -Value '${s.replace(/'/g, "''")}'`);
const getClipboard = (): string => ps("Get-Clipboard -Raw").replace(/\r?\n$/, "");

async function launch(env: Record<string, string> = {}): Promise<void> {
  fs.rmSync(LOG, { force: true });
  app = spawn(ELECTRON, [HERE], { env: { ...process.env, FAKE_CLAUDE_LOG: LOG, ...env }, stdio: "ignore" });
  await until(() => events().find((e) => e.type === "ready"), 20_000);
  await sleep(500);
}

async function quit(): Promise<void> {
  if (!app) return;
  const a = app;
  app = undefined;
  const gone = new Promise((r) => a.once("exit", r));
  a.kill();
  await Promise.race([gone, sleep(3000)]);
}

describe("Windows UI Automation against a stand-in Claude app", { skip, timeout: 240_000 }, () => {
  before(async () => {
    control = await import("../../src/claude/control.ts");
    const { ensureHelper } = await import("../../src/claude/win-helper.ts");
    await ensureHelper(); // first build: ~10 s
    await launch();
  });

  after(async () => {
    await quit();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => markNow());

  it("finds the app (not a CLI) and its prompt box; the found place is cached and reused", async () => {
    assert.equal(await control.isClaudeRunning(), true);
    control.resetUiCache();
    await control.warmUp();
    const p = control.cachedPromptPath();
    assert.ok(Array.isArray(p) && p.length > 0, `path ${JSON.stringify(p)}`);
    const again = await control.runUi({ op: "locate", path: p });
    assert.equal(again.ok, true);
    assert.equal(again.rescanned, false, "the cached path still fits");
  });

  it("Send Prompt: pastes the text, reads it back, presses Return — and puts the user's clipboard back", async () => {
    setClipboard("THE USER'S CLIPBOARD");
    const text = "Héllo from Stream Deck ✓ — \"quotes\" & <tags> 日本";
    const r = await control.typeIntoPrompt(text, { submit: true, requireEmpty: true });
    assert.equal(r.ok, true, r.message);
    const sent = await until(() => since().find((e) => e.type === "send"));
    assert.equal(sent.text, text);
    assert.equal(r.cleared, true);
    assert.equal(getClipboard(), "THE USER'S CLIPBOARD");
  });

  it("a draft in the box: configured text is refused; an empty key sends the draft", async () => {
    const d = await control.typeIntoPrompt("my own draft", { submit: false });
    assert.equal(d.ok, true, d.message);
    const refused = await control.typeIntoPrompt("configured text", { submit: true, requireEmpty: true });
    assert.equal(refused.error, "draft-not-empty");
    assert.equal(since().filter((e) => e.type === "send").length, 0, "nothing was sent");
    const r = await control.typeIntoPrompt(undefined, { submit: true });
    assert.equal(r.ok, true, r.message);
    const sent = await until(() => since().find((e) => e.type === "send"));
    assert.equal(sent.text, "my own draft");
  });

  it("an empty box and an empty key: nothing is sent", async () => {
    const r = await control.typeIntoPrompt(undefined, { submit: true });
    assert.equal(r.error, "prompt-empty");
    assert.equal(since().filter((e) => e.type === "send" || e.type === "enter-empty").length, 0);
  });

  it("Run Skill: a slash command's first Return picks it in the command menu, the second sends it", async () => {
    const r = await control.typeIntoPrompt("/compact", { submit: true, requireEmpty: true });
    assert.equal(r.ok, true, r.message);
    await until(() => since().find((e) => e.type === "send"));
    assert.deepEqual(
      since()
        .filter((e) => e.type === "slash-menu" || e.type === "send")
        .map((e) => [e.type, e.text]),
      [
        ["slash-menu", "/compact"],
        ["send", "/compact"],
      ],
    );
  });

  it("Effort: Ctrl+Shift+E opens the slider, arrows move it to the target, Ctrl+Shift+E closes it", async () => {
    const r = await effort(4, 6);
    assert.equal(r.ok, true, r.message);
    assert.deepEqual([r.from, r.to, r.max], [2, 4, 5]);
    const ev = since();
    assert.deepEqual(
      ev.filter((e) => e.type === "effort").map((e) => e.value),
      [3, 4],
    );
    assert.deepEqual(
      ev.filter((e) => e.type === "effort-toggle").map((e) => e.open),
      [true, false],
      "the slider is closed again",
    );
    markNow();
    const back = await effort(1, 6);
    assert.deepEqual([back.ok, back.from, back.to], [true, 4, 1]);
  });

  it("Effort: a slider with other stops than the model's is left alone (closed, unchanged)", async () => {
    const r = await effort(2, 9);
    assert.equal(r.error, "effort-range");
    const ev = since();
    assert.equal(ev.filter((e) => e.type === "effort").length, 0);
    assert.deepEqual(
      ev.filter((e) => e.type === "effort-toggle").map((e) => e.open),
      [true, false],
    );
  });

  it("Model: Ctrl+Shift+I, then the row's digit once the menu has focus", async () => {
    const r = await model(1);
    assert.equal(r.ok, true, r.message);
    const picked = await until(() => since().find((e) => e.type === "model"));
    assert.equal(picked.model, "claude-fable-5-1");
  });

  it("Stop sends Esc; panel shortcuts use Ctrl", async () => {
    assert.equal((await control.pressKeys([control.shortcut("stop")])).ok, true);
    assert.equal((await control.pressKeys([control.shortcut("review")])).ok, true);
    assert.equal((await control.pressKeys([control.shortcut("fast")])).ok, true);
    await until(() => since().filter((e) => e.type === "key").length >= 3 || undefined);
    const keys = since()
      .filter((e) => e.type === "key")
      .map((e) => `${(e.mods as string[]).join("+")}${(e.mods as string[]).length ? "+" : ""}${e.code}`);
    assert.deepEqual(keys, ["Escape", "ctrl+shift+KeyD", "ctrl+alt+KeyF"]);
    assert.equal(since().filter((e) => e.type === "stop").length, 1);
  });

  it("Stop's prompt-box check: nothing is pressed when the cached box no longer fits", async () => {
    const r = await control.runUi({ op: "keys", keys: [{ key: "escape" }], checkPath: [0, 0, 0, 0, 0, 9] });
    assert.equal(r.error, "prompt-not-found");
    await sleep(300);
    assert.equal(since().filter((e) => e.type === "stop").length, 0);
  });

  it("Dictate focuses the prompt box before its shortcut (F9 here instead of Win+H)", async () => {
    await control.pressKeys([{ key: "tab" }]); // move the cursor out of the box first
    markNow();
    const r = await control.runUi({ op: "dictate", path: control.cachedPromptPath(), keys: [{ key: "f9" }] });
    assert.equal(r.ok, true, r.message);
    const f9 = await until(() => since().find((e) => e.type === "key" && e.key === "F9"));
    assert.equal(f9.target, "prompt");
  });

  it("brings the app back to the front before typing", async () => {
    // Another window takes the foreground (a PowerShell console, started minimized → restored); the helper must
    // bring the stand-in back before it types anything.
    const other = spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Seconds 8"], { stdio: "ignore", detached: false });
    await sleep(800);
    const r = await control.typeIntoPrompt("after a switch", { submit: true, requireEmpty: true });
    other.kill();
    assert.equal(r.ok, true, r.message);
    const sent = await until(() => since().find((e) => e.type === "send"));
    assert.equal(sent.text, "after a switch");
  });

  it("a view without a prompt box: prompt-not-found, nothing typed", async () => {
    await quit();
    await launch({ FAKE_CLAUDE_VIEW: "home" });
    markNow();
    control.resetUiCache();
    const r = await control.typeIntoPrompt("x", { submit: true, requireEmpty: true, scan: true });
    assert.equal(r.error, "prompt-not-found");
    assert.equal(since().filter((e) => e.type === "key").length, 0);
  });

  it("a <textarea> prompt box works too", async () => {
    await quit();
    await launch({ FAKE_CLAUDE_PROMPT: "textarea" });
    markNow();
    control.resetUiCache();
    const r = await control.typeIntoPrompt("textarea text", { submit: true, requireEmpty: true });
    assert.equal(r.ok, true, r.message);
    const sent = await until(() => since().find((e) => e.type === "send"));
    assert.equal(sent.text, "textarea text");
  });

  it("knows when the app isn't running", async () => {
    await quit();
    await sleep(500);
    assert.equal(await control.isClaudeRunning(), false);
    const r = await control.pressKeys([control.shortcut("review")]);
    assert.equal(r.error, "not-running");
  });

  it("keep-awake mode holds until stdin closes", async () => {
    const { helperExe } = await import("../../src/claude/win-helper.ts");
    const child = spawn(helperExe(), ["keepawake", "0"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout!.on("data", (d) => (out += String(d)));
    await until(() => /on/.test(out) || undefined);
    const exited = new Promise<number | null>((r) => child.once("exit", r));
    child.stdin!.end();
    assert.equal(await Promise.race([exited, sleep(5000).then(() => "still running")]), 0);
  });
});
