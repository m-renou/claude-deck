// Small helpers: git diff stats for a chat's folder, and the skills a chat can run.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { skillsDir } from "./paths.ts";

const diffCache = new Map<string, { at: number; value?: { added: number; removed: number }; pending?: boolean }>();

export function parseShortstat(out: string): { added: number; removed: number } | undefined {
  const added = /(\d+) insertion/.exec(out)?.[1];
  const removed = /(\d+) deletion/.exec(out)?.[1];
  if (!added && !removed) return /files? changed/.test(out) ? { added: 0, removed: 0 } : undefined;
  return { added: Number(added ?? 0), removed: Number(removed ?? 0) };
}

/** Uncommitted +/− lines in `cwd` (cached 15 s, computed in the background, never blocks). */
export function diffStat(cwd: string | undefined, now = Date.now()): { added: number; removed: number } | undefined {
  if (!cwd) return undefined;
  const c = diffCache.get(cwd);
  if (c && (now - c.at < 15_000 || c.pending)) return c.value;
  diffCache.set(cwd, { at: now, value: c?.value, pending: true });
  execFile("git", ["-C", cwd, "diff", "--shortstat", "HEAD"], { timeout: 4000 }, (err, stdout) => {
    diffCache.set(cwd, { at: Date.now(), value: err ? undefined : parseShortstat(stdout) });
  });
  return c?.value;
}

export interface Skill {
  name: string; // without "/"
  label: string; // "Review Changes"
  description?: string;
  source: "user" | "project" | "built-in";
}

const titleCase = (s: string): string => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Built-in skills / commands that run in a desktop chat (non-interactive forms). */
export const BUILTIN_SKILLS: Skill[] = [
  { name: "code-review", label: "Review Changes", description: "Review the current diff for bugs", source: "built-in" },
  { name: "simplify", label: "Simplify", description: "Clean up the changed code", source: "built-in" },
  { name: "security-review", label: "Security Review", description: "Security review of the branch diff", source: "built-in" },
  { name: "init", label: "Write CLAUDE.md", description: "Generate a starter CLAUDE.md", source: "built-in" },
  { name: "compact", label: "Compact", description: "Summarize the conversation to free context", source: "built-in" },
  { name: "context", label: "Context", description: "Show context usage", source: "built-in" },
  { name: "usage", label: "Usage", description: "Show plan usage", source: "built-in" },
  { name: "recap", label: "Recap", description: "One-line session summary", source: "built-in" },
];

function frontmatter(file: string): Record<string, string> {
  try {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(file, "utf8").slice(0, 8192));
    const out: Record<string, string> = {};
    for (const line of m?.[1]?.split(/\r?\n/) ?? []) {
      const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "").trim();
    }
    return out;
  } catch {
    return {};
  }
}

function scan(root: string, source: Skill["source"], out: Map<string, Skill>): void {
  try {
    for (const e of fs.readdirSync(root)) {
      const file = path.join(root, e, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const fm = frontmatter(file);
      if (fm["user-invocable"] === "false") continue;
      const name = fm.name || e;
      if (!out.has(name)) out.set(name, { name, label: titleCase(name), description: fm.description, source });
    }
  } catch {
    // none
  }
}

/** Skills for a chat folder: project skills, user skills, then the built-ins. */
export function listSkills(cwd?: string): Skill[] {
  const out = new Map<string, Skill>();
  if (cwd) scan(path.join(cwd, ".claude", "skills"), "project", out);
  scan(skillsDir(), "user", out);
  for (const b of BUILTIN_SKILLS) if (!out.has(b.name)) out.set(b.name, b);
  return [...out.values()];
}
