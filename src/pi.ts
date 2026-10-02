// Property Inspector plumbing: answers the PI pages' requests and keeps the visible PI's status box current.
//
// Call sites (keep these signatures stable):
//   • src/actions/base.ts  onSendToPlugin  → handlePiMessage(actionId, ev)
//       actionId = catalog id ("model", "activity", …); ev = the SDK's SendToPluginEvent (ev.action, ev.payload).
//   • src/actions/base.ts  after every key operation → resultChanged(actionId, contextId, result)
//
// Requests (see src/pi-core.ts for the payloads): the sdpi-components datasources getChats / getSkills / getModels /
// getModelSlots / getFolders, and getStatus. Replies go to the PI that asked, and only while it is the visible one.
// While a PI is open, hub (KeepingYouAwake, live usage) changes and key results are pushed to it (throttled, and only
// when what it shows changed). The Usage page, while open and Claude Code is signed out, has live usage check every
// minute (the page says: sign in, then wait a minute).

import os from "node:os";
import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { lastResultFor, type StampedResult } from "./actions/core.ts";
import { activityPosition } from "./actions/settings.ts";
import { PLUGIN_UUID } from "./catalog.ts";
import { listSkills } from "./claude/extras.ts";
import { findClaudeCli } from "./claude/paths.ts";
import { readPlanUsage } from "./claude/usage.ts";
import { usageLive } from "./claude/usage-live.ts";
import { hub } from "./hub.ts";
import { chatItems, folderItems, modelItems, modelSlotItems, type PiEvent, type PiStatus, piRequest, skillItems, statusPayload } from "./pi-core.ts";
import { keepAwake } from "./system/keep-awake.ts";

const PREFIX = `${PLUGIN_UUID}.`;
/** A PI can ask before the plugin has processed its propertyInspectorDidAppear; replies wait this long for it. */
const REPLY_WAIT_MS = 1500;
const PUSH_THROTTLE_MS = 600;
const ACCESS_RECHECK_MS = 8000;
const CLI_RECHECK_MS = 60_000;
/** Signed out, with the Usage page open: ask Claude Code again at most this often. */
const SIGN_IN_RECHECK_MS = 60_000;

const log = streamDeck.logger.createScope("PI");

type EventLike = { action?: { id?: string }; payload?: unknown };
/** Anything sent to a PI: a JSON object with an `event`. */
type Payload = { event: string; [key: string]: unknown } | PiStatus;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Last payload sent per event to the visible PI (so pushes only go out when something changed). */
let sentFor: string | undefined;
const sent = new Map<string, string>();

async function sendTo(contextId: string, payload: Payload, waitMs = 0): Promise<void> {
  let ui = streamDeck.ui.action;
  for (let waited = 0; ui?.id !== contextId && waited < waitMs; waited += 50) {
    await sleep(50);
    ui = streamDeck.ui.action;
  }
  if (ui?.id !== contextId) return; // another PI (or none) is visible now
  if (sentFor !== contextId) {
    sentFor = contextId;
    sent.clear();
  }
  sent.set(payload.event, JSON.stringify(payload));
  try {
    await streamDeck.ui.sendToPropertyInspector(payload as unknown as JsonValue);
  } catch (err) {
    log.debug(`sendToPropertyInspector failed: ${String(err)}`);
  }
}

async function pushIfChanged(contextId: string, payload: Payload): Promise<void> {
  if (sentFor === contextId && sent.get(payload.event) === JSON.stringify(payload)) return;
  await sendTo(contextId, payload);
}

// ── Payloads ────────────────────────────────────────────────────────────────────────────────────────────

// base.ts imports this module (onSendToPlugin → handlePiMessage), so the action registry is loaded lazily instead of
// with a static import (no import cycle). It is in the same bundle: the import resolves at once.
type Registry = typeof import("./actions/base.ts");
let registry: Registry | undefined;
async function loadRegistry(): Promise<void> {
  registry ??= await import("./actions/base.ts");
}

function actionOf(actionId: string) {
  return registry?.allActions().find((a) => a.actionId === actionId);
}

/** The position an Activity key follows (keys only; dials browse instead). */
function followOf(contextId: string): { position: number; auto: boolean } | undefined {
  const act = actionOf("activity");
  const inst = act?.instance(contextId);
  if (!act || !inst || inst.controller !== "Keypad") return undefined;
  const positionOf = (act as unknown as { positionOf?: (i: typeof inst) => number }).positionOf;
  const position = typeof positionOf === "function" ? positionOf.call(act, inst) : activityPosition(inst.settings) || 1;
  return { position, auto: activityPosition(inst.settings) === 0 };
}

