// Property Inspector: the payloads src/pi.ts sends (src/pi-core.ts, no Stream Deck import) and the static page checks
// (scripts/check-pi.ts) — on the real pages, and on a copy with mistakes put in.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { checkPi, normaliserReads, ROOT, scanTags, settingsRead } from "../scripts/check-pi.ts";
import { PLUGIN_UUID } from "../src/catalog.ts";
import type { Skill } from "../src/claude/extras.ts";
import {
  ACCESS_FIX,
  chatItems,
  folderItems,
  liveUsageLine,
  type LiveUsageInput,
  MAX_POSITION,
  modelItems,
  modelSlotItems,
  piRequest,
  shortPath,
  skillItems,
  STATUS_LABEL,
  statusIcon,
  statusPayload,
} from "../src/pi-core.ts";
import type { Chat, ModelInfo, Snapshot } from "../src/types.ts";
import { setHostPlatform } from "../src/platform.ts";

// The macOS wording (Terminal, shell quoting) whatever machine runs the tests.
setHostPlatform("darwin");

const NOW = 1_800_000_000_000;

const MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", name: "Opus 5.5", shortName: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"], fast: true },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", shortName: "Haiku", efforts: [], fast: false },
];

const chat = (id: string, over: Partial<Chat> = {}): Chat => ({
  id,
  title: `Chat ${id}`,
  status: "idle",
  lastActivityAt: NOW - 5 * 60_000,
  lastFocusedAt: 0,
  live: false,
  ...over,
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  chats: [],
  models: MODELS,
  usage: { kind: "none" },
  app: { installed: true, running: true },
  ...over,
});

describe("piRequest", () => {
  it("accepts the datasource and status events", () => {
    assert.deepEqual(piRequest({ event: "getChats" }), { event: "getChats", isRefresh: false });
    assert.deepEqual(piRequest({ event: "getSkills", isRefresh: true }), { event: "getSkills", isRefresh: true });
    for (const event of ["getModels", "getModelSlots", "getFolders", "getStatus"]) assert.equal(piRequest({ event })?.event, event);
  });

  it("ignores anything else", () => {
    for (const p of [undefined, null, "getChats", 3, [], {}, { event: 1 }, { event: "test" }, { event: "setSettings" }]) assert.equal(piRequest(p), undefined);
  });

  it("the old live-usage token messages are gone (no page may send a token)", () => {
    for (const event of ["setUsageToken", "removeUsageToken"]) assert.equal(piRequest({ event, token: "sk-ant-oat01-x" }), undefined);
  });
});

// ── Live usage (Usage page) ─────────────────────────────────────────────────────────────────────────────

