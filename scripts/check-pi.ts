// Static checks for the Property Inspector pages (com.local.claudecode.sdPlugin/ui/*.html). There is no headless
// Stream Deck, so this reads the HTML with regular expressions and checks the contract:
//   • every action in src/catalog.ts has ui/<id>.html (the manifest's PropertyInspectorPath), and every page belongs
//     to an action; each page says which action it is (<body data-action>);
//   • every setting="…" key on a page is one the action reads — found by grepping src/actions/<id>.ts for
//     `settings.key` (and the normalisers it calls in src/actions/settings.ts) — and none is global;
//   • pages load only local resources: ./vendor/sdpi-components.js in <head>, ./pi.css, ./pi.js as the last thing in
//     <body>, all of which must exist; no http(s) / protocol-relative URLs in src / href / url() / @import, and no
//     network APIs in ui/pi.js; the vendored sdpi-components matches the hash in ui/vendor/README.md;
//   • show-if / copy-to / list-for / array-of references point at a setting on the same page, datasources are ones
//     src/pi.ts answers, and fixed option lists match what the actions accept (view, panel, mode, level, effort cycle,
//     Keep Awake's mode and duration); defaults the actions assume are the ones the pages show (Model slots, the
//     effort cycle);
//   • the status box's data-rows names rows ui/pi.js draws (its ROWS), and only the Keep Awake page — the one the
//     plugin sends KeepingYouAwake's state to — shows the keepAwake row (and it must);
//   • no page takes a password or token (live usage runs on Claude Code's own sign-in); only the Usage page — the one
//     the plugin sends live usage to — has the live-usage section (and it must): its status line and the sign-in
//     command to copy, hidden until the plugin says Claude Code is signed out; ui/pi.js never writes settings itself,
//     and every message it sends is one the plugin handles (PI_EVENTS).
//
//   node scripts/check-pi.ts            (exit code 1 when something is wrong)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { DEFAULT_EFFORT_CYCLE, parseCycle } from "../src/actions/logic.ts";
import { KEEP_AWAKE_DURATIONS, KEEP_AWAKE_MODES, MODEL_SLOT_COUNT, slotDefault, USAGE_VIEWS } from "../src/actions/settings.ts";
import { ACTIONS, PANELS, PLUGIN_UUID } from "../src/catalog.ts";
import { EFFORT_LABEL } from "../src/claude/catalog.ts";
import { PI_EVENTS } from "../src/pi-core.ts";

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

export interface PageReport {
  id: string;
  file: string;
  settings: string[];
  /** Keys the action's source reads. */
  reads: string[];
  datasources: string[];
}

export interface CheckResult {
  pages: PageReport[];
  problems: string[];
}

// ── HTML scanning ───────────────────────────────────────────────────────────────────────────────────────

interface Tag {
  name: string;
  attrs: Record<string, string>;
  index: number;
  end: number;
}

