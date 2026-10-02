// Generates the README / social images in docs/images/*.png from the same renderers the plugin uses at runtime:
// every key, dial strip and tile is the plugin's own SVG with sample chats, laid out on a Stream Deck mockup (HTML/CSS)
// and captured with macOS WebKit (scripts/snapshot.swift, compiled on the fly; needs the Xcode command-line tools).
//   node scripts/gen-screenshots.ts [name …]
// Images are 1600 × 900 (16:9, the shape X / LinkedIn show uncropped) at 2× pixel density; social-preview.png is
// 1280 × 640 at 1× for GitHub's link card.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { activityDial, powerDial, runSkillDial, usageDial } from "../src/render/dial.ts";
import { icon } from "../src/render/icons.ts";
import { C, svg } from "../src/render/kit.ts";
import {
  activityKey,
  dictateKey,
  effortKey,
  keepAwakeKey,
  modelKey,
  newChatKey,
  panelKey,
  runSkillKey,
  sendPromptKey,
  speedKey,
  steerKey,
  stopKey,
  usageKey,
} from "../src/render/keys.ts";
import type { Chat, Usage } from "../src/types.ts";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../docs/images");
const W = 1600;
const H = 900;
const REPO = "github.com/matthberendt/claude-deck";

// ───────────────────────────────────────────────────────────────────────── sample state

const now = Date.now();
const min = 60_000;
const chat = (title: string, status: Chat["status"], ago: number, extra: Partial<Chat> = {}): Chat => ({
  id: title,
  title,
  status,
  lastActivityAt: now - ago,
  lastFocusedAt: now - ago,
  live: true,
  ...extra,
});

const CHATS = {
  working: chat("Add dark mode to the settings page", "working", 2 * min),
  waiting: chat("Migrate the users table to v2", "waiting", 1 * min),
  done: chat("Fix the flaky login test", "done", 6 * min, { diff: { added: 142, removed: 38 } }),
  idle: chat("Write release notes for 1.0", "idle", 3 * 60 * min),
};
const WEEKLY: Usage = { kind: "weekly", percent: 34, line1: "resets Thu", line2: "5-hour 12%", source: "live" };

const K = {
  a1: activityKey(CHATS.working, { selected: true, now }),
  a2: activityKey(CHATS.waiting, { now }),
  a3: activityKey(CHATS.done, { now }),
  a4: activityKey(CHATS.idle, { now }),
  usage: usageKey(WEEKLY),
  context: usageKey({ kind: "context", percent: 42, line1: "420k / 1M", line2: "Add dark mode to…" }),
  newChat: newChatKey(),
  dictate: dictateKey(),
  send: sendPromptKey("Review my changes and fix any bugs"),
  steer: steerKey("Focus on the settings panel first"),
  stop: stopKey({ enabled: true }),
  model: modelKey({ name: "Opus 5.5", index: 1, count: 2 }),
  effort: effortKey({ label: "Ultra", position: 5, steps: 6, ultra: true }),
  speed: speedKey({ state: "on" }),
  skill: runSkillKey("code-review"),
  review: panelKey("review"),
  terminal: panelKey("terminal"),
  awake: keepAwakeKey({ state: "on", remaining: "45m" }),
};

const DIALS = {
  activity: activityDial([CHATS.working, CHATS.waiting, CHATS.done], 0),
  skill: runSkillDial(["Code Review", "Security Review", "Simplify"], 0),
  power: powerDial({ model: "Opus 5.5", effort: "Extra", position: 8, steps: 10 }),
  usage: usageDial(WEEKLY),
};

// ───────────────────────────────────────────────────────────────────────── HTML building blocks

const uri = (s: string): string => `data:image/svg+xml;base64,${Buffer.from(s).toString("base64")}`;
const img = (s: string, cls = ""): string => `<img class="${cls}" src="${uri(s)}" alt="">`;
const key = (s: string): string => `<div class="key">${img(s)}</div>`;
const spark = (size: number, color: string = C.accent): string => img(svg(size, size, icon("spark", { x: 0, y: 0, size, color })), "spark");

