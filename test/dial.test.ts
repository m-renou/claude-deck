// Dials (Stream Deck +) and Neo infobar: touch-strip / infobar images, the layout files, list cursors and the Power
// scale (model × effort) including how a Power step is applied — with fake ops, so nothing touches the Claude app.
// Only pure modules are imported (no SDK, hub, ops or control).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import url from "node:url";
import {
  applyPower,
  cursorIndex,
  moveCursor,
  powerIndex,
  powerLabel,
  powerPlan,
  powerScale,
  powerStart,
  powerView,
  type PowerOps,
} from "../src/actions/dial-logic.ts";
import { ACTIONS } from "../src/catalog.ts";
import {
  D,
  DIAL_H,
  DIAL_W,
  activityDial,
  clippedLine,
  dimmed,
  feedbackUri,
  listStart,
  mix,
  powerDial,
  powerStepX,
  runSkillDial,
  usageDial,
  withDialBadge,
} from "../src/render/dial.ts";
import { C, FADE_ID } from "../src/render/kit.ts";
import { NEO_H, NEO_W, activityNeo, usageNeo } from "../src/render/neo.ts";
import type { ActionResult, Chat, ModelInfo } from "../src/types.ts";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

const chat = (status: Chat["status"], title: string, extra: Partial<Chat> = {}): Chat => ({
  id: `local_${title}`,
  title,
  status,
  lastActivityAt: 0,
  lastFocusedAt: 0,
  live: true,
  ...extra,
});

