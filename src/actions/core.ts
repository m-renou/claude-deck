// SDK-free core of every action: per-instance bookkeeping, "only send what changed" painting, one operation at a
// time per key, and the last result per key (read by the Property Inspector). base.ts wires it to Stream Deck; tests
// drive it with fake surfaces.
//
// Feedback on the key: a failure shows Stream Deck's ⚠ (showAlert). A success shows nothing — the key's own image
// already shows the new state, and a big green check on every press was noise.

import type { ActionResult } from "../types.ts";

export type ControllerKind = "Keypad" | "Encoder" | "Neo";

/** The parts of a Stream Deck action instance the core touches (KeyAction, DialAction and NeoInfobarAction fit). */
export interface Surface {
  readonly id: string;
  setImage?(image?: string): Promise<void>;
  setFeedback?(payload: never): Promise<void>;
  showAlert?(): Promise<void>;
}

export interface Log {
  info(message: string): unknown;
  warn(message: string): unknown;
  error(message: string): unknown;
}

export interface StampedResult extends ActionResult {
  /** Catalog id of the action ("model"). */
  action: string;
  at: number;
}

export interface Instance<S, A extends Surface = Surface> {
  /** Stream Deck context id of this key / dial. */
  id: string;
  action: A;
  settings: S;
  controller: ControllerKind;
  deviceId: string;
  /** undefined inside a Multi Action. */
  coordinates?: { row: number; column: number };
  /** Last image sent with setImage (only re-sent when it changes). */
  image?: string;
  /** Last feedback payload sent with setFeedback (JSON, dial / Neo). */
  feedback?: string;
  /** An operation started by this key is still running. */
  busy: boolean;
  lastResult?: StampedResult;
  /** Free-form per-action state (the chat a key showed, a dial cursor…). */
  state: Record<string, unknown>;
}

/** Last result per context id, kept after the key scrolls away so the PI can still show it. */
const results = new Map<string, StampedResult>();
export const lastResultFor = (contextId: string): StampedResult | undefined => results.get(contextId);

export class InstanceTable<S, A extends Surface = Surface> {
  private readonly map = new Map<string, Instance<S, A>>();

  /** Add or refresh an instance (a key that re-appears is a fresh instance: its image is sent again). */
  upsert(init: { action: A; settings?: S; controller: ControllerKind; deviceId: string; coordinates?: { row: number; column: number } }): Instance<S, A> {
    let inst = this.map.get(init.action.id);
    if (!inst) {
      inst = {
        id: init.action.id,
        action: init.action,
        settings: init.settings ?? ({} as S),
        controller: init.controller,
        deviceId: init.deviceId,
        coordinates: init.coordinates,
        busy: false,
        lastResult: results.get(init.action.id),
        state: {},
      };
      this.map.set(inst.id, inst);
    } else {
      inst.action = init.action;
      inst.controller = init.controller;
      inst.deviceId = init.deviceId;
      inst.coordinates = init.coordinates ?? inst.coordinates;
      if (init.settings) inst.settings = init.settings;
    }
    return inst;
  }

  get(id: string): Instance<S, A> | undefined {
    return this.map.get(id);
  }

  delete(id: string): Instance<S, A> | undefined {
    const inst = this.map.get(id);
    this.map.delete(id);
    return inst;
  }

  values(): Instance<S, A>[] {
    return [...this.map.values()];
  }

  get size(): number {
    return this.map.size;
  }
}

const describe = (err: unknown): string => (err instanceof Error ? (err.stack ?? err.message) : String(err));

/** Send a key image unless it is the one this instance already shows. Returns true when it was sent. */
export function paintImage(inst: Instance<unknown>, image: string, log?: Log): boolean {
  if (inst.image === image || !inst.action.setImage) return false;
  inst.image = image;
  inst.action.setImage(image).catch((err: unknown) => {
    if (inst.image === image) inst.image = undefined; // try again on the next render
    log?.warn(`setImage failed: ${describe(err)}`);
  });
  return true;
}

/** Same for dial / Neo feedback payloads. */
export function paintFeedback(inst: Instance<unknown>, payload: Record<string, unknown>, log?: Log): boolean {
  const json = JSON.stringify(payload);
  if (inst.feedback === json || !inst.action.setFeedback) return false;
  inst.feedback = json;
  (inst.action.setFeedback as (this: Surface, p: unknown) => Promise<void>).call(inst.action, payload).catch((err: unknown) => {
    if (inst.feedback === json) inst.feedback = undefined;
    log?.warn(`setFeedback failed: ${describe(err)}`);
  });
  return true;
}

export interface RunOptions {
  /** Catalog id, for logs and the stored result. */
  actionId: string;
  log?: Log;
  /** Called after the result is stored (PI status push, re-render). */
  onResult?: (result: StampedResult) => void;
  now?: () => number;
}

/** A result that should put ⚠ on the key: every failure, and anything that explicitly asks for it. */
export const wantsAlert = (r: ActionResult): boolean => r.feedback === "alert" || (!r.ok && r.feedback === undefined);

/**
 * Record a result for a key: kept as its last result (for the PI, also after the key scrolls away), logged, ⚠ on a
 * failure (nothing on success), then `onResult`. Used for a press's result and for a failure an operation reports
 * later (a change the app never confirmed, after the press already returned).
 */
export function settle<S, A extends Surface>(inst: Instance<S, A>, result: ActionResult, opts: RunOptions): StampedResult {
  const stamped: StampedResult = { ...result, action: opts.actionId, at: (opts.now ?? Date.now)() };
  inst.lastResult = stamped;
  results.set(inst.id, stamped);
  const line = `${opts.actionId}: ${stamped.ok ? "ok" : "failed"} — ${stamped.message}`;
  if (stamped.ok) opts.log?.info(line);
  else opts.log?.warn(line);
  if (wantsAlert(stamped)) {
    try {
      inst.action.showAlert?.call(inst.action).catch(() => undefined);
    } catch {
      // a key that is gone can't show anything
    }
  }
  try {
    opts.onResult?.(stamped);
  } catch (err) {
    opts.log?.error(`${opts.actionId}: result handler failed: ${describe(err)}`);
  }
  return stamped;
}

/**
 * Run one operation for a key. A press while the previous one is still running is ignored (returns undefined):
 * a bounce or an impatient second press never sends a prompt twice. An operation that returns undefined handled the
 * press locally (nothing recorded). Otherwise the result is settled: failure → ⚠, success → no mark; always logged.
 */
export async function runExclusive<S, A extends Surface>(
  inst: Instance<S, A>,
  op: () => Promise<ActionResult | undefined> | ActionResult | undefined,
  opts: RunOptions,
): Promise<StampedResult | undefined> {
  if (inst.busy) {
    opts.log?.info(`${opts.actionId}: press ignored, the previous one is still running`);
    return undefined;
  }
  inst.busy = true;
  let result: ActionResult | undefined;
  try {
    result = await op();
  } catch (err) {
    opts.log?.error(`${opts.actionId}: ${describe(err)}`);
    result = { ok: false, message: `Something went wrong: ${err instanceof Error ? err.message : String(err)}`, feedback: "alert" };
  } finally {
    inst.busy = false;
  }
  if (!result) return undefined;
  return settle(inst, result, opts);
}
