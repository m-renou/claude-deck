# Claude Code for Stream Deck — design spec

The product is modelled on Elgato's **ChatGPT & Codex** plugin: same action set, same behaviour model, same visual
language — for the Claude desktop app (Claude Code / Code tab). Reference screenshots (not part of the repo) are in
the build scratchpad `design-ref/`.

## Visual language (copy this)

Key canvas 144 × 144 (SVG, rendered with `data:image/svg+xml`). The physical key is rounded; draw edge to edge.

* **Background**: pure black `#000` for command keys. Activity tiles use a filled dark tile colour by status (below).
* **Type**: system UI font (`-apple-system, "SF Pro Display", "Helvetica Neue", Arial`), **bold/semibold**, white.
  Text is **left-aligned at x = 16** and simply clipped at the right edge (no ellipsis — the screenshots cut words
  off). Body text 21–22 px, up to 3 lines, line height ~25 px.
* **Icons**: outline style, white, stroke ≈ 6 px on the 144 canvas (≈ 2 px at 48), round caps and joins
  (Lucide-like). Two placements:
  * **corner icon** top-left at (16, 16), ~30 px — used by Activity, Send Prompt, Steer, Run Skill, Model, Effort.
  * **hero icon** centred, ~64 px — used by New Chat (compose: square + pencil), Dictate (microphone), Stop (filled
    white circle Ø ~92 with a black rounded square inside), Speed (lightning bolt), Toggle Panel (panel outline).
* **Accent**: Codex uses purple. Claude uses its coral: `#D97757` (light `#E8A27F`, dark `#C15F3C`). Effort/Speed
  "active" colour = accent; the effort slider track is a gradient `#F2C4A8 → #D97757`.
* **Status colours** (identical to Codex):
  * working — tile `#2C2C2E`, icon: speech-bubble outline (white), time top-right in grey `#9B9B9F`.
  * done / ready — tile `#173B26`, icon: check (green `#34C759`), top-right `+40` (green `#34C759`) `-8` (red `#FF5B5B`)
    when diff stats exist, else the time.
  * waiting for input — tile `#4A2618`, icon: clock outline (orange `#FF8A3D`), time top-right.
  * idle — tile `#1C1C1E`, icon: speech bubble (grey), time top-right.
  * The chat that is **selected** (open in Claude) gets a 4 px white inner border.
