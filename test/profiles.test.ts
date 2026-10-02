// Bundled profiles: layouts (actions, controllers, settings), the 7.x export format, the zip writer / reader, and that
// the files on disk + the manifest's Profiles list are up to date with scripts/gen-profiles.ts.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import url from "node:url";
import { ACTIONS, PANELS, PLUGIN_NAME, PLUGIN_UUID, actionUuid } from "../src/catalog.ts";
import { activityPosition, panelId, usageView } from "../src/actions/settings.ts";
import { BUILTIN_SKILLS } from "../src/claude/extras.ts";
import {
  LAYOUTS,
  NEO_INFOBAR_COORD,
  PROFILE_EXT,
  REVIEW_PROMPT,
  STEER_TEXT,
  ZERO_UUID,
  buildProfile,
  crc32,
  parseProfile,
  pluginVersion,
  profilePath,
  readZip,
  stableUuid,
  writeZip,
  type DeviceLayout,
  type Slot,
} from "../scripts/gen-profiles.ts";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const slots = (l: DeviceLayout): { slot: Slot; where: string; controller: "Keypad" | "Encoder" | "Neo" }[] => [
  ...l.keys.flatMap((row, r) =>
    row.flatMap((slot, c) => (slot ? [{ slot, where: `key ${c},${r}`, controller: "Keypad" as const }] : [])),
  ),
  ...(l.dials ?? []).map((slot, c) => ({ slot, where: `dial ${c}`, controller: "Encoder" as const })),
  ...(l.infobar ? [{ slot: l.infobar, where: "infobar", controller: "Neo" as const }] : []),
];

const grid = (l: DeviceLayout) => l.keys.map((row) => row.map((s) => s?.action ?? null));

describe("profile layouts", () => {
  it("cover Stream Deck, Mini, XL, + and Neo with matching file suffixes and grid sizes", () => {
    const expected: Record<number, [number, number]> = { 0: [5, 3], 1: [3, 2], 2: [8, 4], 7: [4, 2], 9: [4, 2] };
    assert.deepEqual(LAYOUTS.map((l) => l.deviceType).sort((a, b) => a - b), [0, 1, 2, 7, 9]);
    assert.equal(new Set(LAYOUTS.map((l) => l.file)).size, LAYOUTS.length);
    for (const l of LAYOUTS) {
      assert.match(l.file, new RegExp(` \\(${l.deviceType}\\)$`), l.file);
      assert.deepEqual([l.cols, l.rows], expected[l.deviceType], l.file);
      assert.equal(l.keys.length, l.rows, l.file);
      for (const row of l.keys) assert.equal(row.length, l.cols, l.file);
    }
  });

  it("only use catalog actions on controllers they support", () => {
    for (const l of LAYOUTS) {
      for (const { slot, where, controller } of slots(l)) {
        const def = ACTIONS.find((a) => a.id === slot.action);
        assert.ok(def, `${l.file} ${where}: unknown action ${slot.action}`);
        assert.ok(def.controllers.includes(controller), `${l.file} ${where}: ${slot.action} on ${controller}`);
      }
    }
  });

  it("carry valid settings", () => {
    const skills = new Set(BUILTIN_SKILLS.map((s) => s.name));
    for (const l of LAYOUTS) {
      const positions: number[] = [];
      for (const { slot, where, controller } of slots(l)) {
        const s = (slot.settings ?? {}) as Record<string, unknown>;
        const at = `${l.file} ${where}`;
        switch (slot.action) {
          case "activity":
            if (controller === "Keypad") {
              assert.ok(activityPosition(s) >= 1, `${at}: fixed position`);
              assert.equal(activityPosition(s), s.position, at);
              positions.push(activityPosition(s));
            }
            break;
          case "usage":
            assert.equal(usageView(s), s.view, at);
            break;
          case "toggle-panel":
            assert.equal(panelId(s), s.panel, at);
            break;
          case "run-skill":
            if (controller === "Keypad") {
              assert.ok(skills.has(String(s.skill)), `${at}: built-in skill ${String(s.skill)}`);
              assert.ok(!String(s.skill).startsWith("/"), at);
            }
            break;
          case "send-prompt":
            assert.ok(String(s.prompt ?? "").trim(), `${at}: prompt`);
            break;
          case "steer":
            assert.ok(String(s.text ?? "").trim(), `${at}: text`);
            break;
          case "model":
          case "effort":
            assert.equal(s.mode, "next", at);
            break;
        }
      }
      // Activity keys show the 1st, 2nd, … most recent chats, no gaps or repeats.
      assert.deepEqual(positions, positions.map((_, i) => i + 1), `${l.file}: activity positions`);
    }
  });

  it("have at most one Usage action per profile (the hub keeps one usage preference)", () => {
    for (const l of LAYOUTS) assert.ok(slots(l).filter((x) => x.slot.action === "usage").length <= 1, l.file);
  });

  it("15 keys mirror the Codex profile", () => {
    const sd = LAYOUTS.find((l) => l.deviceType === 0)!;
    assert.deepEqual(grid(sd), [
      ["activity", "activity", "activity", "activity", "usage"],
      ["new-chat", "dictate", "send-prompt", "steer", "stop"],
      ["model", "effort", "speed", "run-skill", "toggle-panel"],
    ]);
    assert.deepEqual(sd.keys[1]![2]!.settings, { prompt: REVIEW_PROMPT });
    assert.equal(REVIEW_PROMPT, "Review my changes and suggest improvements");
    assert.deepEqual(sd.keys[1]![3]!.settings, { text: STEER_TEXT });
    assert.equal(STEER_TEXT, "Focus on the failing test first");
    assert.deepEqual(sd.keys[2]![3]!.settings, { skill: "code-review" });
    assert.deepEqual(sd.keys[2]![4]!.settings, { panel: "review" });
  });

  it("XL has 8 Activity keys and every panel; + has the four dials; Neo has the infobar", () => {
    const xl = LAYOUTS.find((l) => l.deviceType === 2)!;
    assert.deepEqual(grid(xl)[0], Array(8).fill("activity"));
    const panels = slots(xl).filter((x) => x.slot.action === "toggle-panel").map((x) => x.slot.settings?.panel);
    assert.deepEqual([...panels].sort(), PANELS.map((p) => p.id).sort());

    const plus = LAYOUTS.find((l) => l.deviceType === 7)!;
    assert.deepEqual(plus.dials?.map((d) => d.action), ["activity", "run-skill", "power", "usage"]);

    const neo = LAYOUTS.find((l) => l.deviceType === 9)!;
    assert.ok(neo.infobar);
    for (const l of LAYOUTS) if (l !== plus) assert.equal(l.dials, undefined, l.file);
    for (const l of LAYOUTS) if (l !== neo) assert.equal(l.infobar, undefined, l.file);
  });
});

