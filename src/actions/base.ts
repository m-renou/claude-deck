// Base class for every Claude Code action: tracks the visible instances (keys, dials, Neo infobars), re-renders them
// whenever the hub's snapshot changes (sending an image only when it changed), badges keys that type into the Claude
// app while macOS Accessibility is missing, runs one operation at a time per key and reports its result (⚠ on a
// failure, no mark on success; log; last result for the Property Inspector).
//
// Subclasses implement the keypad look (`keySvg`) and press (`pressKey`). Dial / Neo behaviour plugs in through
// `renderDial` / `renderNeo` (+ the SDK's onDialRotate / onDialDown / onTouchTap handlers), using `track`, `run` and
// `paintFeedback` from here — no rewrite of the keypad code needed.

import streamDeck, {
  type Action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { ACTIONS, type ActionDef, actionUuid } from "../catalog.ts";
import { hub } from "../hub.ts";
import { handlePiMessage, resultChanged } from "../pi.ts";
import { withBadge } from "../render/keys.ts";
import { dataUri } from "../render/kit.ts";
import type { ActionResult, Snapshot } from "../types.ts";
import { type ControllerKind, type Instance, InstanceTable, type Log, paintFeedback, paintImage, type RunOptions, runExclusive, settle, type StampedResult } from "./core.ts";

export type Inst<S extends JsonObject> = Instance<S, Action<S>>;

type PayloadLike<S> = { settings?: S; controller?: string; coordinates?: { row: number; column: number } };

const registry: ClaudeAction<JsonObject>[] = [];
let subscribed = false;

/** Re-render every visible instance of every action (hub change, clock tick). Unchanged images are not re-sent. */
export function renderAllActions(): void {
  for (const a of registry) a.renderAll();
}

/** All registered actions (PI handler, plugin entry). */
export const allActions = (): readonly ClaudeAction<JsonObject>[] => registry;

export abstract class ClaudeAction<S extends JsonObject = JsonObject> extends SingletonAction<S> {
  override readonly manifestId: string;
  /** Catalog id ("model"). */
  readonly actionId: string;
  readonly def: ActionDef;
  /** The action types into the Claude app (System Events) → shows the Accessibility badge while that's missing. */
  readonly needsKeys: boolean;
  protected readonly table = new InstanceTable<S, Action<S>>();
  protected readonly log: Log;

  constructor(actionId: string, opts: { needsKeys?: boolean } = {}) {
    super();
    const def = ACTIONS.find((a) => a.id === actionId);
    if (!def) throw new Error(`Unknown action id: ${actionId}`);
    this.def = def;
    this.actionId = actionId;
    this.manifestId = actionUuid(actionId); // what the @action({ UUID }) decorator would set
    this.needsKeys = !!opts.needsKeys;
    this.log = streamDeck.logger.createScope(def.name);
    registry.push(this as unknown as ClaudeAction<JsonObject>);
    if (!subscribed) {
      subscribed = true;
      hub.on("change", () => renderAllActions());
    }
  }

  // ─────────────────────────────────────────────────────────────── to implement

  /** Keypad image (SVG) for this instance; undefined = leave the key as it is. */
  protected abstract keySvg(inst: Inst<S>, snap: Snapshot): string | undefined;

  /** What a key press does. Return the operation's result, or undefined when the press was handled locally. */
  protected abstract pressKey(inst: Inst<S>): Promise<ActionResult | undefined> | ActionResult | undefined;

  /** Dial touch strip (Stream Deck +). Default: the manifest layout as it is. Use `paintFeedback`. */
  protected renderDial(_inst: Inst<S>, _snap: Snapshot): void {}

  /** Neo infobar. Default: nothing. Use `paintFeedback`. */
  protected renderNeo(_inst: Inst<S>, _snap: Snapshot): void {}

  /** An instance appeared, disappeared or its settings changed (Activity re-numbers its keys here). */
  protected instancesChanged(): void {}

  /** Settings arrived: the instance appeared or the PI changed them (runs before the re-render). */
  protected settingsChanged(_inst: Inst<S>): void {}

  // ─────────────────────────────────────────────────────────────── Stream Deck events

  override onWillAppear(ev: WillAppearEvent<S>): void {
    const inst = this.track(ev.action, ev.payload);
    inst.image = undefined; // the key was (re)drawn by Stream Deck: always send the first image
    inst.feedback = undefined;
    this.safe("willAppear", () => {
      this.settingsChanged(inst);
      this.instancesChanged();
    });
    this.render(inst);
  }

  override onWillDisappear(ev: WillDisappearEvent<S>): void {
    this.table.delete(ev.action.id);
    this.safe("willDisappear", () => this.instancesChanged());
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<S>): void {
    const inst = this.track(ev.action, ev.payload);
    this.safe("settings", () => {
      this.settingsChanged(inst);
      this.instancesChanged();
    });
    this.render(inst);
  }

  override async onKeyDown(ev: KeyDownEvent<S>): Promise<void> {
    const inst = this.track(ev.action, ev.payload);
    await this.run(inst, () => this.pressKey(inst));
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, S>): Promise<void> {
    try {
      await handlePiMessage(this.actionId, ev);
    } catch (err) {
      this.log.error(`PI message failed: ${describe(err)}`);
    }
  }

  // ─────────────────────────────────────────────────────────────── helpers (also for dial / Neo handlers)

  /** The hub's current snapshot. */
  protected snapshotNow(): Snapshot {
    return hub.snapshot;
  }

  /** Instances currently visible. */
  instances(): Inst<S>[] {
    return this.table.values();
  }

  instance(contextId: string): Inst<S> | undefined {
    return this.table.get(contextId);
  }

  /** Register / refresh the instance behind an event (any controller). */
  protected track(action: Action<S>, payload: PayloadLike<S> | undefined): Inst<S> {
    const coords = payload?.coordinates ?? action.coordinates;
    return this.table.upsert({
      action,
      settings: payload?.settings ?? undefined,
      controller: (payload?.controller as ControllerKind | undefined) ?? (action.controllerType as ControllerKind),
      deviceId: action.device.id,
      coordinates: coords ? { row: coords.row, column: coords.column } : undefined,
    });
  }

  /** Run an operation for this instance (one at a time; ⚠ on failure, no mark on success; logged; kept for the PI). */
  protected run(inst: Inst<S>, op: () => Promise<ActionResult | undefined> | ActionResult | undefined): Promise<StampedResult | undefined> {
    return runExclusive(inst, op, this.resultOptions(inst));
  }

  /**
   * Callback for a result an operation reports after the press already returned (ops' `onLate`, e.g. the app never
   * confirmed a model change): kept as the key's last result and logged; a failure puts ⚠ on the key, like a failed
   * press (a success shows no mark).
   */
  protected late(inst: Inst<S>): (result: ActionResult) => void {
    return (result) => {
      settle(inst, result, this.resultOptions(inst));
    };
  }

  private resultOptions(inst: Inst<S>): RunOptions {
    return {
      actionId: this.actionId,
      log: this.log,
      onResult: (r) => {
        this.render(inst);
        void Promise.resolve(resultChanged(this.actionId, inst.id, r)).catch((err: unknown) => this.log.warn(`PI status push failed: ${describe(err)}`));
      },
    };
  }

  /** Send a dial / Neo feedback payload unless it equals the last one. */
  protected paintFeedback(inst: Inst<S>, payload: Record<string, unknown>): boolean {
    return paintFeedback(inst, payload, this.log);
  }

  render(inst: Inst<S>): void {
    if (this.table.get(inst.id) !== inst) return; // gone (or re-appeared as a new instance)
    try {
      const snap = hub.snapshot;
      if (inst.controller === "Encoder") {
        this.renderDial(inst, snap);
        return;
      }
      if (inst.controller === "Neo") {
        this.renderNeo(inst, snap);
        return;
      }
      let svg = this.keySvg(inst, snap);
      if (svg === undefined) return;
      if (this.needsKeys && snap.accessibility === false) svg = withBadge(svg, "access");
      paintImage(inst, dataUri(svg), this.log);
    } catch (err) {
      // render runs in event-emitter and timer callbacks: never let it throw
      this.log.error(`render failed: ${describe(err)}`);
    }
  }

  renderAll(): void {
    for (const inst of this.table.values()) this.render(inst);
  }

  protected safe(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log.error(`${what} failed: ${describe(err)}`);
    }
  }
}

export const describe = (err: unknown): string => (err instanceof Error ? (err.stack ?? err.message) : String(err));

/** A failed result for keys that can't do anything right now. */
export const failure = (message: string): ActionResult => ({ ok: false, message, feedback: "alert" });