const texts = (s: string): string[] => [...s.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
const textAttrs = (s: string, content: string): string =>
  new RegExp(`<text ([^>]*)>${content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</text>`).exec(s)?.[1] ?? "";
const attr = (attrs: string, name: string): string | undefined => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

function wellFormed(s: string, w: number, h: number): void {
  assert.ok(s.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`), s.slice(0, 120));
  assert.ok(s.endsWith("</svg>"));
  assert.doesNotMatch(s, /NaN|undefined|Infinity/);
  assert.ok(s.length < 12_000, `SVG too large: ${s.length} chars`);
  assert.doesNotMatch(s, /<style|filter|<mask|clip-path|clipPath|dominant-baseline/);
  // Every referenced gradient is defined.
  for (const m of s.matchAll(/url\(#(\w+)\)/g)) assert.ok(s.includes(`id="${m[1]}"`), `missing gradient ${m[1]}`);
}

const THREE = [
  chat("working", "Refactor feature and review our recent changes"),
  chat("done", "Add more features from the PRD I have attached"),
  chat("waiting", "Explore how our approach could be improved"),
];
const FIVE = [...THREE, chat("idle", "Fix flaky login test"), chat("done", "Write release notes")];

// ── Layout files ────────────────────────────────────────────────────────────────────────────────────────

describe("layouts", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "node_modules/@elgato/schemas/streamdeck/plugins/layout.json"), "utf8"));
  /** Canvas size the schema allows per controller (max x + width of a pixmap rect). */
  const schemaSize = (controller: string): [number, number] => {
    const branch = schema.definitions.Layout.anyOf.find((b: { properties: { controller: { const: string } } }) => b.properties.controller.const === controller);
    const ref: string = branch.properties.items.items.allOf.map((a: { then: { $ref: string } }) => a.then.$ref).find((r: string) => r.includes("Pixmap"));
    const def = schema.definitions[decodeURIComponent(ref.replace("#/definitions/", ""))];
    const rect = def.properties.rect.items;
    return [rect[2].maximum, rect[3].maximum];
  };

  it("matches the canvas sizes the layout schema documents (Stream Deck + 200 × 100, Neo 232 × 50)", () => {
    assert.deepEqual(schemaSize("Encoder"), [DIAL_W, DIAL_H]);
    assert.deepEqual(schemaSize("Neo"), [NEO_W, NEO_H]);
  });

  const layout = (file: string) => JSON.parse(fs.readFileSync(path.join(root, "com.local.claudecode.sdPlugin/layouts", file), "utf8"));
  const check = (file: string, controller: string, w: number, h: number) => {
    const l = layout(file);
    assert.equal(l.controller, controller);
    assert.equal(typeof l.id, "string");
    assert.deepEqual(l.items, [{ key: "canvas", type: "pixmap", rect: [0, 0, w, h] }]);
  };

  it("gives every Encoder action a full-canvas pixmap layout", () => {
    const enc = ACTIONS.filter((a) => a.controllers.includes("Encoder")).map((a) => a.id);
    assert.deepEqual(enc.sort(), ["activity", "power", "run-skill", "usage"]);
    for (const id of enc) check(`${id}-dial.json`, "Encoder", DIAL_W, DIAL_H);
  });

  it("gives every Neo action a full-canvas Neo layout", () => {
    const neo = ACTIONS.filter((a) => a.controllers.includes("Neo")).map((a) => a.id);
    assert.deepEqual(neo.sort(), ["activity", "usage"]);
    for (const id of neo) check(`${id}-neo.json`, "Neo", NEO_W, NEO_H);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────

describe("dial helpers", () => {
  it("encodes feedback as base64 SVG data URIs, even with lone surrogates", () => {
    const u = feedbackUri(`<svg>é \uD83D</svg>`);
    assert.match(u, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);
    assert.equal(Buffer.from(u.split(",")[1]!, "base64").toString("utf8"), "<svg>é \uFFFD</svg>");
  });

  it("mixes colours and dims status colours for grey rows", () => {
    assert.equal(mix("#000000", "#FFFFFF", 0.5), "#808080");
    assert.equal(mix("#34C759", "#000000", 0), "#34C759");
    assert.notEqual(dimmed(C.green), C.green);
    assert.equal(mix("red", "#000000", 0.5), "red"); // not #RRGGBB: unchanged
  });

  it("keeps the cursor on the top row until the end of the list is in view", () => {
    assert.equal(listStart(0, 5), 0);
    assert.equal(listStart(2, 5), 2);
    assert.equal(listStart(4, 5), 2);
    assert.equal(listStart(1, 2), 0);
  });

  it("clips a long line with the fade and a cover up to the canvas edge", () => {
    const r = clippedLine(10, 27, "A very long chat title that cannot fit", { size: 16.5, clipX: 160, width: DIAL_W });
    assert.ok(r.overflow);
    assert.match(r.svg, new RegExp(`fill="url\\(#${FADE_ID}\\)"`));
    assert.match(r.svg, /<rect x="160" y="[\d.]+" width="48"/);
    assert.equal(clippedLine(10, 27, "Short", { size: 16.5, clipX: 160, width: DIAL_W }).overflow, false);
  });
});

// ── Dial images ─────────────────────────────────────────────────────────────────────────────────────────

describe("activityDial", () => {
  it("lists three chats: cursor row white, others grey, ✓ / clock at the right end", () => {
    const s = activityDial(THREE, 0);
    wellFormed(s, DIAL_W, DIAL_H);
    assert.deepEqual(texts(s).map((t) => t.slice(0, 12)), ["Refactor fea", "Add more fea", "Explore how "]);
    assert.equal(attr(textAttrs(s, texts(s)[0]!), "fill"), C.white);
    assert.equal(attr(textAttrs(s, texts(s)[1]!), "fill"), C.grey);
    assert.equal(attr(textAttrs(s, texts(s)[0]!), "y"), "27");
    assert.equal(attr(textAttrs(s, texts(s)[2]!), "y"), "83");
    // Working chats have no icon; done / waiting icons are dimmed on grey rows.
    assert.ok(s.includes(`stroke="${dimmed(C.green)}"`));
    assert.ok(s.includes(`stroke="${dimmed(C.orange)}"`));
    assert.ok(!s.includes(`stroke="${C.green}"`));
    assert.ok(s.includes(`url(#${FADE_ID})`), "long titles fade out");
  });

  it("shows the status colour on the cursor row and scrolls at the end", () => {
    const s = activityDial(FIVE, 4);
    assert.deepEqual(texts(s), ["Explore how our approach could be improved".slice(0, texts(s)[0]!.length), "Fix flaky login test", "Write release notes"]);
    assert.equal(attr(textAttrs(s, "Write release notes"), "fill"), C.white);
    assert.ok(s.includes(`stroke="${C.green}"`));
  });

  it("escapes titles and handles empty lists", () => {
    wellFormed(activityDial([chat("idle", `<b>"x" & y</b>`)], 0), DIAL_W, DIAL_H);
    assert.ok(activityDial([chat("idle", `<b>&</b>`)], 0).includes("&lt;b&gt;&amp;&lt;/b&gt;"));
    const empty = activityDial([], 3);
    wellFormed(empty, DIAL_W, DIAL_H);
    assert.deepEqual(texts(empty), ["No chats yet"]);
  });
});

