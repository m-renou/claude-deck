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
    assert.equal(pages.length, 13);
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

  it("flags a tampered sdpi-components copy", () => {
    edit("vendor/sdpi-components.js", (s) => `${s}\n// changed`);
    const { problems } = checkPi(tmp);
    assert.ok(problems.some((p) => /sdpi-components\.js: SHA-256 .* doesn't match/.test(p)));
  });
});
