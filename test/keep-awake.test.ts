// Keep Awake: reading KeepingYouAwake's state from ps (real lines from this Mac), the countdown and duration labels, the
// settings, what a press sends (a fake KYA behind an injectable runner — nothing runs ps or open), and the key image.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keepAwakeView } from "../src/actions/logic.ts";
import { KEEP_AWAKE_DURATIONS, keepAwakeMode, keepAwakeSeconds } from "../src/actions/settings.ts";
import { keepAwakeKey } from "../src/render/keys.ts";
import { C, countdown } from "../src/render/kit.ts";
import { durationLabel, KeepAwake, type KeepAwakeRunner, kyaAppPaths, kyaLink, parseAwake, parseEtime } from "../src/system/keep-awake.ts";

const NOW = 1_800_000_000_000;

// Real `ps -axo pid=,ppid=,etime=,args=` lines (KeepingYouAwake 1.6.8).
const KYA = "70988     1    05:12:09 /Applications/KeepingYouAwake.app/Contents/MacOS/KeepingYouAwake";
const SPARKLE = "70989     1    09:52:45 /Applications/KeepingYouAwake.app/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc/Contents/MacOS/Downloader";
const INDEFINITE = "11171 70988    03:37:41 /usr/bin/caffeinate -di -w 70988";
const TIMED = "36267 70988       00:01 /usr/bin/caffeinate -di -t 300 -w 70988";
/** Another app's caffeinate (its parent isn't KYA). */
const FOREIGN = "  812   640    1-02:03:04 /usr/bin/caffeinate -i -w 640";
const ps = (...lines: string[]) => `  1     0   10-01:00:00 /sbin/launchd\n${lines.join("\n")}\n`;

describe("parseEtime", () => {
  it("reads ps elapsed times", () => {
    assert.equal(parseEtime("00:01"), 1);
    assert.equal(parseEtime("05:12:09"), 5 * 3600 + 12 * 60 + 9);
    assert.equal(parseEtime("03:37:41"), 3 * 3600 + 37 * 60 + 41);
    assert.equal(parseEtime("1-02:03:04"), 86_400 + 2 * 3600 + 3 * 60 + 4);
    assert.equal(parseEtime("  12:00 "), 720);
  });

  it("rejects anything else", () => {
    for (const s of ["", "5", "abc", "1:2:3:4", "1-03:04", "00:61", "-00:01", "aa:bb"]) assert.equal(parseEtime(s), undefined, s);
  });
});

describe("parseAwake", () => {
  it("off: KYA runs without a caffeinate child", () => {
    assert.deepEqual(parseAwake(ps(KYA, SPARKLE), NOW), { running: true, active: false });
  });

  it("on indefinitely: KYA's caffeinate child without -t", () => {
    assert.deepEqual(parseAwake(ps(KYA, SPARKLE, INDEFINITE), NOW), { running: true, active: true, pid: 11171 });
  });

  it("on for a while: the end is start + t (start = now − elapsed)", () => {
    assert.deepEqual(parseAwake(ps(KYA, TIMED), NOW), { running: true, active: true, pid: 36267, until: NOW + 299_000 });
    const over = "36267 70988       05:10 /usr/bin/caffeinate -di -t 300 -w 70988";
    assert.equal(parseAwake(ps(KYA, over), NOW).until, NOW, "never in the past");
  });

  it("ignores other apps' caffeinate", () => {
    assert.deepEqual(parseAwake(ps(KYA, FOREIGN), NOW), { running: true, active: false });
    assert.deepEqual(parseAwake(ps(FOREIGN), NOW), { running: false, active: false });
  });

  it("off when KYA isn't running (its helper processes and ps / grep lines don't count)", () => {
    assert.deepEqual(parseAwake(ps(), NOW), { running: false, active: false });
    assert.deepEqual(parseAwake(ps(SPARKLE, INDEFINITE), NOW), { running: false, active: false });
    const grep = "4242   900       00:00 /usr/bin/grep /Applications/KeepingYouAwake.app/Contents/MacOS/KeepingYouAwake";
    assert.deepEqual(parseAwake(ps(grep), NOW), { running: false, active: false });
    assert.deepEqual(parseAwake("", NOW), { running: false, active: false });
  });

  it("finds KYA wherever it is installed", () => {
    const elsewhere = "70988     1    05:12:09 /Users/me/My Apps/KeepingYouAwake.app/Contents/MacOS/KeepingYouAwake";
    assert.deepEqual(parseAwake(ps(elsewhere, INDEFINITE), NOW), { running: true, active: true, pid: 11171 });
  });
});

