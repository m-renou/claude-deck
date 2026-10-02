// Speed: hero lightning bolt — accent filled when Fast is on, white outline when off, dim when the selected chat's
// model has no fast mode. Press = ⌘⌥F.

import { toggleFast } from "../ops.ts";
import { speedKey } from "../render/keys.ts";
import type { Snapshot } from "../types.ts";
import { ClaudeAction } from "./base.ts";
import { speedState } from "./logic.ts";
import type { SpeedSettings } from "./settings.ts";

export class SpeedAction extends ClaudeAction<SpeedSettings> {
  constructor() {
    super("speed", { needsKeys: true });
  }

  protected override keySvg(_inst: unknown, snap: Snapshot): string {
    return speedKey({ state: speedState(snap.selected, snap.models) });
  }

  protected override pressKey() {
    return toggleFast();
  }
}
