// Power (dial only): one scale of model × effort, "Faster" ↔ "Smarter" (Haiku → Sonnet low…max → Opus low…max →
// Fable low…max, from the app's model catalog). Rotate moves a pending choice (shown on the strip, with a dot where
// the chat is now); push or touch applies it to the selected chat: the model first (⌘⇧I + number), then the effort
// (the app's effort slider), stopping at the first failure. ops.ts confirms each change from the chat's session file
// in the background; one that never lands comes back through `late` (⚠ on the dial). A pending choice that isn't
// applied falls back to the chat's own setting after a few seconds.

import type { DialDownEvent, DialRotateEvent, TouchTapEvent } from "@elgato/streamdeck";
import { setEffort, setModel } from "../ops.ts";
import { powerDial, withDialBadge } from "../render/dial.ts";
import type { ActionResult, Snapshot } from "../types.ts";
import { ClaudeAction, type Inst } from "./base.ts";
import { applyPower, moveCursor, powerScale, powerStart, powerView } from "./dial-logic.ts";
import { DEFAULT_EFFORT_CYCLE } from "./logic.ts";
import { canvasPayload, dialLayout, ensureLayout } from "./feedback.ts";
import type { PowerSettings } from "./settings.ts";

/** How long a choice that wasn't applied stays on the strip. */
export const PENDING_MS = 8000;

export class PowerAction extends ClaudeAction<PowerSettings> {
  constructor() {
    super("power", { needsKeys: true });
  }

  protected override keySvg(): undefined {
    return undefined; // Encoder-only action
  }

  protected override pressKey(): ActionResult | undefined {
    return undefined;
  }

  protected override renderDial(inst: Inst<PowerSettings>, snap: Snapshot): void {
    ensureLayout(inst, dialLayout(this.actionId), this.log);
    const pending = typeof inst.state.pending === "string" ? inst.state.pending : undefined;
    let svg = powerDial(powerView(powerScale(snap.models), snap.selected, snap.models, pending));
    if (snap.accessibility === false) svg = withDialBadge(svg);
    this.paintFeedback(inst, canvasPayload(svg));
  }

  override onDialRotate(ev: DialRotateEvent<PowerSettings>): void {
    const inst = this.track(ev.action, ev.payload);
    const snap = this.snapshotNow();
    const scale = powerScale(snap.models);
    if (!snap.selected || !scale.length) return;
    const at = typeof inst.state.pending === "string" ? scale.findIndex((s) => s.key === inst.state.pending) : -1;
    const from = at >= 0 ? at : powerStart(scale, snap.selected, snap.models);
    this.setPending(inst, scale[moveCursor(from, ev.payload.ticks, scale.length)]!.key);
  }

  override async onDialDown(ev: DialDownEvent<PowerSettings>): Promise<void> {
    await this.apply(this.track(ev.action, ev.payload));
  }

  override async onTouchTap(ev: TouchTapEvent<PowerSettings>): Promise<void> {
    await this.apply(this.track(ev.action, ev.payload));
  }

  private setPending(inst: Inst<PowerSettings>, key: string | undefined): void {
    clearTimeout(inst.state.pendingTimer as NodeJS.Timeout | undefined);
    inst.state.pending = key;
    inst.state.pendingTimer = undefined;
    if (key !== undefined) {
      const t = setTimeout(() => {
        if (inst.state.pending !== key) return;
        inst.state.pending = undefined;
        this.render(inst);
      }, PENDING_MS);
      t.unref?.();
      inst.state.pendingTimer = t;
    }
    this.render(inst);
  }

  private async apply(inst: Inst<PowerSettings>): Promise<void> {
    const snap = this.snapshotNow();
    const scale = powerScale(snap.models);
    const key = typeof inst.state.pending === "string" ? inst.state.pending : undefined;
    const step = scale.find((s) => s.key === key);
    clearTimeout(inst.state.pendingTimer as NodeJS.Timeout | undefined); // keep the choice on the strip while it applies
    const result = await this.run(inst, () => {
      if (!step) {
        // Nothing turned: push re-applies nothing, it just says where the chat is.
        const v = powerView(scale, snap.selected, snap.models);
        return snap.selected && v.position >= 0
          ? { ok: true, message: `Already on ${v.model}${v.effort ? ` ${v.effort}` : ""}`, feedback: "ok" as const }
          : { ok: false, message: snap.selected ? "Turn the dial to pick a model and effort first." : "No Claude Code chat found. Open the Code tab in the Claude app first.", feedback: "alert" as const };
      }
      const late = this.late(inst);
      return applyPower(step, snap.selected, snap.models, {
        setModel: (model) => setModel(model, [model], late),
        setEffort: (level) => setEffort(level, [...DEFAULT_EFFORT_CYCLE], late),
      });
    });
    // Applied or failed: the strip goes back to what the chat reports now. Ignored (a previous push still running):
    // the choice stays, with a fresh timeout.
    if (inst.state.pending === key) this.setPending(inst, result ? undefined : key);
  }
}
