// The plugin's actions — modelled on Elgato's "ChatGPT & Codex" plugin, for the Claude desktop app (Claude Code).
// The manifest is generated from this list (scripts/gen-manifest.ts).

export const PLUGIN_UUID = "com.local.claudecode";
export const PLUGIN_NAME = "Claude Code";

export type Controller = "Keypad" | "Encoder" | "Neo";

export interface ActionDef {
  id: string;
  name: string;
  tooltip: string;
  controllers: Controller[];
  /** Encoder (dial) trigger descriptions shown in the Stream Deck app. */
  dial?: { rotate?: string; push?: string; touch?: string; longTouch?: string };
  /** Static image ids (imgs/actions/<icon>.svg for the action list, imgs/keys/<icon>.svg as the default key image). */
  icon: string;
  /** Allowed in Multi Actions (false for stateful list actions). */
  multi?: boolean;
}

export const ACTIONS: ActionDef[] = [
  {
    id: "activity",
    name: "Activity",
    tooltip: "Follow a chat: its status (working, waiting for input, ready) and latest activity. Press to open it in the Claude app.",
    controllers: ["Keypad", "Encoder", "Neo"],
    dial: { rotate: "Browse chats", push: "Open chat", touch: "Open chat" },
    icon: "chat",
    multi: false,
  },
  { id: "new-chat", name: "New Chat", tooltip: "Start a new Claude Code chat in the Claude desktop app.", controllers: ["Keypad"], icon: "compose" },
  { id: "dictate", name: "Dictate", tooltip: "Dictate a prompt into the selected chat (macOS Dictation, Windows voice typing).", controllers: ["Keypad"], icon: "mic" },
  { id: "send-prompt", name: "Send Prompt", tooltip: "Send a configured prompt to the selected chat.", controllers: ["Keypad"], icon: "send" },
  { id: "steer", name: "Steer", tooltip: "Give additional direction while the selected chat is working.", controllers: ["Keypad"], icon: "steer" },
  {
    id: "run-skill",
    name: "Run Skill",
    tooltip: "Run a configured skill in the selected chat.",
    controllers: ["Keypad", "Encoder"],
    dial: { rotate: "Browse skills", push: "Run skill", touch: "Run skill" },
    icon: "skill",
  },
  { id: "stop", name: "Stop", tooltip: "Stop active work in the selected chat.", controllers: ["Keypad"], icon: "stop" },
  { id: "model", name: "Model", tooltip: "Choose which model the selected chat uses.", controllers: ["Keypad"], icon: "model" },
  { id: "effort", name: "Effort", tooltip: "Adjust reasoning effort for the selected chat (including Ultracode).", controllers: ["Keypad"], icon: "effort" },
  { id: "speed", name: "Speed", tooltip: "Switch between Standard and Fast when the model offers fast mode.", controllers: ["Keypad"], icon: "bolt" },
  {
    id: "usage",
    name: "Usage",
    tooltip: "View usage: your plan's limits (live every minute from Claude Code, else as the Claude app recorded them), otherwise the selected chat's context window.",
    controllers: ["Keypad", "Encoder", "Neo"],
    dial: { rotate: "Switch view", push: "Refresh", touch: "Refresh" },
    icon: "usage",
  },
  {
    id: "toggle-panel",
    name: "Toggle Panel",
    tooltip: "Show or hide a Claude panel: Review (diff), Terminal, Browser, Files or Side chat.",
    controllers: ["Keypad"],
    icon: "panel-bottom",
  },
  {
    id: "keep-awake",
    name: "Keep Awake",
    tooltip: "Keep your computer awake (on a Mac with KeepingYouAwake). Press to turn it on or off.",
    controllers: ["Keypad"],
    icon: "cup",
  },
  {
    id: "power",
    name: "Power",
    tooltip: "Move between model and reasoning configurations from a single dial.",
    controllers: ["Encoder"],
    dial: { rotate: "Faster ↔ Smarter", push: "Apply", touch: "Apply" },
    icon: "bolt",
  },
];

export const actionUuid = (id: string): string => `${PLUGIN_UUID}.${id}`;

/** Panels for Toggle Panel (documented Code-tab shortcuts, plus ⌘⇧F for Files). */
export const PANELS = [
  { id: "review", label: "Review", icon: "panel-review" },
  { id: "terminal", label: "Terminal", icon: "panel-terminal" },
  { id: "browser", label: "Browser", icon: "panel-browser" },
  { id: "files", label: "Files", icon: "panel-files" },
  { id: "sideChat", label: "Side chat", icon: "panel-side-chat" },
] as const;