const TAG_RE = /<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTR_RE = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function scanTags(html: string): Tag[] {
  const out: Tag[] = [];
  const src = html.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  for (const m of src.matchAll(TAG_RE)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? "").matchAll(ATTR_RE)) attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    out.push({ name: m[1]!.toLowerCase(), attrs, index: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** <option value> list inside the first <tag …> whose attribute `attr` equals `value`. */
function optionsOf(html: string, tags: Tag[], tagName: string, attr: string, value: string): string[] | undefined {
  const open = tags.find((t) => t.name === tagName && t.attrs[attr] === value);
  if (!open) return undefined;
  const close = html.indexOf(`</${tagName}>`, open.end);
  const inner = html.slice(open.end, close < 0 ? undefined : close);
  return scanTags(inner)
    .filter((t) => t.name === "option")
    .map((t) => t.attrs.value ?? "");
}

const REMOTE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** URLs a stylesheet / script loads (url(), @import) plus anything that looks like a remote URL. */
function remoteRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) if (REMOTE_RE.test(m[1]!) && !m[1]!.startsWith("data:")) out.push(m[1]!);
  for (const m of text.matchAll(/@import\s+(?:url\()?\s*["']?([^"');\s]+)/g)) out.push(m[1]!);
  for (const m of text.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`)]+/g)) out.push(m[0]);
  return out;
}

// ── Settings the actions read ───────────────────────────────────────────────────────────────────────────

/** `obj.key`, `obj?.key`, `obj!.key` — property reads, not method calls (`v.trim()`). */
const ACCESS_RE = (obj: string) => new RegExp(`\\b${obj}\\s*(?:\\?\\.|!\\.|\\.)\\s*([A-Za-z_$][\\w$]*)\\b(?!\\s*\\()`, "g");
const BRACKET_RE = (obj: string) => new RegExp(`\\b${obj}\\s*(?:\\?\\.)?\\[\\s*["']([^"']+)["']\\s*\\]`, "g");

/**
 * Normaliser name → keys it reads from its first parameter (src/actions/settings.ts), including the keys of other
 * normalisers it hands that parameter to (`modelPlan(s)` → `modelSlots(s)`).
 */
export function normaliserReads(source: string): Map<string, string[]> {
  const direct = new Map<string, { keys: Set<string>; calls: Set<string> }>();
  const starts = [...source.matchAll(/^export\s+(?:function\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=\s*\()/gm)];
  const names = starts.map((m) => (m[1] ?? m[2])!);
  starts.forEach((m, i) => {
    const name = names[i]!;
    const body = source.slice(m.index!, starts[i + 1]?.index ?? source.length);
    const param = /\(\s*([A-Za-z_$][\w$]*)/.exec(body.slice(body.indexOf("(")))?.[1];
    if (!param) return;
    const keys = new Set<string>();
    for (const a of body.matchAll(ACCESS_RE(param))) keys.add(a[1]!);
    for (const a of body.matchAll(BRACKET_RE(param))) keys.add(a[1]!);
    const calls = new Set(names.filter((n) => n !== name && new RegExp(`\\b${n}\\s*\\(\\s*${param}\\s*[,)]`).test(body)));
    direct.set(name, { keys, calls });
  });
  const out = new Map<string, string[]>();
  const resolve = (name: string, seen: Set<string>): Set<string> => {
    const d = direct.get(name);
    const keys = new Set(d?.keys ?? []);
    for (const c of d?.calls ?? []) if (!seen.has(c)) for (const k of resolve(c, new Set([...seen, c]))) keys.add(k);
    return keys;
  };
  for (const name of direct.keys()) {
    const keys = resolve(name, new Set([name]));
    if (keys.size) out.set(name, [...keys]);
  }
  return out;
}

/** Keys of the per-key settings an action's source reads (directly, by destructuring, or through a normaliser). */
export function settingsRead(actionSource: string, normalisers: Map<string, string[]>): string[] {
  // Module specifiers ("./settings.ts") aren't property reads.
  actionSource = actionSource.replace(/\b(from|import)\s*(\(\s*)?(["'])[^"']*\3/g, "$1 $2''");
  const keys = new Set<string>();
  for (const a of actionSource.matchAll(ACCESS_RE("settings"))) keys.add(a[1]!);
  for (const a of actionSource.matchAll(BRACKET_RE("settings"))) keys.add(a[1]!);
  for (const d of actionSource.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*[\w.?!]*\bsettings\b/g)) {
    for (const part of d[1]!.split(",")) {
      const k = /^\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1];
      if (k) keys.add(k);
    }
  }
  for (const [fn, read] of normalisers) {
    if (new RegExp(`\\b${fn}\\s*\\(\\s*[\\w.?!]*\\bsettings\\s*[,)]`).test(actionSource)) for (const k of read) keys.add(k);
  }
  return [...keys].sort();
}

/** Source of an action: src/actions/<id>.ts plus any src/actions/<id>-*.ts (e.g. a dial implementation). */
function actionSource(root: string, id: string): string | undefined {
  const dir = path.join(root, "src", "actions");
  const files = fs.readdirSync(dir).filter((f) => f === `${id}.ts` || (f.startsWith(`${id}-`) && f.endsWith(".ts")));
  if (!files.includes(`${id}.ts`)) return undefined;
  return files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
}

/** Rows the shared status box can show: the keys of `const ROWS = { … }` in ui/pi.js (what data-rows may list). */
export function statusRowNames(piJs: string): string[] {
  const block = /\bconst ROWS\s*=\s*\{([\s\S]*?)\};/.exec(piJs)?.[1] ?? "";
  return [...block.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]!);
}

/** Events ui/pi.js sends to the plugin: `send({ event: "…" … })`. */
export function sentEvents(piJs: string): string[] {
  return [...new Set([...piJs.matchAll(/\bsend\(\s*\{\s*event\s*:\s*["']([^"']+)["']/g)].map((m) => m[1]!))];
}

/** The live-usage elements ui/pi.js fills in (ids on the Usage page). */
export const LIVE_USAGE_IDS = ["cc-live", "cc-login", "cc-login-cmd", "cc-login-copy"] as const;

// ── The check ───────────────────────────────────────────────────────────────────────────────────────────

type Enums = Record<string, { values: readonly string[]; default?: string }>;

const ENUMS: Enums = {
  view: { values: USAGE_VIEWS, default: "auto" },
  panel: { values: PANELS.map((p) => p.id), default: "review" },
  mode: { values: ["next", "fixed"], default: "next" },
  level: { values: Object.keys(EFFORT_LABEL) },
};

/** Settings whose fixed values differ on one action's page (they replace ENUMS there). */
const ACTION_ENUMS: Record<string, Enums> = {
  "keep-awake": {
    mode: { values: KEEP_AWAKE_MODES, default: "toggle" },
    duration: { values: KEEP_AWAKE_DURATIONS, default: "0" },
  },
};

export function checkPi(root = ROOT): CheckResult {
  const problems: string[] = [];
  const sd = path.join(root, `${PLUGIN_UUID}.sdPlugin`);
  const ui = path.join(sd, "ui");
  const pages: PageReport[] = [];
  const normalisers = normaliserReads(fs.readFileSync(path.join(root, "src", "actions", "settings.ts"), "utf8"));
  const piSource = fs.readFileSync(path.join(root, "src", "pi.ts"), "utf8");
  const piJs = path.join(ui, "pi.js");
  const statusRows = fs.existsSync(piJs) ? statusRowNames(fs.readFileSync(piJs, "utf8")) : [];
  if (fs.existsSync(piJs) && !statusRows.length) problems.push("ui/pi.js: can't find the status box rows (const ROWS = { … })");

  // Manifest ↔ catalog ↔ pages
  let manifest: { Actions?: Array<{ UUID?: string; PropertyInspectorPath?: string }> } = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(sd, "manifest.json"), "utf8"));
  } catch (err) {
    problems.push(`manifest.json: can't read it (${String(err)})`);
  }
  const htmlFiles = fs.existsSync(ui) ? fs.readdirSync(ui).filter((f) => f.endsWith(".html")) : [];
  for (const f of htmlFiles) if (!ACTIONS.some((a) => `${a.id}.html` === f)) problems.push(`ui/${f}: no action uses this page`);

  for (const a of ACTIONS) {
    const rel = `ui/${a.id}.html`;
    const m = manifest.Actions?.find((x) => x.UUID === `${PLUGIN_UUID}.${a.id}`);
    if (manifest.Actions && m?.PropertyInspectorPath !== rel) problems.push(`manifest: ${a.id} should use PropertyInspectorPath "${rel}" (has ${JSON.stringify(m?.PropertyInspectorPath)})`);
    const file = path.join(sd, rel);
    if (!fs.existsSync(file)) {
      problems.push(`${rel}: missing (every action needs a Property Inspector page)`);
      continue;
    }
    const html = fs.readFileSync(file, "utf8");
    const tags = scanTags(html);
    const where = rel;
    const enums: Enums = { ...ENUMS, ...ACTION_ENUMS[a.id] };

    // Identity
    const body = tags.find((t) => t.name === "body");
    if (body?.attrs["data-action"] !== a.id) problems.push(`${where}: <body data-action> should be "${a.id}" (is ${JSON.stringify(body?.attrs["data-action"])})`);
    const status = tags.find((t) => t.attrs.id === "cc-status");
    if (!status) problems.push(`${where}: no status box (<div id="cc-status">)`);
    // pi.js drops row names it doesn't know (a typo would empty the box), so check them here. No data-rows = the
    // Claude rows.
    const rowsAttr = status?.attrs["data-rows"];
    const rows = rowsAttr === undefined ? [] : rowsAttr.split(",").map((r) => r.trim());
    if (statusRows.length) for (const r of rows) if (!statusRows.includes(r)) problems.push(`${where}: data-rows lists "${r}", which isn't a status row (ui/pi.js ROWS: ${statusRows.join(", ")})`);
    if (a.id === "keep-awake" && status && !rows.includes("keepAwake")) problems.push(`${where}: the status box should show the keepAwake row (data-rows)`);
    if (a.id !== "keep-awake" && rows.includes("keepAwake")) problems.push(`${where}: data-rows lists "keepAwake", but only the Keep Awake page gets KeepingYouAwake's state`);

    // Resources
    const headEnd = html.indexOf("</head>");
    const scripts = tags.filter((t) => t.name === "script");
    const sdpi = scripts.find((t) => t.attrs.src === "./vendor/sdpi-components.js");
    if (!sdpi || sdpi.index > headEnd) problems.push(`${where}: must load ./vendor/sdpi-components.js in <head>`);
    if (!tags.some((t) => t.name === "link" && t.attrs.rel === "stylesheet" && t.attrs.href === "./pi.css")) problems.push(`${where}: must load ./pi.css`);
    const lastTag = tags[tags.length - 1];
    if (lastTag?.name !== "script" || lastTag.attrs.src !== "./pi.js" || html.indexOf("</body>") < lastTag.index) problems.push(`${where}: ./pi.js must be the last element in <body>`);
    for (const t of tags) {
      for (const attr of ["src", "href", "srcset", "action", "poster", "data"]) {
        const v = t.attrs[attr];
        if (v === undefined || t.name === "option") continue;
        if (REMOTE_RE.test(v)) problems.push(`${where}: <${t.name} ${attr}="${v}"> is not a local resource`);
        else if (["script", "link", "img", "iframe", "source"].includes(t.name) && !fs.existsSync(path.join(ui, v.split(/[?#]/)[0]!))) problems.push(`${where}: <${t.name} ${attr}="${v}"> does not exist`);
      }
      if (t.name === "iframe" || t.name === "object" || t.name === "embed") problems.push(`${where}: <${t.name}> is not allowed`);
      if (t.name === "script" && !t.attrs.src) problems.push(`${where}: inline <script> (keep behaviour in ./pi.js)`);
      if (t.attrs.style) for (const r of remoteRefs(t.attrs.style)) problems.push(`${where}: style loads ${r}`);
    }
    for (const m2 of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) for (const r of remoteRefs(m2[1]!)) problems.push(`${where}: <style> loads ${r}`);

    // No secrets anywhere: live usage runs on Claude Code's own sign-in.
    for (const t of tags) {
      if (t.name === "sdpi-password" || (t.name === "input" && t.attrs.type?.toLowerCase() === "password")) {
        problems.push(`${where}: <${t.name}${t.attrs.id ? ` id="${t.attrs.id}"` : ""}> is a password field — no page takes a password or token (live usage uses Claude Code's own sign-in)`);
      }
    }
    // The live-usage section: on the Usage page only (the one the plugin sends live usage to), complete there.
    const liveTags = tags.filter((t) => t.attrs["data-live-usage"] !== undefined || (LIVE_USAGE_IDS as readonly string[]).includes(t.attrs.id ?? ""));
    if (a.id !== "usage" && liveTags.length) problems.push(`${where}: has live-usage elements, but only the Usage page gets live usage`);
    if (a.id === "usage") {
      if (!tags.some((t) => t.attrs["data-live-usage"] !== undefined)) problems.push(`${where}: no live-usage section ([data-live-usage])`);
      for (const id of LIVE_USAGE_IDS) if (!tags.some((t) => t.attrs.id === id)) problems.push(`${where}: the live-usage section needs #${id}`);
      const login = tags.find((t) => t.attrs.id === "cc-login");
      if (login && login.attrs.hidden === undefined) problems.push(`${where}: #cc-login should start hidden (the sign-in command shows only while Claude Code is signed out)`);
    }

    // Settings
    const settingTags = tags.filter((t) => t.attrs.setting !== undefined);
    const keys = [...new Set(settingTags.map((t) => t.attrs.setting!))].sort();
    const src = actionSource(root, a.id);
    const reads = src ? settingsRead(src, normalisers) : [];
    if (!src) problems.push(`src/actions/${a.id}.ts: missing (can't check which settings the action reads)`);
    for (const t of settingTags) {
      const k = t.attrs.setting!;
      if (!k) problems.push(`${where}: <${t.name}> has an empty setting=""`);
      else if (src && !reads.includes(k)) problems.push(`${where}: setting "${k}" is not read by src/actions/${a.id}.ts (reads: ${reads.join(", ") || "nothing"})`);
      if (t.attrs.global !== undefined) problems.push(`${where}: setting "${k}" must not be global`);
    }
    for (const k of keys) {
      const n = settingTags.filter((t) => t.attrs.setting === k).length;
      if (n > 1) problems.push(`${where}: setting "${k}" is bound by ${n} elements (use data-copy-to for pickers)`);
    }

    // References
    const hasSetting = (k: string) => keys.includes(k);
    for (const t of tags) {
      const showIf = t.attrs["data-show-if"];
      if (showIf !== undefined) {
        const mm = /^([\w.-]+)(!?=)(.*)$/.exec(showIf);
        if (!mm) problems.push(`${where}: data-show-if="${showIf}" is not "setting=a|b" / "setting!=a"`);
        else if (!hasSetting(mm[1]!)) problems.push(`${where}: data-show-if refers to "${mm[1]}", which this page doesn't set`);
        else {
          const allowed = enums[mm[1]!]?.values;
          for (const v of mm[3]!.split("|")) if (allowed && !allowed.includes(v)) problems.push(`${where}: data-show-if value "${v}" is not a ${mm[1]} value`);
        }
      }
      const arrayOf = t.attrs["data-array-of"];
      if (arrayOf !== undefined) {
        if (t.attrs.setting === undefined) problems.push(`${where}: a data-array-of element needs its own setting (the array)`);
        for (const ref of arrayOf.split(",").map((x) => x.trim())) if (!hasSetting(ref)) problems.push(`${where}: data-array-of lists "${ref}", which this page doesn't set`);
      }
      for (const attr of ["data-copy-to", "data-list-for"]) {
        const ref = t.attrs[attr];
        if (ref === undefined) continue;
        if (!hasSetting(ref)) problems.push(`${where}: ${attr}="${ref}" has no setting="${ref}" field on this page`);
        if (t.attrs.setting !== undefined) problems.push(`${where}: an ${attr} element must not have its own setting`);
      }
      const ctl = t.attrs["data-controller"];
      if (ctl !== undefined) for (const c of ctl.split("|")) if (!a.controllers.includes(c as never)) problems.push(`${where}: data-controller "${c}" is not a controller of ${a.id}`);
    }
    const datasources = [...new Set(tags.map((t) => t.attrs.datasource).filter((d): d is string => d !== undefined))];
    for (const d of datasources) {
      if (!(PI_EVENTS as readonly string[]).includes(d)) problems.push(`${where}: datasource "${d}" is not a PI event (src/pi-core.ts PI_EVENTS)`);
    }
    if (tags.some((t) => t.attrs["data-chats"] !== undefined)) datasources.push("getChats");

    // Fixed option lists
    for (const [k, e] of Object.entries(enums)) {
      const t = settingTags.find((x) => x.attrs.setting === k);
      if (!t) continue;
      const opts = optionsOf(html, tags, t.name, "setting", k);
      if (!opts || !opts.length) continue;
      const missing = e.values.filter((v) => !opts.includes(v));
      const extra = opts.filter((v) => !e.values.includes(v));
      if (missing.length || extra.length) problems.push(`${where}: options for "${k}" should be ${e.values.join(", ")}${missing.length ? ` (missing ${missing.join(", ")})` : ""}${extra.length ? ` (unknown ${extra.join(", ")})` : ""}`);
      if (e.default !== undefined && t.attrs.default !== e.default) problems.push(`${where}: "${k}" should default to "${e.default}" (as the action does)`);
    }
    const cycle = tags.find((t) => t.attrs["data-list-for"] === "cycle");
    if (cycle) {
      const opts = optionsOf(html, tags, cycle.name, "data-list-for", "cycle") ?? [];
      const levels = Object.keys(EFFORT_LABEL);
      if (opts.join() !== levels.join()) problems.push(`${where}: the effort cycle list should offer ${levels.join(", ")} in that order`);
      // Unsaved = every level (incl. Ultra) — what the key steps through without a cycle of its own.
      const field = settingTags.find((x) => x.attrs.setting === "cycle");
      if ((parseCycle(field?.attrs.default) ?? []).join() !== DEFAULT_EFFORT_CYCLE.join())
        problems.push(`${where}: the cycle field should default to "${DEFAULT_EFFORT_CYCLE.join(", ")}" (the key's default cycle)`);
    }

    // Model slots: slot1…slotN dropdowns of getModelSlots, defaulting to what the key assumes for an unsaved slot.
    const slotTags = settingTags.filter((t) => /^slot\d+$/.test(t.attrs.setting!));
    if (slotTags.length) {
      const want = Array.from({ length: MODEL_SLOT_COUNT }, (_, i) => `slot${i + 1}`);
      const have = slotTags.map((t) => t.attrs.setting!);
      if (have.join() !== want.join()) problems.push(`${where}: Model slots should be ${want.join(", ")} in that order (has ${have.join(", ")})`);
      for (const t of slotTags) {
        const n = Number(t.attrs.setting!.slice(4));
        if (t.attrs.datasource !== "getModelSlots") problems.push(`${where}: ${t.attrs.setting} should use datasource="getModelSlots"`);
        if (t.attrs.default !== slotDefault(n)) problems.push(`${where}: ${t.attrs.setting} should default to "${slotDefault(n)}" (as the key does)`);
      }
      const arr = tags.find((t) => t.attrs["data-array-of"] !== undefined);
      if (arr?.attrs["data-array-of"]?.split(",").map((x) => x.trim()).join() !== want.join()) problems.push(`${where}: the slots array field should list ${want.join(",")} (data-array-of)`);
    }
    const position = settingTags.find((t) => t.attrs.setting === "position");
    if (position) {
      const opts = optionsOf(html, tags, position.name, "setting", "position") ?? [];
      const want = ["0", ...Array.from({ length: 12 }, (_, i) => String(i + 1))];
      if (opts.join() !== want.join()) problems.push(`${where}: Position should offer Auto (0) and 1…12`);
      if (position.attrs["value-type"] !== "number") problems.push(`${where}: Position should be stored as a number (value-type="number")`);
    }

    pages.push({ id: a.id, file: rel, settings: keys, reads, datasources });
  }

  // Every datasource the pages use is answered by the plugin.
  for (const d of new Set(pages.flatMap((p) => p.datasources))) {
    if (!piSource.includes(`"${d}"`) && !fs.readFileSync(path.join(root, "src", "pi-core.ts"), "utf8").includes(`"${d}"`)) problems.push(`src/pi.ts: doesn't answer "${d}"`);
  }

  // Shared files
  for (const f of ["pi.js", "pi.css"]) {
    const p = path.join(ui, f);
    if (!fs.existsSync(p)) {
      problems.push(`ui/${f}: missing`);
      continue;
    }
    const text = fs.readFileSync(p, "utf8");
    for (const r of remoteRefs(text)) problems.push(`ui/${f}: refers to ${r}`);
    if (f === "pi.js") {
      for (const api of ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "navigator.sendBeacon", "import(", "importScripts", "innerHTML", "outerHTML", "insertAdjacentHTML", "eval(", "new Function"]) {
        if (text.includes(api)) problems.push(`ui/pi.js: uses ${api} (pages talk to the plugin only through SDPIComponents.streamDeckClient)`);
      }
      for (const api of ["setSettings", "setGlobalSettings", "localStorage", "sessionStorage", "indexedDB"]) {
        if (text.includes(api)) problems.push(`ui/pi.js: uses ${api} (settings are saved by sdpi-components' bound fields only)`);
      }
      const handled: readonly string[] = PI_EVENTS;
      for (const e of sentEvents(text)) if (!handled.includes(e)) problems.push(`ui/pi.js: sends "${e}", which the plugin doesn't handle (src/pi-core.ts PI_EVENTS)`);
    }
  }

  // Vendored sdpi-components: hash recorded in vendor/README.md
  const vendor = path.join(ui, "vendor", "sdpi-components.js");
  const readme = path.join(ui, "vendor", "README.md");
  if (!fs.existsSync(vendor)) problems.push("ui/vendor/sdpi-components.js: missing");
  else {
    const sha = crypto.createHash("sha256").update(fs.readFileSync(vendor)).digest("hex");
    const recorded = fs.existsSync(readme) ? (/`([0-9a-f]{64})`/.exec(fs.readFileSync(readme, "utf8"))?.[1] ?? "") : "";
    if (sha !== recorded) problems.push(`ui/vendor/sdpi-components.js: SHA-256 ${sha} doesn't match ui/vendor/README.md (${recorded || "no hash"})`);
  }

  return { pages, problems };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  const { pages, problems } = checkPi();
  const w = Math.max(...pages.map((p) => p.id.length));
  for (const p of pages) {
    const extra = p.datasources.length ? `   datasources: ${p.datasources.join(", ")}` : "";
    console.log(`${p.id.padEnd(w)}  ${p.settings.length ? p.settings.join(", ") : "(no settings)"}${extra}`);
  }
  if (problems.length) {
    console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exitCode = 1;
  } else {
    console.log(`\ncheck-pi: ${pages.length} pages OK — settings match the actions, only local resources, sdpi-components hash verified.`);
  }
}