describe("zip writer", () => {
  it("computes the standard CRC-32", () => {
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
  });

  it("round-trips directories and deflated files", () => {
    const big = Buffer.from("x".repeat(10_000) + "é✓");
    const entries = [{ name: "a/" }, { name: "a/b.json", data: Buffer.from('{"k":1}') }, { name: "a/big.txt", data: big }];
    const back = readZip(writeZip(entries));
    assert.deepEqual(
      back.map((e) => [e.name, e.data && Buffer.from(e.data).toString()]),
      entries.map((e) => [e.name, e.data && Buffer.from(e.data).toString()]),
    );
    assert.ok(writeZip(entries).length < big.length, "deflated");
  });

  it("rejects corrupted data", () => {
    const zip = writeZip([{ name: "f.txt", data: Buffer.from("hello hello hello") }]);
    const bad = Buffer.from(zip);
    bad[30 + "f.txt".length + 2] ^= 0xff; // flip a byte inside the deflate stream
    assert.throws(() => readZip(bad));
    assert.throws(() => readZip(Buffer.from("not a zip at all, definitely not")));
  });
});

describe("profile format (Stream Deck 7.x export)", () => {
  it("stable UUIDs are well-formed and seed-dependent", () => {
    assert.match(stableUuid("a"), UUID_RE);
    assert.equal(stableUuid("a"), stableUuid("a"));
    assert.notEqual(stableUuid("a"), stableUuid("b"));
  });

  for (const layout of LAYOUTS) {
    it(`${layout.file}: package.json, umbrella and pages`, () => {
      const entries = buildProfile(layout);
      const p = parseProfile(writeZip(entries));

      assert.equal(p.names[0], "package.json");
      assert.deepEqual(p.pkg, {
        AppVersion: p.pkg.AppVersion,
        DeviceModel: layout.model,
        DeviceSettings: null,
        FormatVersion: 1,
        OSType: "macOS",
        OSVersion: p.pkg.OSVersion,
        RequiredPlugins: [PLUGIN_UUID],
      });
      assert.match(String(p.pkg.AppVersion), /^7\.\d+\.\d+\.\d+$/);

      assert.match(p.umbrellaId, /^[0-9A-F-]{36}$/);
      assert.equal(p.manifest.Version, "3.0");
      assert.equal(p.manifest.Name, PLUGIN_NAME);
      assert.equal(p.manifest.Device.Model, layout.model);
      assert.match(p.manifest.Device.UUID, UUID_RE);
      assert.equal(p.manifest.Pages.Current, ZERO_UUID);
      assert.equal(p.manifest.Pages.Pages.length, 1);
      assert.ok(!p.manifest.Pages.Pages.includes(p.manifest.Pages.Default));
      for (const dir of ["Profiles/", `Profiles/${p.umbrellaId}.sdProfile/Images/`])
        assert.ok(p.names.includes(dir), `directory entry ${dir}`);

      // The default page is the empty template for new pages, with the same controllers.
      const page = p.pages.get(p.manifest.Pages.Pages[0]!)!;
      const def = p.pages.get(p.manifest.Pages.Default)!;
      assert.deepEqual(def, { Controllers: page.Controllers.map((c) => ({ Actions: null, Type: c.Type })), Icon: "", Name: "" });

      const types = page.Controllers.map((c) => c.Type);
      assert.deepEqual(types, ["Keypad", ...(layout.dials ? ["Encoder"] : []), ...(layout.infobar ? ["Neo"] : [])]);
    });

    it(`${layout.file}: actions in place with plugin metadata`, () => {
      const p = parseProfile(writeZip(buildProfile(layout)));
      const page = p.pages.get(p.manifest.Pages.Pages[0]!)!;
      const byType = (t: string) => page.Controllers.find((c) => c.Type === t)?.Actions ?? {};
      const ids = new Set<string>();
      const check = (a: Record<string, unknown>, slot: Slot) => {
        const def = ACTIONS.find((x) => x.id === slot.action)!;
        assert.equal(a.UUID, actionUuid(def.id));
        assert.equal(a.Name, def.name);
        assert.deepEqual(a.Plugin, { Name: PLUGIN_NAME, UUID: PLUGIN_UUID, Version: pluginVersion() });
        assert.deepEqual(a.Settings, slot.settings ?? {});
        assert.equal(a.State, 0);
        assert.equal((a.States as unknown[]).length, 1);
        assert.equal((a.States as { ShowTitle: boolean }[])[0]!.ShowTitle, false);
        assert.match(String(a.ActionID), UUID_RE);
        ids.add(String(a.ActionID));
      };

      const keypad = byType("Keypad");
      const placed = layout.keys.flatMap((row, r) => row.flatMap((s, c) => (s ? [[`${c},${r}`, s] as const] : [])));
      assert.deepEqual(Object.keys(keypad).sort(), placed.map(([k]) => k).sort());
      for (const [k, s] of placed) check(keypad[k]!, s);

      const enc = byType("Encoder");
      assert.deepEqual(Object.keys(enc), (layout.dials ?? []).map((_, c) => `${c},0`));
      (layout.dials ?? []).forEach((s, c) => check(enc[`${c},0`]!, s));

      const neo = byType("Neo");
      assert.deepEqual(Object.keys(neo), layout.infobar ? [NEO_INFOBAR_COORD] : []);
      if (layout.infobar) check(neo[NEO_INFOBAR_COORD]!, layout.infobar);

      assert.equal(ids.size, slots(layout).length, "unique ActionIDs");
    });

    it(`${layout.file}: generation is deterministic`, () => {
      assert.deepEqual(buildProfile(layout), buildProfile(layout));
    });
  }

  it("every umbrella, page and action id is unique across profiles", () => {
    const seen = new Set<string>();
    for (const l of LAYOUTS) {
      const p = parseProfile(writeZip(buildProfile(l)));
      const page = p.pages.get(p.manifest.Pages.Pages[0]!)!;
      const ids = [
        p.umbrellaId.toLowerCase(),
        p.manifest.Pages.Default,
        ...p.manifest.Pages.Pages,
        ...page.Controllers.flatMap((c) => Object.values(c.Actions ?? {}).map((a) => String(a.ActionID))),
      ];
      for (const id of ids) {
        assert.ok(!seen.has(id), `duplicate id ${id}`);
        seen.add(id);
      }
    }
  });
});

describe("bundled files are up to date (npm run gen)", () => {
  for (const layout of LAYOUTS) {
    it(`${layout.file}${PROFILE_EXT} matches the generator`, () => {
      const file = profilePath(layout);
      assert.ok(fs.existsSync(file), `${file} missing: run npm run gen-profiles`);
      const onDisk = readZip(fs.readFileSync(file)).map((e) => [e.name, e.data && Buffer.from(e.data).toString("utf8")]);
      const fresh = buildProfile(layout).map((e) => [e.name, e.data && Buffer.from(e.data).toString("utf8")]);
      assert.deepEqual(onDisk, fresh);
    });
  }

  it("manifest.json lists every profile with its device type", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, `${PLUGIN_UUID}.sdPlugin/manifest.json`), "utf8"));
    const listed = (manifest.Profiles ?? []) as { Name: string; DeviceType: number }[];
    assert.deepEqual(
      listed.map((p) => [p.Name, p.DeviceType]).sort(),
      LAYOUTS.map((l) => [`profiles/${l.file}`, l.deviceType]).sort(),
    );
    assert.equal(manifest.Version, pluginVersion(), "profile Plugin.Version follows the manifest Version");
  });
});
