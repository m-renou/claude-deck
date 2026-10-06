// The OS the plugin runs on, for wording that differs (Terminal vs PowerShell …). Tests pin it so their expectations
// don't depend on the machine they run on. (control.ts keeps its own, set with setExec.)

let current: NodeJS.Platform = process.platform;

export const hostPlatform = (): NodeJS.Platform => current;

/** Tests: pretend to run on `p` (nothing = the real platform). */
export function setHostPlatform(p?: NodeJS.Platform): void {
  current = p ?? process.platform;
}
