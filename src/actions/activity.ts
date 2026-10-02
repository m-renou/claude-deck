// Activity: a status tile for one chat (working / waiting / ready / idle, time or +a −d, title). Press opens that chat
// in the Claude app and makes it the selected chat. Which chat: the key's fixed position (1 = most recent), or auto =
// the remaining positions in key order on the device.
// Dial: up to three chats; rotate moves the cursor (it starts on, and until turned follows, the selected chat), push
// or touch opens the chat under it. Neo infobar: the selected chat and the next most recent one (display only).

import type { DialDownEvent, DialRotateEvent, TouchTapEvent } from "@elgato/streamdeck";
import { openChatOp } from "../ops.ts";
import { activityDial } from "../render/dial.ts";
import { activityKey } from "../render/keys.ts";
import { activityNeo } from "../render/neo.ts";
import type { Chat, Snapshot } from "../types.ts";
import { ClaudeAction, failure, type Inst } from "./base.ts";
import { cursorIndex, moveCursor } from "./dial-logic.ts";
import { canvasPayload, dialLayout, ensureLayout, neoLayout } from "./feedback.ts";
import { assignPositions, chatAt } from "./logic.ts";
import { type ActivitySettings, activityPosition } from "./settings.ts";

export class ActivityAction extends ClaudeAction<ActivitySettings> {
  /** Context id → chat position (1-based), for keypad instances. */
  private positions = new Map<string, number>();

  constructor() {
    super("activity");
  }

  /** Position this key follows (1 = most recent chat). */
  positionOf(inst: Inst<ActivitySettings>): number {
    return this.positions.get(inst.id) ?? (activityPosition(inst.settings) || 1);
  }

  /** The chat this key shows right now. */
  chatFor(inst: Inst<ActivitySettings>, snap: Snapshot): Chat | undefined {
    return chatAt(snap.chats, this.positionOf(inst));
  }

  protected override instancesChanged(): void {
    const keys = this.instances()
      .filter((i) => i.controller === "Keypad")
      .map((i) => ({
        id: i.id,
        deviceId: i.deviceId,
        row: i.coordinates?.row ?? Number.MAX_SAFE_INTEGER,
        column: i.coordinates?.column ?? Number.MAX_SAFE_INTEGER,
        position: activityPosition(i.settings),
      }));
    const next = assignPositions(keys);
    const changed = next.size !== this.positions.size || [...next].some(([id, p]) => this.positions.get(id) !== p);
    this.positions = next;
    if (changed) this.renderAll();
  }

  protected override keySvg(inst: Inst<ActivitySettings>, snap: Snapshot): string {
    const chat = this.chatFor(inst, snap);
    inst.state.chatId = chat?.id; // press opens what the key showed, even if the list reorders meanwhile
    return activityKey(chat, { selected: !!chat && chat.id === snap.selected?.id, now: Date.now() });
  }

  protected override pressKey(inst: Inst<ActivitySettings>) {
    const snap = this.snapshotNow();
    const shown = typeof inst.state.chatId === "string" ? snap.chats.find((c) => c.id === inst.state.chatId) : undefined;
    const chat = shown ?? this.chatFor(inst, snap);
    if (!chat) return failure(`No chat at position ${this.positionOf(inst)} yet.`);
    return openChatOp(chat);
  }

  // ─────────────────────────────────────────────────────────────── dial / Neo

  /** Dial cursor: the chat it was turned to (followed when the list reorders), else the selected chat. */
  private dialCursor(inst: Inst<ActivitySettings>, snap: Snapshot): number {
    const selected = snap.chats.findIndex((c) => c.id === snap.selected?.id);
    return cursorIndex(
      snap.chats.map((c) => c.id),
      inst.state.cursorId,
      inst.state.cursorId === undefined ? selected : inst.state.cursorIndex,
      Math.max(0, selected),
    );
  }

  protected override renderDial(inst: Inst<ActivitySettings>, snap: Snapshot): void {
    ensureLayout(inst, dialLayout(this.actionId), this.log);
    const i = this.dialCursor(inst, snap);
    inst.state.cursorIndex = i; // where the cursor stays if its chat disappears
    this.paintFeedback(inst, canvasPayload(activityDial(snap.chats, i)));
  }

  protected override renderNeo(inst: Inst<ActivitySettings>, snap: Snapshot): void {
    ensureLayout(inst, neoLayout(this.actionId), this.log);
    const primary = snap.selected ?? snap.chats[0];
    const secondary = snap.chats.find((c) => c.id !== primary?.id);
    this.paintFeedback(inst, canvasPayload(activityNeo(primary, secondary)));
  }

  override onDialRotate(ev: DialRotateEvent<ActivitySettings>): void {
    const inst = this.track(ev.action, ev.payload);
    const snap = this.snapshotNow();
    if (!snap.chats.length) return;
    const i = moveCursor(this.dialCursor(inst, snap), ev.payload.ticks, snap.chats.length);
    inst.state.cursorId = snap.chats[i]!.id;
    inst.state.cursorIndex = i;
    this.render(inst);
  }

  override async onDialDown(ev: DialDownEvent<ActivitySettings>): Promise<void> {
    await this.openAtCursor(this.track(ev.action, ev.payload));
  }

  override async onTouchTap(ev: TouchTapEvent<ActivitySettings>): Promise<void> {
    await this.openAtCursor(this.track(ev.action, ev.payload));
  }

  private async openAtCursor(inst: Inst<ActivitySettings>): Promise<void> {
    const snap = this.snapshotNow();
    const chat = snap.chats[this.dialCursor(inst, snap)];
    const r = await this.run(inst, () => (chat ? openChatOp(chat) : failure("No Claude Code chats yet.")));
    if (r && chat) inst.state.cursorId = undefined; // the opened chat is the selected one now: follow the selection again
  }
}