/** The Claude Code CLI the Usage page's sign-in command names before live usage ran one (looked up at most once a
 *  minute: the app updates it). */
let cliFound: { at: number; cli: string | undefined } | undefined;
function claudeCli(): string | undefined {
  const now = Date.now();
  if (!cliFound || now - cliFound.at > CLI_RECHECK_MS) cliFound = { at: now, cli: findClaudeCli() };
  return cliFound.cli;
}

export function buildStatus(actionId: string, contextId: string): PiStatus {
  const act = actionOf(actionId);
  const inst = act?.instance(contextId);
  return statusPayload({
    actionId,
    snap: hub.snapshot,
    needsAccess: !!act?.needsKeys,
    result: inst?.lastResult ?? lastResultFor(contextId),
    controller: inst?.controller,
    follow: actionId === "activity" ? followOf(contextId) : undefined,
    keepAwake: keepAwake.state, // statusPayload passes it on to Keep Awake pages only
    // Usage pages only (statusPayload drops it elsewhere): read the app's file only for them.
    liveUsage: actionId === "usage" ? { state: usageLive.state, watching: usageLive.watching, appSampleAt: readPlanUsage()?.at, cli: claudeCli(), now: Date.now() } : undefined,
  });
}

function chatsReply(contextId: string): Payload {
  const follow = followOf(contextId);
  return { event: "getChats", items: chatItems(hub.snapshot, Date.now()), ...(follow ? { follow: follow.position } : {}) };
}

function datasource(event: Exclude<PiEvent, "getStatus">, contextId: string): Payload {
  const snap = hub.snapshot;
  switch (event) {
    case "getChats":
      return chatsReply(contextId);
    case "getSkills":
      return { event, items: skillItems(listSkills(snap.selected?.cwd)) };
    case "getModels":
      return { event, items: modelItems(snap.models) };
    case "getModelSlots":
      return { event, items: modelSlotItems(snap.models) };
    case "getFolders":
      return { event, items: folderItems(snap.chats, os.homedir()) };
  }
}

// ── Accessibility re-check while a PI asks (so granting it shows up quickly) ────────────────────────────

let accessCheckedAt = 0;
function recheckAccess(): void {
  if (hub.snapshot.accessibility === true) return;
  const now = Date.now();
  if (now - accessCheckedAt < ACCESS_RECHECK_MS) return;
  accessCheckedAt = now;
  void hub.checkAccess().catch((err: unknown) => log.debug(`access check failed: ${String(err)}`));
}

// ── Entry points ────────────────────────────────────────────────────────────────────────────────────────

export async function handlePiMessage(actionId: string, ev: unknown): Promise<void> {
  const e = (ev ?? {}) as EventLike;
  const contextId = e.action?.id;
  if (!contextId) return;
  const req = piRequest(e.payload);
  if (!req) return;
  await loadRegistry();
  if (req.event === "getStatus") {
    recheckAccess();
    if (actionId === "usage" && usageLive.state.status === "signed-out") usageLive.refreshNow(SIGN_IN_RECHECK_MS);
    await sendTo(contextId, buildStatus(actionId, contextId), REPLY_WAIT_MS);
    return;
  }
  await sendTo(contextId, datasource(req.event, contextId), REPLY_WAIT_MS);
}

export function resultChanged(actionId: string, contextId: string, result: StampedResult): void | Promise<void> {
  void result;
  if (streamDeck.ui.action?.id !== contextId) return;
  return loadRegistry().then(() => pushIfChanged(contextId, buildStatus(actionId, contextId)));
}

/** Push the visible PI's status (and the chat list on Activity pages) when it changed. */
async function pushVisible(): Promise<void> {
  const ui = streamDeck.ui.action;
  if (!ui || !ui.manifestId.startsWith(PREFIX)) return;
  const actionId = ui.manifestId.slice(PREFIX.length);
  await loadRegistry();
  await pushIfChanged(ui.id, buildStatus(actionId, ui.id));
  if (actionId === "activity") await pushIfChanged(ui.id, chatsReply(ui.id));
}

let pushTimer: NodeJS.Timeout | undefined;
function schedulePush(): void {
  if (pushTimer || !streamDeck.ui.action) return;
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    pushVisible().catch((err: unknown) => log.warn(`PI push failed: ${String(err)}`));
  }, PUSH_THROTTLE_MS);
  pushTimer.unref?.();
}

hub.on("change", schedulePush);
keepAwake.on("change", schedulePush);
usageLive.on("change", schedulePush);
streamDeck.ui.onDidAppear((ev) => {
  sentFor = ev.action.id;
  sent.clear();
});
