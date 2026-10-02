// Live process status from `claude agents --json --all` — the documented way to read session state from
// outside Claude Code (https://code.claude.com/docs/en/agent-view#list-sessions-as-json). Desktop Code-tab
// chats are listed while their process runs: status busy | waiting | idle, waitingFor when waiting.

import { execFile } from "node:child_process";
import { findClaudeCli } from "./paths.ts";

export interface LiveSession {
  sessionId: string;
  status?: "busy" | "waiting" | "idle";
  waitingFor?: string;
  state?: string;
  pid?: number;
  name?: string;
}

export function parseAgents(stdout: string): LiveSession[] {
  const text = stdout.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = /^[ \t]*\[/m.exec(text);
    const end = text.lastIndexOf("]");
    if (!m || end < m.index) return [];
    try {
      parsed = JSON.parse(text.slice(m.index + m[0].length - 1, end + 1));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: LiveSession[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o.sessionId !== "string") continue;
    const status = o.status === "busy" || o.status === "waiting" || o.status === "idle" ? o.status : undefined;
    out.push({
      sessionId: o.sessionId,
      status,
      waitingFor: typeof o.waitingFor === "string" ? o.waitingFor : undefined,
      state: typeof o.state === "string" ? o.state : undefined,
      pid: typeof o.pid === "number" ? o.pid : undefined,
      name: typeof o.name === "string" ? o.name : undefined,
    });
  }
  return out;
}

export class LiveRoster {
  private cli: string | undefined;
  private inFlight = false;
  last = new Map<string, LiveSession>();
  lastOkAt = 0;
  error: string | undefined;

  constructor() {
    this.cli = findClaudeCli();
  }

  /** Poll once (never overlapping). Resolves with the latest map even when the CLI is missing. */
  poll(): Promise<Map<string, LiveSession>> {
    if (this.inFlight) return Promise.resolve(this.last);
    if (!this.cli) this.cli = findClaudeCli();
    if (!this.cli) {
      this.error = "Claude Code CLI not found (install the Claude desktop app).";
      return Promise.resolve(this.last);
    }
    this.inFlight = true;
    return new Promise((resolve) => {
      execFile(this.cli!, ["agents", "--json", "--all"], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        this.inFlight = false;
        if (err && !stdout) {
          this.error = `claude agents --json failed: ${err.message.split("\n")[0]}`;
          if ((err as NodeJS.ErrnoException).code === "ENOENT") this.cli = undefined; // app updated: re-resolve
          resolve(this.last);
          return;
        }
        this.error = undefined;
        this.lastOkAt = Date.now();
        this.last = new Map(parseAgents(stdout).map((s) => [s.sessionId, s]));
        resolve(this.last);
      });
    });
  }
}
