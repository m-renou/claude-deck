// Live usage: the poller over a fake Claude Code (test/fake-claude.ts) and a fake clock — no real CLI, no network.
// Nothing runs until a plan view shows; then one process answers every minute (61 s after its last answer: Claude Code
// repeats a cached answer within a minute), refresh-now is debounced, one request at a time, the process ends two
// minutes after the last plan view, a process that doesn't answer is replaced after 5 s … 5 min, signed out says how
// to sign in, failures keep the last sample, a process other sessions could reach is blocked until the app installs
// another Claude Code, and a throwing listener changes nothing.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { INBOX_OPEN, loginCommand, TURN_STARTED, UsageCli } from "../src/claude/usage-cli.ts";
import { LiveUsage, type LiveUsageOptions, type LiveUsageState } from "../src/claude/usage-live.ts";
import { CLI, FakeClaude, FakeClock, NEW_CLI, settle, SIGNED_OUT_RESPONSE, USAGE_RESPONSE } from "./fake-claude.ts";

const T0 = Date.UTC(2026, 9, 2, 20, 0);
const S = 1000;
const MIN = 60_000;

const fakes: FakeClaude[] = [];
const polls: LiveUsage[] = [];

function setup(o: { cli?: string | undefined; opts?: LiveUsageOptions } = {}) {
  const clock = new FakeClock(T0);
  const fake = new FakeClaude(clock.now);
  fakes.push(fake);
  let cli: string | undefined = "cli" in o ? o.cli : CLI;
  const source = new UsageCli({ spawn: fake.spawn, findCli: () => cli, clock, workDir: () => "/private/usage-cli", env: { HOME: "/Users/me", CLAUDE_CODE_OAUTH_TOKEN: "x" }, sessionRecord: fake.sessionRecord });
  const live = new LiveUsage({ source, clock }, o.opts);
  polls.push(live);
  const seen: LiveUsageState[] = [];
  live.on("change", () => seen.push(live.state));
  /** Request times since T0, in seconds. */
  const times = () => fake.usageTimes.map((t) => (t - T0) / S);
  return { clock, fake, live, source, seen, times, setCli: (c: string | undefined) => (cli = c) };
}

afterEach(() => {
  for (const l of polls.splice(0)) l.stop();
  for (const f of fakes.splice(0)) assert.deepEqual(f.violations, [], "only initialize / get_usage control requests reach Claude Code");
});

