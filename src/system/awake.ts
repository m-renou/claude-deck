// The plugin's Keep Awake controller (one for all Keep Awake keys): KeepingYouAwake on macOS (keep-awake.ts), the
// plugin's own on Windows (keep-awake-win.ts). Both have the same surface.

import { KeepAwake } from "./keep-awake.ts";
import { WinKeepAwake } from "./keep-awake-win.ts";

export const keepAwake: KeepAwake | WinKeepAwake = process.platform === "win32" ? new WinKeepAwake() : new KeepAwake();
