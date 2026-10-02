// Read the Claude desktop app's Code-tab chats from its local session files (read-only).
// Each chat is <appSupport>/claude-code-sessions/<account>/<org>/local_<uuid>.json with fields such as
// title, cliSessionId, cwd, model, effort, sessionSettings.ultracode, permissionMode, lastActivityAt,
// lastFocusedAt, isArchived and postTurnSummary {status_category, status_detail, needs_action}.
// These files are the app's internal state (not a documented API), so every field is optional here and a
// file that doesn't parse is skipped.

import fs from "node:fs";
import path from "node:path";
import { desktopSessionsDir } from "./paths.ts";

export interface DesktopChat {
  id: string;
  cliSessionId?: string;
  title: string;
  cwd?: string;
  model?: string;
  effort?: string;
  ultracode?: boolean;
  fast?: boolean;
  permissionMode?: string;
  createdAt: number;
  lastActivityAt: number;
  lastFocusedAt: number;
  latestUserFrameAt: number;
  completedTurns: number;
  archived: boolean;
  summary?: { category?: string; detail?: string; needsAction?: string };
  file: string;
  mtimeMs: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export function parseDesktopChat(raw: unknown, file: string, mtimeMs: number): DesktopChat | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  const id = str(d.sessionId);
  if (!id || !/^local_[\w-]+$/.test(id)) return undefined;
  const settings = (d.sessionSettings ?? {}) as Record<string, unknown>;
  const pts = (d.postTurnSummary ?? undefined) as Record<string, unknown> | undefined;
  const fastRaw = d.fastMode ?? settings.fastMode;
  return {
    id,
    cliSessionId: str(d.cliSessionId),
    title: str(d.title) ?? "New session",
    cwd: str(d.cwd),
    model: str(d.model),
    effort: str(d.effort),
    ultracode: settings.ultracode === true,
    fast: typeof fastRaw === "boolean" ? fastRaw : typeof fastRaw === "object" && fastRaw ? (fastRaw as { state?: unknown }).state === "on" : undefined,
    permissionMode: str(d.permissionMode),
    createdAt: num(d.createdAt),
    lastActivityAt: num(d.lastActivityAt) || num(d.createdAt) || mtimeMs,
    lastFocusedAt: num(d.lastFocusedAt),
    latestUserFrameAt: num(d.latestUserFrameAt),
    completedTurns: num(d.completedTurns),
    archived: d.isArchived === true,
    summary: pts ? { category: str(pts.status_category), detail: str(pts.status_detail), needsAction: str(pts.needs_action) } : undefined,
    file,
    mtimeMs,
  };
}

/** Scans the session files, re-parsing only files whose mtime/size changed. */
export class DesktopStore {
  private cache = new Map<string, { mtimeMs: number; size: number; chat?: DesktopChat }>();
  private root: string;

  constructor(root = desktopSessionsDir()) {
    this.root = root;
  }

  private files(): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.isFile() && /^local_[\w-]+\.json$/.test(e.name)) out.push(p);
      }
    };
    walk(this.root, 0);
    return out;
  }

  /** All non-archived chats, newest activity first. */
  read(): DesktopChat[] {
    const seen = new Set<string>();
    const chats: DesktopChat[] = [];
    for (const file of this.files()) {
      seen.add(file);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const c = this.cache.get(file);
      let chat = c?.chat;
      if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
        try {
          chat = parseDesktopChat(JSON.parse(fs.readFileSync(file, "utf8")), file, st.mtimeMs);
        } catch {
          chat = c?.chat; // partial write: keep the last good parse
        }
        this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, chat });
      }
      if (chat && !chat.archived) chats.push(chat);
    }
    for (const k of [...this.cache.keys()]) if (!seen.has(k)) this.cache.delete(k);
    return chats.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /** Re-read one chat right now (used to confirm a change landed). */
  readOne(id: string): DesktopChat | undefined {
    for (const file of this.files()) {
      if (!file.endsWith(`${id}.json`)) continue;
      try {
        const st = fs.statSync(file);
        return parseDesktopChat(JSON.parse(fs.readFileSync(file, "utf8")), file, st.mtimeMs);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
