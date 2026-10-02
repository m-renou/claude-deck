// Property Inspector data, without Stream Deck: what the PI pages (ui/*.html + ui/pi.js) are sent.
// src/pi.ts wires these to the SDK; tests drive them with plain snapshots.
//
// PI → plugin (sendToPlugin payloads):
//   { event: "getChats" | "getSkills" | "getModels" | "getModelSlots" | "getFolders", isRefresh? }   sdpi datasources
//   { event: "getStatus" }
// plugin → PI (sendToPropertyInspector payloads):
//   { event: <same>, items: Array<DataItem | DataGroup> }   (the sdpi datasource reply; extra fields are ignored by sdpi)
//   { event: "status", ... }                              (PiStatus below)

import type { StampedResult } from "./actions/core.ts";
import { NO_MODEL } from "./actions/settings.ts";
import type { Skill } from "./claude/extras.ts";
import { icon } from "./render/icons.ts";
import { STATUS_STYLE } from "./render/keys.ts";
import { dataUri, relTime, svg } from "./render/kit.ts";
import type { Chat, ChatStatus, ModelInfo, Snapshot } from "./types.ts";

export const PI_EVENTS = ["getChats", "getSkills", "getModels", "getModelSlots", "getFolders", "getStatus"] as const;
export type PiEvent = (typeof PI_EVENTS)[number];

/** sdpi-components datasource item / group. */
export interface DataItem {
  value: string;
  label?: string;
  disabled?: boolean;
}
export interface DataGroup {
  label?: string;
  children: DataItem[];
}

/** The exact fix for missing Accessibility permission (shown on every page while it's missing). */
export const ACCESS_FIX = "System Settings → Privacy & Security → Accessibility → enable Elgato Stream Deck";

/** Status words, as the ChatGPT & Codex plugin names them. */
export const STATUS_LABEL: Record<ChatStatus, string> = {
  working: "Working",
  waiting: "Waiting for input",
  done: "Ready",
  idle: "Idle",
};

/** Positions an Activity key can pin (same range as the PI's Position select). */
export const MAX_POSITION = 12;

/** A PI message the plugin answers; undefined for anything else. */
export function piRequest(payload: unknown): { event: PiEvent; isRefresh: boolean } | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const p = payload as { event?: unknown; isRefresh?: unknown };
  if (typeof p.event !== "string" || !(PI_EVENTS as readonly string[]).includes(p.event)) return undefined;
  return { event: p.event as PiEvent, isRefresh: p.isRefresh === true };
}

// ── Status icons (the keys' own icons, in their status colours) ────────────────────────────────────────────

const iconCache = new Map<ChatStatus, string>();

/** 24 × 24 data: URI of the status icon an Activity key shows (speech bubble / check / clock). */
export function statusIcon(status: ChatStatus): string {
  let uri = iconCache.get(status);
  if (!uri) {
    const st = STATUS_STYLE[status] ?? STATUS_STYLE.idle;
    uri = dataUri(svg(24, 24, icon(st.icon, { x: 1, y: 1, size: 22, color: st.color, strokeWidth: 2.2 })));
    iconCache.set(status, uri);
  }
  return uri;
}

// ── Datasources ─────────────────────────────────────────────────────────────────────────────────────────

export interface ChatItem extends DataItem {
  value: string;
  label: string;
  /** 1-based position (1 = most recent chat), the number an Activity key pins. */
  position: number;
  title: string;
  status: ChatStatus;
  statusLabel: string;
  /** "2m" (as on the key), or "" when the key shows the diff instead. */
  time: string;
  diff?: { added: number; removed: number };
  /** Open in the Claude app (the chat every other key acts on). */
  selected: boolean;
  /** Tile and icon colours of the key. */
  tile: string;
  color: string;
  icon: string;
}

/** The chats Activity keys follow, newest first, as the keys draw them (getChats). */
export function chatItems(snap: Snapshot, now: number, limit = MAX_POSITION): ChatItem[] {
  return snap.chats.slice(0, limit).map((c, i) => {
    const st = STATUS_STYLE[c.status] ?? STATUS_STYLE.idle;
    const diff = c.status === "done" && c.diff && (c.diff.added > 0 || c.diff.removed > 0) ? { added: c.diff.added, removed: c.diff.removed } : undefined;
    const position = i + 1;
    return {
      value: String(position),
      label: `${position}. ${c.title} — ${STATUS_LABEL[c.status] ?? c.status}`,
      position,
      title: c.title,
      status: c.status,
      statusLabel: STATUS_LABEL[c.status] ?? c.status,
      time: diff ? "" : relTime(now - (c.lastActivityAt || now)),
      ...(diff ? { diff } : {}),
      selected: !!snap.selected && snap.selected.id === c.id,
      tile: st.tile,
      color: st.color,
      icon: statusIcon(c.status),
    };
  });
}