describe("labels and links", () => {
  it("counts down compactly, rounding up", () => {
    assert.equal(countdown(45_000), "45s");
    assert.equal(countdown(44_200), "45s");
    assert.equal(countdown(59_500), "1m");
    assert.equal(countdown(12 * 60_000), "12m");
    assert.equal(countdown(11.5 * 60_000), "12m");
    assert.equal(countdown(30 * 60_000 - 1000), "30m");
    assert.equal(countdown(60 * 60_000), "1h");
    assert.equal(countdown(65 * 60_000), "1h 5m");
    assert.equal(countdown(5 * 3600_000), "5h");
    for (const v of [0, -5000, Number.NaN]) assert.equal(countdown(v), "0s");
  });

  it("names a session's length", () => {
    assert.deepEqual([45, 300, 1800, 3600, 5400, 7200, 18000].map(durationLabel), ["45 s", "5 min", "30 min", "1 hour", "1 h 30 min", "2 hours", "5 hours"]);
  });

  it("builds KYA's links", () => {
    assert.equal(kyaLink(true), "keepingyouawake:///activate");
    assert.equal(kyaLink(true, 1800), "keepingyouawake:///activate?seconds=1800");
    assert.equal(kyaLink(false, 1800), "keepingyouawake:///deactivate");
  });

  it("looks for the app in /Applications and ~/Applications", () => {
    assert.deepEqual(kyaAppPaths("/Users/me"), ["/Applications/KeepingYouAwake.app", "/Users/me/Applications/KeepingYouAwake.app"]);
  });
});

describe("settings", () => {
  it("mode: toggle unless on / off", () => {
    assert.equal(keepAwakeMode(undefined), "toggle");
    assert.equal(keepAwakeMode({}), "toggle");
    assert.equal(keepAwakeMode({ mode: "on" }), "on");
    assert.equal(keepAwakeMode({ mode: "off" }), "off");
    assert.equal(keepAwakeMode({ mode: "bogus" as never }), "toggle");
  });

  it("duration: seconds, 0 = indefinitely; junk and negatives are indefinitely", () => {
    assert.equal(keepAwakeSeconds(undefined), 0);
    assert.equal(keepAwakeSeconds({}), 0);
    assert.equal(keepAwakeSeconds({ duration: "0" }), 0);
    assert.equal(keepAwakeSeconds({ duration: "1800" }), 1800);
    assert.equal(keepAwakeSeconds({ duration: " 600 " }), 600);
    assert.equal(keepAwakeSeconds({ duration: 300 as never }), 300);
    assert.equal(keepAwakeSeconds({ duration: "12.7" }), 12);
    for (const d of ["-300", "abc", "1e3", "0.5", "", "Infinity"]) assert.equal(keepAwakeSeconds({ duration: d }), 0, d);
    assert.equal(keepAwakeSeconds({ duration: Number.POSITIVE_INFINITY as never }), 0);
  });

  it("every PI duration is one the key reads as itself", () => {
    for (const d of KEEP_AWAKE_DURATIONS) assert.equal(keepAwakeSeconds({ duration: d }), Number(d));
  });
});

// ── Pressing (a fake KeepingYouAwake) ───────────────────────────────────────────────────────────────────

const KYA_PID = 70988;

/** KYA as ps shows it, reacting to the links `open` gets (after `delayMs`; Infinity = never). */
class FakeKya {
  installed = true;
  running = false;
  child: { pid: number; t?: number; startedAt: number } | undefined;
  delayMs = 20;
  psFails = false;
  /** ps starts failing once a link was opened. */
  psFailsAfterOpen = false;
  opens: string[] = [];
  psCalls = 0;
  private nextPid = 50_000;

  constructor(o: { running?: boolean; on?: boolean; t?: number; installed?: boolean } = {}) {
    this.installed = o.installed ?? true;
    this.running = o.running ?? !!o.on;
    if (o.on) this.child = { pid: this.nextPid++, t: o.t, startedAt: Date.now() };
  }

