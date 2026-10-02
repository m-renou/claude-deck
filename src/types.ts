// Shared types for the Claude Code Stream Deck plugin.

/** Chat status as shown on keys (same four states as the ChatGPT & Codex plugin). */
export type ChatStatus =
  | "working" // a turn is running
  | "waiting" // Claude needs you: permission prompt, question, or the turn ended blocked on you
  | "done" // finished a turn you haven't looked at yet
  | "idle"; // nothing new

export interface Chat {
  /** Desktop app session id ("local_…"), used in claude://code/continue?session=… */
  id: string;
  /** Claude Code session id (transcript file name, `claude agents --json` sessionId). */
  cliSessionId?: string;
  title: string;
  cwd?: string;
  status: ChatStatus;
  /** One-line detail from the app's own turn summary, when it wrote one. */
  detail?: string;
  /** Last activity (ms epoch). */
  lastActivityAt: number;
  lastFocusedAt: number;
  /** Process is running (listed by `claude agents --json`). */
  live: boolean;
  model?: string;
  effort?: string;
  ultracode?: boolean;
  fast?: boolean;
  permissionMode?: string;
  /** Lines added / removed in the chat's working tree (git), for finished chats. */
  diff?: { added: number; removed: number };
  /** model / effort / ultracode above are an optimistic value from a key press the session file hasn't confirmed yet. */
  pending?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string; // "Opus 5.5"
  shortName: string; // "Opus"
  efforts: string[]; // ["low","medium","high","xhigh","max"] — empty when the model has no effort setting
  fast: boolean;
}

export interface Usage {
  /** What is shown: "weekly" / "5-hour" plan limits (the newest sample: live from Claude Code, or what the app
   * recorded), the selected chat's context window, or "none" (no data for the requested view — line1 says why). */
  kind: "weekly" | "5-hour" | "context" | "none";
  /** The view that was asked for (label a "none" result with it: "Weekly" + "No usage recorded yet"). */
  view?: "weekly" | "5-hour" | "context";
  percent?: number;
  /** Secondary line, e.g. "420k / 1M", "resets 22:40" or "as of 12:39". */
  line1?: string;
  line2?: string;
  updatedAt?: number;
  /** Plan views: where the numbers come from ("live" = live usage, "app" = the desktop app's file). */
  source?: "live" | "app";
}

export interface Snapshot {
  chats: Chat[];
  /** The chat keys act on: the one open in the Claude app (most recently focused), or the last one opened from the deck. */
  selected?: Chat;
  models: ModelInfo[];
  usage: Usage;
  /** Claude desktop app installed / running. */
  app: { installed: boolean; running: boolean };
  /** macOS Accessibility granted to Stream Deck (needed for keys that type into the app). undefined = not checked yet. */
  accessibility?: boolean;
  /** Error text for the PI / logs (never shown as a crash). */
  error?: string;
}

export type ActionResult = { ok: boolean; message: string; feedback?: "ok" | "alert" };
