// Windows: the UI Automation program (uia-win.ts) as an executable. It is built on first use with what every Windows
// 10/11 has — Windows PowerShell and the .NET Framework's C# compiler — into a folder named after the program's own
// hash, so a new plugin version builds its own copy and an unchanged one is reused:
//   %LOCALAPPDATA%\claude-code-deck\uia\<hash>\claude-deck-uia.exe   (+ Interop.UIAutomationClient.dll)
// Nothing is downloaded; the source that is compiled is the one in this plugin.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILD_PS_SOURCE, UIA_CS_SOURCE } from "./uia-win.ts";

export const HELPER_EXE = "claude-deck-uia.exe";

export const helperHash = (): string => createHash("sha256").update(UIA_CS_SOURCE).update("\0").update(BUILD_PS_SOURCE).digest("hex").slice(0, 16);

/** Where the built program lives (CLAUDE_CODE_DECK_WIN_HELPER_DIR overrides the base folder, for tests). */
export function helperDir(): string {
  const base =
    process.env.CLAUDE_CODE_DECK_WIN_HELPER_DIR ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "claude-code-deck", "uia");
  return path.join(base, helperHash());
}

export const helperExe = (): string => path.join(helperDir(), HELPER_EXE);

const BUILD_TIMEOUT_MS = 120_000;

let building: Promise<string> | undefined;

/** The built program's path; builds it first when it isn't there yet (one build at a time). Rejects when it can't. */
export function ensureHelper(): Promise<string> {
  const exe = helperExe();
  if (fs.existsSync(exe)) return Promise.resolve(exe);
  if (building) return building;
  const p = new Promise<string>((resolve, reject) => {
    const dir = helperDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "claude-deck-uia.cs"), UIA_CS_SOURCE, "utf8");
      fs.writeFileSync(path.join(dir, "build.ps1"), BUILD_PS_SOURCE, "utf8");
    } catch (err) {
      reject(new Error(`Couldn't prepare the Windows helper: ${(err as Error).message}`));
      return;
    }
    const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    execFile(
      fs.existsSync(ps) ? ps : "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "build.ps1"), "-Out", dir],
      { timeout: BUILD_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (fs.existsSync(exe)) resolve(exe);
        else reject(new Error(`Couldn't build the Windows helper: ${String(stderr || err?.message || "no output").trim().split("\n").slice(-3).join(" ")}`));
      },
    );
  });
  building = p;
  const done = () => {
    if (building === p) building = undefined;
  };
  p.then(done, done);
  return p;
}
