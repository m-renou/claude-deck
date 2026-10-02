// Generates the bundled Stream Deck profiles: com.local.claudecode.sdPlugin/profiles/<Name> (<DeviceType>).streamDeckProfile
// (gen-manifest.ts lists them in the manifest's `Profiles`, reading the DeviceType from the " (<n>)" suffix).
//   node scripts/gen-profiles.ts
//
// Format: the one Stream Deck 7.x writes when it exports a profile (Exporter::write_package_json), as found in the
// newest profiles Elgato ships inside the app (Contents/Resources/DefaultProfiles, e.g. GalleonPRO80SD, AppVersion
// 7.6.0.23022). The app's single importer (Importer::import_profiles) also reads it for plugin profiles:
//
//   package.json                                   {"AppVersion","DeviceModel","DeviceSettings":null,"FormatVersion":1,
//                                                   "OSType":"macOS","OSVersion","RequiredPlugins":[…]}
//   Profiles/<UMBRELLA>.sdProfile/manifest.json    {"Device":{"Model","UUID"},"Name","Pages":{"Current":0-uuid,
//                                                   "Default":<page>,"Pages":[<page>…]},"Version":"3.0"}
//   Profiles/<UMBRELLA>.sdProfile/Profiles/<PAGE>/manifest.json
//                                                  {"Controllers":[{"Actions":{"col,row":{…}}|null,"Type":"Keypad"|
//                                                   "Encoder"|"Neo"}],"Icon":"","Name":""}
//
// Folder names are upper-case UUIDs, the umbrella manifest refers to pages in lower case; "Default" is the (empty)
// template page for pages the user adds, "Pages" holds the one real page. JSON is compact with sorted keys, like
// the app's own writer. Every id (umbrella, pages, ActionID, device) is derived from a hash of the profile + slot, and
// the zip uses a fixed timestamp, so regenerating gives the same content.
//
// The zip writer / reader are tiny and pure Node (node:zlib deflateRaw + CRC-32); tests reuse them.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";
import { ACTIONS, PLUGIN_NAME, PLUGIN_UUID, actionUuid, type Controller } from "../src/catalog.ts";

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const PROFILES_DIR = path.resolve(here, `../${PLUGIN_UUID}.sdPlugin/profiles`);
export const PROFILE_EXT = ".streamDeckProfile";

/** Shown in Stream Deck's profile list (every device gets its own copy). */
export const PROFILE_NAME = PLUGIN_NAME;
/** Values the exporter writes into package.json (Stream Deck 7.6 on macOS, as installed here). */
export const APP_VERSION = "7.6.0.23012";
export const OS_VERSION = "26.6.2";
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// ───────────────────────────────────────────────────────────────────────────── layouts

/** One action placed on a key, dial or Neo infobar. `settings` are the action's per-key settings (src/actions/settings.ts). */
export interface Slot {
  action: string;
  settings?: Record<string, unknown>;
}

export interface DeviceLayout {
  /** File name without extension; ends with " (<DeviceType>)". */
  file: string;
  /** Manifest DeviceType: 0 Stream Deck, 1 Mini, 2 XL, 7 Stream Deck +, 9 Neo. */
  deviceType: number;
  /** Device model the profile was "exported" from (the app maps it onto the user's device of the same type). */
  model: string;
  cols: number;
  rows: number;
  /** keys[row][col]; null = empty key. */
  keys: (Slot | null)[][];
  /** Stream Deck + dials, left to right. */
  dials?: Slot[];
  /** Stream Deck Neo infobar. */
  infobar?: Slot;
}

export const REVIEW_PROMPT = "Review my changes and suggest improvements";
export const STEER_TEXT = "Focus on the failing test first";

const activity = (position: number): Slot => ({ action: "activity", settings: { position } });
const newChat: Slot = { action: "new-chat", settings: {} };
const dictate: Slot = { action: "dictate", settings: {} };
const sendPrompt = (prompt: string): Slot => ({ action: "send-prompt", settings: { prompt } });
const steer = (text: string): Slot => ({ action: "steer", settings: { text } });
const stop: Slot = { action: "stop", settings: {} };
const model: Slot = { action: "model", settings: { mode: "next" } };
const effort: Slot = { action: "effort", settings: { mode: "next" } };
const speed: Slot = { action: "speed", settings: {} };
const usage: Slot = { action: "usage", settings: { view: "auto" } };
const skill = (name: string): Slot => ({ action: "run-skill", settings: { skill: name } });
const panel = (id: string): Slot => ({ action: "toggle-panel", settings: { panel: id } });

