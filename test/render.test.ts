// Render kit + key images: escaping, text layout and clipping, status colours, step dots, slider and usage bar.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  L,
  SLIDER,
  activityKey,
  dictateKey,
  effortKey,
  heroKey,
  modelKey,
  newChatKey,
  panelKey,
  runSkillKey,
  sendPromptKey,
  sliderX,
  speedKey,
  steerKey,
  stopKey,
  usageKey,
  withBadge,
} from "../src/render/keys.ts";
import { C, FADE_ID, dataUri, esc, fitPrefix, relTime, squash, svg, textBlock, textWidth, titleCase, wrapLines } from "../src/render/kit.ts";
import type { Chat } from "../src/types.ts";

const NOW = 1_760_000_000_000;
const chat = (status: Chat["status"], title: string, extra: Partial<Chat> = {}): Chat => ({
  id: `local_${status}`,
  title,
  status,
  lastActivityAt: NOW - 60_000,
  lastFocusedAt: NOW - 60_000,
  live: true,
  ...extra,
});

/** Text contents of every <text> element, in order. */
const texts = (s: string): string[] => [...s.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
/** Attributes of the <text> element whose content is `content`. */
const textAttrs = (s: string, content: string): string => new RegExp(`<text ([^>]*)>${content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</text>`).exec(s)?.[1] ?? "";
const attr = (attrs: string, name: string): string | undefined => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

function wellFormedKey(s: string): void {
  assert.match(s, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="144" height="144" viewBox="0 0 144 144">/);
  assert.ok(s.endsWith("</svg>"));
  assert.doesNotMatch(s, /NaN|undefined|Infinity/);
  assert.ok(s.length < 9000, `key SVG too large: ${s.length} chars`);
  // Rasteriser-safe subset: no CSS, filters, masks or clip paths.
  assert.doesNotMatch(s, /<style|filter|<mask|clip-path|clipPath|dominant-baseline/);
}

// ───────────────────────────────────────────────────────────────────────── kit

describe("kit", () => {
  it("escapes XML and drops forbidden control characters", () => {
    assert.equal(esc(`a & b < c > d "e" 'f'`), "a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;");
    assert.equal(esc("x\u0000y\u0007z\tw"), "xyz\tw");
  });

  it("builds data URIs, even from lone surrogates", () => {
    const s = svg(10, 10, "<rect/>");
    assert.equal(s, `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><rect/></svg>`);
    const uri = dataUri(s);
    assert.ok(uri.startsWith("data:image/svg+xml,"));
    assert.equal(decodeURIComponent(uri.slice("data:image/svg+xml,".length)), s);
    assert.doesNotThrow(() => dataUri("<svg>\uD83D</svg>"));
  });

  it("measures text roughly like SF Pro Semibold", () => {
    // "settings panel" is 6.2 em in SF Pro Semibold.
    assert.ok(Math.abs(textWidth("settings panel", 100) - 620) < 5);
    assert.ok(textWidth("WWW", 18) > textWidth("iii", 18));
    assert.equal(fitPrefix("abcdef", 18, 0), "");
    assert.equal(fitPrefix("abc", 18, 1000), "abc");
  });

  it("wraps like the Codex keys: word-wrapped lines, then the rest on the last line (clipped, no ellipsis)", () => {
    const lines = wrapLines("Refactor feature and review our recent changes", 18, 113, 3);
    assert.deepEqual(lines.slice(0, 2), ["Refactor", "feature and"]);
    assert.ok(lines[2]!.startsWith("review our rec"));
    assert.ok(!lines.join("").includes("…"));
    assert.deepEqual(wrapLines("Focus on the settings panel first, then review", 18, 113, 3).slice(0, 2), ["Focus on the", "settings panel"]);
    assert.deepEqual(wrapLines("  Short\n title ", 18, 113, 3), ["Short title"]);
    assert.deepEqual(wrapLines("", 18, 113, 3), []);
    assert.equal(wrapLines("one two three four five six seven eight nine ten eleven", 18, 60, 2).length, 2);
  });

  it("breaks an over-long word, preferring a separator", () => {
    const lines = wrapLines("/security-review-of-everything-in-the-repo now", 18, 113, 3);
    assert.ok(lines[0]!.endsWith("-"), lines[0]);
    for (const l of lines.slice(0, 2)) assert.ok(textWidth(l, 18) <= 113, l);
  });

  it("keeps the last line short enough to stay small", () => {
    const [line] = wrapLines("x".repeat(500), 18, 113, 1);
    assert.ok(textWidth(line!, 18) <= 113 + 3 * 18);
  });

  it("fades only the lines that overflow", () => {
    const block = textBlock(["Short", "A much longer line that will never fit"], { y: 78, size: 18, lineHeight: 22, bg: "#123456" });
    assert.equal(block.overflow, true);
    assert.equal((block.svg.match(new RegExp(`url\\(#${FADE_ID}\\)`, "g")) ?? []).length, 1);
    assert.match(block.svg, /<rect x="115" y="[\d.]+" width="16" height="[\d.]+" fill="url\(#fd\)"\/>/);
    assert.match(block.svg, /<rect x="131" [^>]*fill="#123456"\/>/);
    assert.equal(textBlock(["Short"], { y: 78, size: 18, lineHeight: 22, bg: "#000" }).overflow, false);
  });

  it("formats relative time", () => {
    assert.equal(relTime(0), "now");
    assert.equal(relTime(59_999), "now");
    assert.equal(relTime(-5_000), "now");
    assert.equal(relTime(Number.NaN), "now");
    assert.equal(relTime(60_000), "1m");
    assert.equal(relTime(59 * 60_000), "59m");
    assert.equal(relTime(2 * 3_600_000 + 5), "2h");
    assert.equal(relTime(3 * 86_400_000), "3d");
  });

  it("title-cases skill names", () => {
    assert.equal(titleCase("review-changes"), "Review Changes");
    assert.equal(titleCase("/draft_release  notes"), "Draft Release Notes");
    assert.equal(squash(" a \n b "), "a b");
  });
});

// ───────────────────────────────────────────────────────────────────────── Activity

describe("activityKey", () => {
  it("uses the status tile, icon colour and time", () => {
    const cases: Array<[Chat["status"], string, string]> = [
      ["working", C.tile.working, C.white],
      ["done", C.tile.done, C.green],
      ["waiting", C.tile.waiting, C.orange],
      ["idle", C.tile.idle, C.greyDim],
    ];
    for (const [status, tile, iconColor] of cases) {
      const s = activityKey(chat(status, "Refactor"), { now: NOW });
      wellFormedKey(s);
      assert.ok(s.includes(`<rect x="0" y="0" width="144" height="144" fill="${tile}"/>`), status);
      assert.ok(s.includes(`stroke="${iconColor}"`), `${status} icon colour`);
      const time = textAttrs(s, "1m");
      assert.equal(attr(time, "fill"), C.grey, status);
      assert.equal(attr(time, "text-anchor"), "end");
      assert.equal(attr(time, "x"), "128");
    }
  });

  it("shows +added -removed for a finished chat with diff stats", () => {
    const s = activityKey(chat("done", "Add more features", { diff: { added: 40, removed: 8 } }), { now: NOW });
    assert.equal(attr(textAttrs(s, "+40"), "fill"), C.green);
    assert.equal(attr(textAttrs(s, "-8"), "fill"), C.red);
    assert.ok(!texts(s).includes("1m"));
    assert.ok(Number(attr(textAttrs(s, "+40"), "x")) < 128);
    // Only additions: right-aligned on its own.
    assert.equal(attr(textAttrs(activityKey(chat("done", "x", { diff: { added: 3, removed: 0 } }), { now: NOW }), "+3"), "x"), "128");
    // Working chats never show a diff.
    assert.ok(texts(activityKey(chat("working", "x", { diff: { added: 3, removed: 1 } }), { now: NOW })).includes("1m"));
  });

  it("lays the title out on the 78 / 100 / 122 baselines, escaped and clipped", () => {
    const s = activityKey(chat("working", "Refactor <feature> & review our recent changes"), { now: NOW });
    assert.equal(attr(textAttrs(s, "Refactor"), "y"), "78");
    assert.equal(attr(textAttrs(s, "&lt;feature&gt; &amp;"), "y"), "100");
    const last = texts(s).find((t) => t.startsWith("review"));
    assert.ok(last);
    assert.equal(attr(textAttrs(s, last!), "y"), "122");
    assert.ok(s.includes(`stop-color="${C.tile.working}"`), "fade in the tile colour");
    assert.equal(attr(textAttrs(s, "Refactor"), "x"), "16");
  });

  it("marks the selected chat with a 4 px white inner border", () => {
    const sel = activityKey(chat("idle", "x"), { now: NOW, selected: true });
    assert.match(sel, /<rect x="2" y="2" width="140" height="140" rx="18" fill="none" stroke="#FFFFFF" stroke-width="4"\/>/);
    assert.doesNotMatch(activityKey(chat("idle", "x"), { now: NOW }), /stroke-width="4"/);
  });

  it("draws an empty slot as a dim chat icon", () => {
    const s = activityKey(undefined);
    wellFormedKey(s);
    assert.ok(s.includes(`stroke="${C.empty}"`));
    assert.deepEqual(texts(s), []);
  });
});

// ───────────────────────────────────────────────────────────────────────── command keys

describe("command keys", () => {
  it("renders hero keys on black", () => {
    for (const s of [newChatKey(), dictateKey(), stopKey({ enabled: true }), panelKey("terminal"), heroKey("bolt")]) {
      wellFormedKey(s);
      assert.ok(s.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect x="0" y="0" width="144" height="144" fill="#000000"/>`));
    }
  });

  it("colours the microphone while dictating", () => {
    assert.ok(dictateKey({ active: true }).includes(`stroke="${C.accent}"`));
    assert.ok(!dictateKey({ active: false }).includes(C.accent));
  });

  it("puts prompt / steer text under the corner icon", () => {
    const s = sendPromptKey("Review my changes and suggest improvements");
    wellFormedKey(s);
    assert.deepEqual(texts(s).slice(0, 2), ["Review my", "changes and"]);
    assert.equal(attr(textAttrs(s, "Review my"), "y"), "78");
    const st = steerKey("Focus on the settings panel first, then review");
    assert.deepEqual(texts(st).slice(0, 2), ["Focus on the", "settings panel"]);
    // Empty: grey placeholder.
    assert.equal(attr(textAttrs(sendPromptKey("  "), "Send Prompt"), "fill"), C.grey);
    assert.equal(attr(textAttrs(steerKey(""), "Steer"), "fill"), C.grey);
  });

  it("puts the skill name bottom-left in Title Case", () => {
    const s = runSkillKey("review-changes");
    wellFormedKey(s);
    assert.equal(attr(textAttrs(s, "Review"), "y"), "100");
    assert.equal(attr(textAttrs(s, "Changes"), "y"), "122");
    assert.equal(attr(textAttrs(runSkillKey("Lint"), "Lint"), "y"), "122");
    // A label the user capitalised is kept as typed.
    assert.ok(texts(runSkillKey("Fix my PR")).join(" ").includes("Fix my PR"));
  });

  it("dims Stop when nothing is running", () => {
    assert.match(stopKey({ enabled: false }), /fill-opacity="0.65"/);
    assert.doesNotMatch(stopKey({ enabled: true }), /fill-opacity/);
    assert.match(stopKey({ enabled: true }), /fill-rule="evenodd"/);
  });

  it("draws a different hero icon per panel, falling back for unknown ids", () => {
    const all = ["review", "terminal", "browser", "files", "sideChat"].map((p) => panelKey(p));
    assert.equal(new Set(all).size, 5);
    assert.equal(panelKey("nope"), heroKey("panel-bottom"));
  });
});

// ───────────────────────────────────────────────────────────────────────── model / effort / speed

describe("model / effort / speed", () => {
  const pills = (s: string) => [...s.matchAll(/<rect x="[\d.]+" y="120.5" width="[\d.]+" height="7" rx="3.5" fill="(#[0-9A-F]+)"\/>/g)].map((m) => m[1]);

  it("shows the model name and one pill per model, the current one white", () => {
    const s = modelKey({ name: "Opus 5.5", index: 2, count: 5 });
    wellFormedKey(s);
    assert.equal(attr(textAttrs(s, "Opus 5.5"), "font-size"), "23");
    assert.equal(attr(textAttrs(s, "Opus 5.5"), "y"), "103");
    assert.deepEqual(pills(s), [C.pill, C.pill, C.white, C.pill, C.pill]);
    assert.deepEqual(pills(modelKey({ name: "x", index: -1, count: 3 })), [C.pill, C.pill, C.pill]);
    assert.deepEqual(pills(modelKey({ name: "x", index: 0, count: 0 })), []);
    // Many models still fit inside the key.
    const many = modelKey({ name: "x", index: 11, count: 12 });
    assert.equal(pills(many).length, 12);
    const xs = [...many.matchAll(/<rect x="([\d.]+)" y="120.5" width="([\d.]+)"/g)].map((m) => Number(m[1]) + Number(m[2]));
    assert.ok(Math.max(...xs) <= 128.01);
  });

  it("shrinks a long model name before clipping it", () => {
    const s = modelKey({ name: "Claude Haiku 4.5 (legacy)", index: 0, count: 1 });
    const size = Number(/font-size="([\d.]+)"/.exec(s)?.[1]);
    assert.ok(size < 23 && size >= 17);
  });

  it("places the effort knob at the level (index on the slider, or a fraction)", () => {
    assert.equal(sliderX(0, 5), SLIDER.p0);
    assert.equal(sliderX(4, 5), SLIDER.p1);
    assert.equal(sliderX(2, 5), (SLIDER.p0 + SLIDER.p1) / 2);
    assert.equal(sliderX(0.5, 5), (SLIDER.p0 + SLIDER.p1) / 2);
    assert.equal(sliderX(9, 5), SLIDER.p1);
    assert.equal(sliderX(-1, 5), undefined);
    assert.equal(sliderX(0, 1), SLIDER.p1);

    const knob = (s: string) => new RegExp(`<circle cx="([\\d.]+)" cy="${SLIDER.y}" r="${SLIDER.knob}" fill="#FFFFFF"/>`).exec(s)?.[1];
    const s = effortKey({ label: "Extra", position: 3, steps: 5 });
    wellFormedKey(s);
    assert.equal(Number(knob(s)), SLIDER.p0 + (3 / 4) * (SLIDER.p1 - SLIDER.p0));
    assert.equal(attr(textAttrs(s, "Extra"), "fill"), C.accent);
    assert.ok(s.includes(`stroke="${C.accent}"`), "brain in accent");
    assert.ok(s.includes(`stop-color="${C.sliderFrom}"`) && s.includes(`stop-color="${C.sliderTo}"`));
    // Dots: 5 steps, the one under the knob hidden; dots left of the knob are lit.
    const dots = [...s.matchAll(/<circle cx="([\d.]+)" cy="118" r="1.8" fill="(#[0-9A-F]+)"/g)];
    assert.equal(dots.length, 4);
    assert.deepEqual(
      dots.map((d) => d[2]),
      [C.white, C.white, C.white, C.dot],
    );
    // Ultra: knob at the end, darker gradient end.
    const u = effortKey({ label: "Ultra", position: 4, steps: 5, ultra: true });
    assert.equal(Number(knob(u)), SLIDER.p1);
    assert.ok(u.includes(`stop-color="${C.accentDark}"`));
    // Unknown level: no knob.
    assert.equal(knob(effortKey({ label: "Default", position: -1, steps: 5 })), undefined);
  });

  it("dims Effort when the model has no effort setting", () => {
    const s = effortKey({ label: "Effort", position: 2, steps: 5, disabled: true });
    assert.match(s, /fill-opacity="0.65"\/><\/svg>$/);
    assert.doesNotMatch(s, /fill="url\(#sl\)"/);
  });

  it("draws Speed filled in accent when on, outlined when off, dim when unavailable", () => {
    const on = speedKey({ state: "on" });
    assert.ok(on.includes(`fill="${C.accent}"`));
    const off = speedKey({ state: "off" });
    assert.ok(off.includes(`fill="none" stroke="#FFFFFF"`));
    assert.doesNotMatch(off, /fill-opacity/);
    assert.match(speedKey({ state: "na" }), /fill-opacity="0.65"/);
    assert.match(speedKey({ state: "unavailable" }), /fill-opacity="0.65"/);
  });
});

// ───────────────────────────────────────────────────────────────────────── usage

describe("usageKey", () => {
  it("shows label, percentage, two grey lines and a bar filled from the bottom", () => {
    const s = usageKey({ kind: "weekly", percent: 61, line1: "Aug 28", line2: "3 resets" });
    wellFormedKey(s);
    assert.deepEqual(texts(s), ["Weekly", "61%", "Aug 28", "3 resets"]);
    assert.equal(attr(textAttrs(s, "61%"), "font-size"), "30");
    assert.equal(attr(textAttrs(s, "Aug 28"), "fill"), C.grey);
    assert.ok(s.includes(`<rect x="118" y="16" width="8" height="112" rx="4" fill="${C.track}"/>`));
    const fill = /<rect x="118" y="([\d.]+)" width="8" height="([\d.]+)" rx="4" fill="#FFFFFF"\/>/.exec(s);
    assert.ok(fill);
    assert.ok(Math.abs(Number(fill![2]) - 0.61 * 112) < 0.02);
    assert.ok(Math.abs(Number(fill![1]) + Number(fill![2]) - 128) < 0.02);
  });

  it("covers context, empty and out-of-range values", () => {
    const c = usageKey({ kind: "context", percent: 78, line1: "779k / 1M" });
    assert.deepEqual(texts(c), ["Context", "78%", "779k / 1M"]);
    const none = usageKey({ kind: "none" });
    assert.deepEqual(texts(none), ["Usage", "—", "No data"]);
    assert.doesNotMatch(none, /fill="#FFFFFF"\/><\/svg>$/);
    const over = usageKey({ kind: "5-hour", percent: 140 });
    assert.ok(texts(over).includes("140%"));
    assert.ok(over.includes(`<rect x="118" y="16" width="8" height="112" rx="4" fill="#FFFFFF"/>`));
  });
});

// ───────────────────────────────────────────────────────────────────────── badge

describe("withBadge", () => {
  it("overlays a ⚠ in the top-right, over a patch of the key's own background", () => {
    const base = activityKey(chat("waiting", "x"), { now: NOW });
    const s = withBadge(base, "access");
    assert.ok(s.startsWith(base.slice(0, -"</svg>".length)));
    assert.ok(s.endsWith("</svg>"));
    assert.ok(s.includes(`<rect x="96" y="6" width="40" height="34" fill="${C.tile.waiting}"/>`));
    assert.ok(s.includes(`fill="${C.warn}"`));
    wellFormedKey(s);
    assert.equal(withBadge("not svg", "access"), "not svg");
  });
});

describe("layout constants", () => {
  it("matches the screenshot grid", () => {
    assert.deepEqual([...L.body.baselines], [78, 100, 122]);
    assert.equal(L.pad, 16);
  });
});
