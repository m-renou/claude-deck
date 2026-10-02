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

const isExecutable = (p: string): boolean => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The CLI copies the desktop app bundles, newest version first. Two layouts:
 *   <appSupport>/claude-code/<version>/claude.app/Contents/MacOS/claude            (older apps)
 *   <appSupport>/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude     (2.1.28x: one folder per build)
 * Within a version the plain layout comes first, then the build folders, most recently written first. Only executables
 * that exist are listed (a half-downloaded build has none).
 */
export function bundledClaudeClis(appDir = appSupportDir(), platform: NodeJS.Platform = process.platform): string[] {
  const bundled = path.join(appDir, "claude-code");
  const exe = (dir: string) => (platform === "win32" ? path.join(dir, "claude.exe") : path.join(dir, "claude.app", "Contents", "MacOS", "claude"));
  const subdirs = (dir: string): string[] => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.endsWith(".app"))
        .map((e) => {
          const p = path.join(dir, e.name);
          let mtime = 0;
          try {
            mtime = fs.statSync(p).mtimeMs;
          } catch {
            // gone meanwhile
          }
          return { p, name: e.name, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
        .map((e) => e.p);
    } catch {
      return [];
    }
  };
  let versions: string[];
  try {
    versions = fs.readdirSync(bundled).filter((v) => /^\d+\.\d+/.test(v)).sort((a, b) => compareVersions(b, a));
  } catch {
    return []; // no desktop bundle
  }
  const out: string[] = [];
  for (const v of versions) {
    const dir = path.join(bundled, v);
    for (const c of [exe(dir), ...subdirs(dir).map(exe)]) if (isExecutable(c)) out.push(c);
  }
  return out;
}

/** The Claude Code CLI: PATH-independent. Prefers the copy the desktop app bundles (newest version). */
export function findClaudeCli(): string | undefined {
  const own = [path.join(home(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  return [...bundledClaudeClis(), ...own].find(isExecutable);
}

export const CLAUDE_BUNDLE_ID = "com.anthropic.claudefordesktop";
export const CLAUDE_APP_PATH = "/Applications/Claude.app";
