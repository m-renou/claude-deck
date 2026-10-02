// Claude Code for Stream Deck — plugin entry point. Self-contained: reads the Claude desktop app's local state through
// the hub and drives the app through src/ops.ts. Registers every action, then connects (the SDK requires connect() last).

import streamDeck from "@elgato/streamdeck";
import { renderAllActions } from "./actions/base.ts";
import { createActions } from "./actions/index.ts";
import { CLAUDE_BUNDLE_ID } from "./claude/paths.ts";
import { hub } from "./hub.ts";

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

// The manifest monitors the Claude desktop app (ApplicationsToMonitor).
streamDeck.system.onApplicationDidLaunch((ev) => {
  if (ev.application !== CLAUDE_BUNDLE_ID) return;
  log.info("Claude app launched");
  hub.snapshot.app = { ...hub.snapshot.app, running: true };
  refresh("app launch");
  void hub.checkAccess().catch(() => undefined);
  // Find the prompt box once the window is up (accessibility reads only), so the first Send Prompt press is fast.
  // (This handler marks the app running before the hub's own poll would notice the launch and warm up itself.)
  hub.warmSoon(8000);
});
streamDeck.system.onApplicationDidTerminate((ev) => {
  if (ev.application !== CLAUDE_BUNDLE_ID) return;
  log.info("Claude app quit");
  hub.snapshot.app = { ...hub.snapshot.app, running: false };
  refresh("app quit");
});
streamDeck.system.onSystemDidWakeUp(() => {
  refresh("wake");
  hub.warmSoon(); // re-check the prompt box's place (quick when it's still valid)
});

hub.start();

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
