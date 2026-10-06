// Claude Code for Stream Deck — plugin entry point. Self-contained: reads the Claude desktop app's local state through
// the hub and drives the app through src/ops.ts. Live usage (src/claude/usage-live.ts) keeps one Claude Code process
// (the CLI the app installs) running while a Usage key shows a plan view and asks it for the plan's usage every minute
// ("get_usage"; Claude Code reads it from Anthropic with its own sign-in — the plugin itself contacts no host). The
// process takes no messages from other Claude Code sessions (its inbox is switched off; should one open, or a turn
// start, it is killed: src/claude/usage-cli.ts). It is ended two minutes after the last plan view went away, and on
// exit. Registers every action, then connects (the SDK requires connect() last).

import os from "node:os";
import streamDeck from "@elgato/streamdeck";
import { renderAllActions } from "./actions/base.ts";
import { createActions } from "./actions/index.ts";
import { CLAUDE_BUNDLE_ID, CLAUDE_WIN_EXE } from "./claude/paths.ts";
import { usageLive } from "./claude/usage-live.ts";
import { hub } from "./hub.ts";
import { keepAwake } from "./system/awake.ts";

streamDeck.logger.setLevel("info");
const log = streamDeck.logger.createScope("Claude Code");

// Async listeners are fire-and-forget in the SDK, and render / hub work runs in timer callbacks: log stray errors
// instead of letting Node exit (Stream Deck would only restart the plugin into the same state).
process.on("unhandledRejection", (reason) => log.error(`unhandled rejection: ${(reason as Error)?.stack ?? String(reason)}`));
process.on("uncaughtException", (err) => log.error(`uncaught exception: ${err?.stack ?? String(err)}`));

const actions = createActions();
for (const a of actions) streamDeck.actions.registerAction(a);

/** Re-read the app's state right away (instead of waiting for the next poll). */
function refresh(why: string): void {
  try {
    hub.refresh(true);
  } catch (err) {
    log.error(`refresh after ${why} failed: ${(err as Error)?.stack ?? String(err)}`);
  }
}

// The manifest monitors the Claude desktop app (ApplicationsToMonitor): its bundle id on macOS, Claude.exe on Windows.
// On Windows that name is also a Claude Code CLI's (claude.exe), so there a launch is checked (the hub asks the
// helper, which tells the app from the CLI by its folder) instead of believed.
const isClaudeApp = (application: string): boolean =>
  process.platform === "win32" ? application.toLowerCase() === CLAUDE_WIN_EXE.toLowerCase() : application === CLAUDE_BUNDLE_ID;

streamDeck.system.onApplicationDidLaunch((ev) => {
  if (!isClaudeApp(ev.application)) return;
  if (process.platform === "win32") {
    void hub.recheckApp().catch(() => undefined);
    return;
  }
  log.info("Claude app launched");
  hub.snapshot.app = { ...hub.snapshot.app, running: true };
  refresh("app launch");
  void hub.checkAccess().catch(() => undefined);
  // Find the prompt box once the window is up (accessibility reads only), so the first Send Prompt press is fast.
  // (This handler marks the app running before the hub's own poll would notice the launch and warm up itself.)
  hub.warmSoon(8000);
});
streamDeck.system.onApplicationDidTerminate((ev) => {
  if (!isClaudeApp(ev.application)) return;
  if (process.platform === "win32") {
    void hub.recheckApp().catch(() => undefined);
    return;
  }
  log.info("Claude app quit");
  hub.snapshot.app = { ...hub.snapshot.app, running: false };
  refresh("app quit");
});
streamDeck.system.onSystemDidWakeUp(() => {
  refresh("wake");
  hub.warmSoon(); // re-check the prompt box's place (quick when it's still valid)
});

hub.start();
// A key / PI that failed to re-render on new live usage (the poller itself carries on).
usageLive.on("listenerError", (err: unknown) => log.error(`live-usage update failed: ${(err as Error)?.stack ?? String(err)}`));
// Log each status change (live / signed-out / no-answer …) with Claude Code's words.
let liveStatus = usageLive.state.status;
usageLive.on("change", () => {
  const { status, message } = usageLive.state;
  if (status === liveStatus) return;
  liveStatus = status;
  const line = `live usage: ${status}${message ? ` — ${message}` : ""}`;
  if (status === "live" || status === "starting" || status === "idle") log.info(line);
  else if (status === "blocked") log.error(line);
  else log.warn(line);
});
// Never leave Claude Code running behind the plugin. (Its stdin closes with the plugin anyway, which ends it too.)
process.on("exit", () => {
  usageLive.shutdown();
  if ("shutdown" in keepAwake) keepAwake.shutdown(); // Windows: end the keep-awake session with the plugin
});
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.once(sig, () => {
    usageLive.shutdown();
    if ("shutdown" in keepAwake) keepAwake.shutdown();
    process.exit(128 + (os.constants.signals[sig] ?? 0));
  });
}

// Times on Activity keys ("2m") move without the snapshot changing: re-render now and then (unchanged images
// are never re-sent).
const ticker = setInterval(() => {
  try {
    renderAllActions();
  } catch (err) {
    log.error(`tick failed: ${(err as Error)?.stack ?? String(err)}`);
  }
}, 10_000);
ticker.unref?.();

streamDeck
  .connect()
  .then(() => log.info(`connected: ${actions.length} actions`))
  .catch((err: unknown) => log.error(`connect failed: ${(err as Error)?.stack ?? String(err)}`));
