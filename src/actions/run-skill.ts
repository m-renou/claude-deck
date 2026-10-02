// Run Skill: corner cube icon + the skill name in Title Case. Press types /skill [args] + Return in the selected chat.
// Dial: the skills the selected chat can run (project, user, built-in) with a cube before each; rotate moves the
// cursor (starting on the key's configured skill), push or touch runs the skill under it in the selected chat.

import type { DialDownEvent, DialRotateEvent, TouchTapEvent } from "@elgato/streamdeck";
import { listSkills, type Skill } from "../claude/extras.ts";
import { runSkill } from "../ops.ts";
import { runSkillDial, withDialBadge } from "../render/dial.ts";
import { runSkillKey } from "../render/keys.ts";
import type { Snapshot } from "../types.ts";
import { ClaudeAction, failure, type Inst } from "./base.ts";
import { cursorIndex, moveCursor } from "./dial-logic.ts";
import { canvasPayload, dialLayout, ensureLayout } from "./feedback.ts";
import { skillLabel } from "./logic.ts";
import { type RunSkillSettings, str } from "./settings.ts";

/** Skills per chat folder, re-read at most every 10 s (the dial re-renders on every hub change). */
const skillCache = new Map<string, { at: number; skills: Skill[] }>();
function skillsFor(cwd: string | undefined, now = Date.now()): Skill[] {
  const key = cwd ?? "";
  const hit = skillCache.get(key);
  if (hit && now - hit.at < 10_000) return hit.skills;
  const skills = listSkills(cwd);
  skillCache.set(key, { at: now, skills });
  return skills;
}

const configured = (s: RunSkillSettings): string => str(s.skill).replace(/^\/+/, "");

export class RunSkillAction extends ClaudeAction<RunSkillSettings> {
  constructor() {
    super("run-skill", { needsKeys: true });
  }

  protected override keySvg(inst: Inst<RunSkillSettings>): string {
    return runSkillKey(skillLabel(inst.settings.skill));
  }

  protected override pressKey(inst: Inst<RunSkillSettings>) {
    return runSkill(str(inst.settings.skill), str(inst.settings.args) || undefined);
  }

  // ─────────────────────────────────────────────────────────────── dial

  /** Dial cursor: the skill it was turned to, else the key's configured skill, else the first one. */
  private dialCursor(inst: Inst<RunSkillSettings>, skills: Skill[]): number {
    const key = typeof inst.state.cursorName === "string" ? inst.state.cursorName : configured(inst.settings) || undefined;
    return cursorIndex(
      skills.map((s) => s.name),
      key,
      inst.state.cursorIndex,
    );
  }

  protected override renderDial(inst: Inst<RunSkillSettings>, snap: Snapshot): void {
    ensureLayout(inst, dialLayout(this.actionId), this.log);
    const skills = skillsFor(snap.selected?.cwd);
    const i = this.dialCursor(inst, skills);
    inst.state.cursorIndex = i;
    let svg = runSkillDial(
      skills.map((s) => s.label),
      i,
    );
    if (snap.accessibility === false) svg = withDialBadge(svg);
    this.paintFeedback(inst, canvasPayload(svg));
  }

  override onDialRotate(ev: DialRotateEvent<RunSkillSettings>): void {
    const inst = this.track(ev.action, ev.payload);
    const skills = skillsFor(this.snapshotNow().selected?.cwd);
    if (!skills.length) return;
    const i = moveCursor(this.dialCursor(inst, skills), ev.payload.ticks, skills.length);
    inst.state.cursorName = skills[i]!.name;
    inst.state.cursorIndex = i;
    this.render(inst);
  }

  override async onDialDown(ev: DialDownEvent<RunSkillSettings>): Promise<void> {
    await this.runAtCursor(this.track(ev.action, ev.payload));
  }

  override async onTouchTap(ev: TouchTapEvent<RunSkillSettings>): Promise<void> {
    await this.runAtCursor(this.track(ev.action, ev.payload));
  }

  private async runAtCursor(inst: Inst<RunSkillSettings>): Promise<void> {
    const skills = skillsFor(this.snapshotNow().selected?.cwd);
    const skill = skills[this.dialCursor(inst, skills)];
    // The key's arguments go with the key's own skill only.
    const args = skill && skill.name === configured(inst.settings) ? str(inst.settings.args) || undefined : undefined;
    await this.run(inst, () => (skill ? runSkill(skill.name, args) : failure("No skills found.")));
  }
}