describe("runSkillDial", () => {
  it("puts a cube before every skill and highlights the cursor", () => {
    const s = runSkillDial(["Review Changes", "Write Tests", "Draft Release Notes"], 1);
    wellFormed(s, DIAL_W, DIAL_H);
    assert.deepEqual(texts(s), ["Review Changes", "Write Tests", "Draft Release Notes"]);
    assert.equal(attr(textAttrs(s, "Write Tests"), "fill"), C.white);
    assert.equal(attr(textAttrs(s, "Review Changes"), "fill"), C.grey);
    assert.equal(attr(textAttrs(s, "Review Changes"), "x"), String(D.skill.textX));
    assert.equal((s.match(/<g transform=/g) ?? []).length, 3);
  });

  it("windows long lists and shows a placeholder when empty", () => {
    assert.deepEqual(texts(runSkillDial(["a", "b", "c", "d", "e"], 3)), ["c", "d", "e"]);
    assert.deepEqual(texts(runSkillDial([], 0)), ["No skills"]);
  });
});

describe("powerDial", () => {
  it("draws model + effort, bolt, gradient track with dots, knob and Faster / Smarter", () => {
    const s = powerDial({ model: "Opus 5.5", effort: "Extra", position: 9, steps: 16 });
    wellFormed(s, DIAL_W, DIAL_H);
    // Model and effort share one <text>: the effort is a <tspan>, so the space between them is the font's own.
    assert.ok(s.includes(`>Opus 5.5 <tspan fill="${C.accent}">Extra</tspan></text>`));
    assert.deepEqual(texts(s), ["Faster", "Smarter"]);
    assert.equal(attr(textAttrs(s, "Smarter"), "text-anchor"), "end");
    assert.ok(s.includes(`fill="url(#pw)"`));
    const kx = powerStepX(9, 16);
    assert.match(s, new RegExp(`<circle cx="${Math.round(kx * 100) / 100}" cy="${D.power.track.y}" r="${D.power.knob}" fill="${C.white}"/>`));
    // One dot per step, except the ones the knob covers (with 16 steps its neighbours too), plus the knob.
    const dots = [...s.matchAll(/<circle cx="([\d.]+)" cy="[\d.]+" r="1.6"/g)].map((m) => Number(m[1]));
    assert.equal(dots.length, 13);
    assert.ok(dots.every((x) => Math.abs(x - kx) >= D.power.knob));
    assert.equal(dots[0], D.power.p0);
  });

  it("spaces steps between the first and last knob position", () => {
    assert.equal(powerStepX(0, 5), D.power.p0);
    assert.equal(powerStepX(4, 5), D.power.p1);
    assert.equal(powerStepX(0, 1), D.power.p1);
  });

  it("marks where the chat is while a pending choice is shown", () => {
    const s = powerDial({ model: "Fable 5.1", effort: "Max", position: 15, steps: 16, current: 9 });
    assert.match(s, new RegExp(`<circle cx="${Math.round(powerStepX(9, 16) * 100) / 100}" cy="[\\d.]+" r="3.4"`));
  });

  it("has no knob for an unknown step, no effort for Haiku, and dims when disabled", () => {
    const unknown = powerDial({ model: "Opus 5.5", position: -1, steps: 16 });
    assert.ok(!unknown.includes(`r="${D.power.knob}"`));
    assert.ok(!unknown.includes(`url(#pw)`));
    assert.deepEqual(texts(powerDial({ model: "Haiku 4.5", position: 0, steps: 16 })), ["Haiku 4.5", "Faster", "Smarter"]);
    assert.match(powerDial({ model: "Model", position: -1, steps: 1, disabled: true }), /fill-opacity="0.65"\/><\/svg>$/);
  });

  it("uses the ultracode colours", () => {
    assert.ok(powerDial({ model: "Opus 5.5", effort: "Ultra", position: 4, steps: 5, ultra: true }).includes(C.accentLight));
  });
});

