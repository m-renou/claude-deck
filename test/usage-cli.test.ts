// Claude Code's get_usage as a usage source: reading its answers (shaped like this Mac's real output), the line
// buffer, the stripped environment, the sign-in command, and the long-lived process behind a fake spawn and a fake
// clock — nothing runs the real CLI. Only initialize / get_usage control requests are ever written to it, its inbox for
// other sessions is switched off, and it's blocked (fails closed) when one opens anyway or a turn starts.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  CLI_ARGS,
  CliError,
  cliEnv,
  controlLine,
  INBOX_OPEN,
  isTurnLine,
  LineBuffer,
  loginCommand,
  messagingSocketOf,
  readUsageAnswer,
  shellQuote,
  TURN_STARTED,
  UsageCli,
  type UsageCliOptions,
} from "../src/claude/usage-cli.ts";
import { CLI, FakeClaude, FakeClock, NEW_CLI, settle, SIGNED_OUT_RESPONSE, USAGE_RESPONSE } from "./fake-claude.ts";

const AT = Date.UTC(2026, 9, 2, 21, 41);

describe("readUsageAnswer", () => {
  it("reads the 5-hour and weekly windows of a real-shaped answer", () => {
    assert.deepEqual(readUsageAnswer(USAGE_RESPONSE, AT), {
      kind: "usage",
      sample: {
        at: AT,
        source: "live",
        fiveHour: 15,
        weekly: 19,
        fiveHourResetsAt: Date.UTC(2026, 9, 2, 22, 39, 59, 847),
        weeklyResetsAt: Date.UTC(2026, 9, 8, 4, 59, 59, 847),
      },
    });
  });

  it("tolerates nulls, missing keys, numbers as strings and more than 100 %", () => {
    const answer = (rate_limits: unknown) => readUsageAnswer({ subscription_type: "max", rate_limits_available: true, rate_limits }, AT);
    assert.deepEqual(answer({ five_hour: null, seven_day: { utilization: "42", resets_at: null } }), { kind: "usage", sample: { at: AT, source: "live", weekly: 42 } });
    assert.deepEqual(answer({ seven_day: { utilization: 101.5, resets_at: "soon" } }), { kind: "usage", sample: { at: AT, source: "live", weekly: 101.5 } }, "over the limit is shown");
    assert.deepEqual(answer({ five_hour: { utilization: 7 }, seven_day: { utilization: null, resets_at: "2026-10-08T05:00:00Z" } }), { kind: "usage", sample: { at: AT, source: "live", fiveHour: 7 } });
    assert.deepEqual(answer({ five_hour: { utilization: 0, resets_at: 1_790_973_600 } }), { kind: "usage", sample: { at: AT, source: "live", fiveHour: 0, fiveHourResetsAt: 1_790_973_600_000 } }, "epoch seconds");
    for (const bad of [-1, "lots", "", Number.NaN, Number.POSITIVE_INFINITY, true, {}, [3]]) {
      const r = answer({ five_hour: { utilization: bad }, seven_day: { utilization: 5 } });
      assert.equal(r.kind === "usage" ? r.sample.fiveHour : "not usage", undefined, String(bad));
    }
    // rate_limits_available missing: the numbers still count.
    assert.equal(readUsageAnswer({ rate_limits: { seven_day: { utilization: 3 } } }, AT).kind, "usage");
  });

  it("signed out: no plan, no limits", () => {
    assert.deepEqual(readUsageAnswer(SIGNED_OUT_RESPONSE, AT), { kind: "signed-out" });
    assert.deepEqual(readUsageAnswer({ rate_limits_available: false }, AT), { kind: "signed-out" });
  });

  it("any other shape is an error, never a guess", () => {
    assert.deepEqual(readUsageAnswer({ subscription_type: "max", rate_limits_available: false, rate_limits: null }, AT), {
      kind: "invalid",
      message: "Claude Code has no usage numbers for this max plan right now",
    });
    for (const body of [null, undefined, "{}", 42, [], {}, { rate_limits: null }, { rate_limits: [] }, { rate_limits: { five_hour: null, seven_day: null } }, { rate_limits: { five_hour: "3%" } }, { rate_limits: { seven_day: [{ utilization: 1 }] } }]) {
      assert.equal(readUsageAnswer(body, AT).kind, "invalid", JSON.stringify(body));
    }
  });
});