/**
 * The bundled layouts. Stream Deck (15 keys) mirrors the Codex plugin's profile:
 *   Activity ×4 · Usage / New Chat · Dictate · Send Prompt · Steer · Stop / Model · Effort · Speed · Run Skill · Panel
 * The others are subsets / supersets of it. One Usage key per profile (each Usage key shows its own view; press cycles it).
 */
export const LAYOUTS: DeviceLayout[] = [
  {
    file: "Claude Code (0)",
    deviceType: 0,
    model: "20GBA9901", // Stream Deck MK.2
    cols: 5,
    rows: 3,
    keys: [
      [activity(1), activity(2), activity(3), activity(4), usage],
      [newChat, dictate, sendPrompt(REVIEW_PROMPT), steer(STEER_TEXT), stop],
      [model, effort, speed, skill("code-review"), panel("review")],
    ],
  },
  {
    file: "Claude Code Mini (1)",
    deviceType: 1,
    model: "20GAI9901", // Stream Deck Mini
    cols: 3,
    rows: 2,
    keys: [
      [activity(1), activity(2), usage],
      [newChat, dictate, stop],
    ],
  },
  {
    file: "Claude Code XL (2)",
    deviceType: 2,
    model: "20GAT9902", // Stream Deck XL
    cols: 8,
    rows: 4,
    keys: [
      [activity(1), activity(2), activity(3), activity(4), activity(5), activity(6), activity(7), activity(8)],
      [newChat, dictate, sendPrompt(REVIEW_PROMPT), steer(STEER_TEXT), stop, model, effort, speed],
      [
        skill("code-review"),
        skill("security-review"),
        skill("simplify"),
        panel("review"),
        panel("terminal"),
        panel("browser"),
        panel("files"),
        panel("sideChat"),
      ],
      [
        sendPrompt("Write tests for these changes"),
        sendPrompt("Explain what you changed and why"),
        steer("Keep the change small and focused"),
        null,
        null,
        null,
        null,
        usage,
      ],
    ],
  },
  {
    file: "Claude Code Plus (7)",
    deviceType: 7,
    model: "20GBD9901", // Stream Deck +
    cols: 4,
    rows: 2,
    keys: [
      [newChat, dictate, sendPrompt(REVIEW_PROMPT), stop],
      [steer(STEER_TEXT), speed, panel("review"), panel("terminal")],
    ],
    // Activity browses chats, Run Skill browses skills, Power replaces Model + Effort, Usage switches views.
    dials: [
      { action: "activity", settings: {} },
      { action: "run-skill", settings: {} },
      { action: "power", settings: {} },
      usage,
    ],
  },
  {
    file: "Claude Code Neo (9)",
    deviceType: 9,
    model: "20GBJ9901", // Stream Deck Neo
    cols: 4,
    rows: 2,
    keys: [
      [activity(1), activity(2), activity(3), activity(4)],
      [newChat, dictate, sendPrompt(REVIEW_PROMPT), stop],
    ],
    // The 15-key profile's top row: Activity ×4 on keys, Usage on the infobar.
    infobar: usage,
  },
];

/** Neo infobar coordinates (the app's own Neo profile keeps its infobar action in the "Neo" controller at 1,0). */
export const NEO_INFOBAR_COORD = "1,0";

// ───────────────────────────────────────────────────────────────────────────── profile JSON

