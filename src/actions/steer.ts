// Steer: corner ↳ icon + the steering text. Same delivery as Send Prompt; while Claude works, the app takes it
// without stopping the turn. A key without text (grey "Steer") submits what you typed in Claude's prompt box.

import { steer } from "../ops.ts";
import { steerKey } from "../render/keys.ts";
import { ClaudeAction, type Inst } from "./base.ts";
import { pressText } from "./logic.ts";
import { type SteerSettings, str } from "./settings.ts";

export class SteerAction extends ClaudeAction<SteerSettings> {
  constructor() {
    super("steer", { needsKeys: true });
  }

  protected override keySvg(inst: Inst<SteerSettings>): string {
    return steerKey(str(inst.settings.text));
  }

  protected override pressKey(inst: Inst<SteerSettings>) {
    return pressText(inst.settings.text, steer);
  }
}
