// Where the Claude desktop app keeps its bundled Claude Code CLI: both layouts (<version>/claude.app and, since
// 2.1.28x, <version>/<build hash>/claude.app), newest version first, only executables that exist. A private temp dir.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { bundledClaudeClis, compareVersions, winAppSupportDir } from "../src/claude/paths.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-paths-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** A fresh app-support dir with the given CLI files (relative to claude-code/); `mode` 0o644 = not executable. */
function appDir(files: Array<{ rel: string; mode?: number; mtime?: number }>, dirs: string[] = []): string {
  const root = path.join(tmp, `app-${++n}`);
  for (const d of dirs) fs.mkdirSync(path.join(root, "claude-code", d), { recursive: true });
  for (const f of files) {
    const p = path.join(root, "claude-code", f.rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "#!/bin/sh\n");
    fs.chmodSync(p, f.mode ?? 0o755);
  }
  // Build folders' times (set last: writing inside a folder changes its mtime).
  for (const f of files) {
    if (f.mtime === undefined) continue;
    const dir = path.join(root, "claude-code", f.rel.split("/").slice(0, 2).join("/"));
    fs.utimesSync(dir, new Date(f.mtime), new Date(f.mtime));
  }
  return root;
}

const MAC = "claude.app/Contents/MacOS/claude";
const cli = (root: string, rel: string) => path.join(root, "claude-code", rel);

describe("bundledClaudeClis", () => {
  it("finds the per-build layout (<version>/<hash>/claude.app), newest version first", () => {
    const root = appDir([{ rel: `2.1.284/4819fdb9b264/${MAC}` }, { rel: `2.1.286/f2326db61802/${MAC}` }]);
    fs.writeFileSync(path.join(root, "claude-code", "2.1.286", "f2326db61802", ".verified"), "x");
    assert.deepEqual(bundledClaudeClis(root, "darwin"), [cli(root, `2.1.286/f2326db61802/${MAC}`), cli(root, `2.1.284/4819fdb9b264/${MAC}`)]);
  });

  it("still finds the older layout (<version>/claude.app), and mixes both by version", () => {
    const root = appDir([{ rel: `1.0.9/${MAC}` }, { rel: `1.0.10/${MAC}` }, { rel: `2.1.286/f2326db61802/${MAC}` }]);
    assert.deepEqual(bundledClaudeClis(root, "darwin"), [cli(root, `2.1.286/f2326db61802/${MAC}`), cli(root, `1.0.10/${MAC}`), cli(root, `1.0.9/${MAC}`)]);
  });

  it("skips builds without an executable; several builds of one version: most recent first", () => {
    const root = appDir(
      [
        { rel: `2.1.286/aaaa/${MAC}`, mtime: Date.UTC(2026, 8, 1) },
        { rel: `2.1.286/bbbb/${MAC}`, mtime: Date.UTC(2026, 9, 1) },
        // Not executable (Windows has no mode bits: there every file counts, so this one only exists elsewhere).
        ...(process.platform === "win32" ? [] : [{ rel: `2.1.286/cccc/${MAC}`, mode: 0o644 }]),
      ],
      ["2.1.286/dddd", "2.1.287/half-downloaded", "not-a-version/x"],
    );
    assert.deepEqual(bundledClaudeClis(root, "darwin"), [cli(root, `2.1.286/bbbb/${MAC}`), cli(root, `2.1.286/aaaa/${MAC}`)]);
  });

  it("Windows: claude.exe in either layout", () => {
    const root = appDir([{ rel: "2.1.286/f2326db61802/claude.exe" }, { rel: "2.1.200/claude.exe" }]);
    assert.deepEqual(bundledClaudeClis(root, "win32"), [cli(root, "2.1.286/f2326db61802/claude.exe"), cli(root, "2.1.200/claude.exe")]);
  });

  it("nothing when the app bundles no CLI", () => {
    assert.deepEqual(bundledClaudeClis(path.join(tmp, "missing"), "darwin"), []);
    assert.deepEqual(bundledClaudeClis(appDir([], [""]), "darwin"), []);
  });

  it("compares versions numerically", () => {
    assert.ok(compareVersions("2.1.286", "2.1.284") > 0);
    assert.ok(compareVersions("1.0.10", "1.0.9") > 0);
    assert.equal(compareVersions("2.1", "2.1.0"), 0);
  });
});

describe("winAppSupportDir (Windows)", () => {
  const HOME = String.raw`C:\Users\me`;
  const ROAMING = String.raw`C:\Users\me\AppData\Roaming\Claude`;
  const env = { APPDATA: String.raw`C:\Users\me\AppData\Roaming`, LOCALAPPDATA: path.join(tmp, "local") };

  it("%APPDATA%\\Claude when it holds the Code-tab chats (installer and Microsoft Store builds alike)", () => {
    assert.equal(winAppSupportDir(env, HOME, (p) => p === String.raw`${ROAMING}\claude-code-sessions`), ROAMING);
  });

  it("an MSIX package's private copy when only that one has them", { skip: process.platform !== "win32" && "reads a Windows folder" }, () => {
    const pkg = path.join(env.LOCALAPPDATA, "Packages", "Claude_pzs8sxrjxfjjc");
    fs.mkdirSync(pkg, { recursive: true });
    fs.mkdirSync(path.join(env.LOCALAPPDATA, "Packages", "Other_123"), { recursive: true });
    const want = path.win32.join(env.LOCALAPPDATA, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude");
    assert.equal(winAppSupportDir(env, HOME, (p) => p === path.win32.join(want, "claude-code-sessions")), want);
  });

  it("%APPDATA%\\Claude when neither exists yet (a fresh install)", () => {
    assert.equal(winAppSupportDir(env, HOME, () => false), ROAMING);
    assert.equal(winAppSupportDir({}, HOME, () => false), ROAMING);
  });
});