describe("usageDial", () => {
  it("shows label, percentage, right-aligned detail and a horizontal bar", () => {
    const s = usageDial({ kind: "weekly", percent: 61, line1: "Aug 28", line2: "3 resets" });
    wellFormed(s, DIAL_W, DIAL_H);
    assert.deepEqual(texts(s), ["Weekly", "61%", "Aug 28", "3 resets"]);
    assert.equal(attr(textAttrs(s, "Aug 28"), "text-anchor"), "end");
    assert.equal(attr(textAttrs(s, "Aug 28"), "x"), String(D.right));
    const w = D.right - D.left;
    assert.ok(s.includes(`width="${Math.round(w * 0.61 * 100) / 100}" height="${D.usage.bar.h}"`));
  });

  it("left-aligns and fades a detail line that doesn't fit next to the percentage", () => {
    const s = usageDial({ kind: "context", percent: 7, line1: "70k / 1M", line2: "Refactor feature and review our recent changes" });
    assert.equal(attr(textAttrs(s, texts(s)[3]!), "text-anchor"), undefined);
    assert.ok(s.includes(`url(#${FADE_ID})`));
  });

  it("says when there is no data", () => {
    const s = usageDial({ kind: "none" });
    assert.deepEqual(texts(s), ["Usage", "—", "No data"]);
    assert.equal((s.match(/fill="#FFFFFF"\/>/g) ?? []).length, 0, "no bar fill");
  });

  it("badges the strip while Accessibility is missing", () => {
    const s = withDialBadge(powerDial({ model: "Opus 5.5", effort: "Extra", position: 9, steps: 16 }));
    wellFormed(s, DIAL_W, DIAL_H);
    assert.ok(s.includes(C.warn));
  });
});

// ── Neo infobar ─────────────────────────────────────────────────────────────────────────────────────────

describe("Neo infobar", () => {
  it("shows the selected chat in white and the next one grey with its status icon", () => {
    const s = activityNeo(THREE[0], THREE[1]);
    wellFormed(s, NEO_W, NEO_H);
    assert.equal(texts(s).length, 2);
    assert.equal(attr(textAttrs(s, texts(s)[0]!), "fill"), C.white);
    assert.equal(attr(textAttrs(s, texts(s)[1]!), "fill"), C.grey);
    assert.ok(s.includes(`stroke="${dimmed(C.green)}"`));
    assert.deepEqual(texts(activityNeo(undefined)), ["No chats yet"]);
  });

  it("shows usage: label, detail, percentage right-aligned and a short bar", () => {
    const s = usageNeo({ kind: "weekly", percent: 61, line1: "Aug 28", line2: "3 resets" });
    wellFormed(s, NEO_W, NEO_H);
    assert.deepEqual(texts(s), ["Weekly", "Aug 28", "3 resets", "61%"]);
    assert.equal(attr(textAttrs(s, "61%"), "text-anchor"), "end");
    wellFormed(usageNeo({ kind: "none" }), NEO_W, NEO_H);
  });

  it("never cuts the other window's number: shown whole, else the detail row is line1 alone", () => {
    const fresh = usageNeo({ kind: "5-hour", percent: 3, line1: "resets 00:41", line2: "Weekly 16%", source: "live" });
    wellFormed(fresh, NEO_W, NEO_H);
    assert.deepEqual(texts(fresh), ["5-hour", "resets 00:41", "3%"]);
    assert.deepEqual(texts(usageNeo({ kind: "weekly", percent: 16, line1: "resets Wed", line2: "5-hour 3%" })), ["Weekly", "resets Wed", "16%"]);
    assert.deepEqual(texts(usageNeo({ kind: "weekly", percent: 16, line1: "Oct 8", line2: "5-hour 3%" })), ["Weekly", "Oct 8", "5-hour 3%", "16%"], "fits: shown");
    // A chat title may still fade out after the context numbers.
    const ctx = usageNeo({ kind: "context", percent: 7, line1: "70k / 1M", line2: "Refactor feature and review our recent changes" });
    assert.equal(texts(ctx).length, 4);
  });
});

