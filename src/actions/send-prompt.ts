// Send Prompt: corner up-arrow icon + the prompt text. Press pastes it into the selected chat and presses Return.
// A key without a prompt (grey "Send Prompt") submits what you typed in Claude's prompt box instead.

import { sendText } from "../ops.ts";
import { sendPromptKey } from "../render/keys.ts";
import { ClaudeAction, type Inst } from "./base.ts";
import { pressText } from "./logic.ts";
import { type SendPromptSettings, str } from "./settings.ts";

export class SendPromptAction extends ClaudeAction<SendPromptSettings> {
  constructor() {
    super("send-prompt", { needsKeys: true });
  }

  protected override keySvg(inst: Inst<SendPromptSettings>): string {
    return sendPromptKey(str(inst.settings.prompt));
  }

  protected override pressKey(inst: Inst<SendPromptSettings>) {
    return pressText(inst.settings.prompt, sendText);
  }
}
