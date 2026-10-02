// Toggle Panel: hero icon of the chosen panel. Press = that panel's shortcut (⌘⇧D, ⌃`, ⌘⇧B, ⌘⇧F, ⌘;).

import { togglePanel } from "../ops.ts";
import { panelKey } from "../render/keys.ts";
import { ClaudeAction, type Inst } from "./base.ts";
import { panelId, type TogglePanelSettings } from "./settings.ts";

export class TogglePanelAction extends ClaudeAction<TogglePanelSettings> {
  constructor() {
    super("toggle-panel", { needsKeys: true });
  }

  protected override keySvg(inst: Inst<TogglePanelSettings>): string {
    return panelKey(panelId(inst.settings));
  }

  protected override pressKey(inst: Inst<TogglePanelSettings>) {
    return togglePanel(panelId(inst.settings));
  }
}
