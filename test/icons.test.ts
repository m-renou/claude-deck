// Icon set: every name renders, scaling / stroke conversion, solid variants, and coverage of the catalog's icons.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIONS, PANELS } from "../src/catalog.ts";
import { ICON_NAMES, icon, isIconName, sparkPoints } from "../src/render/icons.ts";
import { PANEL_ICON } from "../src/render/keys.ts";

const REQUIRED = [
  "chat",
  "check",
  "clock",
  "compose",
  "mic",
  "send",
  "steer",
  "skill",
  "stop",
  "model",
  "effort",
  "bolt",
  "usage",
  "panel-bottom",
  "panel-side",
  "panel-review",
  "panel-terminal",
  "panel-browser",
  "panel-files",
  "panel-side-chat",
  "warning",
  "spark",
  "cup",
];

describe("icons", () => {
  it("has every icon the design needs", () => {
    for (const name of REQUIRED) assert.ok(isIconName(name), name);
    assert.equal(new Set(ICON_NAMES).size, ICON_NAMES.length);
  });

  it("covers the catalog's action icons and the panels", () => {
    for (const a of ACTIONS) assert.ok(isIconName(a.icon), `${a.id}: ${a.icon}`);
    for (const p of PANELS) assert.ok(isIconName(p.icon), p.id);
    for (const p of PANELS) assert.equal(PANEL_ICON[p.id], p.icon);
  });

  it("renders each icon as a scaled group with round caps and joins", () => {
    for (const name of ICON_NAMES) {
      const g = icon(name, { x: 11, y: 11, size: 40, color: "#FFFFFF" });
      assert.match(g, /^<g transform="translate\(11 11\) scale\(1\.6667\)" stroke-linecap="round" stroke-linejoin="round">/, name);
      assert.ok(g.endsWith("</g>"), name);
      assert.doesNotMatch(g, /NaN|undefined|Infinity/, name);
      assert.ok(g.includes("#FFFFFF"), name);
      assert.ok(g.length < 2500, `${name}: ${g.length} chars`);
    }
  });

  it("converts the stroke width from output pixels to grid units", () => {
    assert.match(icon("check", { x: 0, y: 0, size: 48, color: "#fff", strokeWidth: 4 }), /stroke-width="2"/);
    assert.match(icon("check", { x: 0, y: 0, size: 72, color: "#fff" }), /stroke-width="2"/);
    assert.match(icon("check", { x: 0, y: 0, size: 24, color: "#fff", strokeWidth: 3 }), /stroke-width="3"/);
  });

  it("has solid variants for send, stop, bolt, spark and cup", () => {
    const send = icon("send", { x: 0, y: 0, size: 24, color: "#FFFFFF", knockout: "#123456" });
    assert.match(send, /fill="#FFFFFF"/);
    assert.match(send, /stroke="#123456"/);
    assert.doesNotMatch(icon("send", { x: 0, y: 0, size: 24, color: "#FFFFFF", fill: false }), /#000000/);
    assert.match(icon("stop", { x: 0, y: 0, size: 24, color: "#FFFFFF" }), /fill-rule="evenodd"/);
    assert.match(icon("bolt", { x: 0, y: 0, size: 24, color: "#D97757", fill: true }), /fill="#D97757"/);
    assert.match(icon("bolt", { x: 0, y: 0, size: 24, color: "#FFFFFF" }), /fill="none"/);
    assert.match(icon("spark", { x: 0, y: 0, size: 24, color: "#FFFFFF" }), /fill="#FFFFFF"/);
    // Cup: outline by default; the solid mug adds steam.
    const cup = icon("cup", { x: 0, y: 0, size: 24, color: "#FFFFFF" });
    assert.doesNotMatch(cup, /fill="#FFFFFF"|Q/);
    const full = icon("cup", { x: 0, y: 0, size: 24, color: "#D97757", fill: true });
    assert.match(full, /fill="#D97757"/);
    assert.equal((full.match(/Q/g) ?? []).length, 3);
  });

  it("builds an 8-ray spark inside its radius", () => {
    const pts = sparkPoints(12, 12, 11);
    assert.equal(pts.length, 16);
    for (const [x, y] of pts) assert.ok(Math.hypot(x - 12, y - 12) <= 11 + 1e-9);
    // Alternating outer / inner points.
    const r = pts.map(([x, y]) => Math.hypot(x - 12, y - 12));
    for (let i = 0; i < 16; i += 2) assert.ok(r[i]! > 3 * r[i + 1]!);
  });
});