  private etime(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  ps(): string {
    const lines = [FOREIGN];
    if (this.running) lines.push(`${KYA_PID}     1    05:12:09 /Applications/KeepingYouAwake.app/Contents/MacOS/KeepingYouAwake`);
    const c = this.child;
    if (this.running && c) lines.push(`${c.pid} ${KYA_PID} ${this.etime(Date.now() - c.startedAt)} /usr/bin/caffeinate -di${c.t ? ` -t ${c.t}` : ""} -w ${KYA_PID}`);
    return ps(...lines);
  }

  private follow(link: string): void {
    const u = new URL(link);
    this.running = true;
    if (u.pathname === "/activate") {
      const t = Number(u.searchParams.get("seconds") ?? 0);
      this.child = { pid: this.nextPid++, t: t || undefined, startedAt: Date.now() };
    } else if (u.pathname === "/deactivate") this.child = undefined;
  }

  runner: KeepAwakeRunner = {
    exec: async (file, args) => {
      if (file === "/bin/ps") {
        this.psCalls++;
        if (this.psFails) throw new Error("ps failed (1)");
        return this.ps();
      }
      if (file === "/usr/bin/open") {
        assert.equal(args[0], "-g", "opened in the background");
        const link = args[1]!;
        this.opens.push(link);
        if (this.psFailsAfterOpen) this.psFails = true;
        if (Number.isFinite(this.delayMs)) setTimeout(() => this.follow(link), this.delayMs);
        return "";
      }
      throw new Error(`unexpected command ${file}`);
    },
    exists: (p) => this.installed && p === "/Applications/KeepingYouAwake.app",
    now: () => Date.now(),
  };
}

const controller = (kya: FakeKya) => new KeepAwake(kya.runner, { pollMs: 25, confirmEveryMs: 5, confirmMs: 400 });

describe("KeepAwake.press", () => {
  it("toggle while on sends deactivate", async () => {
    const kya = new FakeKya({ on: true });
    const ka = controller(kya);
    const r = await ka.press("toggle");
    assert.deepEqual(kya.opens, ["keepingyouawake:///deactivate"]);
    assert.deepEqual(r, { ok: true, message: "Keep awake is off" });
    assert.deepEqual(ka.state, { installed: true, running: true, active: false });
  });

  it("toggle while off sends activate with the key's duration", async () => {
    const kya = new FakeKya({ running: true });
    const ka = controller(kya);
    const before = Date.now();
    const r = await ka.press("toggle", 1800);
    assert.deepEqual(kya.opens, ["keepingyouawake:///activate?seconds=1800"]);
    assert.deepEqual(r, { ok: true, message: "Keeping your Mac awake for 30 min" });
    assert.equal(ka.state.active, true);
    assert.ok(ka.state.until! >= before + 1_798_000 && ka.state.until! <= Date.now() + 1_800_000, String(ka.state.until));
    assert.equal(ka.state.pending, undefined);
  });

  it("toggle while KYA isn't running starts it (indefinitely)", async () => {
    const kya = new FakeKya();
    const ka = controller(kya);
    const r = await ka.press("toggle");
    assert.deepEqual(kya.opens, ["keepingyouawake:///activate"]);
    assert.deepEqual(r, { ok: true, message: "Keeping your Mac awake" });
    assert.deepEqual(ka.state, { installed: true, running: true, active: true });
  });

  it("'on' while on re-activates with the new duration", async () => {
    const kya = new FakeKya({ on: true });
    const ka = controller(kya);
    const r = await ka.press("on", 600);
    assert.deepEqual(kya.opens, ["keepingyouawake:///activate?seconds=600"]);
    assert.equal(r.ok, true);
    assert.equal(kya.child?.t, 600);
    assert.ok(Math.abs(ka.state.until! - (Date.now() + 600_000)) < 2000, "shows the new session's end");
  });

  it("'off' while off (KYA not running) does nothing", async () => {
    const kya = new FakeKya();
    const ka = controller(kya);
    assert.deepEqual(await ka.press("off"), { ok: true, message: "Keep awake is off" });
    assert.deepEqual(kya.opens, []);
  });

  it("refuses when KeepingYouAwake isn't installed, without opening anything", async () => {
    const kya = new FakeKya({ installed: false });
    const ka = controller(kya);
    assert.equal(ka.state.installed, false);
    const r = await ka.press("toggle", 300);
    assert.deepEqual(r, { ok: false, message: "KeepingYouAwake isn't installed (keepingyouawake.app)", feedback: "alert" });
    assert.deepEqual(kya.opens, []);
  });

  it("fails when KYA never follows, and doesn't leave the optimistic state up", async () => {
    const kya = new FakeKya({ running: true });
    kya.delayMs = Number.POSITIVE_INFINITY;
    const ka = controller(kya);
    const r = await ka.press("toggle");
    assert.deepEqual(r, { ok: false, message: "KeepingYouAwake didn't respond", feedback: "alert" });
    assert.deepEqual(kya.opens, ["keepingyouawake:///activate"]);
    assert.deepEqual(ka.state, { installed: true, running: true, active: false });
  });

  it("when ps fails after the open, goes back to the last state ps showed and blames the read", async () => {
    for (const delayMs of [Number.POSITIVE_INFINITY, 20]) {
      const kya = new FakeKya({ running: true });
      kya.delayMs = delayMs; // whether KYA follows or not, nothing can confirm it
      kya.psFailsAfterOpen = true;
      const ka = controller(kya);
      const r = await ka.press("toggle", 300);
      assert.deepEqual(kya.opens, ["keepingyouawake:///activate?seconds=300"]);
      assert.deepEqual(r, { ok: false, message: "Couldn't read KeepingYouAwake's state: ps failed (1)", feedback: "alert" });
      // Not the unconfirmed target (on, with an invented end time): the pre-press read, plus the error.
      assert.deepEqual(ka.state, { installed: true, running: true, active: false, error: "ps failed (1)" });
      kya.psFails = false;
      assert.equal((await ka.refresh()).error, undefined);
    }
  });

  it("when ps fails after some good reads, keeps the latest one", async () => {
    const kya = new FakeKya({ on: true, t: 600 });
    kya.delayMs = Number.POSITIVE_INFINITY;
    const runner = kya.runner;
    // Reads keep working for a few confirm rounds (KYA hasn't followed), then ps breaks.
    let reads = 0;
    const flaky: KeepAwakeRunner = { ...runner, exec: async (file, args) => (file === "/bin/ps" && ++reads > 4 ? Promise.reject(new Error("ps timed out")) : runner.exec(file, args)) };
    const ka = new KeepAwake(flaky, { pollMs: 25, confirmEveryMs: 5, confirmMs: 400 });
    const r = await ka.press("off");
    assert.deepEqual(r, { ok: false, message: "Couldn't read KeepingYouAwake's state: ps timed out", feedback: "alert" });
    assert.ok(reads > 4);
    assert.equal(ka.state.active, true, "still on, as the last good read said");
    assert.ok(Math.abs(ka.state.until! - (Date.now() + 600_000)) < 2000);
    assert.equal(ka.state.error, "ps timed out");
    assert.equal(ka.state.pending, undefined);
  });

  it("flips the key at once (pending) and polls don't overwrite it", async () => {
    const kya = new FakeKya({ running: true });
    kya.delayMs = 80;
    const ka = controller(kya);
    await ka.refresh();
    const seen: Array<{ active: boolean; pending?: boolean }> = [];
    ka.on("change", () => seen.push({ active: ka.state.active, pending: ka.state.pending }));
    const press = ka.press("toggle", 300);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ka.state.active, true);
    assert.equal(ka.state.pending, true);
    assert.ok(Math.abs(ka.state.until! - (Date.now() + 300_000)) < 1000);
    await ka.refresh(); // a poll that reads the old state while the press is pending
    assert.equal(ka.state.active, true);
    assert.equal(ka.state.pending, true);
    assert.equal((await press).ok, true);
    assert.equal(ka.state.pending, undefined);
    assert.equal(ka.state.active, true);
    assert.deepEqual(seen[0], { active: true, pending: true });
    assert.deepEqual(seen.at(-1), { active: true, pending: undefined });
  });

  it("presses from two keys run one after the other", async () => {
    const kya = new FakeKya({ running: true });
    const ka = controller(kya);
    const [a, b] = await Promise.all([ka.press("toggle"), ka.press("toggle")]);
    assert.deepEqual(kya.opens, ["keepingyouawake:///activate", "keepingyouawake:///deactivate"]);
    assert.equal(a.ok && b.ok, true);
    assert.equal(ka.state.active, false);
  });
});

