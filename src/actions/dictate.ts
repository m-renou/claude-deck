// Dictate: hero microphone (accent while dictating). Press opens the selected chat and clicks Edit ▸ Start Dictation;
// a second press while it's on clicks the same menu item again (it reads "Stop Dictation" then). The app doesn't tell
// us when macOS dictation ends, so the key shows "active" for DICTATION_MS after a press.

import { dictate } from "../ops.ts";
import { dictateKey } from "../render/keys.ts";
import type { ActionResult } from "../types.ts";
import { ClaudeAction, type Inst } from "./base.ts";
import type { DictateSettings } from "./settings.ts";

export const DICTATION_MS = 10_000;

export class DictateAction extends ClaudeAction<DictateSettings> {
  /** Dictation is system-wide: one state for every Dictate key. 0 = off. */
  private activeUntil = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    super("dictate", { needsKeys: true });
  }

  get active(): boolean {
    return this.activeUntil > Date.now();
  }

  private setActive(on: boolean): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.activeUntil = on ? Date.now() + DICTATION_MS : 0;
    if (on) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.activeUntil = 0;
        this.renderAll();
      }, DICTATION_MS + 50);
      this.timer.unref?.();
    }
    this.renderAll();
  }

  protected override keySvg(): string {
    return dictateKey({ active: this.active });
  }

  protected override async pressKey(_inst: Inst<DictateSettings>): Promise<ActionResult> {
    const turnOn = !this.active;
    this.setActive(turnOn); // show it right away; the menu click takes a moment
    const r = await dictate();
    if (!r.ok && turnOn) this.setActive(false);
    return r;
  }
}
