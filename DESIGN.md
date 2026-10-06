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
    white circle Ø ~92 with a black rounded square inside), Speed (lightning bolt), Toggle Panel (panel outline),
    Keep Awake (coffee mug).
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
| Usage | “Weekly” / “5-hour” / “Context” label (17 px), big percentage (30 px, down to 22 px when it's wide), two grey lines (17 px) — the reset or the sample's age, then the other window (“resets 22:40” / “resets Thu” / “as of 12:39”, “5-hour 3%”; Context: “779k / 1M”, chat title), shrunk up to 2 px before a digit would be cut — vertical bar on the right (grey track, white fill from the bottom) | Cycles the key's view. Each key shows its own view: Weekly / 5-hour show the newest sample — live from Claude Code every minute (PI: “Live usage”), else the latest one the app recorded (any age) — and never fall back to Context; Auto shows Weekly when a sample from the last 24 h exists (either source), else Context |
| Toggle Panel | Hero panel icon for the chosen panel (Review = ± document, Terminal = `>_` window, Browser = globe, Files = folders, Side chat = chat bubble with +) | The panel's shortcut (⌘⇧D, ⌃\`, ⌘⇧B, ⌘⇧F, ⌘;) |
| Keep Awake (extra, not in Codex) | Hero coffee mug (KeepingYouAwake's symbol): accent filled with three wavy steam lines while the Mac is kept awake, white outline when off, dim when KeepingYouAwake isn't installed. A timed session shows its time left top-right in the time style (“45s”, “12m”, “1h 5m”), with the mug 7 px lower so the steam clears it | Toggles KeepingYouAwake on / off, or always turns it on / off (PI), on for the PI's duration (indefinitely, 5 min … 5 h). The key flips at once and is confirmed by re-reading KeepingYouAwake's state (⚠ if it doesn't follow within ~4 s, or isn't installed) |

## Dials (Stream Deck +, 200 × 100 touch strip per dial)

* **Activity**: list of up to 3 chats — the current one in white 22 px bold, others grey 20 px — each with its status
  icon at the right end. Rotate = move, push/touch = open.
* **Run Skill**: list of skills with a cube icon before each name. Rotate = move, push/touch = run.
* **Power**: one combined scale of model × effort, e.g. `Opus 5.5 Extra` + bolt, a gradient slider with dots and a
  white knob, labels “Faster” (left) and “Smarter” (right). Rotate = move along the scale, push = apply.
* **Usage**: label + big percentage on the left, the key's two grey lines right-aligned (`Weekly` · `resets Thu`,
  `16%` · `5-hour 3%`), a horizontal bar. Rotate = view, push/touch = re-read now; live usage asks Claude Code only
  when its last answer is over a minute old (e.g. after a failure) and nothing went out in the last 10 s.

## Neo infobar

* **Activity**: the selected / most recent chat title with its status icon; tap areas cycle.
* **Usage**: label + percentage + horizontal bar; one grey detail row: line1 (“resets 22:40”, “as of 12:39”), then the
  other window (“Weekly 16%”) only when it fits whole — a number is never cut (a context view's chat title may fade).

## Behaviour model

* **Selected chat** = the chat open in the Claude app (its most recent focus), or the one last opened from the deck.
  Every chat action targets it. The chat is only re-opened (`claude://code/continue`) when the app isn't already
  showing it, and Claude is only activated when it isn't already frontmost.
* Reading state is local and read-only: the app's chat files (`~/Library/Application Support/Claude/claude-code-sessions`),
  `claude agents --json --all` for live status (the CLI the app bundles: `claude-code/<version>/<build>/claude.app` or
  the older `claude-code/<version>/claude.app`, newest version first), the model catalog cache, transcripts for
  context usage. Live usage (below) also runs that CLI, as a long-lived helper; the plugin itself contacts no host.
* **Usage numbers.** The app writes `plan-usage-history.json` only when its own usage poll runs (every 15 min, and only
  while its menu-bar menu was opened in the last 24 h), so on its own the key is often hours behind. Live usage asks
  Claude Code itself — the CLI the app bundles — with Claude Code's own sign-in: the plugin never sees a password or
  token and contacts no host (Claude Code reads the numbers from Anthropic, as for its own `/usage`).
  * One long-lived process (src/claude/usage-cli.ts): `claude -p --input-format stream-json --output-format
    stream-json --verbose --no-session-persistence --strict-mcp-config --setting-sources user --settings
    '{"crossSessionInbound":"refuse"}'`, in a private empty folder (`~/.config/claude-code-deck/usage-cli`, 0700: no
    project settings or CLAUDE.md apply), without the plugin's `CLAUDE_CODE_*` / `ANTHROPIC_*` / `CLAUDECODE` variables
    (so it always uses its own sign-in; `--bare` can't be used — it never reads the sign-in). The plugin writes only
    two SDK control requests to it: `initialize` once, then `get_usage` (`skip_behaviors: true`) — never a prompt or
    user message. The answer's `rate_limits.five_hour` / `seven_day` (`utilization` %, `resets_at`) become the sample;
    its stdout is read line by line and every other line (the 31 KB initialize answer too) is skipped. Every start of
    Claude Code writes `~/.claude.json` and `~/.claude/backups`, hence one process instead of one per minute (~210 MB
    resident).
  * Other sessions can't reach it. Claude Code registers every process as a local session
    (`~/.claude/sessions/<pid>.json`) and normally opens an inbox there that the user's other Claude Code sessions can
    message — a message would start a model turn (spending plan usage, running tools) the plugin never asked for. The
    process runs with `CLAUDE_CODE_HARBOR_KITE=0` (set after the stripping): Claude Code's internal, undocumented
    switch for that inbox, measured on 2.1.286 — no socket, no `.key` file, not listed as a peer, `get_usage` still
    answers. `crossSessionInbound: "refuse"` (Claude Code's own setting) refuses such messages should an inbox open
    anyway; alone it doesn't stop the socket. And it fails closed: a session record that names a
    `messagingSocketPath` (checked with every answer) or a turn's line on stdout (`user` / `assistant` / `result`, or
    a `system` init) kills the process at once, and that Claude Code isn't started again until the app installs
    another one (status “blocked”, logged as an error). The session record itself stays while it runs (kind
    “interactive”, entrypoint “sdk-cli”; removed when it quits).
  * The request is experimental in Claude Code (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`): an
    answer of another shape is an error, never a guess, and the keys fall back to the app's numbers (“as of …”).
  * It runs only while a Usage key / dial / infobar shows Weekly, 5-hour or Auto: started then and asked at once, then
    every minute — 61 s after its last answer, because Claude Code answers from its own cache for a minute after it
    asked Anthropic (measured: 60 s later it repeats itself in 2 ms, 65 s later it asks anew). So a dial push asks
    only when the last answer is over a minute old (after a failure) and no request went out < 10 s ago — while
    polling works, the next minute's request is already the earliest new answer. One request at a time, 15 s each.
    The process is ended (stdin closed; SIGTERM / SIGKILL if it lingers) two minutes after the last plan view went
    away, and when the plugin exits. A new Claude Code (the app updates it) is picked up on the next request.
  * Failures are said, not hidden (PI status line): signed out (`rate_limits_available: false`) → “Sign in once: run
    this in Terminal” with the shell-quoted `'…/claude.app/Contents/MacOS/claude' auth login` and a Copy button (the
    app's copy isn't on PATH), “then wait a minute” — the process is ended (a running one may not notice a new
    sign-in) and a new one asks every minute (every 5 min after ten tries; every minute while the Usage page is open);
    no answer in 15 s or a crash → “Claude Code didn't answer — retrying” (killed; a new one after 5 s, 10 s … 5 min);
    no CLI → “Claude Code isn't installed in the Claude app yet”; an error answer → its words, retried next minute;
    blocked → “Live usage stopped: other sessions could reach Claude Code”. Polling paused with a live sample → grey
    “Paused · last update 22:41” (never a green “Live” for a sample nobody refreshes).
    The detail names the numbers the keys show meanwhile — the newer of the last live answer and the app's sample.
    The next request is always armed: a key or PI that fails to re-render on new numbers is logged, and neither stops
    polling nor keeps the other listeners from hearing about it.
  * Keys show the newest of the live and the app's sample. A live sample ≤ 3 min old shows when the window resets
    (“resets 22:40”, a weekday, or a date a week out); anything older keeps the honest “as of 12:39”.
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
* Keep Awake drives the KeepingYouAwake app (not Claude) through its URL scheme (`keepingyouawake:///activate[?seconds=N]`,
  `…/deactivate`, opened with `open -g`; never `toggle` — the press reads the state and picks the command) and reads
  its state from the `/usr/bin/caffeinate` child KeepingYouAwake runs while active (`ps`; `-t` gives a timed session's
  end), polling only while a Keep Awake key is visible.
* **Windows** does the same through Windows UI Automation instead of System Events: a small C# program
  (`src/claude/uia-win.ts`, compiled on first use with the .NET Framework compiler every Windows 10/11 has, into
  `%LOCALAPPDATA%\claude-code-deck\uia\<hash>\`) takes the same requests on stdin and answers with the same replies
  and error codes. It uses the COM UIA client (UIA3) — the managed one doesn't see Chromium's tree — and Chromium only
  builds the page's tree once a UIA client asks, so a first search is retried for a few seconds. Shortcuts use Ctrl
  where macOS uses ⌘ (Ctrl+Shift+I / E, Ctrl+Alt+F …), keys go out with SendInput (layout-aware), the clipboard is saved
  format by format and our text is kept out of the clipboard history. Windows asks for no permission, so there is no
  ⚠ badge; a press only fails when Claude runs as administrator (Windows then drops the keys) or when another app holds
  a shortcut system-wide. Links open through the shell's URL handler. Dictate presses Win+H (Windows voice typing).
  Keep Awake needs no app there: the helper's `keepawake` mode holds `SetThreadExecutionState(ES_SYSTEM_REQUIRED |
  ES_DISPLAY_REQUIRED)` until its time is up, it's turned off, or the plugin quits. The desktop app (Claude.exe) is told
  apart from Claude Code CLIs (also claude.exe) by folder.
* Every switch of the app (Activity, New Chat, a key that opens its chat) is a queued job that includes the app's
  switch time, so the next key's keystrokes can't reach the chat shown before. Model, Effort, Stop and panel keys never
  wait for the background prompt-box search.