* Disabled / not available: everything at 35 % opacity.
* Transient feedback after a press: Stream Deck's own ⚠ (`showAlert`) on a failure only. A success shows no mark
  (the key's own image already shows the new state); no custom overlays.

## Keys

| Action | Look | Press |
| --- | --- | --- |
| Activity | Status tile (above): corner status icon, time or `+a -d` top-right, chat title 3 lines | Opens that chat in Claude (`claude://code/continue?session=…`) and makes it the selected chat |
| New Chat | Hero compose icon | `claude://code/new` (optional folder / prefilled prompt from the PI) |
| Dictate | Hero microphone (accent while dictating) | Opens the selected chat, then Edit ▸ Start Dictation (macOS Dictation) |
| Send Prompt | Corner icon: up-arrow in a circle; prompt text (3 lines) | Pastes the prompt into the selected chat's prompt box and presses Return (refused while the box holds a draft). An empty key presses Return to send what you typed in the box (“The prompt box is empty.” when there's nothing) |
| Steer | Corner icon: ↳ (corner-down-right arrow); steering text | Same delivery (an empty key sends what you typed); while Claude works, the app takes it without stopping the turn |
| Run Skill | Corner icon: cube (skill); skill name bottom-left in Title Case (“Review Changes”) | Types `/skill` + Return in the selected chat |
| Stop | Hero: white filled circle with black square; dim when the selected chat isn't working | Esc in the selected chat — re-checked right before Esc goes out (still working, and a Code chat is shown, else the chat is opened first) |
| Model | Corner icon: 3-D box; model name (“Opus 5.5”) 26 px; a row of step dots at the bottom (one per slot, current one is a wider white pill, others grey) | Next model in the key's slots (PI: Slot 1 … Slot 4, default Fable 5.1 then Opus 5.5), or one fixed model, via ⌘⇧I + the model's row number in the app's menu (the digit is only typed once focus moved into the menu, never into a text field). Shows the new model at once; the chat's session file confirms it in the background (⚠ if it doesn't within 3 s) |
| Effort | Corner icon: brain in accent; level name in accent (“Extra”, “Ultra”); slider at the bottom (gradient track, dots, white knob at the level) | Next ticked level (default Low → Medium → High → Extra → Max → Ultra), or a fixed one, on the app's effort slider: ⌘⇧E opens it, Left / Right arrows move it (each stop applies at once), ⌘⇧E closes it. Ultra = Ultracode, the slider's last stop. Never digits, never Esc. Confirmed in the background like Model |
| Speed | Hero lightning bolt: accent filled when Fast is on, white outline when off, dim when the model has no fast mode | ⌘⌥F |
| Usage | “Weekly” / “5-hour” / “Context” label (20 px), big percentage (36 px bold), two grey lines (e.g. “779k / 1M”, “as of 12:39”), vertical bar on the right (grey track, white fill from the bottom) | Cycles the key's view. Each key shows its own view: Weekly / 5-hour show the latest sample the app recorded (any age, with its time) and never fall back to Context; Auto shows Weekly when a sample from the last 24 h exists, else Context |
| Toggle Panel | Hero panel icon for the chosen panel (Review = ± document, Terminal = `>_` window, Browser = globe, Files = folders, Side chat = chat bubble with +) | The panel's shortcut (⌘⇧D, ⌃\`, ⌘⇧B, ⌘⇧F, ⌘;) |

## Dials (Stream Deck +, 200 × 100 touch strip per dial)

* **Activity**: list of up to 3 chats — the current one in white 22 px bold, others grey 20 px — each with its status
  icon at the right end. Rotate = move, push/touch = open.
* **Run Skill**: list of skills with a cube icon before each name. Rotate = move, push/touch = run.
* **Power**: one combined scale of model × effort, e.g. `Opus 5.5 Extra` + bolt, a gradient slider with dots and a
  white knob, labels “Faster” (left) and “Smarter” (right). Rotate = move along the scale, push = apply.
* **Usage**: `Weekly 61%` / `Aug 28 · 3 resets` style layout with a horizontal bar.

## Neo infobar

* **Activity**: the selected / most recent chat title with its status icon; tap areas cycle.
* **Usage**: label + percentage + horizontal bar.

## Behaviour model

* **Selected chat** = the chat open in the Claude app (its most recent focus), or the one last opened from the deck.
  Every chat action targets it. The chat is only re-opened (`claude://code/continue`) when the app isn't already
  showing it, and Claude is only activated when it isn't already frontmost.
* Reading state is local and read-only: the app's chat files (`~/Library/Application Support/Claude/claude-code-sessions`),
  `claude agents --json` for live status, the model catalog cache, transcripts for context usage.
* Acting uses the app's own shortcuts through macOS System Events → **Stream Deck needs Accessibility permission**
  (macOS asks once). Keys show a small ⚠ badge while permission is missing. Every keystroke first checks that Claude
  is frontmost. Esc is sent only by the Stop key (in the app, Esc stops a running response).
* The prompt box (an AXTextArea “Prompt” deep in the window's accessibility tree) takes seconds to find, so its index
  path is cached (`~/.config/claude-code-deck/ui-cache.json`), verified on every use and re-searched only when it
  moved. A background warm-up (accessibility reads only: no activation, no keystrokes) refreshes it on start, when
  Claude launches, on wake and every 10 minutes.
* Results are honest: model/effort changes are confirmed by re-reading the chat's session file in the background — only
  a write after the press counts (with two slots, the old file often already holds the new value); when that doesn't
  happen within a few seconds the key shows ⚠ and the PI says why.
* Prompt delivery: Return is only pressed after the pasted text was read back from the located prompt box and while
  that box itself has keyboard focus. The clipboard is saved with every item and type and put back afterwards.
* Every switch of the app (Activity, New Chat, a key that opens its chat) is a queued job that includes the app's
  switch time, so the next key's keystrokes can't reach the chat shown before. Model, Effort, Stop and panel keys never
  wait for the background prompt-box search.
