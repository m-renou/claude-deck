// A stand-in for the Claude desktop app's Code tab on Windows (Electron, like the real app): one window titled
// "Claude" with a prompt box, the effort slider (Ctrl+Shift+E), the model menu (Ctrl+Shift+I) and the panel
// shortcuts. Everything the page sees (sent prompts, effort / model picks, shortcuts) is appended as JSON lines to
// FAKE_CLAUDE_LOG, so the end-to-end tests can check what the plugin's UI Automation program did.
//   FAKE_CLAUDE_LOG      file the events go to (required)
//   FAKE_CLAUDE_PROMPT   "contenteditable" (default, like the real app) or "textarea"
//   FAKE_CLAUDE_VIEW     "chat" (default) or "home" (no prompt box)

const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const log = process.env.FAKE_CLAUDE_LOG;
if (!log) {
  console.error("FAKE_CLAUDE_LOG is required");
  process.exit(2);
}

ipcMain.on("event", (_e, ev) => fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...ev })}\n`));

// No default menu: its accelerators (Ctrl+Shift+I = DevTools …) would take the shortcuts the real app uses.
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    title: "Claude",
    width: 900,
    height: 640,
    show: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: false },
  });
  win.setMenuBarVisibility(false);
  const query = { prompt: process.env.FAKE_CLAUDE_PROMPT || "contenteditable", view: process.env.FAKE_CLAUDE_VIEW || "chat" };
  win.loadFile(path.join(__dirname, "index.html"), { query });
  win.on("page-title-updated", (e) => e.preventDefault());
  win.webContents.once("did-finish-load", () => fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), type: "ready", pid: process.pid })}\n`));
});

app.on("window-all-closed", () => app.quit());
