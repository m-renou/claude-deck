// control.ts / ax.ts without the Claude app: the JXA program (ax.ts) runs in a Node vm against a simulated System Events
// (an accessibility tree, keystrokes, clipboard, a fake clock), and control.ts runs with a fake process runner that
// records every osascript / open call. Nothing here starts osascript or opens a link.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-control-test-"));
process.env.PATH = path.join(tmp, "empty-bin");
process.env.CLAUDE_CODE_DECK_UI_CACHE = path.join(tmp, "cfg", "ui-cache.json");

type Control = typeof import("../src/claude/control.ts");
let control: Control;
let JXA_SOURCE: string;

before(async () => {
  control = await import("../src/claude/control.ts");
  JXA_SOURCE = (await import("../src/claude/ax.ts")).JXA_SOURCE;
});

after(() => {
  control?.setExec();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Simulated System Events ─────────────────────────────────────────────────────────────────────────────────

const BUNDLE = "com.anthropic.claudefordesktop";

interface AXNode {
  role: string;
  desc?: string;
  title?: string;
  value?: unknown;
  max?: number;
  size?: [number, number];
  pos?: [number, number];
  children: AXNode[];
}

const UTF8 = "public.utf8-plain-text";
/** One clipboard item: type → data. */
type ClipItem = Record<string, string>;

const node = (role: string, children: AXNode[] = [], extra: Partial<AXNode> = {}): AXNode => ({ role, children, ...extra });
const text = (s: string): AXNode => node("AXStaticText", [], { value: s });

class Sim {
  running = true;
  frontmost = true;
  /** activate() brings the app forward. */
  activates = true;
  activated = 0;
  focusSets = 0;
  manual = false;
  clock = 1_000_000;
  log: string[] = [];
  typedElsewhere = 0;
  clip: ClipItem[] = [{ [UTF8]: "OLD CLIP" }];
  changeCount = 0;
  prompt: AXNode = node("AXTextArea", [], { desc: "Prompt", value: "\n", pos: [300, 700] });
  slider: AXNode = node("AXSlider", [], { desc: "Effort", value: 2, max: 5 });
  modelMenu: AXNode = node("AXMenu", [node("AXMenuItem", [], { title: "Opus 5.5" }), node("AXMenuItem", [], { title: "Fable 5.1" })]);
  /** ⌘⇧I opens the model menu, and it takes focus. */
  menuOpens = true;
  menuOpen = false;
  /** Row digit the model menu took. */
  picked: string[] = [];
  /** ⌘⇧E opens the slider. */
  sliderOpens = true;
  sliderOpen = false;
  /** Return in the prompt box sends it (the box empties). */
  returnSends = true;
  /** ⌘V puts the clipboard into the focused text area. */
  pasteWorks = true;
  /** Runs after each keystroke (tests: the app switching chats, a dialog taking focus …). */
  afterKey?: (name: string) => void;
  /** Setting AXFocused moves focus. */
  focusWorks = true;
  /** The app takes ⌘V / opens the slider this much later (simulated ms). */
  pasteDelayMs = 0;
  sliderDelayMs = 0;
  private timers: Array<{ at: number; fn: () => void }> = [];

  /** Run what's due (called by the simulated delay()). */
  tick(): void {
    const due = this.timers.filter((t) => t.at <= this.clock);
    this.timers = this.timers.filter((t) => t.at > this.clock);
    for (const t of due) t.fn();
  }

  later(ms: number, fn: () => void): void {
    this.timers.push({ at: this.clock + ms, fn });
  }
  sent: string[] = [];
  focused: AXNode | null;
  window: AXNode;
  menuBar: AXNode;

  constructor() {
    this.window = node("AXWindow", [
      node("AXGroup", [text("Finished 1"), node("AXButton", [text("Clear finished tasks")])]),
      node("AXGroup", [
        node("AXScrollArea", [text("transcript line 1"), text("transcript line 2")]),
        node("AXGroup", [node("AXTextArea", [], { desc: "Prompt", size: [0, 0] }), this.prompt]),
      ]),
    ]);
    this.focused = this.window.children[0]!; // after activation the focus is NOT the prompt box
    this.menuBar = node("AXMenuBar", [
      node("AXMenuBarItem", [], { title: "Apple" }),
      node("AXMenuBarItem", [node("AXMenu", [node("AXMenuItem", [], { title: "Undo" }), node("AXMenuItem", [], { title: "Start Dictation…" })])], { title: "Edit" }),
    ]);
  }

  /** The prompt's index path from the window (the real app's is ~32 levels deep). */
  get promptPath(): number[] {
    const walk = (n: AXNode, p: number[]): number[] | undefined => {
      if (n === this.prompt) return p;
      for (let i = 0; i < n.children.length; i++) {
        const r = walk(n.children[i]!, [...p, i]);
        if (r) return r;
      }
      return undefined;
    };
    return walk(this.window, [])!;
  }

  /** Text on the clipboard (its first item's plain text), or null. Setting it replaces the clipboard. */
  get clipboard(): string | null {
    return this.clip[0]?.[UTF8] ?? null;
  }
  set clipboard(v: string | null) {
    this.clip = v === null ? [] : [{ [UTF8]: v }];
  }

  key(k: { key?: string; code?: number; using: string[] }): void {
    if (!this.frontmost) this.typedElsewhere++;
    const mods = k.using.map((u) => ({ "command down": "cmd", "shift down": "shift", "control down": "ctrl", "option down": "alt" })[u] ?? u);
    const name = [...mods, k.key ?? `code:${k.code}`].join("+");
    this.log.push(name);
    this.press(name, k);
    this.afterKey?.(name);
  }

  private press(name: string, k: { key?: string; code?: number; using: string[] }): void {
    const f = this.focused;
    if (name === "cmd+shift+i") {
      if (this.menuOpen) {
        this.menuOpen = false;
        this.focused = this.prompt;
      } else if (this.menuOpens) {
        this.menuOpen = true;
        this.focused = this.modelMenu;
      }
    } else if (k.key && /^[1-9]$/.test(k.key) && !k.using.length && f === this.modelMenu) {
      this.picked.push(k.key);
      this.menuOpen = false;
      this.focused = this.prompt;
    } else if (k.key && k.key.length === 1 && !k.using.length && f?.role === "AXTextArea") {
      f.value = `${String(f.value ?? "").replace(/\n$/, "")}${k.key}\n`; // typed into the box
    } else if (name === "cmd+shift+e") {
      if (this.sliderOpen) {
        this.sliderOpen = false;
        this.focused = this.prompt;
      } else if (this.sliderOpens) {
        const open = () => {
          this.sliderOpen = true;
          this.focused = this.slider;
        };
        if (this.sliderDelayMs) this.later(this.sliderDelayMs, open);
        else open();
      }
    } else if ((k.code === 123 || k.code === 124) && f === this.slider) {
      const v = Number(this.slider.value) + (k.code === 123 ? -1 : 1);
      this.slider.value = Math.max(0, Math.min(this.slider.max ?? 5, v));
    } else if (name === "cmd+v" && f?.role === "AXTextArea" && this.pasteWorks) {
      const paste = () => (f.value = `${String(f.value ?? "").replace(/\n$/, "")}${this.clipboard ?? ""}\n`);
      if (this.pasteDelayMs) this.later(this.pasteDelayMs, paste);
      else paste();
    } else if (k.code === 36 && f === this.prompt && this.returnSends) {
      this.sent.push(String(this.prompt.value).replace(/\n$/, ""));
      this.prompt.value = "\n";
    }
  }
}

/** A JXA element specifier over the simulated tree (resolved lazily, like the real ones). */
function elem(sim: Sim, resolve: () => AXNode | undefined): Record<string, unknown> {
  const need = (): AXNode => {
    const n = resolve();
    if (!n) throw new Error("Can't get object.");
    return n;
  };
  const kids = (): AXNode[] => need().children;
  const e: Record<string, unknown> = {
    role: () => need().role,
    title: () => need().title,
    size: () => need().size ?? [120, 24],
    position: () => need().pos ?? [10, 10],
    click: () => {
      sim.log.push(`click:${need().title}`);
    },
    attributes: { byName: (name: string) => attrSpec(sim, need, name) },
  };
  for (const k of ["uiElements", "menuBarItems", "menus", "menuItems"]) e[k] = collection(sim, kids);
  return e;
}

function collection(sim: Sim, kids: () => AXNode[]): unknown {
  const fn = () => kids().map((_, i) => elem(sim, () => kids()[i]));
  return new Proxy(fn, {
    get(target, prop) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        const i = Number(prop);
        return elem(sim, () => kids()[i]);
      }
      if (prop === "length") return kids().length;
      if (prop === "role") return () => kids().map((n) => n.role);
      if (prop === "name") return () => kids().map((n) => n.title);
      if (prop === "byName") return (name: string) => elem(sim, () => kids().find((n) => n.title === name));
      return Reflect.get(target, prop);
    },
  });
}

