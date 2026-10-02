// Keep Awake (not in the Codex plugin): KeepingYouAwake's coffee cup — accent filled with steam while the Mac is kept
// awake, white outline when off, dim when KeepingYouAwake isn't installed; a timed session's time left top-right.
// Press = on / off through KeepingYouAwake's URL scheme (src/system/keep-awake.ts). Never touches the Claude app, so
// it needs no Accessibility permission.

import { keepAwakeKey } from "../render/keys.ts";
import { keepAwake } from "../system/keep-awake.ts";
import { ClaudeAction, type Inst } from "./base.ts";
import { keepAwakeView } from "./logic.ts";
import { keepAwakeMode, keepAwakeSeconds, type KeepAwakeSettings } from "./settings.ts";

export class KeepAwakeAction extends ClaudeAction<KeepAwakeSettings> {
  /** Re-renders every second while a timed session shows its time left (only changed images are sent). */
  private ticker: NodeJS.Timeout | undefined;

  constructor() {
    super("keep-awake");
    keepAwake.on("change", () => {
      this.syncTicker();
      this.renderAll();
    });
  }

  protected override keySvg(): string {
    return keepAwakeKey(keepAwakeView(keepAwake.state, Date.now()));
  }

  protected override pressKey(inst: Inst<KeepAwakeSettings>) {
    return keepAwake.press(keepAwakeMode(inst.settings), keepAwakeSeconds(inst.settings));
  }

  /** KeepingYouAwake is only polled while a Keep Awake key is visible. */
  protected override instancesChanged(): void {
    keepAwake.setWatching(this.instances().length > 0);
    this.syncTicker();
  }

  private syncTicker(): void {
    const timed = keepAwake.state.active && keepAwake.state.until !== undefined && this.instances().length > 0;
    if (timed && !this.ticker) {
      this.ticker = setInterval(() => this.renderAll(), 1000);
      this.ticker.unref?.();
    } else if (!timed && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }
}