/** Stream Deck (MK.2): 5 × 3 keys. */
const streamDeck = (keys: string[], keySize = 132): string => `
  <div class="device" style="--k:${keySize}px; --cols:5">
    <div class="grid">${keys.map(key).join("")}</div>
  </div>`;

/** Stream Deck +: 4 × 2 keys, the 4-segment touch strip, 4 dials. */
const streamDeckPlus = (keys: string[], dials: string[], keySize = 128): string => `
  <div class="device plus" style="--k:${keySize}px; --cols:4">
    <div class="grid">${keys.map(key).join("")}</div>
    <div class="strip">${dials.map((d) => img(d)).join("")}</div>
    <div class="knobs">${dials.map(() => `<div class="knob"></div>`).join("")}</div>
  </div>`;

const brand = `<div class="brand">${spark(30)}<span>Claude Deck</span></div>`;
const footer = `<div class="footer"><span>Open source · MIT</span><span>${REPO}</span></div>`;

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: var(--w, ${W}px); height: var(--h, ${H}px); overflow: hidden; }
  body {
    font-family: -apple-system, system-ui, "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
    color: #fff; -webkit-font-smoothing: antialiased;
    background:
      radial-gradient(900px 600px at var(--gx, 72%) var(--gy, 52%), rgba(217,119,87,.20), transparent 70%),
      radial-gradient(1200px 700px at 0% 100%, rgba(217,119,87,.06), transparent 70%),
      #0d0d0d;
    position: relative;
  }
  .brand { position: absolute; left: 80px; top: 64px; display: flex; align-items: center; gap: 12px;
           font-size: 24px; font-weight: 600; letter-spacing: -.01em; }
  .spark { display: block; }
  .footer { position: absolute; left: 80px; right: 80px; bottom: 54px; display: flex; justify-content: space-between;
            font-size: 20px; color: #8e8e93; font-weight: 500; }
  h1 { font-size: 72px; line-height: 1.02; font-weight: 700; letter-spacing: -.035em; }
  h1 em { font-style: normal; color: #D97757; }
  h2 { font-size: 56px; line-height: 1.05; font-weight: 700; letter-spacing: -.03em; }
  p.lead { font-size: 25px; line-height: 1.4; color: #b5b5ba; font-weight: 450; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; }
  .chip { font-size: 18px; font-weight: 550; color: #e5e5ea; padding: 8px 15px; border-radius: 999px;
          background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.10); }

  .device {
    padding: calc(var(--k) * .30); border-radius: calc(var(--k) * .36);
    background: linear-gradient(160deg, #2a2a2c 0%, #161617 45%, #0f0f10 100%);
    box-shadow: 0 1px 0 rgba(255,255,255,.10) inset, 0 -1px 0 rgba(0,0,0,.6) inset,
                0 40px 80px rgba(0,0,0,.65), 0 10px 24px rgba(0,0,0,.5);
    border: 1px solid #2c2c2e;
  }
  .grid { display: grid; grid-template-columns: repeat(var(--cols), var(--k)); gap: calc(var(--k) * .2); }
  .key {
    width: var(--k); height: var(--k); border-radius: calc(var(--k) * .16); overflow: hidden; background: #000;
    box-shadow: 0 0 0 calc(var(--k) * .035) #050505, 0 3px 6px rgba(0,0,0,.7), 0 0 0 calc(var(--k) * .045) #2a2a2c;
  }
  .key img { width: 100%; height: 100%; display: block; }
  .plus .strip {
    margin-top: calc(var(--k) * .32); display: grid; grid-template-columns: repeat(4, 1fr);
    width: calc(var(--k) * 4 + var(--k) * .6); height: calc((var(--k) * 4 + var(--k) * .6) / 8);
    border-radius: 10px; overflow: hidden; background: #000; box-shadow: 0 0 0 4px #050505, 0 0 0 5px #2a2a2c;
  }
  .plus .strip img { width: 100%; height: 100%; display: block; border-left: 1px solid #111; }
  .plus .strip img:first-child { border-left: 0; }
  .plus .knobs { margin-top: calc(var(--k) * .38); display: grid; grid-template-columns: repeat(4, 1fr); justify-items: center; }
  .knob { width: calc(var(--k) * .82); height: calc(var(--k) * .82); border-radius: 50%;
          background: repeating-conic-gradient(from 0deg, #2e2e30 0 2deg, #232325 2deg 4deg);
          box-shadow: 0 0 0 5px #0a0a0a, 0 0 0 6px #333, 0 14px 22px rgba(0,0,0,.7), inset 0 2px 2px rgba(255,255,255,.12); }

  .big { display: flex; gap: 36px; justify-content: center; }
  .big figure { display: flex; flex-direction: column; align-items: center; gap: 22px; }
  .big .key { --k: 260px; }
  .big figcaption { text-align: center; }
  .big figcaption b { display: block; font-size: 26px; font-weight: 650; letter-spacing: -.01em; }
  .big figcaption span { display: block; margin-top: 6px; font-size: 19px; color: #9b9b9f; line-height: 1.35; }
`;

const page = (body: string, vars = ""): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body style="${vars}">${body}</body></html>`;

const figure = (s: string, title: string, sub: string): string =>
  `<figure>${key(s)}<figcaption><b>${title}</b><span>${sub}</span></figcaption></figure>`;

// ───────────────────────────────────────────────────────────────────────── pages

const PAGES: Record<string, string> = {
  hero: page(
    `${brand}
     <div style="position:absolute; left:80px; top:180px; width:600px; display:flex; flex-direction:column; gap:30px">
       <h1>Claude Code,<br><em>on your<br>Stream Deck.</em></h1>
       <p class="lead" style="max-width:560px">Every chat on a key. Send prompts, steer, stop, and switch model, effort and Ultracode, without leaving your flow.</p>
       <div class="chips"><span class="chip">Claude desktop app</span><span class="chip">No setup</span><span class="chip">Live plan usage</span></div>
     </div>
     <div style="position:absolute; right:80px; top:50%; transform:translateY(-50%)">
       ${streamDeck([K.a1, K.a2, K.a3, K.a4, K.usage, K.newChat, K.dictate, K.send, K.steer, K.stop, K.model, K.effort, K.speed, K.skill, K.review])}
     </div>
     ${footer}`,
  ),

  activity: page(
    `${brand}
     <div style="position:absolute; left:80px; top:150px; right:80px">
       <h2>Every chat, on a key.</h2>
       <p class="lead" style="margin-top:14px; max-width:1100px">See at a glance which chat is working, which one needs you and what just finished. Press a key to jump straight to that chat.</p>
     </div>
     <div class="big" style="position:absolute; left:0; right:0; top:390px">
       ${figure(K.a1, "Working", "Claude is on it · white frame = open now")}
       ${figure(K.a2, "Needs you", "A question or a permission prompt")}
       ${figure(K.a3, "Done", "Finished, with lines added / removed")}
       ${figure(K.a4, "Idle", "Nothing new since you looked")}
     </div>
     ${footer}`,
    "--gx:50%; --gy:75%",
  ),

  controls: page(
    `${brand}
     <div style="position:absolute; left:80px; top:150px; right:80px">
       <h2>Model, effort, speed. <span style="color:#D97757">One press each.</span></h2>
       <p class="lead" style="margin-top:14px; max-width:1100px">Drives the app's own controls, then checks the chat really switched. Effort goes all the way to Ultracode.</p>
     </div>
     <div class="big" style="position:absolute; left:0; right:0; top:390px">
       ${figure(K.model, "Model", "Cycles your slots: Fable 5.1, Opus 5.5")}
       ${figure(K.effort, "Effort", "Low … Max, then Ultra (Ultracode)")}
       ${figure(K.speed, "Speed", "Fast mode on / off")}
       ${figure(K.usage, "Usage", "Weekly / 5-hour, live every minute")}
     </div>
     ${footer}`,
    "--gx:50%; --gy:75%",
  ),

  "stream-deck-plus": page(
    `${brand}
     <div style="position:absolute; left:80px; top:190px; width:560px; display:flex; flex-direction:column; gap:28px">
       <h2>Dials on<br>Stream Deck +.</h2>
       <p class="lead">Turn to browse chats and skills, slide from <b style="color:#fff">Faster</b> to <b style="color:#fff">Smarter</b> across every model and effort level, and keep an eye on your plan.</p>
       <div class="chips"><span class="chip">Activity</span><span class="chip">Run Skill</span><span class="chip">Power</span><span class="chip">Usage</span></div>
     </div>
     <div style="position:absolute; right:100px; top:50%; transform:translateY(-50%)">
       ${streamDeckPlus([K.newChat, K.dictate, K.send, K.stop, K.steer, K.speed, K.review, K.terminal], [DIALS.activity, DIALS.skill, DIALS.power, DIALS.usage])}
     </div>
     ${footer}`,
  ),

  // GitHub's link card (Settings → Social preview): 1280 × 640 at 1×, under GitHub's 1 MB limit.
  "social-preview": page(
    `<div class="brand" style="left:64px; top:52px">${spark(28)}<span>Claude Deck</span></div>
     <div style="position:absolute; left:64px; top:150px; width:470px; display:flex; flex-direction:column; gap:24px">
       <h1 style="font-size:60px">Claude Code,<br><em>on your<br>Stream Deck.</em></h1>
       <p class="lead" style="font-size:21px">Every chat on a key. Prompts, steer, stop, model, effort and Ultracode.</p>
     </div>
     <div style="position:absolute; right:56px; top:50%; transform:translateY(-50%)">
       ${streamDeck([K.a1, K.a2, K.a3, K.a4, K.usage, K.newChat, K.dictate, K.send, K.steer, K.stop, K.model, K.effort, K.speed, K.skill, K.review], 106)}
     </div>
     <div class="footer" style="left:64px; right:64px; bottom:40px; font-size:17px"><span>Open source · MIT</span><span>${REPO}</span></div>`,
    "--w:1280px; --h:640px; --gx:75%",
  ),

  "all-keys": page(
    `${brand}
     <div style="position:absolute; left:80px; top:150px; right:80px">
       <h2>Every key.</h2>
     </div>
     <div style="position:absolute; left:80px; right:80px; top:260px; display:grid; grid-template-columns:repeat(7, 1fr); gap:30px 20px">
       ${[
         [K.a1, "Activity"], [K.newChat, "New Chat"], [K.dictate, "Dictate"], [K.send, "Send Prompt"], [K.steer, "Steer"],
         [K.skill, "Run Skill"], [K.stop, "Stop"], [K.model, "Model"], [K.effort, "Effort"], [K.speed, "Speed"],
         [K.usage, "Usage"], [K.context, "Usage · Context"], [K.review, "Toggle Panel"], [K.awake, "Keep Awake"],
       ]
         .map(([s, t]) => `<div style="display:flex; flex-direction:column; align-items:center; gap:14px"><div class="key" style="--k:170px">${img(s!)}</div><div style="font-size:20px; font-weight:600; color:#d1d1d6">${t}</div></div>`)
         .join("")}
     </div>
     ${footer}`,
    "--gx:50%; --gy:60%",
  ),
};

// ───────────────────────────────────────────────────────────────────────── capture

/** Pages that aren't 1600 × 900 @2×. */
const SIZES: Record<string, { w: number; h: number; scale: number }> = { "social-preview": { w: 1280, h: 640, scale: 1 } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-deck-shots-"));
const snapshot = path.join(tmp, "snapshot");
execFileSync("swiftc", ["-O", "-o", snapshot, path.join(here, "snapshot.swift")], { stdio: "inherit" });
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);

for (const [name, html] of Object.entries(PAGES)) {
  if (only.length && !only.includes(name)) continue;
  const file = path.join(tmp, `${name}.html`);
  fs.writeFileSync(file, html);
  const size = SIZES[name] ?? { w: W, h: H, scale: 2 };
  execFileSync(snapshot, [file, path.join(OUT, `${name}.png`), String(size.w), String(size.h), String(size.scale)], { stdio: "inherit" });
  console.log(`docs/images/${name}.png`);
}
fs.rmSync(tmp, { recursive: true, force: true });