function attrSpec(sim: Sim, need: () => AXNode, name: string): unknown {
  const o = {};
  Object.defineProperty(o, "value", {
    get: () => () => {
      const n = need();
      if (name === "AXDescription") return n.desc ?? "";
      if (name === "AXValue") return n.value;
      if (name === "AXMaxValue") return n.max;
      if (name === "AXFocused") return sim.focused === n;
      if (name === "AXFocusedUIElement") {
        const f = sim.focused;
        return f ? elem(sim, () => f) : null;
      }
      throw new Error(`no attribute ${name}`);
    },
    set: (v: unknown) => {
      const n = need();
      if (name === "AXFocused" && v === true) {
        sim.focusSets++;
        if (sim.focusWorks) sim.focused = n;
      } else if (name === "AXManualAccessibility") sim.manual = true;
    },
  });
  return o;
}

function jxaGlobals(sim: Sim): Record<string, unknown> {
  const proc = elem(sim, () => node("AXApplication", []));
  Object.defineProperty(proc, "frontmost", {
    get: () => () => sim.frontmost,
    set: (v: boolean) => {
      if (v && sim.activates) sim.frontmost = true;
    },
  });
  proc.windows = collection(sim, () => [sim.window]);
  proc.menuBars = collection(sim, () => [sim.menuBar]);
  proc.attributes = {
    byName: (name: string) =>
      attrSpec(sim, () => node("AXApplication", []), name),
  };
  const se = {
    applicationProcesses: {
      whose: (q: { bundleIdentifier?: string }) => () => (sim.running && q.bundleIdentifier === BUNDLE ? [proc] : []),
    },
    keystroke: (key: string, o?: { using?: string[] }) => sim.key({ key, using: o?.using ?? [] }),
    keyCode: (code: number, o?: { using?: string[] }) => sim.key({ code, using: o?.using ?? [] }),
  };
  // NSArray / NSPasteboardItem / NSData stand-ins (the bridge exposes 0-argument methods as properties)
  const nsArray = <T,>(list: T[]) => ({ count: list.length, objectAtIndex: (i: number) => list[i] });
  const pb = {
    stringForType: () => ({ s: sim.clipboard ?? undefined }),
    setStringForType: (v: { s: string }, t: string) => {
      sim.clip = [{ [t]: v.s }];
      sim.changeCount++;
    },
    get clearContents() {
      sim.clip = [];
      sim.changeCount++;
      return sim.changeCount;
    },
    get changeCount() {
      return String(sim.changeCount); // the real bridge hands back a string here
    },
    get pasteboardItems() {
      return nsArray(
        sim.clip.map((item) => ({
          types: nsArray(Object.keys(item)),
          dataForType: (t: string) => ({ data: item[t], isNil: () => item[t] === undefined }),
        })),
      );
    },
    writeObjects: (arr: { items: Array<{ data: ClipItem }> }) => {
      sim.clip = arr.items.map((i) => ({ ...i.data }));
      sim.changeCount++;
      return true;
    },
  };
  const $ = Object.assign((s: string) => ({ s }), {
    NSPasteboard: { generalPasteboard: pb },
    NSPasteboardTypeString: UTF8,
    NSMutableArray: {
      get array() {
        const items: unknown[] = [];
        return { items, addObject: (x: unknown) => items.push(x) };
      },
    },
    NSPasteboardItem: {
      get alloc() {
        return {
          get init() {
            const data: ClipItem = {};
            return { data, setDataForType: (d: { data: string }, t: string) => ((data[t] = d.data), true) };
          },
        };
      },
    },
  });
  return {
    Application: (name: string) =>
      name === "System Events"
        ? se
        : {
            activate: () => {
              sim.activated++;
              if (sim.activates) sim.frontmost = true;
            },
          },
    delay: (s: number) => {
      sim.clock += s * 1000;
      sim.tick();
    },
    Date: { now: () => sim.clock },
    ObjC: { import: () => undefined, unwrap: (x: { s?: string } | undefined) => x?.s },
    $,
  };
}

/** Run one request through the real JXA program, against the simulation. */
function jxa(sim: Sim, req: Record<string, unknown>): Record<string, unknown> {
  const ctx = vm.createContext(jxaGlobals(sim));
  vm.runInContext(JXA_SOURCE, ctx);
  const out = (ctx.run as (argv: string[]) => string)([JSON.stringify({ bundle: BUNDLE, ...req })]);
  return JSON.parse(out) as Record<string, unknown>;
}