// ── Cursors and the Power scale ─────────────────────────────────────────────────────────────────────────

describe("list cursors", () => {
  it("moves by ticks and clamps (no wrap-around)", () => {
    assert.equal(moveCursor(0, 1, 5), 1);
    assert.equal(moveCursor(0, -3, 5), 0);
    assert.equal(moveCursor(3, 4, 5), 4);
    assert.equal(moveCursor(2, 1, 0), 0);
    assert.equal(moveCursor(Number.NaN, 2, 5), 2);
  });

  it("follows the item it was left on, else the remembered index, else the fallback", () => {
    assert.equal(cursorIndex(["a", "b", "c"], "c", 0), 2);
    assert.equal(cursorIndex(["a", "b"], "gone", 5), 1);
    assert.equal(cursorIndex(["a", "b", "c"], undefined, undefined, 1), 1);
    assert.equal(cursorIndex([], "a", 3), 0);
  });
});

const MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", name: "Opus 5.5", shortName: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"], fast: false },
  { id: "claude-fable-5-1", name: "Fable 5.1", shortName: "Fable", efforts: ["low", "medium", "high", "xhigh", "max"], fast: false },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", shortName: "Sonnet", efforts: ["max", "low", "high", "medium"], fast: false },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", shortName: "Haiku", efforts: [], fast: false },
];

describe("power scale", () => {
  const scale = powerScale(MODELS);

  it("orders Haiku → Sonnet low…max → Opus low…max → Fable low…max", () => {
    assert.deepEqual(
      scale.map((s) => powerLabel(s)),
      [
        "Haiku 4.5",
        "Sonnet 5.5 Low",
        "Sonnet 5.5 Medium",
        "Sonnet 5.5 High",
        "Sonnet 5.5 Max",
        "Opus 5.5 Low",
        "Opus 5.5 Medium",
        "Opus 5.5 High",
        "Opus 5.5 Extra",
        "Opus 5.5 Max",
        "Fable 5.1 Low",
        "Fable 5.1 Medium",
        "Fable 5.1 High",
        "Fable 5.1 Extra",
        "Fable 5.1 Max",
      ],
    );
    assert.equal(scale[0]!.effort, undefined);
    assert.equal(new Set(scale.map((s) => s.key)).size, scale.length);
  });

  it("puts older versions of a family first and leaves ultracode off the scale", () => {
    const s = powerScale([
      { id: "claude-opus-5-5", name: "Opus 5.5", shortName: "Opus", efforts: ["high", "ultracode"], fast: false },
      { id: "claude-opus-4-6", name: "Opus 4.6", shortName: "Opus", efforts: ["high"], fast: false },
    ]);
    assert.deepEqual(s.map((x) => x.key), ["claude-opus-4-6|high", "claude-opus-5-5|high"]);
  });

  it("finds the chat's step, or where turning starts when it is unknown", () => {
    assert.equal(powerIndex(scale, chat("idle", "x", { model: "claude-opus-5-5", effort: "xhigh" }), MODELS), 8);
    assert.equal(powerIndex(scale, chat("idle", "x", { model: "claude-haiku-4-5-20251001" }), MODELS), 0);
    assert.equal(powerIndex(scale, chat("idle", "x", { model: "claude-opus-5-5" }), MODELS), -1);
    assert.equal(powerIndex(scale, undefined, MODELS), -1);
    assert.equal(powerStart(scale, chat("idle", "x", { model: "claude-opus-5-5" }), MODELS), 5);
    assert.equal(powerStart(scale, chat("idle", "x", { model: "gpt-5" }), MODELS), 0);
  });

  it("shows the chat's setting, or a pending choice with the chat's step marked", () => {
    const c = chat("idle", "x", { model: "claude-opus-5-5", effort: "xhigh" });
    assert.deepEqual(powerView(scale, c, MODELS), { model: "Opus 5.5", effort: "Extra", position: 8, steps: 15, ultra: false });
    assert.deepEqual(powerView(scale, c, MODELS, "claude-fable-5-1|max"), { model: "Fable 5.1", effort: "Max", position: 14, steps: 15, current: 8 });
    // A pending choice equal to the chat's step is just the chat's step.
    assert.equal(powerView(scale, c, MODELS, "claude-opus-5-5|xhigh").current, undefined);
    assert.equal(powerView(scale, { ...c, ultracode: true }, MODELS).effort, "Ultra");
    assert.equal(powerView(scale, undefined, MODELS).disabled, true);
    assert.equal(powerView([], c, []).disabled, true);
  });

  it("plans only what has to change", () => {
    const c = chat("idle", "x", { model: "claude-opus-5-5", effort: "high" });
    const at = (key: string) => scale.find((s) => s.key === key)!;
    assert.deepEqual(powerPlan(at("claude-opus-5-5|max"), c, MODELS), { model: undefined, effort: "max" });
    assert.deepEqual(powerPlan(at("claude-fable-5-1|high"), c, MODELS), { model: "claude-fable-5-1", effort: "high" });
    assert.deepEqual(powerPlan(at("claude-haiku-4-5-20251001|"), c, MODELS), { model: "claude-haiku-4-5-20251001", effort: undefined });
    assert.deepEqual(powerPlan(at("claude-opus-5-5|high"), c, MODELS), { model: undefined, effort: undefined });
  });
});