describe("LiveUsage", () => {
  it("runs nothing until a plan view shows; then asks at once and keeps the sample", async () => {
    const { clock, fake, live, seen } = setup();
    await clock.advance(10 * MIN);
    assert.equal(fake.procs.length, 0, "no Claude Code while nothing shows a plan view");
    assert.deepEqual(live.state, { status: "idle" });
    live.setWatching(true);
    await clock.advance(0);
    assert.equal(fake.procs.length, 1);
    assert.deepEqual(live.state, {
      status: "live",
      checkedAt: T0 + 10 * MIN,
      cli: CLI,
      sample: {
        at: T0 + 10 * MIN,
        source: "live",
        fiveHour: 15,
        weekly: 19,
        fiveHourResetsAt: Date.UTC(2026, 9, 2, 22, 39, 59, 847),
        weeklyResetsAt: Date.UTC(2026, 9, 8, 4, 59, 59, 847),
      },
    });
    assert.deepEqual(
      seen.map((s) => s.status),
      ["starting", "live"],
    );
  });

  it("asks every minute — 61 s after the last answer, past Claude Code's own one-minute cache — on one process", async () => {
    const { clock, fake, live, times } = setup();
    live.setWatching(true);
    await clock.advance(0);
    await clock.advance(3 * 61 * S);
    assert.deepEqual(times(), [0, 61, 122, 183]);
    assert.equal(fake.procs.length, 1, "one long-lived process");
    assert.equal(live.nextAt, T0 + 244 * S);
    live.setWatching(true); // idempotent
    await clock.advance(0);
    assert.equal(fake.usageRequests, 4);
  });

  it("refresh-now: not within 10 s of the last request, not while Claude Code would repeat itself, one at a time", async () => {
    const { clock, fake, live, times } = setup();
    live.setWatching(true);
    await clock.advance(0);
    await clock.advance(30 * S);
    live.refreshNow();
    await settle();
    assert.deepEqual(times(), [0], "within a minute of an answer Claude Code would only repeat it");
    fake.replies = [{ error: "Failed to fetch usage" }];
    await clock.advance(31 * S);
    assert.deepEqual([times(), live.state.status], [[0, 61], "error"]);
    await clock.advance(5 * S);
    live.refreshNow();
    await settle();
    assert.deepEqual(times(), [0, 61], "5 s after the last request");
    await clock.advance(5 * S);
    live.refreshNow();
    live.refreshNow();
    live.refreshNow();
    await settle();
    assert.deepEqual([times(), live.state.status], [[0, 61, 71], "live"], "one request for a burst");

    fake.replies = ["hang"];
    await clock.advance(61 * S);
    assert.deepEqual(times(), [0, 61, 71, 132]);
    await clock.advance(11 * S);
    live.refreshNow();
    await settle();
    assert.deepEqual(times(), [0, 61, 71, 132], "a request is on its way");
    assert.equal(fake.procs.length, 1);
  });

  it("ends the process two minutes after the last plan view went away; one back in time keeps it", async () => {
    const { clock, fake, live, times } = setup();
    live.setWatching(true);
    await clock.advance(0);
    const p = fake.last!;
    live.setWatching(false);
    assert.equal(live.watching, false);
    assert.equal(live.nextAt, undefined);
    await clock.advance(119 * S);
    assert.equal(p.ended, false);
    live.setWatching(true);
    await clock.advance(0);
    assert.deepEqual(times(), [0, 119], "back: asks at once (more than a minute passed), same process");
    live.setWatching(false);
    await clock.advance(119 * S);
    assert.equal(p.ended, false);
    await clock.advance(1 * S);
    assert.equal(p.ended, true, "stdin closed: Claude Code quits");
    assert.equal(p.exited, true);
    await clock.advance(30 * MIN);
    assert.deepEqual(times(), [0, 119], "no requests while nothing shows a plan view");
    live.setWatching(true);
    await clock.advance(0);
    assert.deepEqual([fake.procs.length, times().length, live.state.status], [2, 3, "live"]);
  });

  it("a refresh while nothing shows a plan view: the process still ends two minutes later", async () => {
    const { clock, fake, live } = setup();
    live.refreshNow();
    await clock.advance(0);
    assert.equal(live.state.status, "live");
    await clock.advance(119 * S);
    assert.equal(fake.last!.ended, false);
    await clock.advance(1 * S);
    assert.equal(fake.last!.ended, true);
  });

  it("no answer: the process is killed and a new one asks after 5 s, 10 s, 20 s … 5 min; an answer resets that", async () => {
    const { clock, fake, live, times, seen } = setup();
    fake.fallback = "hang";
    live.setWatching(true);
    await clock.advance(1100 * S);
    // 15 s timeout each, then the wait.
    assert.deepEqual(times(), [0, 20, 45, 80, 135, 230, 405, 720, 1035]);
    assert.equal(fake.procs.length, 9, "a new process each time");
    for (const p of fake.procs.slice(0, -1)) assert.deepEqual(p.signals, ["SIGTERM"], "killed");
    assert.deepEqual([live.state.status, live.state.message, live.state.retryAt], ["no-answer", "no answer within 15 s", T0 + 1350 * S]);
    assert.ok(seen.every((s) => s.status === "starting" || s.status === "no-answer"));

    fake.fallback = { response: USAGE_RESPONSE };
    await clock.advance(250 * S);
    assert.deepEqual([times().at(-1), live.state.status, live.state.retryAt], [1350, "live", undefined]);
    fake.fallback = "hang";
    await clock.advance(80 * S);
    assert.deepEqual(times().slice(-2), [1350, 1411]);
    await clock.advance(20 * S); // timed out at 1426: 5 s again
    assert.deepEqual(times().slice(-3), [1350, 1411, 1431]);
  });

  it("a crash during a request: no-answer in Claude Code's words, a new process 5 s later; a crash in between: the next minute's request starts one", async () => {
    const { clock, fake, live, times } = setup();
    fake.replies = [{ exit: 2, stderr: "Segmentation fault: 11\n" }];
    live.setWatching(true);
    await clock.advance(0);
    assert.deepEqual([live.state.status, live.state.message], ["no-answer", "Claude Code quit (exit 2): Segmentation fault: 11"]);
    await clock.advance(5 * S);
    assert.deepEqual([live.state.status, fake.procs.length], ["live", 2]);
    fake.last!.exit(null, "SIGSEGV");
    await clock.advance(60 * S);
    assert.deepEqual([times(), fake.procs.length], [[0, 5], 2], "nothing before the next request is due");
    await clock.advance(1 * S);
    assert.deepEqual([times(), fake.procs.length, live.state.status], [[0, 5, 66], 3, "live"]);
  });

  it("the Claude app updated Claude Code: the next request runs the new one", async () => {
    const { clock, fake, live, setCli } = setup();
    live.setWatching(true);
    await clock.advance(0);
    setCli(NEW_CLI);
    await clock.advance(61 * S);
    assert.deepEqual(
      fake.procs.map((p) => [p.file, p.ended]),
      [
        [CLI, true],
        [NEW_CLI, false],
      ],
    );
    assert.deepEqual([live.state.status, live.state.cli], ["live", NEW_CLI]);
  });

  it("signed out: says how to sign in, ends the process, asks anew every minute (every 5 min after ten tries) until signed in", async () => {
    const { clock, fake, live, times } = setup();
    live.setWatching(true);
    await clock.advance(0);
    const sample = live.state.sample;
    fake.fallback = { response: SIGNED_OUT_RESPONSE };
    await clock.advance(61 * S);
    assert.equal(live.state.status, "signed-out");
    assert.equal(live.state.message, `Claude Code isn't signed in — run ${loginCommand(CLI)} in Terminal once`);
    assert.equal(live.state.message, `Claude Code isn't signed in — run '${CLI}' auth login in Terminal once`);
    assert.equal(live.state.cli, CLI);
    assert.equal(live.state.sample, sample, "the last numbers stay");
    assert.equal(fake.last!.ended, true, "a running Claude Code may not notice a sign-in: ended");
    await clock.advance(9 * MIN);
    assert.deepEqual(times().slice(1), [61, 121, 181, 241, 301, 361, 421, 481, 541, 601]);
    assert.equal(fake.procs.length, 10, "a new process for every try after the first signed-out answer");
    await clock.advance(4 * MIN);
    assert.equal(times().length, 11, "after ten tries: every 5 min");
    await clock.advance(1 * MIN);
    assert.deepEqual(times().slice(-1), [901]);
    // The Usage page is open: it asks once a minute.
    await clock.advance(59 * S);
    live.refreshNow(MIN);
    await settle();
    assert.equal(times().length, 12, "not within a minute of the last try");
    await clock.advance(1 * S);
    fake.fallback = { response: USAGE_RESPONSE }; // signed in
    live.refreshNow(MIN);
    await settle();
    assert.deepEqual([times().slice(-1), live.state.status, live.state.message], [[961], "live", undefined]);
  });

  it("an error answer or one of another shape keeps the sample and the process, and is asked again next minute", async () => {
    const { clock, fake, live, times } = setup();
    live.setWatching(true);
    await clock.advance(0);
    const sample = live.state.sample;
    fake.replies = [{ error: "Rate limited" }, { response: { subscription_type: "max", rate_limits_available: true, rate_limits: null } }];
    await clock.advance(61 * S);
    assert.deepEqual([live.state.status, live.state.message, live.state.sample], ["error", "Rate limited", sample]);
    await clock.advance(60 * S);
    assert.deepEqual([live.state.status, live.state.message, live.state.sample], ["error", "Claude Code's usage answer had no rate limits", sample]);
    await clock.advance(60 * S);
    assert.deepEqual([times(), live.state.status, fake.procs.length], [[0, 61, 121, 181], "live", 1]);
  });

  it("no Claude Code: no-cli, nothing runs, looked for every minute, live once it's there", async () => {
    const { clock, fake, live, seen, setCli } = setup({ cli: undefined });
    live.setWatching(true);
    await clock.advance(5 * MIN);
    assert.deepEqual([live.state.status, live.state.message, fake.procs.length], ["no-cli", undefined, 0]);
    assert.deepEqual(
      seen.map((s) => s.status),
      ["starting", "no-cli"],
      "a failing check every minute isn't news",
    );
    setCli(CLI);
    await clock.advance(1 * MIN);
    assert.deepEqual([live.state.status, fake.procs.length], ["live", 1]);
  });

  it("a process that can't start: no-answer with the reason, tried again after the wait", async () => {
    const { clock, fake, live } = setup();
    fake.spawnThrows = new Error("spawn EACCES");
    live.setWatching(true);
    await clock.advance(0);
    assert.deepEqual([live.state.status, live.state.message, live.state.retryAt], ["no-answer", "Couldn't start Claude Code: spawn EACCES", T0 + 5 * S]);
    fake.spawnThrows = undefined;
    await clock.advance(5 * S);
    assert.equal(live.state.status, "live");
  });

  it("a \"change\" listener that throws changes nothing: the others still hear it, polling goes on", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { clock, live, times } = setup();
      let throws = 2;
      live.prependListener("change", () => {
        if (throws-- > 0) throw new Error("render boom");
      });
      let heard = 0;
      live.on("change", () => heard++);
      const errors: unknown[] = [];
      live.on("listenerError", (err: unknown) => errors.push(err));
      live.setWatching(true);
      await clock.advance(3 * 61 * S);
      assert.equal(times().length, 4, "polling on after the throws");
      assert.equal(live.state.status, "live", "the listener's error is not a live-usage error");
      assert.equal(live.state.message, undefined);
      assert.ok(heard >= 2, "the other listeners heard every change");
      assert.deepEqual(
        errors.map((e) => (e as Error).message),
        ["render boom", "render boom"],
      );
      assert.ok(live.nextAt !== undefined, "the next request is armed");
      await settle();
      assert.deepEqual(unhandled, [], "no unhandled rejections");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("blocked (an inbox for other sessions): killed, the sample kept, nothing starts until the app installs another Claude Code", async () => {
    const { clock, fake, live, seen, setCli, times } = setup();
    live.setWatching(true);
    await clock.advance(0);
    const sample = live.state.sample;
    fake.inbox = true;
    await clock.advance(61 * S);
    assert.deepEqual([live.state.status, live.state.message, live.state.sample, live.state.cli], ["blocked", INBOX_OPEN, sample, CLI]);
    assert.deepEqual(fake.procs[0]!.signals, ["SIGTERM"]);
    await clock.advance(10 * MIN);
    assert.deepEqual([times(), fake.procs.length], [[0, 61], 1], "looked for another Claude Code every minute; nothing ran");
    assert.deepEqual(
      seen.map((s) => s.status),
      ["starting", "live", "blocked"],
      "said once",
    );
    setCli(NEW_CLI);
    fake.inbox = false;
    await clock.advance(1 * MIN);
    assert.deepEqual([live.state.status, live.state.cli, fake.procs.length], ["live", NEW_CLI, 2]);
  });

  it("blocked by a turn between requests: the next request says so without starting Claude Code", async () => {
    const { clock, fake, live } = setup();
    live.setWatching(true);
    await clock.advance(0);
    fake.last!.print('{"type":"result","subtype":"success","result":"Done"}\n');
    await clock.advance(61 * S);
    assert.deepEqual([live.state.status, live.state.message, fake.procs.length], ["blocked", TURN_STARTED, 1]);
    live.refreshNow();
    await clock.advance(10 * S);
    assert.equal(fake.procs.length, 1);
  });

  it("shutdown(): the process gets SIGTERM at once and nothing new starts", async () => {
    const { clock, fake, live, times } = setup();
    live.setWatching(true);
    await clock.advance(0);
    live.shutdown();
    assert.deepEqual([fake.last!.ended, fake.last!.signals], [true, ["SIGTERM"]]);
    assert.deepEqual(clock.armed, [], "no timers left");
    await clock.advance(10 * MIN);
    assert.deepEqual([times(), fake.procs.length], [[0], 1]);
  });
});