function jxaFn<T>(name: string): T {
  const ctx = vm.createContext({});
  vm.runInContext(JXA_SOURCE, ctx);
  return ctx[name] as T;
}

// ── JXA program ─────────────────────────────────────────────────────────────────────────────────────────────

describe("JXA pure helpers", () => {
  it("planPrompt: configured text pastes, an empty key submits the draft", () => {
    const plan = jxaFn<(d: string, t: string | undefined, o: object) => Record<string, unknown>>("planPrompt");
    assert.deepEqual({ ...plan("", "hi", { submit: true, requireEmpty: true }) }, { paste: true, submit: true });
    assert.deepEqual({ ...plan("draft", "hi", { submit: true, requireEmpty: true }) }, { error: "draft-not-empty" });
    assert.deepEqual({ ...plan("draft", "hi", { submit: true, requireEmpty: false }) }, { paste: true, submit: true });
    assert.deepEqual({ ...plan("my draft", undefined, { submit: true }) }, { paste: false, submit: true });
    assert.deepEqual({ ...plan("  ", undefined, { submit: true }) }, { error: "prompt-empty" });
    assert.deepEqual({ ...plan("", "   ", { submit: true }) }, { error: "prompt-empty" });
  });

  it("arrowPlan: 5 → 4 is one Left, 0 → 5 five Rights", () => {
    const arrows = jxaFn<(a: number, b: number) => { code: number; count: number }>("arrowPlan");
    assert.deepEqual({ ...arrows(5, 4) }, { code: 123, count: 1 });
    assert.deepEqual({ ...arrows(0, 5) }, { code: 124, count: 5 });
    assert.equal(arrows(3, 3).count, 0);
  });
});

