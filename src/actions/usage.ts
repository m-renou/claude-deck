// Usage: label ("Weekly" / "5-hour" / "Context"), big percentage, two grey lines and a vertical bar. Each key shows
// its own view (settings.view → hub.usageFor(view): a Weekly key never shows Context — without weekly data it keeps
// its label and says so in grey). Press cycles the view auto → weekly → 5-hour → context (saved in the key's settings).
// Dial: "Weekly 61%", detail lines and a horizontal bar; rotate switches the view (saved like the key's), push or
// touch re-reads now (live usage asks Claude Code only when its last answer is over a minute old, e.g. after a
// failure). Neo infobar: label, detail, percentage and bar (display only).
// Live usage (src/claude/usage-live.ts) runs Claude Code and polls only while one of these shows a plan view (weekly,
// 5-hour or auto).

import type { DialDownEvent, DialRotateEvent, TouchTapEvent } from "@elgato/streamdeck";
import { usageLive } from "../claude/usage-live.ts";
import { hub } from "../hub.ts";
import { usageDial } from "../render/dial.ts";
import { usageKey } from "../render/keys.ts";
import { usageNeo } from "../render/neo.ts";
import type { Usage } from "../types.ts";
import { ClaudeAction, type Inst } from "./base.ts";
import { canvasPayload, dialLayout, ensureLayout, neoLayout } from "./feedback.ts";
import { nextUsageView, usageFor } from "./logic.ts";
import { USAGE_VIEWS, type UsageSettings, type UsageView, usageView } from "./settings.ts";

export class UsageAction extends ClaudeAction<UsageSettings> {
  constructor() {
    super("usage");
  }

  /** What this key / dial / infobar shows: usage for its own view (the hub computes each view once per refresh). */
  protected usageOf(inst: Inst<UsageSettings>): Usage {
    return usageFor(usageView(inst.settings), (view) => hub.usageFor(view));
  }

  /** Re-draw now. The hub also follows this view (so it notices when that view's numbers change). */
  protected applyView(view: UsageView): void {
    hub.setUsagePreference(view);
    this.syncLive();
    hub.refresh(true);
  }

  protected override settingsChanged(inst: Inst<UsageSettings>): void {
    this.applyView(usageView(inst.settings));
  }

  protected override instancesChanged(): void {
    this.syncLive();
  }

  /** Live usage is asked for only while a key / dial / infobar shows a plan view (Context doesn't need it). */
  private syncLive(): void {
    usageLive.setWatching(this.instances().some((i) => usageView(i.settings) !== "context"));
  }

  protected override keySvg(inst: Inst<UsageSettings>): string {
    return usageKey(this.usageOf(inst));
  }

  protected override pressKey(inst: Inst<UsageSettings>): undefined {
    const view = nextUsageView(usageView(inst.settings));
    inst.settings = { ...inst.settings, view };
    void inst.action.setSettings(inst.settings).catch((err: unknown) => this.log.warn(`setSettings failed: ${String(err)}`));
    this.applyView(view);
    return undefined;
  }

  // ─────────────────────────────────────────────────────────────── dial / Neo

  protected override renderDial(inst: Inst<UsageSettings>): void {
    ensureLayout(inst, dialLayout(this.actionId), this.log);
    this.paintFeedback(inst, canvasPayload(usageDial(this.usageOf(inst))));
  }

  protected override renderNeo(inst: Inst<UsageSettings>): void {
    ensureLayout(inst, neoLayout(this.actionId), this.log);
    this.paintFeedback(inst, canvasPayload(usageNeo(this.usageOf(inst))));
  }

  /** Rotate: previous / next view (auto → weekly → 5-hour → context, wrapping), saved in the dial's settings. */
  override onDialRotate(ev: DialRotateEvent<UsageSettings>): void {
    const inst = this.track(ev.action, ev.payload);
    const n = USAGE_VIEWS.length;
    const step = Math.trunc(ev.payload.ticks) % n;
    if (!step) return;
    const view = USAGE_VIEWS[(((USAGE_VIEWS.indexOf(usageView(inst.settings)) + step) % n) + n) % n]!;
    inst.settings = { ...inst.settings, view };
    void inst.action.setSettings(inst.settings).catch((err: unknown) => this.log.warn(`setSettings failed: ${String(err)}`));
    this.applyView(view);
  }

  override onDialDown(ev: DialDownEvent<UsageSettings>): void {
    this.refreshFor(this.track(ev.action, ev.payload));
  }

  override onTouchTap(ev: TouchTapEvent<UsageSettings>): void {
    this.refreshFor(this.track(ev.action, ev.payload));
  }

  /** Push / touch: re-read usage now (a forced hub refresh recomputes every view). Live usage asks Claude Code only
   *  when its last answer is over a minute old (e.g. after a failure): while polling works, it would repeat itself. */
  private refreshFor(inst: Inst<UsageSettings>): void {
    this.safe("refresh", () => {
      this.applyView(usageView(inst.settings));
      if (usageView(inst.settings) !== "context") usageLive.refreshNow();
    });
  }
}
