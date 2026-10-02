# Claude Deck — Claude Code for Stream Deck

A Stream Deck plugin for the **Claude desktop app's Code tab** (Claude Code). Follow your chats on keys, open one
with a press, send prompts, steer or stop running work, switch model / effort (Ultracode included) / Fast mode,
watch your plan usage, and toggle the app's panels — all from hardware keys and dials.

It works out of the box: no background service, no config file, no API key. The plugin reads the app's local state
and drives the app through its own keyboard shortcuts.

> Built on the model of Elgato's *ChatGPT & Codex* plugin (same key set, behaviour and look), recoloured in Claude
> coral. Not affiliated with, or endorsed by, Anthropic or Elgato.

## Keys

| Key | What it shows | Press |
| --- | --- | --- |
| **Activity** | A chat tile: working / waiting for input / ready / idle, its time or `+added −deleted` lines, and its title. The chat open in Claude gets a white border | Opens that chat in Claude |
| **New Chat** | Compose icon | Starts a new Code chat (optional folder and prefilled prompt) |
| **Dictate** | Microphone | Opens the selected chat and starts macOS Dictation |
| **Send Prompt** | Your prompt text | Pastes the prompt into the selected chat and sends it. Leave it empty to send whatever you typed in the box |
| **Steer** | Your steering text | Same, but meant for a chat that's working: Claude takes it without stopping the turn |
| **Run Skill** | Skill name (“Code Review”) | Runs `/skill` in the selected chat |
| **Stop** | Stop button (dim when nothing is running) | Stops the selected chat's running turn |
| **Model** | Model name + one dot per slot | Next model in the key's slots (default **Fable 5.1 → Opus 5.5**), or one fixed model |
| **Effort** | Level + slider | Next level: Low → Medium → High → Extra → Max → **Ultra** (Ultracode), or one fixed level |
| **Speed** | Lightning bolt (filled when Fast is on) | Toggles Fast mode |
| **Usage** | Weekly / 5-hour plan usage (live, every minute) or the chat's context window, with a bar | Cycles the view |
| **Toggle Panel** | The panel's icon | Shows / hides Review (diff), Terminal, Browser, Files or Side chat |
| **Keep Awake** | Coffee mug (steaming while on, time left when timed) | Turns [KeepingYouAwake](https://keepingyouawake.app) on / off — optional, needs that app |

**Dials (Stream Deck +):** Activity (browse chats), Run Skill (browse skills), **Power** (one Faster ↔ Smarter scale of
model × effort) and Usage. **Stream Deck Neo:** Activity and Usage on the infobar.

Every action targets the **selected chat** — the one open in Claude, or the one you last opened from the deck. A
failed press shows Stream Deck's ⚠; a successful one simply shows the new state.

## Requirements

* **macOS 13** or later
* **Stream Deck 7.6** or later (any model: Stream Deck, Mini, XL, +, Neo — a ready-made profile ships for each)
* The **Claude desktop app** with the Code tab (Claude Code). A separate `claude` CLI is *not* needed: the plugin
  uses the copy the app bundles.
* Optional: [KeepingYouAwake](https://keepingyouawake.app) for the Keep Awake key

## Installation

### Option A — download the release (easiest)

1. Download `com.local.claudecode.streamDeckPlugin` from the
   [latest release](https://github.com/matthberendt/claude-deck/releases/latest).
2. Double-click it. Stream Deck installs the plugin and adds a **Claude Code** profile for each of your devices.
3. Continue with [First run](#first-run).

### Option B — build from source

Needs **Node.js 24+** (the build scripts run TypeScript directly).

```bash
git clone https://github.com/matthberendt/claude-deck.git
cd claude-deck
npm install
npm run build        # bundles src/ into com.local.claudecode.sdPlugin/bin/plugin.js
```

Then either link the folder into Stream Deck (best for development):

```bash
npx streamdeck link com.local.claudecode.sdPlugin
npx streamdeck restart com.local.claudecode
```

or package it and double-click the result:

```bash
npm run pack         # → dist/com.local.claudecode.streamDeckPlugin
open dist/com.local.claudecode.streamDeckPlugin
```

## First run

1. **Allow Accessibility.** The plugin presses the Claude app's shortcuts through macOS System Events, so macOS asks
   once to let **Stream Deck** control your computer. Allow it in *System Settings → Privacy & Security →
   Accessibility* (and *Automation → System Events* if asked). Until then keys show a small ⚠ badge.
2. **Pick a layout.** Switch to the **Claude Code** profile in Stream Deck (it isn't switched to automatically), or
   drag actions from the **Claude Code** category onto your own profile. The 15-key profile:

   ```text
   Activity 1   Activity 2   Activity 3   Activity 4   Usage
   New Chat     Dictate      Send Prompt  Steer        Stop
   Model        Effort       Speed        Code Review  Review panel
   ```

3. **Usage (optional).** Weekly / 5-hour numbers come live from Claude Code every minute, using its own sign-in. If
   the Usage key's settings say *Sign in once*, copy the command shown there into Terminal (it runs the app's bundled
   `claude auth login`), then wait a minute. Without it, the key falls back to the numbers the Claude app last
   recorded (“as of 12:39”).

## Configuring keys

Select a key in Stream Deck to open its settings:

* **Activity** — which chat it follows: the 1st … 12th most recent, or Auto (by key position).
* **New Chat** — start folder (from your recent folders) and an optional prefilled prompt.
* **Send Prompt / Steer** — the text to send (empty = send what's typed in the prompt box).
* **Run Skill** — the skill to run.
* **Model** — Slot 1 … Slot 4 to cycle through, or one fixed model.
* **Effort** — the levels to cycle through, or one fixed level.
* **Usage** — Auto, Weekly, 5-hour or Context; shows the live-usage status.
* **Toggle Panel** — Review, Terminal, Browser, Files or Side chat.
* **Keep Awake** — toggle / always on / always off, and for how long (indefinitely, 5 min … 5 h).

## How it works

* **Reading state** is local and read-only: the app's chat files in
  `~/Library/Application Support/Claude/claude-code-sessions`, `claude agents --json --all` from the bundled CLI for
  live status, Claude Code's model catalog and transcripts (for context usage).
* **Acting** uses the app's own shortcuts — `claude://code/continue?session=…` to open a chat, ⌘⇧I for the model
  menu, ⌘⇧E for the effort slider, ⌘⌥F for Fast, the panel shortcuts — and only after checking Claude is frontmost.
  Prompts are pasted into the prompt box and Return is pressed only after the text was read back from it; your
  clipboard is restored afterwards. Esc is only ever sent by the Stop key.
* **Model / effort changes are confirmed** by re-reading the chat's session file; if that doesn't happen within a
  few seconds the key shows ⚠.
* **Live usage** keeps one Claude Code process (the app's bundled CLI) running while a Usage view is visible and asks
  it for `/usage` numbers once a minute — never a prompt. It runs in a private empty folder with its cross-session
  inbox switched off, and is stopped two minutes after the last Usage view disappears.
* The plugin itself contacts no server and never sees a password or token.

The full spec — every key's look and behaviour, timings and failure messages — is in [DESIGN.md](DESIGN.md).

Plugin data lives in `~/.config/claude-code-deck/` (a UI cache and the live-usage working folder); logs in
`~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.local.claudecode.sdPlugin/logs/`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Every key shows a small ⚠ badge | Grant Stream Deck Accessibility permission (see First run), then restart Stream Deck |
| A press shows ⚠ | Open the key's settings: the status line says why (e.g. Claude not running, no chat selected, the model didn't change) |
| Activity keys are empty | Open the Code tab in the Claude app and start or open a chat |
| Usage says “as of …” instead of “resets …” | Live usage isn't running — check the Usage key's settings; sign in once if asked |
| Keep Awake is dimmed | Install KeepingYouAwake in `/Applications` |
| Changes to the source don't show | `npm run build`, then `npx streamdeck restart com.local.claudecode` (or `npm run watch`) |

## Uninstall

In Stream Deck, open *Preferences → Plugins*, select **Claude Code** and click **−** (Uninstall). This also removes
its bundled profiles. Optionally delete `~/.config/claude-code-deck/`.

## Development

```bash
npm install
npm run watch        # rebuild + restart the plugin on every change (after `streamdeck link`)
npm test             # 400+ unit tests (node --test)
npm run typecheck
npm run validate     # streamdeck validate
npm run gen          # regenerate icons, bundled profiles and manifest.json
npm run pack         # dist/com.local.claudecode.streamDeckPlugin
```

```text
src/
  plugin.ts          entry point: registers the actions
  hub.ts             shared state: chats, selection, usage — notifies actions on change
  ops.ts             queued operations against the app (open chat, paste prompt, model, effort, …)
  actions/           one file per key / dial
  claude/            app + CLI integration: session files, Accessibility (JXA), usage, live usage
  render/            SVG rendering for keys, dials and the Neo infobar
  system/            Keep Awake (KeepingYouAwake)
scripts/             icon / profile / manifest generators, Property Inspector checks
com.local.claudecode.sdPlugin/   the plugin bundle (manifest, UI, images, layouts, profiles)
test/                unit tests
```

## License

[MIT](LICENSE). “Claude” and “Claude Code” are trademarks of Anthropic; “Stream Deck” is a trademark of Corsair /
Elgato. This is an independent community project.
