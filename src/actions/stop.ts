// Stop: hero white circle with a black square; dim unless the selected chat is working. Press = Esc in that chat.

import { stop } from "../ops.ts";
import { stopKey } from "../render/keys.ts";
import type { Snapshot } from "../types.ts";
import { ClaudeAction } from "./base.ts";
import type { StopSettings } from "./settings.ts";

export class StopAction extends ClaudeAction<StopSettings> {
  constructor() {
    super("stop", { needsKeys: true });
  }

  protected override keySvg(_inst: unknown, snap: Snapshot): string {
    return stopKey({ enabled: snap.selected?.status === "working" });
  }

  protected override pressKey() {
    return stop();
  }
}
