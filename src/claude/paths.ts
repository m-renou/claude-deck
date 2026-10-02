// Where the Claude desktop app and Claude Code keep their local state (macOS; Windows paths for later).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = (): string => os.homedir();

/** ~/Library/Application Support/Claude (desktop app data). */
export function appSupportDir(): string {
  if (process.env.CLAUDE_CODE_DECK_APP_DIR) return process.env.CLAUDE_CODE_DECK_APP_DIR;
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home(), "AppData", "Roaming"), "Claude");
  return path.join(home(), "Library", "Application Support", "Claude");
}

/** One JSON file per Code-tab chat: <appSupport>/claude-code-sessions/<account>/<org>/local_<uuid>.json */
export const desktopSessionsDir = (): string => path.join(appSupportDir(), "claude-code-sessions");

/** Claude Code's own config dir (~/.claude), transcripts live in projects/. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude");
}

export const modelCatalogDir = (): string => path.join(claudeConfigDir(), "cache", "model-catalog");

export const planUsageFile = (): string => path.join(appSupportDir(), "plan-usage-history.json");

export const skillsDir = (): string => path.join(claudeConfigDir(), "skills");

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** The Claude Code CLI: PATH-independent. Prefers the copy the desktop app bundles (newest version). */
export function findClaudeCli(): string | undefined {
  const candidates: string[] = [];
  const bundled = path.join(appSupportDir(), "claude-code");
  try {
    const versions = fs.readdirSync(bundled).filter((v) => /^\d+\.\d+/.test(v)).sort((a, b) => compareVersions(b, a));
    for (const v of versions) {
      candidates.push(
        process.platform === "win32" ? path.join(bundled, v, "claude.exe") : path.join(bundled, v, "claude.app", "Contents", "MacOS", "claude"),
      );
    }
  } catch {
    // no desktop bundle
  }
  candidates.push(
    path.join(home(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  );
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // next
    }
  }
  return undefined;
}

export const CLAUDE_BUNDLE_ID = "com.anthropic.claudefordesktop";
export const CLAUDE_APP_PATH = "/Applications/Claude.app";
