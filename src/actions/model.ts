// Model: corner box icon, the selected chat's model name (pending-aware: the hub shows a just-picked model at once)
// and a row of step dots, one per slot, the current slot's dot white.
// Press = the next model in the key's slots (Model PI: Slot 1 … Slot 4; default Fable 5.1, Opus 5.5), or the key's one
// model ("fixed"). ops.ts picks it in the app's model menu (⌘⇧I + its number) and confirms it from the chat's session
// file in the background; a change that never lands comes back through `late` (⚠ on the key).

import { setModel } from "../ops.ts";
import { modelKey } from "../render/keys.ts";
import type { Snapshot } from "../types.ts";
import { ClaudeAction, type Inst } from "./base.ts";
import { modelView } from "./logic.ts";
import { type ModelSettings, modelPlan } from "./settings.ts";

export class ModelAction extends ClaudeAction<ModelSettings> {
  constructor() {
    super("model", { needsKeys: true });
  }

  protected override keySvg(inst: Inst<ModelSettings>, snap: Snapshot): string {
    return modelKey(modelView(snap.selected, snap.models, modelPlan(inst.settings).slots));
  }

  protected override pressKey(inst: Inst<ModelSettings>) {
    const { target, slots } = modelPlan(inst.settings);
    return setModel(target, slots, this.late(inst));
  }
}