describe("LineBuffer", () => {
  it("joins lines split across chunks, also inside a UTF-8 character", () => {
    const b = new LineBuffer();
    const text = '{"a":"ü🙂"}\r\n\n  \n{"b":2}\n{"c":';
    const buf = Buffer.from(text, "utf8");
    const out: string[] = [];
    for (let i = 0; i < buf.length; i++) out.push(...b.push(buf.subarray(i, i + 1)));
    assert.deepEqual(out, ['{"a":"ü🙂"}', '{"b":2}'], "whole lines only, blank ones and \\r dropped");
    assert.deepEqual(b.push("3}\n"), ['{"c":3}']);
  });

  it("drops a line longer than its limit, up to its newline, and carries on", () => {
    const b = new LineBuffer(10);
    assert.deepEqual(b.push("short\nxxxxxxxx"), ["short"]);
    assert.deepEqual(b.push("xxxxxxxx"), [], "over the limit: dropped");
    assert.deepEqual(b.push("xxxx\nnext\n"), ["next"], "its end goes too");
  });
});

describe("commands and environment", () => {
  it("the sign-in command names the Claude Code that runs, quoted for the shell", () => {
    assert.equal(loginCommand(CLI), `'${CLI}' auth login`);
    assert.equal(loginCommand("/opt/homebrew/bin/claude"), "/opt/homebrew/bin/claude auth login");
    assert.equal(loginCommand(undefined), "claude auth login");
    assert.equal(shellQuote("/Users/o'brien/My Apps/claude"), `'/Users/o'\\''brien/My Apps/claude'`);
    assert.equal(shellQuote("$(rm -rf ~)"), `'$(rm -rf ~)'`);
  });

  it("strips CLAUDE_CODE_*, ANTHROPIC_* and CLAUDECODE, keeps the rest, then switches the inbox for other sessions off", () => {
    const env = cliEnv({
      HOME: "/Users/me",
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/Users/me/.claude",
      CLAUDE_CODE_OAUTH_TOKEN: "x",
      CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
      ANTHROPIC_API_KEY: "y",
      ANTHROPIC_BASE_URL: "https://example.invalid",
      CLAUDECODE: "1",
      anthropic_api_key: "z",
      UNSET: undefined,
    });
    assert.deepEqual(env, { HOME: "/Users/me", PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/Users/me/.claude", CLAUDE_CODE_HARBOR_KITE: "0" });
    assert.equal(cliEnv({ CLAUDE_CODE_HARBOR_KITE: "1", claude_code_harbor_kite: "true" }).CLAUDE_CODE_HARBOR_KITE, "0", "set after the stripping: never on");
    assert.deepEqual(Object.keys(cliEnv({ claude_code_harbor_kite: "1" })), ["CLAUDE_CODE_HARBOR_KITE"]);
  });

  it("messages from other sessions are refused by setting too (--settings)", () => {
    const i = CLI_ARGS.indexOf("--settings");
    assert.ok(i > 0);
    assert.deepEqual(JSON.parse(CLI_ARGS[i + 1]!), { crossSessionInbound: "refuse" });
  });

  it("a session record names a messaging socket: its inbox is open", () => {
    assert.equal(messagingSocketOf({ pid: 1, kind: "interactive", messagingSocketPath: "/tmp/cc-socks/1.sock" }), "/tmp/cc-socks/1.sock");
    for (const r of [undefined, null, "x", [], {}, { messagingSocketPath: "" }, { messagingSocketPath: " " }, { messagingSocketPath: 3 }, { messagingSocketPath: null }]) {
      assert.equal(messagingSocketOf(r), undefined, JSON.stringify(r));
    }
  });

  it("a turn's lines: user / assistant / result, or a system init", () => {
    for (const m of [{ type: "user" }, { type: "assistant", message: {} }, { type: "result", subtype: "success" }, { type: "system", subtype: "init" }]) assert.equal(isTurnLine(m), true, JSON.stringify(m));
    for (const m of [{ type: "system", subtype: "status" }, { type: "control_response" }, { type: "control_request" }, { type: "keep_alive" }, { response: { type: "user" } }, [{ type: "user" }], "user", null]) {
      assert.equal(isTurnLine(m), false, JSON.stringify(m));
    }
  });

  it("control lines are one JSON line each", () => {
    assert.equal(controlLine("deck-usage-2", { subtype: "get_usage", skip_behaviors: true }), '{"type":"control_request","request_id":"deck-usage-2","request":{"subtype":"get_usage","skip_behaviors":true}}\n');
  });
});

// ── The process ─────────────────────────────────────────────────────────────────────────────────────────

const ENV = { HOME: "/Users/me", PATH: "/usr/bin:/bin", CLAUDE_CODE_OAUTH_TOKEN: "desktop-token", ANTHROPIC_BASE_URL: "https://proxy.invalid", CLAUDECODE: "1" };
const fakes: FakeClaude[] = [];

function setup(o: { cli?: string | undefined; opts?: UsageCliOptions } = {}) {
  const clock = new FakeClock(AT);
  const fake = new FakeClaude();
  fakes.push(fake);
  let cli: string | undefined = "cli" in o ? o.cli : CLI;
  const usage = new UsageCli({ spawn: fake.spawn, findCli: () => cli, clock, workDir: () => "/private/usage-cli", env: ENV, sessionRecord: fake.sessionRecord }, o.opts);
  return { clock, fake, usage, setCli: (c: string | undefined) => (cli = c) };
}

/** Settle a request, failing the test on a hang. */
async function outcome(p: Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; err: CliError }> {
  let r: { ok: true; value: unknown } | { ok: false; err: CliError } | undefined;
  p.then(
    (value) => (r = { ok: true, value }),
    (err: CliError) => (r = { ok: false, err }),
  );
  await settle(20);
  assert.ok(r, "the request settled");
  return r;
}

afterEach(() => {
  for (const f of fakes.splice(0)) assert.deepEqual(f.violations, [], "only initialize / get_usage control requests reach Claude Code");
});

describe("UsageCli", () => {
  it("starts Claude Code once, in its own folder, with the stream-json flags, and keeps it for the next request", async () => {
    const { fake, usage } = setup();
    const r = await outcome(usage.request());
    assert.deepEqual(r, { ok: true, value: USAGE_RESPONSE });
    assert.equal(fake.procs.length, 1);
    const p = fake.last!;
    assert.equal(p.file, CLI);
    assert.ok(!p.args.includes("--bare"), "--bare never reads the sign-in");
    assert.deepEqual(p.args, [...CLI_ARGS]);
    assert.deepEqual(p.args, [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--setting-sources",
      "user",
      "--settings",
      '{"crossSessionInbound":"refuse"}',
    ]);
    assert.equal(p.cwd, "/private/usage-cli");
    assert.equal(usage.running, true);
    assert.equal(usage.cli, CLI);
    assert.equal(usage.pid, p.pid);

    assert.deepEqual((await outcome(usage.request())).ok, true);
    assert.equal(fake.procs.length, 1, "one process for every request");
    assert.deepEqual(
      p.lines.map((l) => JSON.parse(l)),
      [
        { type: "control_request", request_id: "deck-init-1", request: { subtype: "initialize" } },
        { type: "control_request", request_id: "deck-usage-2", request: { subtype: "get_usage", skip_behaviors: true } },
        { type: "control_request", request_id: "deck-usage-3", request: { subtype: "get_usage", skip_behaviors: true } },
      ],
      "initialize once, then get_usage — never a prompt or user message",
    );
  });

  it("runs without the plugin's CLAUDE_CODE_* / ANTHROPIC_* / CLAUDECODE variables (its own sign-in)", async () => {
    const { fake, usage } = setup();
    await outcome(usage.request());
    assert.deepEqual(fake.last!.env, { HOME: "/Users/me", PATH: "/usr/bin:/bin", CLAUDE_CODE_HARBOR_KITE: "0" }, "and with its inbox for other sessions off");
  });

  it("reads its answer from lines split anywhere, and skips every other line", async () => {
    const { fake, usage } = setup();
    fake.chunk = 3; // the 31 KB initialize answer and ours arrive in 3-byte pieces
    fake.replies = [
      {
        noise: [
          "not json at all",
          "{id} in a line that isn't JSON",
          '{"type":"keep_alive"}',
          '{"type":"system","subtype":"status","note":"{id}"}',
          '{"type":"control_request","request_id":"cli-1","request":{"subtype":"can_use_tool"}}',
          '{"type":"control_response","response":{"subtype":"success","request_id":"{id}0","response":{"rate_limits":{"five_hour":{"utilization":99}}}}}',
          '{"type":"control_response","response":{"subtype":"success","request_id":"deck-usage-77","response":{}}}',
          "[1,2,3]",
        ],
        then: { response: USAGE_RESPONSE },
      },
    ];
    assert.deepEqual(await outcome(usage.request()), { ok: true, value: USAGE_RESPONSE });
  });

  it("an error answer fails the request (kind answer) and keeps the process", async () => {
    const { fake, usage } = setup();
    fake.replies = [{ error: "Failed to fetch usage:\n 503 upstream" }];
    const r = await outcome(usage.request());
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.err instanceof CliError);
    assert.deepEqual(!r.ok && [r.err.kind, r.err.message], ["answer", "Failed to fetch usage: 503 upstream"]);
    assert.equal(usage.running, true);
    assert.equal((await outcome(usage.request())).ok, true);
    assert.equal(fake.procs.length, 1);
  });

  it("one request at a time: a second caller gets the same answer", async () => {
    const { fake, usage } = setup();
    const a = usage.request();
    const b = usage.request();
    assert.equal(a, b);
    await outcome(a);
    assert.equal(fake.last!.usageRequests, 1);
  });

  it("no answer in time: the request fails, the process is killed (SIGKILL when it lingers), the next request starts a new one", async () => {
    const { clock, fake, usage } = setup();
    fake.replies = ["hang"];
    fake.exitOnEnd = false;
    fake.ignoreSigterm = true;
    let err: CliError | undefined;
    usage.request().catch((e: CliError) => (err = e));
    await clock.advance(14_999);
    assert.equal(err === undefined, true, "not yet");
    await clock.advance(1);
    assert.deepEqual([err?.kind, err?.message], ["timeout", "no answer within 15 s"]);
    const first = fake.last!;
    assert.deepEqual(first.signals, ["SIGTERM"]);
    assert.equal(usage.running, false);
    await clock.advance(2000);
    assert.deepEqual(first.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(first.exited, true);

    assert.equal((await outcome(usage.request())).ok, true);
    assert.equal(fake.procs.length, 2);
    assert.notEqual(fake.last!.pid, first.pid);
    assert.match(fake.last!.lines[1]!, /"deck-usage-4"/, "request ids stay unique across processes");
  });

  it("quits before answering: the request fails with its exit and the first line of its stderr", async () => {
    const { fake, usage } = setup();
    fake.replies = [{ exit: 1, stderr: `\nError: Invalid API key · Please run /login\n${"    at stack frame\n".repeat(5000)}` }];
    const r = await outcome(usage.request());
    assert.deepEqual(!r.ok && [r.err.kind, r.err.message], ["exited", "Claude Code quit (exit 1): Error: Invalid API key · Please run /login"]);
    assert.equal(usage.running, false);
    assert.equal((await outcome(usage.request())).ok, true, "a new one answers");
    assert.equal(fake.procs.length, 2);
  });

  it("a process that can't start fails the request (kind spawn), also when spawn throws", async () => {
    const { fake, usage } = setup();
    const p = usage.request();
    fake.last!.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
    const r = await outcome(p);
    assert.deepEqual(!r.ok && [r.err.kind, r.err.message], ["spawn", "Couldn't start Claude Code: spawn EACCES"]);
    fake.spawnThrows = new Error("EBADF");
    const r2 = await outcome(usage.request());
    assert.deepEqual(!r2.ok && [r2.err.kind, r2.err.message], ["spawn", "Couldn't start Claude Code: EBADF"]);
  });

  it("the Claude app updated Claude Code: the old process is ended, the new one runs", async () => {
    const { clock, fake, usage, setCli } = setup();
    await outcome(usage.request());
    const old = fake.last!;
    fake.exitOnEnd = false; // the old one lingers: SIGTERM after 2 s
    setCli(NEW_CLI);
    assert.equal((await outcome(usage.request())).ok, true);
    assert.equal(old.ended, true);
    assert.deepEqual([fake.procs.length, fake.last!.file, usage.cli], [2, NEW_CLI, NEW_CLI]);
    await clock.advance(2000);
    assert.deepEqual(old.signals, ["SIGTERM"]);
    assert.deepEqual(fake.last!.signals, [], "the new one runs on");
  });

  it("no Claude Code: fails at once (kind no-cli), nothing runs", async () => {
    const { fake, usage } = setup({ cli: undefined });
    const r = await outcome(usage.request());
    assert.deepEqual(!r.ok && [r.err.kind, r.err.message], ["no-cli", "Claude Code isn't installed in the Claude app yet"]);
    assert.equal(fake.procs.length, 0);
    assert.equal(usage.cli, undefined);
  });

  it("stop(): stdin closes; SIGTERM after 2 s and SIGKILL after 4 s only while it lingers; a request on its way fails", async () => {
    const { clock, fake, usage } = setup();
    await outcome(usage.request());
    const quick = fake.last!;
    usage.stop();
    assert.equal(quick.ended, true);
    await clock.advance(5000);
    assert.equal(quick.exited, true);
    assert.deepEqual(quick.signals, [], "it quit by itself when stdin closed");

    fake.exitOnEnd = false;
    fake.ignoreSigterm = true;
    fake.replies = ["hang"];
    let err: CliError | undefined;
    usage.request().catch((e: CliError) => (err = e));
    await settle();
    const slow = fake.last!;
    usage.stop();
    await settle();
    assert.equal(err?.kind, "stopped");
    await clock.advance(1999);
    assert.deepEqual(slow.signals, []);
    await clock.advance(1);
    assert.deepEqual(slow.signals, ["SIGTERM"]);
    await clock.advance(2000);
    assert.deepEqual(slow.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(usage.running, false);
  });

  it("shutdown(): every process not gone yet gets SIGTERM at once", async () => {
    const { fake, usage, setCli } = setup();
    fake.exitOnEnd = false;
    await outcome(usage.request());
    setCli(NEW_CLI);
    await outcome(usage.request()); // the first one is still on its way out
    const [a, b] = fake.procs;
    usage.shutdown();
    assert.deepEqual([a!.ended, b!.ended], [true, true]);
    assert.deepEqual([a!.signals, b!.signals], [["SIGTERM"], ["SIGTERM"]]);
    assert.equal(usage.running, false);
  });
});

describe("UsageCli fails closed when other sessions could reach it", () => {
  it("its session record names a messaging socket: the answer is dropped, the process killed, that Claude Code not started again", async () => {
    const { clock, fake, usage, setCli } = setup();
    fake.inbox = true;
    fake.exitOnEnd = false;
    fake.ignoreSigterm = true;
    const r = await outcome(usage.request());
    assert.deepEqual(!r.ok && [r.err.kind, r.err.message], ["blocked", INBOX_OPEN], "no numbers from a process other sessions can message");
    const first = fake.last!;
    assert.deepEqual(first.signals, ["SIGTERM"], "killed at once, not after stdin closes");
    assert.equal(first.ended, true);
    assert.equal(usage.running, false);
    await clock.advance(2000);
    assert.deepEqual(first.signals, ["SIGTERM", "SIGKILL"]);

    const again = await outcome(usage.request());
    assert.deepEqual(!again.ok && [again.err.kind, again.err.message], ["blocked", INBOX_OPEN]);
    assert.equal(fake.procs.length, 1, "nothing starts for the same Claude Code");

    setCli(NEW_CLI); // the app installed another one
    fake.inbox = false;
    assert.equal((await outcome(usage.request())).ok, true);
    assert.deepEqual([fake.procs.length, fake.last!.file], [2, NEW_CLI]);
  });

  it("a turn's line while a request is on its way: the request fails (blocked), the process is killed", async () => {
    const { fake, usage } = setup();
    fake.chunk = 5;
    fake.replies = [{ noise: ['{"type":"system","subtype":"init","session_id":"s","tools":[]}'], then: { response: USAGE_RESPONSE } }];
    const r = await outcome(usage.request());
    assert.deepEqual(!r.ok && [r.err.kind, r.err.message], ["blocked", TURN_STARTED]);
    assert.deepEqual(fake.last!.signals, ["SIGTERM"]);
    assert.equal(usage.running, false);
    assert.equal((await outcome(usage.request())).ok, false);
    assert.equal(fake.procs.length, 1);
  });

  it("a turn's line between requests (a message from another session): killed at once, the next request fails without starting one", async () => {
    const { fake, usage } = setup();
    assert.equal((await outcome(usage.request())).ok, true);
    const p = fake.last!;
    p.print('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"On it"}]}}\n');
    await settle();
    assert.deepEqual(p.signals, ["SIGTERM"]);
    assert.equal(usage.running, false);
    const r = await outcome(usage.request());
    assert.deepEqual(!r.ok && [r.err.kind, r.err.message], ["blocked", TURN_STARTED]);
    assert.equal(fake.procs.length, 1);
    assert.equal(p.usageRequests, 1);
  });

  it("lines that only mention a turn's type don't count", async () => {
    const { fake, usage } = setup();
    fake.replies = [
      {
        noise: [
          '{"type":"system","subtype":"status","status":"idle"}',
          '{"type":"control_response","response":{"subtype":"success","request_id":"other","response":{"messages":[{"type":"user"},{"type":"assistant"}]}}}',
          '{"note":"{\\"type\\":\\"result\\"}"}',
          '{"type":"user" broken json',
        ],
        then: { response: USAGE_RESPONSE },
      },
    ];
    assert.deepEqual(await outcome(usage.request()), { ok: true, value: USAGE_RESPONSE });
    assert.equal(usage.running, true);
  });

  it("reads Claude Code's own session records (under CLAUDE_CONFIG_DIR) by default", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cli-test-"));
    try {
      const clock = new FakeClock(AT);
      const fake = new FakeClaude();
      fakes.push(fake);
      const usage = new UsageCli({ spawn: fake.spawn, findCli: () => CLI, clock, workDir: () => "/private/usage-cli", env: { HOME: "/Users/me", CLAUDE_CONFIG_DIR: dir } });
      assert.equal((await outcome(usage.request())).ok, true, "no record: nothing to go on");
      fs.mkdirSync(path.join(dir, "sessions"));
      fs.writeFileSync(path.join(dir, "sessions", `${fake.last!.pid}.json`), JSON.stringify({ pid: fake.last!.pid, kind: "interactive" }));
      assert.equal((await outcome(usage.request())).ok, true, "a record without a socket");
      fs.writeFileSync(path.join(dir, "sessions", `${fake.last!.pid}.json`), JSON.stringify({ pid: fake.last!.pid, messagingSocketPath: "/tmp/cc-socks/x.sock" }));
      const r = await outcome(usage.request());
      assert.deepEqual(!r.ok && r.err.kind, "blocked");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