describe("KeepAwake state", () => {
  it("a failed read keeps the last state, records the error and never throws", async () => {
    const kya = new FakeKya({ on: true });
    const ka = controller(kya);
    await ka.refresh();
    assert.equal(ka.state.active, true);
    kya.psFails = true;
    const s = await ka.refresh();
    assert.equal(s.active, true);
    assert.equal(s.error, "ps failed (1)");
    const r = await ka.press("toggle");
    assert.equal(r.ok, false);
    assert.match(r.message, /^Couldn't read KeepingYouAwake's state/);
    assert.deepEqual(kya.opens, []);
    kya.psFails = false;
    assert.equal((await ka.refresh()).error, undefined, "cleared by the next good read");
  });

  it("only polls while watching", async () => {
    const kya = new FakeKya({ on: true });
    const ka = controller(kya);
    assert.equal(ka.watching, false);
    let changes = 0;
    ka.on("change", () => changes++);
    ka.setWatching(true);
    ka.setWatching(true); // idempotent
    assert.equal(ka.watching, true);
    await new Promise((r) => setTimeout(r, 70));
    assert.ok(kya.psCalls >= 2, `polled ${kya.psCalls}×`);
    assert.equal(changes, 1, "only a real change is announced");
    assert.equal(ka.state.active, true);
    ka.setWatching(false);
    assert.equal(ka.watching, false);
    const calls = kya.psCalls;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(kya.psCalls, calls);
  });

  it("a timed session's end doesn't jitter with ps's 1 s resolution", async () => {
    const kya = new FakeKya({ on: true, t: 300 });
    const ka = controller(kya);
    const first = (await ka.refresh()).until;
    kya.child!.startedAt -= 400; // the next read lands in another elapsed second
    await new Promise((r) => setTimeout(r, 650));
    assert.equal((await ka.refresh()).until, first);
  });
});