describe("liveUsageLine (Usage page)", () => {
  const T = new Date(2026, 9, 2, 22, 41).getTime(); // local, so "22:41" holds in any time zone
  const APP_AT = new Date(2026, 9, 2, 12, 39).getTime();
  const CLI = "/Users/me/Library/Application Support/Claude/claude-code/2.1.286/f2326db61802/claude.app/Contents/MacOS/claude";
  const line = (state: LiveUsageInput["state"], o: Partial<Omit<LiveUsageInput, "state">> = {}) => liveUsageLine({ state, watching: true, now: T + 30_000, ...o });
  const sample = { at: T, source: "live" as const, weekly: 16, fiveHour: 3 };

  it("live", () => {
    assert.deepEqual(line({ status: "live", sample, checkedAt: T, cli: CLI }), {
      tone: "good",
      text: "Live · updated 22:41",
      detail: "Every minute while a Usage key shows Weekly, 5-hour or Auto.",
    });
    // Paused (no plan view): no green dot next to an update that may be hours old.
    assert.deepEqual(line({ status: "live", sample, checkedAt: T }, { watching: false, now: T + 3 * 3600_000 }), {
      tone: "idle",
      text: "Paused · last update 22:41",
      detail: "Starts again when a Usage key shows Weekly, 5-hour or Auto.",
    });
  });

  it("signed out: sign in once with the shell-quoted command of the Claude Code it runs, then wait a minute", () => {
    assert.deepEqual(line({ status: "signed-out", message: "Claude Code isn't signed in", cli: CLI }, { appSampleAt: APP_AT }), {
      tone: "bad",
      text: "Sign in once: run this in Terminal",
      detail: "Keys show the Claude app's saved numbers (as of 12:39) meanwhile.",
      loginCommand: `'${CLI}' auth login`,
    });
    // Without a CLI in the state: the one the plugin found, else plain claude.
    assert.equal(line({ status: "signed-out" }, { cli: "/opt/homebrew/bin/claude" }).loginCommand, "/opt/homebrew/bin/claude auth login");
    assert.equal(line({ status: "signed-out" }).loginCommand, "claude auth login");
    for (const status of ["idle", "starting", "live", "no-cli", "no-answer", "error", "blocked"] as const) {
      assert.equal(line({ status, cli: CLI }).loginCommand, undefined, `${status}: no sign-in command`);
    }
  });

  it("failures, in the words the page shows, with the numbers the keys show meanwhile", () => {
    const noAnswer = line({ status: "no-answer", message: "no answer within 15 s", retryAt: new Date(2026, 9, 2, 22, 42).getTime(), sample });
    assert.deepEqual([noAnswer.tone, noAnswer.text, noAnswer.detail], [
      "bad",
      "Claude Code didn't answer — retrying",
      "no answer within 15 s · next try 22:42 · Keys show the last live numbers (as of 22:41) until it answers.",
    ]);
    assert.deepEqual(line({ status: "no-cli" }, { appSampleAt: APP_AT }), {
      tone: "bad",
      text: "Claude Code isn't installed in the Claude app yet",
      detail: "Open the Code tab in the Claude app once. · Keys show the Claude app's saved numbers (as of 12:39) meanwhile.",
    });
    const err = line({ status: "error", message: "Failed to fetch usage: 503", sample });
    assert.deepEqual([err.tone, err.text, err.detail], ["bad", "Failed to fetch usage: 503", "Retrying every minute. · Keys show the last live numbers (as of 22:41) meanwhile."]);
    assert.equal(line({ status: "error" }).text, "Claude Code's answer had no usage numbers");
    assert.equal(line({ status: "error", message: "x".repeat(300) }).text.length, 120, "a short error");
    assert.deepEqual(line({ status: "blocked", message: "Claude Code opened an inbox for messages from other sessions", sample }), {
      tone: "bad",
      text: "Live usage stopped: other sessions could reach Claude Code",
      detail: "Claude Code opened an inbox for messages from other sessions · It starts again when the Claude app updates Claude Code. · Keys show the last live numbers (as of 22:41) meanwhile.",
    });
  });

  it("names the newer source: the last live answer or the app's own sample", () => {
    const old = new Date(2026, 9, 1, 9, 0).getTime();
    assert.equal(line({ status: "no-answer", sample: { ...sample, at: old } }, { appSampleAt: APP_AT }).detail, "Keys show the Claude app's saved numbers (as of 12:39) until it answers.");
    assert.equal(line({ status: "no-cli", sample: { ...sample, at: old } }, { now: T + 3 * 86_400_000 }).detail, "Open the Code tab in the Claude app once. · Keys show the last live numbers (as of Oct 1) meanwhile.");
    assert.equal(line({ status: "no-answer" }).detail, undefined);
  });

  it("before the first answer", () => {
    assert.deepEqual(line({ status: "idle" }), { tone: "idle", text: "Starting Claude Code…" });
    assert.deepEqual(line({ status: "idle" }, { watching: false }), { tone: "idle", text: "Paused", detail: "Starts when a Usage key shows Weekly, 5-hour or Auto." });
    assert.deepEqual(line({ status: "starting" }), { tone: "idle", text: "Asking Claude Code…" });
  });

  it("goes to Usage pages only, as plain JSON", () => {
    const liveUsage: LiveUsageInput = { state: { status: "live", sample, checkedAt: T }, watching: true, now: T };
    const p = statusPayload({ actionId: "usage", snap: snap(), needsAccess: false, liveUsage });
    assert.equal(p.liveUsage?.text, "Live · updated 22:41");
    assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
    for (const actionId of ["model", "keep-awake"]) assert.equal(statusPayload({ actionId, snap: snap(), needsAccess: false, liveUsage }).liveUsage, undefined, actionId);
  });
});