describe("JXA program: prompt box", () => {
  it("locate is read-only: no activation, no focus, no keys — and finds the visible box", () => {
    const sim = new Sim();
    sim.frontmost = false;
    const r = jxa(sim, { op: "locate" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.path, sim.promptPath);
    assert.equal(r.rescanned, true);
    assert.equal(sim.activated, 0);
    assert.equal(sim.focusSets, 0);
    assert.deepEqual(sim.log, []);
    assert.equal(sim.manual, true, "AXManualAccessibility is turned on for Electron");
  });

  it("uses a valid cached path without searching", () => {
    const sim = new Sim();
    const r = jxa(sim, { op: "locate", path: sim.promptPath });
    assert.equal(r.ok, true);
    assert.equal(r.rescanned, false);
    assert.equal(r.visited, undefined);
  });

  it("re-finds the box when the cached path went stale (nearest-first)", () => {
    const sim = new Sim();
    const old = sim.promptPath;
    sim.window.children.unshift(node("AXGroup", [text("A new banner")]));
    const r = jxa(sim, { op: "locate", path: old });
    assert.equal(r.ok, true);
    assert.equal(r.rescanned, true);
    assert.notDeepEqual(r.path, old);
    assert.deepEqual(r.path, sim.promptPath);
  });

  it("reports prompt-not-found when the window has no prompt box", () => {
    const sim = new Sim();
    sim.window.children.pop();
    const r = jxa(sim, { op: "locate", path: [1, 1, 1] });
    assert.equal(r.ok, false);
    assert.equal(r.error, "prompt-not-found");
  });

  it("configured text: focuses the box, pastes, Return; the clipboard comes back", () => {
    const sim = new Sim();
    const r = jxa(sim, { op: "prompt", path: sim.promptPath, text: "Run the tests", submit: true, requireEmpty: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(sim.focused, sim.prompt);
    assert.deepEqual(sim.log, ["cmd+v", "code:36"]);
    assert.deepEqual(sim.sent, ["Run the tests"]);
    assert.equal(r.cleared, true);
    assert.equal(sim.clipboard, "OLD CLIP");
    assert.equal(sim.activated, 0, "already frontmost: no activation");
  });

  it("an empty key presses Return only, sending the user's draft", () => {
    const sim = new Sim();
    sim.prompt.value = "what I typed\n";
    const r = jxa(sim, { op: "prompt", path: sim.promptPath, submit: true, requireEmpty: true });
    assert.equal(r.ok, true);
    assert.deepEqual(sim.log, ["code:36"]);
    assert.deepEqual(sim.sent, ["what I typed"]);
    assert.equal(sim.clipboard, "OLD CLIP");
  });

  it("refuses configured text when the box holds a draft — nothing is pressed", () => {
    const sim = new Sim();
    sim.prompt.value = "half-written\n";
    const r = jxa(sim, { op: "prompt", path: sim.promptPath, text: "hi", submit: true, requireEmpty: true });
    assert.equal(r.ok, false);
    assert.equal(r.error, "draft-not-empty");
    assert.deepEqual(sim.log, []);
    assert.equal(sim.prompt.value, "half-written\n");
  });

  it("an empty key with an empty box fails without keys", () => {
    const sim = new Sim();
    const r = jxa(sim, { op: "prompt", path: sim.promptPath, submit: true, requireEmpty: true });
    assert.equal(r.error, "prompt-empty");
    assert.deepEqual(sim.log, []);
  });

  it("doesn't press Return when the paste never arrived", () => {
    const sim = new Sim();
    sim.pasteWorks = false;
    const r = jxa(sim, { op: "prompt", path: sim.promptPath, text: "hi", submit: true, requireEmpty: true });
    assert.equal(r.error, "paste-failed");
    assert.deepEqual(sim.log, ["cmd+v"]);
    assert.equal(sim.clipboard, "OLD CLIP");
  });

  it("brings Claude forward first, and types nothing when it won't come", () => {
    const sim = new Sim();
    sim.frontmost = false;
    const r = jxa(sim, { op: "prompt", path: sim.promptPath, text: "hi", submit: true });
    assert.equal(r.ok, true);
    assert.equal(sim.activated, 1);

    const stuck = new Sim();
    stuck.frontmost = false;
    stuck.activates = false;
    const r2 = jxa(stuck, { op: "prompt", path: stuck.promptPath, text: "hi", submit: true });
    assert.equal(r2.error, "not-frontmost");
    assert.deepEqual(stuck.log, []);
    assert.equal(stuck.typedElsewhere, 0);
  });

  it("a box that can't be read back after ⌘V doesn't count as pasted: no Return", () => {
    const sim = new Sim();
    const path = sim.promptPath;
    const box = sim.window.children[1]!.children[1]!;
    sim.afterKey = (k) => {
      if (k === "cmd+v") box.children.splice(1, 1); // the composer re-rendered: the element is gone
    };
    const r = jxa(sim, { op: "prompt", path, text: "Run the tests", submit: true, requireEmpty: true });
    assert.equal(r.error, "paste-failed");
    assert.deepEqual(sim.log, ["cmd+v"]);
    assert.equal(sim.clipboard, "OLD CLIP");
  });

  it("text that isn't what was pasted doesn't count either", () => {
    const sim = new Sim();
    sim.afterKey = (k) => {
      if (k === "cmd+v") sim.prompt.value = "something else\n";
    };
    const r = jxa(sim, { op: "prompt", path: sim.promptPath, text: "Run the tests", submit: true, requireEmpty: true });
    assert.equal(r.error, "paste-failed");
    assert.ok(!sim.log.includes("code:36"));
  });

  it("Return only while the box itself has focus: a dialog that took it gets nothing", () => {
    const sim = new Sim();
    const dialog = node("AXButton", [], { title: "Allow" });
    sim.afterKey = (k) => {
      if (k === "cmd+v") sim.focused = dialog;
    };
    const r = jxa(sim, { op: "prompt", path: sim.promptPath, text: "hi", submit: true, requireEmpty: true });
    assert.equal(r.ok, false);
    assert.equal(r.error, "focus-lost");
    assert.deepEqual(sim.log, ["cmd+v"]);
    assert.deepEqual(sim.sent, []);
  });

  it("another focused Prompt box (side chat) isn't taken for the located one", () => {
    const sim = new Sim();
    const side = node("AXTextArea", [], { desc: "Prompt", value: "side draft\n", pos: [900, 300] });
    sim.window.children.push(node("AXGroup", [side]));
    sim.focused = side;
    sim.prompt.value = "main draft\n";
    const r = jxa(sim, { op: "prompt", path: sim.promptPath, submit: true, requireEmpty: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(sim.sent, ["main draft"]);
    assert.equal(side.value, "side draft\n");
    assert.equal(sim.focused, sim.prompt);
  });

  it("a paste the app takes late still counts (and the clipboard isn't restored under it)", () => {
    const sim = new Sim();
    sim.pasteDelayMs = 1700;
    const r = jxa(sim, { op: "prompt", path: sim.promptPath, text: "hi there", submit: true, requireEmpty: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(sim.sent, ["hi there"]);
    assert.equal(sim.clipboard, "OLD CLIP");
  });

  it("restores every clipboard item with all its types (an image, a file), not just text", () => {
    const sim = new Sim();
    const before: ClipItem[] = [{ "public.png": "PNG-BYTES", "public.tiff": "TIFF-BYTES" }, { "public.file-url": "file:///tmp/a.txt", [UTF8]: "a.txt", "org.nspasteboard.ConcealedType": "" }];
    sim.clip = before.map((i) => ({ ...i }));
    const r = jxa(sim, { op: "prompt", path: sim.promptPath, text: "hi", submit: true, requireEmpty: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(sim.sent, ["hi"]);
    assert.deepEqual(sim.clip, before);
  });

  it("an empty clipboard comes back empty; a clipboard changed meanwhile is left alone", () => {
    const empty = new Sim();
    empty.clip = [];
    jxa(empty, { op: "prompt", path: empty.promptPath, text: "hi", submit: true });
    assert.deepEqual(empty.clip, []);
    const busy = new Sim();
    busy.afterKey = (k) => {
      if (k === "cmd+v") {
        busy.clip = [{ [UTF8]: "copied by the user meanwhile" }];
        busy.changeCount++;
      }
    };
    jxa(busy, { op: "prompt", path: busy.promptPath, text: "hi", submit: true });
    assert.equal(busy.clipboard, "copied by the user meanwhile");
  });

  it("a cached path to a hidden box isn't used: the visible one is searched for", () => {
    const sim = new Sim();
    const hidden = [1, 1, 0]; // the zero-size composer next to the real one
    const r = jxa(sim, { op: "locate", path: hidden });
    assert.equal(r.ok, true);
    assert.equal(r.rescanned, true);
    assert.deepEqual(r.path, sim.promptPath);
  });

  it("a cached box that won't take focus is reported stale (so the retry searches again)", () => {
    const sim = new Sim();
    sim.focusWorks = false;
    const r = jxa(sim, { op: "prompt", path: sim.promptPath, text: "hi", submit: true, requireEmpty: true });
    assert.equal(r.error, "focus-failed");
    assert.equal(r.stale, true);
    assert.equal(r.path, null);
    assert.deepEqual(sim.log, []);
  });

  it("scan: false only tries the cached path (no search of the window)", () => {
    const sim = new Sim();
    const old = sim.promptPath;
    sim.window.children.unshift(node("AXGroup", [text("A new banner")]));
    const r = jxa(sim, { op: "prompt", path: old, scan: false, text: "hi", submit: true, requireEmpty: true });
    assert.equal(r.error, "prompt-not-found");
    assert.equal(r.visited, undefined);
    assert.deepEqual(sim.log, []);
    const none = jxa(new Sim(), { op: "prompt", scan: false, submit: true });
    assert.equal(none.error, "prompt-not-found");
  });

  it("a slash command whose first Return the command menu took gets a second Return", () => {
    const sim = new Sim();
    let first = true;
    const orig = sim.key.bind(sim);
    sim.key = (k) => {
      if (k.code === 36 && first) {
        first = false;
        sim.log.push("code:36");
        return; // the menu took it; the box still holds the command
      }
      orig(k);
    };
    const r = jxa(sim, { op: "prompt", path: sim.promptPath, text: "/code-review", submit: true, requireEmpty: true });
    assert.equal(r.ok, true);
    assert.deepEqual(sim.log, ["cmd+v", "code:36", "code:36"]);
    assert.deepEqual(sim.sent, ["/code-review"]);
  });
});

describe("JXA program: effort slider", () => {
  it("Ultracode (5) → Max (4) is one Left, then ⌘⇧E closes the slider", () => {
    const sim = new Sim();
    sim.slider.value = 5;
    const r = jxa(sim, { op: "effort", target: 4, stops: 6 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.from, 5);
    assert.equal(r.to, 4);
    assert.deepEqual(sim.log, ["cmd+shift+e", "code:123", "cmd+shift+e"]);
    assert.equal(sim.sliderOpen, false);
    assert.equal(sim.focused, sim.prompt);
  });

  it("Low (0) → Ultracode (5): five Rights", () => {
    const sim = new Sim();
    sim.slider.value = 0;
    const r = jxa(sim, { op: "effort", target: 5, stops: 6 });
    assert.equal(r.to, 5);
    assert.deepEqual(sim.log, ["cmd+shift+e", ...Array(5).fill("code:124"), "cmd+shift+e"]);
  });

  it("uses an already-open slider (no extra ⌘⇧E that would close it)", () => {
    const sim = new Sim();
    sim.sliderOpen = true;
    sim.focused = sim.slider;
    sim.slider.value = 1;
    const r = jxa(sim, { op: "effort", target: 2, stops: 6 });
    assert.equal(r.ok, true);
    assert.deepEqual(sim.log, ["code:124", "cmd+shift+e"]);
  });

  it("fails without further keys when the slider doesn't open", () => {
    const sim = new Sim();
    sim.sliderOpens = false;
    const r = jxa(sim, { op: "effort", target: 4, stops: 6 });
    assert.equal(r.error, "effort-not-open");
    assert.deepEqual(sim.log, ["cmd+shift+e"]);
  });

  it("closes without moving when the slider's stops don't match the model", () => {
    const sim = new Sim();
    sim.slider.max = 4;
    const r = jxa(sim, { op: "effort", target: 5, stops: 6 });
    assert.equal(r.error, "effort-range");
    assert.deepEqual(sim.log, ["cmd+shift+e", "cmd+shift+e"]);
  });

  it("a slider without an Ultracode stop still takes the other levels", () => {
    const sim = new Sim();
    sim.slider.max = 4;
    sim.slider.value = 1;
    const r = jxa(sim, { op: "effort", target: 3, stops: 6 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(sim.slider.value, 3);
    const odd = new Sim();
    odd.slider.max = 2;
    assert.equal(jxa(odd, { op: "effort", target: 1, stops: 6 }).error, "effort-range");
  });

  it("a slider that opens after the wait is closed again before giving up", () => {
    const sim = new Sim();
    sim.sliderDelayMs = 1300;
    const r = jxa(sim, { op: "effort", target: 4, stops: 6 });
    assert.equal(r.error, "effort-not-open");
    assert.equal(sim.sliderOpen, false);
    assert.deepEqual(sim.log, ["cmd+shift+e", "cmd+shift+e"]);
  });

  it("closing is never a blind toggle: a slider that already closed isn't re-opened", () => {
    const sim = new Sim();
    sim.slider.value = 1;
    sim.afterKey = (k) => {
      if (k === "code:124") {
        sim.sliderOpen = false; // the app closed it on its own
        sim.focused = sim.prompt;
      }
    };
    const r = jxa(sim, { op: "effort", target: 3, stops: 6 });
    assert.equal(sim.sliderOpen, false);
    assert.deepEqual(sim.log, ["cmd+shift+e", "code:124"]);
    assert.equal(r.closed, true);
    assert.equal(r.error, "effort-stuck");
  });

  it("never presses Esc (it would stop a running response)", () => {
    for (const req of [
      { op: "effort", target: 3, stops: 6 },
      { op: "model", index: 1 },
      { op: "prompt", text: "x", submit: true },
      { op: "dictate", menu: "Edit", items: ["Start Dictation"] },
    ]) {
      const sim = new Sim();
      jxa(sim, { path: sim.promptPath, ...req });
      assert.ok(!sim.log.includes("code:53"), `${req.op}: ${sim.log.join(", ")}`);
    }
  });
});

describe("JXA program: model, keys, dictation", () => {
  it("model: ⌘⇧I, then the row's digit", () => {
    const sim = new Sim();
    const r = jxa(sim, { op: "model", index: 1 });
    assert.equal(r.ok, true);
    assert.deepEqual(sim.log, ["cmd+shift+i", "2"]);
  });

  it("model: no digit when ⌘⇧I didn't move focus into the menu (it would land in the prompt box)", () => {
    const sim = new Sim();
    sim.menuOpens = false;
    sim.focused = sim.prompt;
    sim.prompt.value = "my draft\n";
    const r = jxa(sim, { op: "model", index: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "model-menu-not-open");
    assert.deepEqual(sim.log, ["cmd+shift+i"]);
    assert.equal(sim.prompt.value, "my draft\n");
  });

  it("model: focus moving to another text input isn't the menu either", () => {
    const sim = new Sim();
    const terminal = node("AXTextArea", [], { desc: "Terminal input" });
    sim.menuOpens = false;
    sim.afterKey = (k) => {
      if (k === "cmd+shift+i") sim.focused = terminal;
    };
    const r = jxa(sim, { op: "model", index: 0 });
    assert.equal(r.error, "model-menu-not-open");
    assert.deepEqual(sim.log, ["cmd+shift+i"]);
  });

  it("model: the menu took the digit", () => {
    const sim = new Sim();
    sim.focused = sim.prompt;
    const r = jxa(sim, { op: "model", index: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(sim.picked, ["1"]);
    assert.equal(sim.prompt.value, "\n");
  });

  it("keys with checkPath: nothing is pressed unless a Code chat's prompt box is shown", () => {
    const sim = new Sim();
    const r = jxa(sim, { op: "keys", keys: [{ code: 53 }], checkPath: [0, 0] });
    assert.equal(r.error, "prompt-not-found");
    assert.deepEqual(sim.log, []);
    const ok = new Sim();
    assert.equal(jxa(ok, { op: "keys", keys: [{ code: 53 }], checkPath: ok.promptPath }).ok, true);
    assert.deepEqual(ok.log, ["code:53"]);
  });

  it("keys: shortcuts with modifiers, guarded", () => {
    const sim = new Sim();
    const r = jxa(sim, { op: "keys", keys: [{ key: "d", mods: ["cmd", "shift"] }, { code: 53 }] });
    assert.equal(r.ok, true);
    assert.deepEqual(sim.log, ["cmd+shift+d", "code:53"]);
  });

  it("dictation: cursor into the prompt box, then Edit ▸ Start Dictation", () => {
    const sim = new Sim();
    const r = jxa(sim, { op: "dictate", path: sim.promptPath, menu: "Edit", items: ["Start Dictation", "Stop Dictation"] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(sim.focused, sim.prompt);
    assert.deepEqual(sim.log, ["click:Start Dictation…"]);
  });

  it("not running", () => {
    const sim = new Sim();
    sim.running = false;
    assert.equal(jxa(sim, { op: "keys", keys: [{ key: "b", mods: ["cmd"] }] }).error, "not-running");
  });
});

// ── control.ts with a fake process runner ─────────────────────────────────────────────────────────────────

interface Call {
  cmd: string;
  args: string[];
  req?: Record<string, unknown>;
}

function fakeExec(reply: (req: Record<string, unknown>) => Record<string, unknown> | { code: number; stderr: string }): Call[] {
  const calls: Call[] = [];
  control.setExec(async (cmd, args) => {
    const call: Call = { cmd, args };
    calls.push(call);
    if (cmd !== "osascript") return { code: 0, stdout: "", stderr: "" };
    const req = JSON.parse(args[args.length - 1]!) as Record<string, unknown>;
    call.req = req;
    const r = reply(req);
    if ("code" in r && typeof r.code === "number") return { code: r.code, stdout: "", stderr: String(r.stderr) };
    return { code: 0, stdout: JSON.stringify(r), stderr: "" };
  });
  return calls;
}

describe("control.ts", () => {
  beforeEach(() => {
    fs.rmSync(path.dirname(process.env.CLAUDE_CODE_DECK_UI_CACHE!), { recursive: true, force: true });
    control.resetUiCache();
  });
  afterEach(() => control.setExec());

  it("passes text only as argv JSON, never inside the script", async () => {
    const calls = fakeExec(() => ({ ok: true, path: [1, 2, 3], cleared: true }));
    const secret = 'say "hi" `rm -rf` ${HOME} \\ end';
    const r = await control.typeIntoPrompt(secret, { submit: true, requireEmpty: true });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    const [c] = calls;
    assert.equal(c!.cmd, "osascript");
    assert.deepEqual(c!.args.slice(0, 2), ["-l", "JavaScript"]);
    assert.equal(c!.args[4], "--");
    assert.ok(!c!.args[3]!.includes(secret));
    assert.equal(c!.req!.text, secret);
    assert.equal(c!.req!.op, "prompt");
    assert.equal(c!.req!.bundle, BUNDLE);
  });

  it("an empty / blank text sends no text (submit what's in the box)", async () => {
    const calls = fakeExec(() => ({ ok: true }));
    await control.typeIntoPrompt("   ", { submit: true, requireEmpty: true });
    await control.typeIntoPrompt(undefined, { submit: true });
    assert.equal(calls[0]!.req!.text, undefined);
    assert.equal(calls[1]!.req!.text, undefined);
    assert.equal(calls[1]!.req!.submit, true);
  });

  it("caches the prompt box's path (memory + file) and sends it with the next request", async () => {
    const calls = fakeExec(() => ({ ok: true, path: [0, 4, 2, 7] }));
    await control.typeIntoPrompt("a", { submit: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(process.env.CLAUDE_CODE_DECK_UI_CACHE!, "utf8")).prompt.path, [0, 4, 2, 7]);
    control.resetUiCache(); // a restarted plugin reads the file
    await control.typeIntoPrompt("b", { submit: true });
    assert.deepEqual(calls[1]!.req!.path, [0, 4, 2, 7]);
  });

  it("a miss keeps the old path as the next search's starting point", async () => {
    let n = 0;
    const calls = fakeExec(() => (n++ === 0 ? { ok: true, path: [3, 1] } : { ok: false, error: "prompt-not-found", path: null }));
    await control.focusPrompt();
    const r = await control.focusPrompt();
    assert.equal(r.error, "prompt-not-found");
    assert.match(r.message, /prompt box/);
    await control.focusPrompt();
    assert.deepEqual(calls[2]!.req!.path, [3, 1]);
  });

  it("maps the program's errors to messages, and osascript's own permission errors", async () => {
    fakeExec(() => ({ ok: false, error: "draft-not-empty" }));
    assert.equal((await control.typeIntoPrompt("x", { submit: true, requireEmpty: true })).message, "The prompt box already has text — send or clear it first.");
    fakeExec(() => ({ ok: false, error: "prompt-empty" }));
    assert.equal((await control.typeIntoPrompt(undefined, { submit: true })).message, "The prompt box is empty.");
    fakeExec(() => ({ ok: false, error: "exception", detail: "osascript is not allowed assistive access. (-25211)" }));
    assert.equal((await control.pickModel(1)).error, "accessibility");
    fakeExec(() => ({ code: 1, stderr: "execution error: Not authorized to send Apple events to System Events. (-1743)" }));
    assert.equal((await control.pressKeys([control.shortcut("review")])).error, "automation");
    fakeExec(() => ({ ok: false, error: "something-new" }));
    assert.equal((await control.pressKeys([control.shortcut("review")])).error, "failed");
  });

  it("effort and model requests carry indexes, keys carry key codes", async () => {
    const calls = fakeExec(() => ({ ok: true, from: 5, to: 4 }));
    const e = await control.setEffortSlider(4, 6);
    assert.deepEqual([e.from, e.to], [5, 4]);
    await control.pickModel(1);
    await control.pressKeys([control.shortcut("stop")]);
    await control.pressKeys([control.shortcut("terminal")]);
    assert.deepEqual(
      calls.map((c) => c.req),
      [
        { bundle: BUNDLE, op: "effort", target: 4, stops: 6 },
        { bundle: BUNDLE, op: "model", index: 1 },
        { bundle: BUNDLE, op: "keys", keys: [{ code: 53 }] },
        { bundle: BUNDLE, op: "keys", keys: [{ key: "`", mods: ["ctrl"] }] },
      ],
    );
  });

  it("refuses a model row the digit keys can't reach, without running anything", async () => {
    const calls = fakeExec(() => ({ ok: true }));
    assert.equal((await control.pickModel(9)).ok, false);
    assert.equal(calls.length, 0);
  });

  it("opens the chat first only when asked to", async () => {
    const calls = fakeExec(() => ({ ok: true }));
    await control.pressKeys([control.shortcut("review")], { openChat: "local_abc" });
    assert.equal(calls[0]!.cmd, "open");
    assert.deepEqual(calls[0]!.args, ["claude://code/continue?session=local_abc"]);
    assert.equal(calls[1]!.cmd, "osascript");
    await control.pressKeys([control.shortcut("review")]);
    assert.equal(calls.length, 3);
    assert.equal(calls[2]!.cmd, "osascript");
  });

  it("warmUp only locates (no activation op), once at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: Call[] = [];
    control.setExec(async (cmd, args) => {
      const req = JSON.parse(args[args.length - 1]!) as Record<string, unknown>;
      calls.push({ cmd, args, req });
      await gate;
      return { code: 0, stdout: JSON.stringify({ ok: true, path: [9, 9] }), stderr: "" };
    });
    const a = control.warmUp();
    const b = control.warmUp();
    release();
    await Promise.all([a, b]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.req!.op, "locate");
    assert.deepEqual(control.cachedPromptPath(), [9, 9]);
  });

  it("a stale cached box is dropped (memory and file), so the next attempt searches", async () => {
    let n = 0;
    const calls = fakeExec(() => (n++ === 0 ? { ok: true, path: [3, 1] } : { ok: false, error: "focus-failed", stale: true, path: null }));
    await control.focusPrompt();
    assert.deepEqual(control.cachedPromptPath(), [3, 1]);
    const r = await control.focusPrompt();
    assert.equal(r.error, "focus-failed");
    assert.equal(control.cachedPromptPath(), null);
    control.resetUiCache();
    assert.equal(control.cachedPromptPath(), null);
    await control.focusPrompt();
    assert.equal(calls[2]!.req!.path, null);
  });

  it("scan: false is passed through to prompt jobs only when asked", async () => {
    const calls = fakeExec(() => ({ ok: true }));
    await control.typeIntoPrompt("x", { submit: true, scan: false });
    await control.typeIntoPrompt("x", { submit: true });
    assert.equal(calls[0]!.req!.scan, false);
    assert.equal("scan" in calls[1]!.req!, false);
  });

  it("only prompt-box jobs wait for a running warm-up; Model, Effort and Stop don't", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    control.setExec(async (cmd, args) => {
      const req = JSON.parse(args[args.length - 1]!) as Record<string, unknown>;
      seen.push(String(req.op));
      if (req.op === "locate") await gate;
      return { code: 0, stdout: JSON.stringify({ ok: true, path: [5, 5] }), stderr: "" };
    });
    const warm = control.warmUp();
    await control.pickModel(0);
    await control.setEffortSlider(2, 6);
    await control.pressKeys([control.shortcut("stop")]);
    assert.deepEqual(seen, ["locate", "model", "effort", "keys"]);
    const prompt = control.typeIntoPrompt("x", { submit: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, ["locate", "model", "effort", "keys"], "the prompt job waits for the warm-up");
    release();
    await Promise.all([warm, prompt]);
    assert.deepEqual(seen, ["locate", "model", "effort", "keys", "prompt"]);
  });

  it("the effort program gets a long timeout (never killed with the slider open)", async () => {
    const timeouts: Record<string, number> = {};
    control.setExec(async (_cmd, args, timeout) => {
      const req = JSON.parse(args[args.length - 1]!) as Record<string, unknown>;
      timeouts[String(req.op)] = timeout;
      return { code: 0, stdout: JSON.stringify({ ok: true, from: 1, to: 2, max: 5 }), stderr: "" };
    });
    const r = await control.setEffortSlider(2, 6);
    assert.equal(r.max, 5);
    assert.ok(timeouts.effort! >= 20_000);
  });

  it("a guard stops a queued job before anything is sent", async () => {
    const calls = fakeExec(() => ({ ok: true }));
    const r = await control.pressKeys([control.shortcut("stop")], { guard: () => "not any more" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "cancelled");
    assert.equal(r.message, "not any more");
    assert.equal(calls.length, 0);
  });

  it("checkPrompt sends the cached path, except when the chat is being opened", async () => {
    const calls = fakeExec(() => ({ ok: true, path: [4, 4] }));
    await control.focusPrompt(); // caches [4, 4]
    await control.pressKeys([control.shortcut("stop")], { checkPrompt: true });
    await control.pressKeys([control.shortcut("stop")], { checkPrompt: true, openChat: "local_x" });
    assert.deepEqual(calls[1]!.req!.checkPath, [4, 4]);
    assert.equal("checkPath" in calls[3]!.req!, false);
  });

  it("showChat and openNewChat are queued; showChat keeps the app's switch time inside its job", async () => {
    const stamps: Array<[string, number]> = [];
    control.setExec(async (cmd) => {
      stamps.push([cmd, Date.now()]);
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = control.serial(() => gate);
    const fresh = control.openNewChat();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stamps.length, 0, "New Chat waits for the job ahead of it");
    release();
    await Promise.all([job, fresh]);
    stamps.length = 0;
    const shown = control.showChat("local_b");
    await control.pressKeys([control.shortcut("stop")]);
    await shown;
    assert.deepEqual(
      stamps.map((s) => s[0]),
      ["open", "osascript"],
    );
    assert.ok(stamps[1]![1] - stamps[0]![1] >= 390, `Esc went out ${stamps[1]![1] - stamps[0]![1]} ms after the link`);
  });

  it("no development probe ships with the plugin", () => {
    const src = path.join(import.meta.dirname, "..", "src");
    assert.equal(fs.existsSync(path.join(src, "diag.ts")), false);
    const plugin = fs.readFileSync(path.join(src, "plugin.ts"), "utf8");
    assert.ok(!/onDidReceiveDeepLink|diag/i.test(plugin));
  });

  it("drives macOS and Windows only", async () => {
    const calls: string[] = [];
    control.setExec(
      async (cmd) => {
        calls.push(cmd);
        return { code: 0, stdout: "", stderr: "" };
      },
      { platform: "linux" },
    );
    const r = await control.typeIntoPrompt("x", { submit: true });
    assert.equal(r.ok, false);
    assert.match(r.message, /macOS and Windows only/);
    assert.deepEqual(calls, []);
  });

  it("serial runs one job at a time, in order", async () => {
    const order: string[] = [];
    const a = control.serial(async () => {
      order.push("a1");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a2");
    });
    const b = control.serial(async () => {
      order.push("b");
    });
    assert.equal(control.queueBusy(), true);
    await Promise.all([a, b]);
    assert.deepEqual(order, ["a1", "a2", "b"]);
    assert.equal(control.queueBusy(), false);
  });
});

// ── Windows: the same requests to the UI Automation helper (uia-win.ts), on stdin ────────────────────────────

interface WinCall {
  cmd: string;
  args: string[];
  input?: string;
  req?: Record<string, unknown>;
}

function winExec(reply: (req: Record<string, unknown>) => Record<string, unknown> | { code: number; stderr: string }, helper?: () => Promise<string>): WinCall[] {
  const calls: WinCall[] = [];
  control.setExec(
    async (cmd, args, _timeout, input) => {
      const call: WinCall = { cmd, args, input };
      calls.push(call);
      if (cmd !== "claude-deck-uia.exe") return { code: 0, stdout: "", stderr: "" };
      const req = JSON.parse(input!) as Record<string, unknown>;
      call.req = req;
      const r = reply(req);
      if ("code" in r && typeof r.code === "number") return { code: r.code, stdout: "", stderr: String(r.stderr) };
      return { code: 0, stdout: JSON.stringify(r), stderr: "" };
    },
    { platform: "win32", ...(helper ? { helper } : {}) },
  );
  return calls;
}

describe("control.ts on Windows", () => {
  beforeEach(() => {
    fs.rmSync(path.dirname(process.env.CLAUDE_CODE_DECK_UI_CACHE!), { recursive: true, force: true });
    control.resetUiCache();
  });
  afterEach(() => control.setExec());

  it("sends the request on stdin (never as an argument), naming the desktop app's executable", async () => {
    const calls = winExec(() => ({ ok: true, path: [0, 1, 2], cleared: true }));
    const secret = String.raw`say "hi" & del /q C:\ %PATH% 'x' $(y) ü€`;
    const r = await control.typeIntoPrompt(secret, { submit: true, requireEmpty: true });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cmd, "claude-deck-uia.exe");
    assert.deepEqual(calls[0]!.args, []);
    assert.deepEqual(calls[0]!.req, { exe: ["Claude.exe"], op: "prompt", path: null, text: secret, submit: true, requireEmpty: true });
    assert.deepEqual(control.cachedPromptPath(), [0, 1, 2]);
  });

  it("shortcuts use Ctrl for ⌘ and key names instead of macOS key codes", async () => {
    const calls = winExec(() => ({ ok: true }));
    await control.pressKeys([control.shortcut("stop")]);
    await control.pressKeys([control.shortcut("terminal")]);
    await control.pressKeys([control.shortcut("fast")]);
    await control.pressKeys([control.shortcut("sideChat")]);
    await control.pressKeys([{ key: "Return", mods: ["cmd", "ctrl"] }]);
    assert.deepEqual(
      calls.map((c) => c.req!.keys),
      [[{ key: "escape" }], [{ key: "`", mods: ["ctrl"] }], [{ key: "f", mods: ["ctrl", "alt"] }], [{ key: ";", mods: ["ctrl"] }], [{ key: "return", mods: ["ctrl"] }]],
    );
  });

  it("effort and model requests are the macOS ones", async () => {
    const calls = winExec(() => ({ ok: true, from: 1, to: 3, max: 5 }));
    const e = await control.setEffortSlider(3, 6);
    assert.deepEqual([e.ok, e.from, e.to, e.max], [true, 1, 3, 5]);
    await control.pickModel(2);
    assert.deepEqual(
      calls.map((c) => c.req),
      [
        { exe: ["Claude.exe"], op: "effort", target: 3, stops: 6 },
        { exe: ["Claude.exe"], op: "model", index: 2 },
      ],
    );
  });

  it("Dictate focuses the prompt box, then presses Win+H (Windows voice typing)", async () => {
    const calls = winExec(() => ({ ok: true, path: [4] }));
    const r = await control.dictation();
    assert.equal(r.ok, true);
    assert.deepEqual(calls[0]!.req, { exe: ["Claude.exe"], op: "dictate", path: null, keys: [{ key: "h", mods: ["win"] }] });
  });

  it("opens links with the shell's URL handler (no cmd.exe, so & in a link is safe)", async () => {
    const calls = winExec(() => ({ ok: true }));
    await control.openNewChat({ prompt: "a & b", folder: String.raw`C:\work\repo` });
    await control.showChat("local_abc");
    assert.deepEqual(
      calls.map((c) => [c.cmd, ...c.args]),
      [
        ["rundll32.exe", "url.dll,FileProtocolHandler", "claude://code/new?q=a%20%26%20b&folder=C%3A%5Cwork%5Crepo"],
        ["rundll32.exe", "url.dll,FileProtocolHandler", "claude://code/continue?session=local_abc"],
      ],
    );
  });

  it("asks the helper whether the desktop app runs; needs no permission", async () => {
    let running = true;
    const calls = winExec((req) => (req.op === "running" ? { ok: true, running, window: running } : { ok: false }));
    assert.equal(await control.isClaudeRunning(), true);
    running = false;
    assert.equal(await control.isClaudeRunning(), false);
    assert.equal(await control.accessibilityGranted(), true);
    assert.deepEqual(
      calls.map((c) => c.req!.op),
      ["running", "running"],
    );
  });

  it("Windows wording: Ctrl shortcuts, and blocked key presses explained", async () => {
    winExec(() => ({ ok: false, error: "effort-not-open" }));
    assert.equal((await control.setEffortSlider(1, 6)).message, "Claude's effort slider didn't open (Ctrl+Shift+E), so nothing was changed.");
    winExec(() => ({ ok: false, error: "model-menu-not-open" }));
    assert.equal((await control.pickModel(0)).message, "Claude's model menu didn't open (Ctrl+Shift+I), so nothing was changed.");
    winExec(() => ({ ok: false, error: "accessibility", detail: "SendInput was blocked" }));
    const r = await control.pressKeys([control.shortcut("review")]);
    assert.equal(r.error, "accessibility");
    assert.match(r.message, /administrator/);
    winExec(() => ({ ok: false, error: "prompt-not-found" }));
    assert.equal((await control.focusPrompt()).message, control.MESSAGES["prompt-not-found"]);
  });

  it("a helper that can't be built fails the press with the reason, and runs nothing", async () => {
    const calls = winExec(
      () => ({ ok: true }),
      async () => {
        throw new Error("Couldn't build the Windows helper: csc missing");
      },
    );
    const r = await control.pressKeys([control.shortcut("review")]);
    assert.equal(r.ok, false);
    assert.equal(r.error, "failed");
    assert.match(r.message, /csc missing/);
    assert.equal(calls.length, 0);
  });

  it("a crashed helper (no JSON) is a failure with its last stderr line", async () => {
    winExec(() => ({ code: 3, stderr: "Unhandled Exception: boom\nat Main" }));
    const r = await control.pressKeys([control.shortcut("review")]);
    assert.equal(r.ok, false);
    assert.equal(r.error, "failed");
    assert.match(r.message, /at Main/);
  });

  it("labels shortcuts the way each platform writes them", () => {
    winExec(() => ({ ok: true }));
    assert.deepEqual(
      (["modelMenu", "effortMenu", "fast", "terminal", "stop"] as const).map((n) => control.keyLabel(control.shortcut(n))),
      ["Ctrl+Shift+I", "Ctrl+Shift+E", "Ctrl+Alt+F", "Ctrl+`", "Escape"],
    );
    control.setExec(async () => ({ code: 0, stdout: "", stderr: "" }));
    assert.deepEqual(
      (["modelMenu", "effortMenu", "fast", "terminal"] as const).map((n) => control.keyLabel(control.shortcut(n))),
      ["⌘⇧I", "⌘⇧E", "⌘⌥F", "⌃`"],
    );
  });

  it("warms up (locate) on Windows too", async () => {
    const calls = winExec(() => ({ ok: true, path: [7, 7] }));
    await control.warmUp();
    assert.equal(calls[0]!.req!.op, "locate");
    assert.deepEqual(control.cachedPromptPath(), [7, 7]);
  });
});