describe("applyPower (fake ops)", () => {
  const scale = powerScale(MODELS);
  const at = (key: string) => scale.find((s) => s.key === key)!;
  const c = chat("idle", "x", { model: "claude-opus-5-5", effort: "high" });
  const fake = (results: { model?: ActionResult; effort?: ActionResult } = {}) => {
    const calls: string[] = [];
    const ops: PowerOps = {
      setModel: async (m) => {
        calls.push(`model:${m}`);
        return results.model ?? { ok: true, message: m, feedback: "ok" };
      },
      setEffort: async (e) => {
        calls.push(`effort:${e}`);
        return results.effort ?? { ok: true, message: e, feedback: "ok" };
      },
    };
    return { calls, ops };
  };

  it("switches the model, then the effort", async () => {
    const f = fake();
    const r = await applyPower(at("claude-fable-5-1|xhigh"), c, MODELS, f.ops);
    assert.deepEqual(f.calls, ["model:claude-fable-5-1", "effort:xhigh"]);
    assert.deepEqual(r, { ok: true, message: "Fable 5.1 Extra", feedback: "ok" });
  });

  it("stops at the first failure", async () => {
    const f = fake({ model: { ok: false, message: "Sent ⌘⇧I 2, but the chat still reports claude-opus-5-5.", feedback: "alert" } });
    const r = await applyPower(at("claude-fable-5-1|xhigh"), c, MODELS, f.ops);
    assert.deepEqual(f.calls, ["model:claude-fable-5-1"]);
    assert.equal(r.ok, false);
    assert.match(r.message, /still reports/);
  });

  it("says the model changed when only the effort failed", async () => {
    const f = fake({ effort: { ok: false, message: "max isn't available for this model.", feedback: "alert" } });
    const r = await applyPower(at("claude-fable-5-1|max"), c, MODELS, f.ops);
    assert.deepEqual(f.calls, ["model:claude-fable-5-1", "effort:max"]);
    assert.equal(r.ok, false);
    assert.match(r.message, /^Switched to Fable 5\.1, but the effort didn't change: max isn't available/);
  });

  it("only sets the effort within the same model, and does nothing when already there", async () => {
    const f = fake();
    await applyPower(at("claude-opus-5-5|low"), c, MODELS, f.ops);
    assert.deepEqual(f.calls, ["effort:low"]);
    const g = fake();
    const r = await applyPower(at("claude-opus-5-5|high"), c, MODELS, g.ops);
    assert.deepEqual(g.calls, []);
    assert.equal(r.message, "Already on Opus 5.5 High");
  });

  it("fails honestly without a chat", async () => {
    const f = fake();
    const r = await applyPower(at("claude-opus-5-5|low"), undefined, MODELS, f.ops);
    assert.deepEqual(f.calls, []);
    assert.equal(r.ok, false);
  });
});