describe("chatItems (getChats)", () => {
  const chats = [
    chat("a", { title: "Refactor feature and review our recent changes", status: "working", lastActivityAt: NOW - 60_000 }),
    chat("b", { title: "Add more features from the PRD", status: "done", diff: { added: 40, removed: 8 } }),
    chat("c", { title: "Explore how our approach could be improved", status: "waiting", lastActivityAt: NOW - 2 * 60_000 }),
    chat("d", { status: "done", diff: { added: 0, removed: 0 }, lastActivityAt: NOW - 3 * 3600_000 }),
  ];

  it("numbers chats newest first, like the Activity keys", () => {
    const items = chatItems(snap({ chats, selected: chats[2] }), NOW);
    assert.deepEqual(
      items.map((i) => [i.value, i.position, i.title]),
      chats.map((c, n) => [String(n + 1), n + 1, c.title]),
    );
    assert.equal(items[0]!.label, "1. Refactor feature and review our recent changes — Working");
  });

  it("carries what the key shows: status, time or diff, tile colours, selection", () => {
    const [a, b, c, d] = chatItems(snap({ chats, selected: chats[2] }), NOW);
    assert.deepEqual([a!.statusLabel, b!.statusLabel, c!.statusLabel, d!.statusLabel], ["Working", "Ready", "Waiting for input", "Ready"]);
    assert.equal(a!.time, "1m");
    assert.equal(b!.time, "");
    assert.deepEqual(b!.diff, { added: 40, removed: 8 });
    assert.equal(d!.diff, undefined, "an empty diff shows the time instead");
    assert.equal(d!.time, "3h");
    assert.deepEqual([a!.tile, b!.tile, c!.tile], ["#2C2C2E", "#173B26", "#4A2618"]);
    assert.deepEqual([a!.color, b!.color, c!.color], ["#FFFFFF", "#34C759", "#FF8A3D"]);
    assert.deepEqual(
      [a, b, c, d].map((i) => i!.selected),
      [false, false, true, false],
    );
    assert.ok(a!.icon.startsWith("data:image/svg+xml,"));
  });

  it("stops at the last pinnable position", () => {
    const many = Array.from({ length: 20 }, (_, i) => chat(`x${i}`));
    assert.equal(chatItems(snap({ chats: many }), NOW).length, MAX_POSITION);
    assert.deepEqual(chatItems(snap(), NOW), []);
  });
});

describe("statusIcon", () => {
  it("is the key's icon in the status colour, as an inline SVG", () => {
    const uri = statusIcon("waiting");
    assert.ok(uri.startsWith("data:image/svg+xml,"));
    const svg = decodeURIComponent(uri.slice("data:image/svg+xml,".length));
    assert.match(svg, /^<svg [^>]*width="24" height="24"/);
    assert.match(svg, /stroke="#FF8A3D"/);
    assert.match(decodeURIComponent(statusIcon("done")), /stroke="#34C759"/);
    assert.equal(statusIcon("waiting"), uri, "cached");
    assert.doesNotMatch(svg, /<script|href=/);
  });
});

