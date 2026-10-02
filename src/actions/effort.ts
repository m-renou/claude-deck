// Effort: corner brain icon (accent), the level name in accent ("Extra", "Ultra" while Ultracode is on) and a slider
// over the key's stops (its cycle, limited to what the chat's model offers). Press = the next level in the key's cycle
// (default: Low … Max, then Ultra), or the key's fixed level. ops.ts moves the app's effort slider (⌘⇧E, arrow keys,
// ⌘⇧E) and confirms the change in the background; a change that never lands comes back through `late` (⚠ on the key).

import { setEffort } from "../ops.ts";
import { effortKey } from "../render/keys.ts";
import type { Snapshot } from "../types.ts";
import { ClaudeAction, type Inst } from "./base.ts";
import { effortCycle, effortTarget, effortView } from "./logic.ts";
import { type EffortSettings, isFixed } from "./settings.ts";

export class EffortAction extends ClaudeAction<EffortSettings> {
  constructor() {
    super("effort", { needsKeys: true });
  }

  protected override keySvg(inst: Inst<EffortSettings>, snap: Snapshot): string {
    return effortKey(effortView(snap.selected, snap.models, effortCycle(inst.settings.cycle)));
  }

  protected override pressKey(inst: Inst<EffortSettings>) {
    return setEffort(effortTarget(isFixed(inst.settings), inst.settings.level), effortCycle(inst.settings.cycle), this.late(inst));
  }
}
