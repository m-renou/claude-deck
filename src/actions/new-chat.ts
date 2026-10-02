// New Chat: hero compose icon. Press opens claude://code/new (optional folder / prefilled prompt from the PI).

import { newChat } from "../ops.ts";
import { newChatKey } from "../render/keys.ts";
import { ClaudeAction, type Inst } from "./base.ts";
import { type NewChatSettings, str } from "./settings.ts";

export class NewChatAction extends ClaudeAction<NewChatSettings> {
  constructor() {
    super("new-chat");
  }

  protected override keySvg(): string {
    return newChatKey();
  }

  protected override pressKey(inst: Inst<NewChatSettings>) {
    const folder = str(inst.settings.folder);
    const prompt = str(inst.settings.prompt);
    return newChat({ folder: folder || undefined, prompt: prompt || undefined });
  }
}