// ── The key ─────────────────────────────────────────────────────────────────────────────────────────────

describe("Keep Awake key", () => {
  const texts = (s: string): string[] => [...s.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);

  it("maps KYA's state to the key", () => {
    assert.deepEqual(keepAwakeView({ installed: false, running: false, active: false }, NOW), { state: "na" });
    assert.deepEqual(keepAwakeView({ installed: true, running: true, active: false }, NOW), { state: "off" });
    assert.deepEqual(keepAwakeView({ installed: true, running: true, active: true }, NOW), { state: "on" });
    assert.deepEqual(keepAwakeView({ installed: true, running: true, active: true, until: NOW + 12 * 60_000 }, NOW), { state: "on", remaining: "12m" });
    assert.deepEqual(keepAwakeView({ installed: true, running: false, active: true, pending: true }, NOW), { state: "on" }, "a pending press shows its outcome");
  });

  it("on: accent mug filled, with steam", () => {
    const s = keepAwakeKey({ state: "on" });
    assert.match(s, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="144" height="144" viewBox="0 0 144 144"><rect x="0" y="0" width="144" height="144" fill="#000000"\/>/);
    assert.ok(s.includes(`fill="${C.accent}" stroke="${C.accent}"`));
    assert.equal((s.match(/Q/g) ?? []).length, 3, "three steam lines");
    assert.doesNotMatch(s, /fill-opacity|#FFFFFF/);
    assert.deepEqual(texts(s), []);
  });

  it("off: white outline, no steam; not installed: dimmed", () => {
    const off = keepAwakeKey({ state: "off" });
    assert.ok(off.includes(`fill="none" stroke="#FFFFFF"`));
    assert.doesNotMatch(off, /fill-opacity|Q/);
    assert.ok(!off.includes(C.accent));
    const na = keepAwakeKey({ state: "na" });
    assert.match(na, /fill-opacity="0.65"\/><\/svg>$/);
    assert.ok(na.includes(`stroke="#FFFFFF"`));
    assert.equal(keepAwakeKey({ state: "off", remaining: "5m" }), off, "no time while off");
  });

  it("draws the time left top-right in the time style", () => {
    const s = keepAwakeKey({ state: "on", remaining: "1h 5m" });
    assert.deepEqual(texts(s), ["1h 5m"]);
    const attrs = /<text ([^>]*)>1h 5m<\/text>/.exec(s)![1]!;
    for (const [k, v] of [["x", "128"], ["y", "33"], ["font-size", "17"], ["fill", C.grey], ["text-anchor", "end"]]) assert.ok(attrs.includes(`${k}="${v}"`), `${k}=${v}`);
    assert.doesNotMatch(s, /NaN|undefined|Infinity/);
    assert.ok(s.length < 9000);
  });

  it("moves the cup down under a time, so the steam clears the time row", () => {
    const at = (s: string) => /<g transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)"/.exec(s)!.slice(1).map(Number) as [number, number, number];
    const [x, y] = at(keepAwakeKey({ state: "on" }));
    assert.deepEqual([x, y], [33, 33], "centred without a time");
    for (const remaining of ["45s", "12m", "1h 5m", "4h 59m"]) {
      const s = keepAwakeKey({ state: "on", remaining });
      const [tx, ty, k] = at(s);
      assert.equal(tx, 33);
      assert.ok(ty > 33, `${remaining}: cup at y=${ty}`);
      // Steam tops (grid y 1.6 minus half the stroke) ≥ 8 px below the time's baseline; the mug stays on the key.
      const sw = Number(/stroke-width="([\d.]+)"/.exec(s)![1]);
      assert.ok(ty + (1.6 - sw / 2) * k >= 33 + 8, `${remaining}: steam top ${ty + (1.6 - sw / 2) * k}`);
      assert.ok(ty + (21.4 + sw / 2) * k <= 144 - 24, `${remaining}: mug bottom ${ty + (21.4 + sw / 2) * k}`);
    }
  });
});