/** Name-based (v5-style) UUID, lower case: same seed → same id. */
export function stableUuid(seed: string): string {
  const b = crypto.createHash("sha1").update(`${PLUGIN_UUID}:${seed}`).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Deep copy with object keys in byte order (the app's JSON writer sorts keys). */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

const json = (v: unknown): Uint8Array => Buffer.from(JSON.stringify(sortKeys(v)), "utf8");

/** Title state as the app writes it; titles stay hidden (the plugin draws every key). */
const STATE = {
  FontFamily: "",
  FontSize: 12,
  FontStyle: "",
  FontUnderline: false,
  OutlineThickness: 2,
  ShowTitle: false,
  TitleAlignment: "bottom",
  TitleColor: "#ffffff",
};

/** The plugin's manifest Version (from gen-manifest.ts, so a version bump reaches both files in one `npm run gen`). */
export function pluginVersion(): string {
  try {
    const src = fs.readFileSync(path.join(here, "gen-manifest.ts"), "utf8");
    return /\bVersion:\s*"(\d+\.\d+\.\d+\.\d+)"/.exec(src)?.[1] ?? "1.0.0.0";
  } catch {
    return "1.0.0.0";
  }
}

export function actionEntry(slot: Slot, controller: Controller, seed: string, version: string): Record<string, unknown> {
  const def = ACTIONS.find((a) => a.id === slot.action);
  if (!def) throw new Error(`${seed}: unknown action "${slot.action}"`);
  if (!def.controllers.includes(controller)) throw new Error(`${seed}: "${slot.action}" has no ${controller} controller`);
  return {
    ActionID: stableUuid(`action:${seed}`),
    LinkedTitle: true,
    Name: def.name,
    Plugin: { Name: PLUGIN_NAME, UUID: PLUGIN_UUID, Version: version },
    Resources: null,
    Settings: slot.settings ?? {},
    State: 0,
    States: [{ ...STATE }],
    UUID: actionUuid(def.id),
  };
}

export interface ZipEntry {
  /** Forward slashes; directories end with "/" and have no data. */
  name: string;
  data?: Uint8Array;
}

/** All entries of one .streamDeckProfile, in the exporter's order. */
export function buildProfile(layout: DeviceLayout, version = pluginVersion()): ZipEntry[] {
  if (!/ \(\d+\)$/.test(layout.file) || Number(/\((\d+)\)$/.exec(layout.file)![1]) !== layout.deviceType)
    throw new Error(`${layout.file}: file name must end with " (${layout.deviceType})"`);
  if (layout.keys.length !== layout.rows || layout.keys.some((r) => r.length !== layout.cols))
    throw new Error(`${layout.file}: keys must be ${layout.rows} rows of ${layout.cols}`);

  const id = (what: string) => stableUuid(`${layout.file}:${what}`);
  const umbrella = id("umbrella");
  const page = id("page");
  const defaultPage = id("default-page");

  const keypad: Record<string, unknown> = {};
  layout.keys.forEach((row, r) =>
    row.forEach((slot, c) => {
      if (slot) keypad[`${c},${r}`] = actionEntry(slot, "Keypad", `${layout.file}:key:${c},${r}`, version);
    }),
  );
  const controllers: { Actions: Record<string, unknown> | null; Type: string }[] = [{ Actions: keypad, Type: "Keypad" }];
  const emptyControllers: { Actions: null; Type: string }[] = [{ Actions: null, Type: "Keypad" }];
  if (layout.dials) {
    const enc: Record<string, unknown> = {};
    layout.dials.forEach((slot, c) => (enc[`${c},0`] = actionEntry(slot, "Encoder", `${layout.file}:dial:${c}`, version)));
    controllers.push({ Actions: enc, Type: "Encoder" });
    emptyControllers.push({ Actions: null, Type: "Encoder" });
  }
  if (layout.infobar) {
    const neo = { [NEO_INFOBAR_COORD]: actionEntry(layout.infobar, "Neo", `${layout.file}:infobar`, version) };
    controllers.push({ Actions: neo, Type: "Neo" });
    emptyControllers.push({ Actions: null, Type: "Neo" });
  }

  const pkg = {
    AppVersion: APP_VERSION,
    DeviceModel: layout.model,
    DeviceSettings: null,
    FormatVersion: 1,
    OSType: "macOS",
    OSVersion: OS_VERSION,
    RequiredPlugins: [PLUGIN_UUID],
  };
  const manifest = {
    Device: { Model: layout.model, UUID: id("device") },
    Name: PROFILE_NAME,
    Pages: { Current: ZERO_UUID, Default: defaultPage, Pages: [page] },
    Version: "3.0",
  };
  const root = `Profiles/${umbrella.toUpperCase()}.sdProfile/`;
  const pageEntries = (uuid: string, ctrls: unknown[]): ZipEntry[] => {
    const dir = `${root}Profiles/${uuid.toUpperCase()}/`;
    return [
      { name: dir },
      { name: `${dir}Images/` },
      { name: `${dir}manifest.json`, data: json({ Controllers: ctrls, Icon: "", Name: "" }) },
    ];
  };
  return [
    { name: "package.json", data: json(pkg) },
    { name: "Profiles/" },
    { name: root },
    { name: `${root}Images/` },
    { name: `${root}manifest.json`, data: json(manifest) },
    { name: `${root}Profiles/` },
    ...pageEntries(page, controllers),
    ...pageEntries(defaultPage, emptyControllers),
  ];
}

// ───────────────────────────────────────────────────────────────────────────── zip (store + deflate)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Fixed DOS timestamp (2026-01-01 00:00) so builds are reproducible. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const isDir = e.name.endsWith("/");
    if (isDir && e.data?.length) throw new Error(`zip: directory ${e.name} has data`);
    const raw = Buffer.from(e.data ?? new Uint8Array(0));
    const method = isDir ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const crc = crc32(raw);
    const flags = /[^\x20-\x7e]/.test(e.name) ? 0x0800 : 0; // UTF-8 names

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by: MS-DOS, 2.0 (as the app's exports)
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(isDir ? 0x10 : 0, 38); // external attributes: MS-DOS directory bit
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

/** Reads a zip written by `writeZip` (or any plain, unencrypted, non-zip64 zip); verifies every CRC. */
export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: no end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`zip: bad central header #${n}`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;

    if (buf.readUInt32LE(at) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : method === 0 ? Buffer.from(body) : undefined;
    if (!data) throw new Error(`zip: ${name}: unsupported method ${method}`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`zip: ${name}: size / CRC mismatch`);
    out.push(name.endsWith("/") ? { name } : { name, data });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────── read back

export interface ParsedProfile {
  pkg: Record<string, unknown>;
  umbrellaId: string;
  manifest: { Device: { Model: string; UUID: string }; Name: string; Pages: { Current: string; Default: string; Pages: string[] }; Version: string };
  /** Page manifests by lower-case page id. */
  pages: Map<string, { Controllers: { Actions: Record<string, Record<string, unknown>> | null; Type: string }[]; Icon: string; Name: string }>;
  names: string[];
}

/** Parses a .streamDeckProfile in the 7.x export format and checks its internal references. */
export function parseProfile(buf: Buffer): ParsedProfile {
  const entries = readZip(buf);
  const names = entries.map((e) => e.name);
  const file = (n: string) => {
    const e = entries.find((x) => x.name === n);
    if (!e?.data) throw new Error(`profile: missing ${n}`);
    return JSON.parse(Buffer.from(e.data).toString("utf8"));
  };
  const umbrellas = names.filter((n) => /^Profiles\/[0-9A-F-]{36}\.sdProfile\/manifest\.json$/.test(n));
  if (umbrellas.length !== 1) throw new Error(`profile: expected one umbrella manifest, found ${umbrellas.length}`);
  const umbrellaId = umbrellas[0]!.slice("Profiles/".length, "Profiles/".length + 36);
  const root = `Profiles/${umbrellaId}.sdProfile/`;
  const manifest = file(`${root}manifest.json`);
  const pages: ParsedProfile["pages"] = new Map();
  for (const pid of [manifest.Pages.Default, ...manifest.Pages.Pages] as string[]) {
    if (pid !== pid.toLowerCase()) throw new Error(`profile: page id ${pid} must be lower case in the manifest`);
    pages.set(pid, file(`${root}Profiles/${pid.toUpperCase()}/manifest.json`));
  }
  return { pkg: file("package.json"), umbrellaId, manifest, pages, names };
}

// ───────────────────────────────────────────────────────────────────────────── main

export function profilePath(layout: DeviceLayout): string {
  return path.join(PROFILES_DIR, `${layout.file}${PROFILE_EXT}`);
}

function main(): void {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const wanted = new Set(LAYOUTS.map((l) => `${l.file}${PROFILE_EXT}`));
  for (const f of fs.readdirSync(PROFILES_DIR)) {
    if (f.endsWith(PROFILE_EXT) && !wanted.has(f)) {
      fs.rmSync(path.join(PROFILES_DIR, f));
      console.log(`removed stale profiles/${f}`);
    }
  }
  const version = pluginVersion();
  for (const layout of LAYOUTS) {
    const zip = writeZip(buildProfile(layout, version));
    fs.writeFileSync(profilePath(layout), zip);
    // Read it back: zip structure, CRCs, JSON and page references.
    const parsed = parseProfile(fs.readFileSync(profilePath(layout)));
    const page = parsed.pages.get(parsed.manifest.Pages.Pages[0]!)!;
    const counts = page.Controllers.map((c) => `${Object.keys(c.Actions ?? {}).length} ${c.Type}`).join(", ");
    console.log(`wrote profiles/${layout.file}${PROFILE_EXT} (${zip.length} bytes; ${counts})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) main();