const SKILL_GROUPS: Array<{ source: Skill["source"]; label: string }> = [
  { source: "project", label: "This chat's folder" },
  { source: "user", label: "Your skills" },
  { source: "built-in", label: "Built-in" },
];

/** Skills grouped by where they come from (getSkills). Values are names without "/". */
export function skillItems(skills: Skill[]): DataGroup[] {
  const out: DataGroup[] = [];
  for (const g of SKILL_GROUPS) {
    const children = skills
      .filter((s) => s.source === g.source)
      .map((s) => ({ value: s.name, label: s.label && s.label.toLowerCase() !== s.name.toLowerCase() ? `${s.label} (/${s.name})` : `/${s.name}` }));
    if (children.length) out.push({ label: g.label, children });
  }
  return out;
}

/** Models in the order of the app's model menu (getModels). */
export function modelItems(models: ModelInfo[]): DataItem[] {
  return models.map((m) => ({ value: m.id, label: m.name }));
}

/** A Model key slot's choices: "— none —" (an empty slot), then the app's models (getModelSlots). */
export function modelSlotItems(models: ModelInfo[]): DataItem[] {
  return [{ value: NO_MODEL, label: "— none —" }, ...modelItems(models)];
}

/** "/Users/me/code/app" → "~/code/app". */
export function shortPath(p: string, home: string): string {
  if (home && (p === home || p.startsWith(home.endsWith("/") ? home : `${home}/`))) return `~${p.slice(home.replace(/\/+$/, "").length)}`;
  return p;
}

/** Folders of recent chats, most recent first, without duplicates (getFolders). */
export function folderItems(chats: Chat[], home: string, limit = 15): DataItem[] {
  const seen = new Set<string>();
  const out: DataItem[] = [];
  for (const c of [...chats].sort((a, b) => b.lastActivityAt - a.lastActivityAt)) {
    const cwd = c.cwd?.trim();
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    out.push({ value: cwd, label: shortPath(cwd, home) });
    if (out.length >= limit) break;
  }
  return out.length ? out : [{ value: "", label: "No recent folders", disabled: true }];
}

// ── Status box ──────────────────────────────────────────────────────────────────────────────────────────

export interface PiStatus {
  event: "status";
  /** Catalog id of the action this PI belongs to. */
  action: string;
  controller?: string;
  app: { installed: boolean; running: boolean };
  /** macOS Accessibility for Stream Deck. */
  access: "granted" | "missing" | "unknown";
  /** This action types into the Claude app (so it needs Accessibility). */
  needsAccess: boolean;
  accessFix: string;
  /** The selected chat: the one every chat key acts on. */
  chat: { title: string; status: ChatStatus; statusLabel: string; detail?: string; icon: string } | null;
  /** The key's last result. */
  result: { ok: boolean; message: string; at: number } | null;
  /** Activity keys: the position this key follows (auto = key order). */
  follow?: { position: number; auto: boolean };
  /** Live-status problem worth knowing (e.g. `claude agents` failed). */
  note?: string;
}

export interface StatusInput {
  actionId: string;
  snap: Snapshot;
  needsAccess: boolean;
  result?: StampedResult;
  controller?: string;
  follow?: { position: number; auto: boolean };
}

export function statusPayload(i: StatusInput): PiStatus {
  const s = i.snap.selected;
  const out: PiStatus = {
    event: "status",
    action: i.actionId,
    app: { installed: i.snap.app.installed !== false, running: !!i.snap.app.running },
    access: i.snap.accessibility === true ? "granted" : i.snap.accessibility === false ? "missing" : "unknown",
    needsAccess: i.needsAccess,
    accessFix: ACCESS_FIX,
    chat: s
      ? {
          title: s.title,
          status: s.status,
          statusLabel: STATUS_LABEL[s.status] ?? s.status,
          ...(s.detail ? { detail: s.detail } : {}),
          icon: statusIcon(s.status),
        }
      : null,
    result: i.result ? { ok: i.result.ok, message: i.result.message, at: i.result.at } : null,
  };
  if (i.controller) out.controller = i.controller;
  if (i.follow) out.follow = { position: i.follow.position, auto: i.follow.auto };
  if (i.snap.error) out.note = i.snap.error;
  return out;
}