describe("skillItems (getSkills)", () => {
  const skills: Skill[] = [
    { name: "code-review", label: "Review Changes", source: "built-in" },
    { name: "write-tests", label: "Write Tests", source: "user" },
    { name: "deploy", label: "Deploy", source: "project" },
    { name: "simplify", label: "Simplify", source: "built-in" },
  ];

  it("groups project, user and built-in skills; values are names without /", () => {
    assert.deepEqual(skillItems(skills), [
      { label: "This chat's folder", children: [{ value: "deploy", label: "/deploy" }] },
      { label: "Your skills", children: [{ value: "write-tests", label: "Write Tests (/write-tests)" }] },
      {
        label: "Built-in",
        children: [
          { value: "code-review", label: "Review Changes (/code-review)" },
          { value: "simplify", label: "/simplify" },
        ],
      },
    ]);
  });

  it("leaves out empty groups", () => {
    assert.deepEqual(
      skillItems([skills[0]!]).map((g) => g.label),
      ["Built-in"],
    );
  });
});

describe("modelItems (getModels)", () => {
  it("lists the app's models in menu order, by id", () => {
    assert.deepEqual(modelItems(MODELS), [
      { value: "claude-opus-5-5", label: "Opus 5.5" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    ]);
  });
});

describe("modelSlotItems (getModelSlots)", () => {
  it("offers an empty slot first, then the app's models", () => {
    assert.deepEqual(modelSlotItems(MODELS), [
      { value: "none", label: "— none —" },
      { value: "claude-opus-5-5", label: "Opus 5.5" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    ]);
  });
});

describe("folderItems (getFolders)", () => {
  it("lists recent chat folders once each, most recent first, with ~ for home", () => {
    const chats = [
      chat("1", { cwd: "/Users/me/code/app", lastActivityAt: 10 }),
      chat("2", { cwd: "/Users/me/code/api", lastActivityAt: 30 }),
      chat("3", { cwd: "/Users/me/code/app", lastActivityAt: 20 }),
      chat("4", { cwd: "/opt/work", lastActivityAt: 5 }),
      chat("5", { lastActivityAt: 40 }),
    ];
    assert.deepEqual(folderItems(chats, "/Users/me"), [
      { value: "/Users/me/code/api", label: "~/code/api" },
      { value: "/Users/me/code/app", label: "~/code/app" },
      { value: "/opt/work", label: "/opt/work" },
    ]);
  });

  it("says so when there are none (a disabled item keeps the picker from spinning)", () => {
    assert.deepEqual(folderItems([], "/Users/me"), [{ value: "", label: "No recent folders", disabled: true }]);
  });

  it("shortPath only shortens real home sub-paths", () => {
    assert.equal(shortPath("/Users/me", "/Users/me"), "~");
    assert.equal(shortPath("/Users/me/x", "/Users/me/"), "~/x");
    assert.equal(shortPath("/Users/meow/x", "/Users/me"), "/Users/meow/x");
  });
});

describe("statusPayload (getStatus)", () => {
  it("reports app, accessibility, the selected chat and the key's last result", () => {
    const sel = chat("s", { title: "Fix login", status: "waiting", detail: "Approve the edit to auth.ts" });
    const p = statusPayload({
      actionId: "send-prompt",
      snap: snap({ chats: [sel], selected: sel, accessibility: false }),
      needsAccess: true,
      result: { ok: false, message: "Not allowed to send keystrokes", feedback: "alert", action: "send-prompt", at: NOW },
      controller: "Keypad",
    });
    assert.equal(p.event, "status");
    assert.equal(p.action, "send-prompt");
    assert.deepEqual(p.app, { installed: true, running: true });
    assert.equal(p.access, "missing");
    assert.equal(p.accessFix, ACCESS_FIX);
    assert.equal(ACCESS_FIX, "System Settings → Privacy & Security → Accessibility → enable Elgato Stream Deck");
    assert.equal(p.needsAccess, true);
    assert.deepEqual({ ...p.chat, icon: undefined }, { title: "Fix login", status: "waiting", statusLabel: STATUS_LABEL.waiting, detail: "Approve the edit to auth.ts", icon: undefined });
    assert.deepEqual(p.result, { ok: false, message: "Not allowed to send keystrokes", at: NOW });
    assert.equal(p.controller, "Keypad");
    assert.equal(p.follow, undefined);
    assert.equal(p.note, undefined);
  });

  it("maps unknown accessibility and the empty states", () => {
    const p = statusPayload({ actionId: "usage", snap: snap({ app: { installed: true, running: false }, error: "claude agents failed" }), needsAccess: false });
    assert.equal(p.access, "unknown");
    assert.equal(p.chat, null);
    assert.equal(p.result, null);
    assert.equal(p.app.running, false);
    assert.equal(p.note, "claude agents failed");
    assert.equal(statusPayload({ actionId: "x", snap: snap({ accessibility: true }), needsAccess: true }).access, "granted");
  });

  it("tells an Activity key which chat it follows", () => {
    const p = statusPayload({ actionId: "activity", snap: snap(), needsAccess: false, follow: { position: 3, auto: true } });
    assert.deepEqual(p.follow, { position: 3, auto: true });
  });

  it("carries KeepingYouAwake's state for Keep Awake pages only", () => {
    const p = statusPayload({
      actionId: "keep-awake",
      snap: snap(),
      needsAccess: false,
      keepAwake: { installed: true, running: true, active: true, until: NOW + 60_000, pending: true },
    });
    assert.deepEqual(p.keepAwake, { installed: true, running: true, active: true, until: NOW + 60_000, pending: true });
    const off = statusPayload({ actionId: "keep-awake", snap: snap(), needsAccess: false, keepAwake: { installed: false, running: false, active: false, error: "ps failed" } });
    assert.deepEqual(off.keepAwake, { installed: false, running: false, active: false, error: "ps failed" });
    const on = { installed: true, running: true, active: true };
    for (const actionId of ["speed", "activity", "power"]) assert.equal(statusPayload({ actionId, snap: snap(), needsAccess: false, keepAwake: on }).keepAwake, undefined, actionId);
  });

  it("is plain JSON (what sendToPropertyInspector carries)", () => {
    const sel = chat("s");
    const p = statusPayload({ actionId: "model", snap: snap({ selected: sel, chats: [sel] }), needsAccess: true });
    assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
  });
});

// ── Static page checks ──────────────────────────────────────────────────────────────────────────────────

describe("check-pi helpers", () => {
  it("scanTags reads attributes in any quoting", () => {
    const [t] = scanTags(`<sdpi-select setting="mode" default='next' hot-reload data-x=1>`);
    assert.deepEqual(t!.attrs, { setting: "mode", default: "next", "hot-reload": "", "data-x": "1" });
    assert.equal(scanTags("<!-- <script src=x> -->").length, 0);
  });

  it("follows the settings normalisers an action calls", () => {
    const norms = normaliserReads(
      [
        "export function usageView(s: UsageSettings | undefined): UsageView {\n  return ok(s?.view) ? s!.view : 'auto';\n}",
        "export const isFixed = (s: { mode?: string } | undefined): boolean => s?.mode === 'fixed';",
        "export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');",
      ].join("\n"),
    );
    assert.deepEqual(norms.get("usageView"), ["view"]);
    assert.deepEqual(norms.get("isFixed"), ["mode"]);
    assert.equal(norms.has("str"), false, "v.trim() is a method call, not a settings key");
    const reads = settingsRead('import { str } from "./settings.ts";\nconst x = isFixed(inst.settings) ? str(inst.settings.model) : \'\';\nconst { level, cycle: c } = inst.settings;', norms);
    assert.deepEqual(reads, ["cycle", "level", "mode", "model"]);
  });

  it("follows a normaliser into the normalisers it hands the settings to", () => {
    const norms = normaliserReads(
      [
        "export const isFixed = (s: { mode?: string } | undefined): boolean => s?.mode === 'fixed';",
        "export function modelSlots(s: ModelSettings | undefined): string[] {\n  return [s?.slot1, s?.slot2].concat(s?.slots ?? []);\n}",
        "export function modelPlan(s: ModelSettings | undefined) {\n  const fixed = isFixed(s) ? str(s?.model) : '';\n  return fixed ? [fixed] : modelSlots(s);\n}",
      ].join("\n"),
    );
    assert.deepEqual(norms.get("modelPlan")?.sort(), ["mode", "model", "slot1", "slot2", "slots"]);
    assert.deepEqual(settingsRead("return modelPlan(inst.settings);", norms), ["mode", "model", "slot1", "slot2", "slots"]);
  });
});

describe("check-pi on the real pages", () => {
  it("passes", () => {
    const { problems, pages } = checkPi();
    assert.deepEqual(problems, []);
    assert.equal(pages.length, 14);
    const keys = Object.fromEntries(pages.map((p) => [p.id, p.settings]));
    assert.deepEqual(keys, {
      activity: ["position"],
      "new-chat": ["folder", "prompt"],
      dictate: [],
      "send-prompt": ["prompt"],
      steer: ["text"],
      "run-skill": ["args", "skill"],
      stop: [],
      model: ["mode", "model", "slot1", "slot2", "slot3", "slot4", "slots"],
      effort: ["cycle", "level", "mode"],
      speed: [],
      usage: ["view"],
      "toggle-panel": ["panel"],
      "keep-awake": ["duration", "mode"],
      power: [],
    });
  });
});

describe("check-pi catches mistakes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-pi-test-"));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // A copy of what check-pi reads: the plugin folder (minus big binaries) and the sources it greps.
  const sd = `${PLUGIN_UUID}.sdPlugin`;
  fs.cpSync(path.join(ROOT, sd, "ui"), path.join(tmp, sd, "ui"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, sd, "manifest.json"), path.join(tmp, sd, "manifest.json"));
  fs.cpSync(path.join(ROOT, "src"), path.join(tmp, "src"), { recursive: true });
  const ui = path.join(tmp, sd, "ui");
  const edit = (file: string, fn: (s: string) => string) => fs.writeFileSync(path.join(ui, file), fn(fs.readFileSync(path.join(ui, file), "utf8")));

  it("flags remote resources, unknown settings, a missing page and broken references", () => {
    edit("steer.html", (s) => s.replace("</head>", `  <script src="https://cdn.example.com/x.js"></script>\n</head>`));
    edit("send-prompt.html", (s) => s.replace(`setting="prompt"`, `setting="message"`));
    edit("model.html", (s) => s.replace(`data-show-if="mode=fixed"`, `data-show-if="kind=fixed"`));
    edit("usage.html", (s) => s.replace(`<option value="context">Context</option>`, ""));
    edit("keep-awake.html", (s) =>
      s
        .replace(`<option value="off">Turn off</option>`, `<option value="fixed">Fixed</option>`)
        .replace(`data-show-if="mode!=off"`, `data-show-if="mode!=never"`)
        .replace(`data-rows="keepAwake,result"`, `data-rows="keepawake,result"`),
    );
    edit("dictate.html", (s) => s.replace(`<div id="cc-status">`, `<div id="cc-status" data-rows="app,keepAwake,result">`));
    edit("pi.css", (s) => `@import url("https://fonts.example.com/a.css");\n${s}`);
    edit("pi.js", (s) => `${s}\nfetch("/x");\n`);
    fs.rmSync(path.join(ui, "stop.html"));
    fs.writeFileSync(path.join(ui, "extra.html"), "<!DOCTYPE html><html><body></body></html>");

    const { problems } = checkPi(tmp);
    const has = (re: RegExp) => assert.ok(problems.some((p) => re.test(p)), `expected a problem matching ${re}\n${problems.join("\n")}`);
    has(/ui\/steer\.html: <script src="https:\/\/cdn\.example\.com\/x\.js"> is not a local resource/);
    has(/ui\/send-prompt\.html: setting "message" is not read by src\/actions\/send-prompt\.ts/);
    has(/ui\/model\.html: data-show-if refers to "kind"/);
    has(/ui\/usage\.html: options for "view" should be .*missing context/);
    has(/ui\/keep-awake\.html: options for "mode" should be toggle, on, off \(missing off\) \(unknown fixed\)/);
    has(/ui\/keep-awake\.html: data-show-if value "never" is not a mode value/);
    has(/ui\/keep-awake\.html: data-rows lists "keepawake", which isn't a status row \(ui\/pi\.js ROWS: app, access, chat, keepAwake, result\)/);
    has(/ui\/keep-awake\.html: the status box should show the keepAwake row/);
    has(/ui\/dictate\.html: data-rows lists "keepAwake", but only the Keep Awake page/);
    has(/ui\/pi\.css: refers to https:\/\/fonts\.example\.com/);
    has(/ui\/pi\.js: uses fetch\(/);
    has(/ui\/stop\.html: missing/);
    has(/ui\/extra\.html: no action uses this page/);
  });

  it("flags Model slots and an effort cycle that don't match what the keys assume", () => {
    edit("model.html", (s) =>
      s.replace(`setting="slot1" default="claude-fable-5-1"`, `setting="slot1" default="claude-opus-5-5"`).replace(`setting="slot4" default="none" datasource="getModelSlots"`, `setting="slot4" default="none" datasource="getModels"`),
    );
    edit("effort.html", (s) => s.replace(`default="low, medium, high, xhigh, max, ultracode"`, `default="low, medium, high, xhigh, max"`));
    const { problems } = checkPi(tmp);
    const has = (re: RegExp) => assert.ok(problems.some((p) => re.test(p)), `expected a problem matching ${re}\n${problems.join("\n")}`);
    has(/ui\/model\.html: slot1 should default to "claude-fable-5-1"/);
    has(/ui\/model\.html: slot4 should use datasource="getModelSlots"/);
    has(/ui\/effort\.html: the cycle field should default to "low, medium, high, xhigh, max, ultracode"/);
  });

  it("flags a password field anywhere, a broken live-usage section, live usage on another page, unknown messages", () => {
    edit("usage.html", (s) =>
      s
        .replace(`<div class="cc-row">`, `<sdpi-item label="Token"><sdpi-password id="cc-token"></sdpi-password></sdpi-item>\n    <div class="cc-row">`)
        .replace(`id="cc-live"`, `id="cc-live-status"`)
        .replace(`id="cc-login" hidden`, `id="cc-login"`),
    );
    edit("speed.html", (s) => s.replace(`<div id="cc-status">`, `<input type="password" id="x" />\n  <span id="cc-live"></span>\n  <div id="cc-status">`));
    edit("pi.js", (s) => `${s}\nsend({ event: "setUsageToken", token: "x" });\nclient.setGlobalSettings({});\n`);
    const { problems } = checkPi(tmp);
    const has = (re: RegExp) => assert.ok(problems.some((p) => re.test(p)), `expected a problem matching ${re}\n${problems.join("\n")}`);
    has(/ui\/usage\.html: <sdpi-password id="cc-token"> is a password field — no page takes a password or token/);
    has(/ui\/usage\.html: the live-usage section needs #cc-live$/);
    has(/ui\/usage\.html: #cc-login should start hidden/);
    has(/ui\/speed\.html: <input id="x"> is a password field/);
    has(/ui\/speed\.html: has live-usage elements, but only the Usage page gets live usage/);
    has(/ui\/pi\.js: uses setGlobalSettings/);
    has(/ui\/pi\.js: sends "setUsageToken", which the plugin doesn't handle/);
  });

  it("flags a tampered sdpi-components copy", () => {
    edit("vendor/sdpi-components.js", (s) => `${s}\n// changed`);
    const { problems } = checkPi(tmp);
    assert.ok(problems.some((p) => /sdpi-components\.js: SHA-256 .* doesn't match/.test(p)));
  });
});
