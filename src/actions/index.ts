// One action class per entry in src/catalog.ts ACTIONS.

import type { JsonObject } from "@elgato/utils";
import { ACTIONS } from "../catalog.ts";
import { ActivityAction } from "./activity.ts";
import type { ClaudeAction } from "./base.ts";
import { DictateAction } from "./dictate.ts";
import { EffortAction } from "./effort.ts";
import { ModelAction } from "./model.ts";
import { NewChatAction } from "./new-chat.ts";
import { PowerAction } from "./power.ts";
import { RunSkillAction } from "./run-skill.ts";
import { SendPromptAction } from "./send-prompt.ts";
import { SpeedAction } from "./speed.ts";
import { SteerAction } from "./steer.ts";
import { StopAction } from "./stop.ts";
import { TogglePanelAction } from "./toggle-panel.ts";
import { UsageAction } from "./usage.ts";

export const ACTION_CLASSES: Record<string, new () => ClaudeAction<JsonObject>> = {
  activity: ActivityAction,
  "new-chat": NewChatAction,
  dictate: DictateAction,
  "send-prompt": SendPromptAction,
  steer: SteerAction,
  "run-skill": RunSkillAction,
  stop: StopAction,
  model: ModelAction,
  effort: EffortAction,
  speed: SpeedAction,
  usage: UsageAction,
  "toggle-panel": TogglePanelAction,
  power: PowerAction,
} as unknown as Record<string, new () => ClaudeAction<JsonObject>>;

/** Instantiate every catalog action (throws when one has no class, so a new catalog entry can't be forgotten). */
export function createActions(): ClaudeAction<JsonObject>[] {
  return ACTIONS.map((def) => {
    const Cls = ACTION_CLASSES[def.id];
    if (!Cls) throw new Error(`No action class for "${def.id}"`);
    return new Cls();
  });
}
