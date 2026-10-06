// Generates com.local.claudecode.sdPlugin/manifest.json from src/catalog.ts. Run with plain `node` (type stripping).
//   node scripts/gen-manifest.ts

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { ACTIONS, PLUGIN_NAME, PLUGIN_UUID, actionUuid } from "../src/catalog.ts";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const sd = path.resolve(here, `../${PLUGIN_UUID}.sdPlugin`);

const exists = (rel: string) => fs.existsSync(path.join(sd, rel));
const profiles = fs.existsSync(path.join(sd, "profiles"))
  ? fs
      .readdirSync(path.join(sd, "profiles"))
      .filter((f) => f.endsWith(".streamDeckProfile"))
      .sort()
      .map((f) => {
        const name = `profiles/${f.replace(/\.streamDeckProfile$/, "")}`;
        // File names end with " (<DeviceType>)" so the generator knows the device type.
        const dt = Number(/\((\d+)\)$/.exec(name)?.[1] ?? 0);
        return { Name: name, DeviceType: dt, Readonly: false, DontAutoSwitchWhenInstalled: true, AutoInstall: true };
      })
  : [];

const manifest = {
  $schema: "https://schemas.elgato.com/streamdeck/plugins/manifest.json",
  UUID: PLUGIN_UUID,
  Name: PLUGIN_NAME,
  Version: "1.0.0.0",
  Author: "Claude Code for Stream Deck",
  Description:
    "Keep Claude Code within reach while you work: follow active chats, send prompts, steer running tasks, stop work, and switch model, effort and speed in the Claude desktop app — straight from Stream Deck.",
  Category: PLUGIN_NAME,
  CategoryIcon: "imgs/plugin/category-icon",
  Icon: "imgs/plugin/marketplace",
  CodePath: "bin/plugin.js",
  SDKVersion: 3,
  Software: { MinimumVersion: "7.6" },
  OS: [
    { Platform: "mac", MinimumVersion: "13" },
    { Platform: "windows", MinimumVersion: "10" },
  ],
  Nodejs: { Version: "24", Debug: "enabled" },
  ApplicationsToMonitor: { mac: ["com.anthropic.claudefordesktop"], windows: ["Claude.exe"] },
  ...(profiles.length ? { Profiles: profiles } : {}),
  Actions: ACTIONS.map((a) => {
    const action: Record<string, unknown> = {
      UUID: actionUuid(a.id),
      Name: a.name,
      Tooltip: a.tooltip,
      Icon: `imgs/actions/${a.icon}`,
      Controllers: a.controllers,
      PropertyInspectorPath: `ui/${a.id}.html`,
      DisableAutomaticStates: true,
      UserTitleEnabled: false,
      SupportedInMultiActions: a.multi !== false,
      States: [{ Image: `imgs/keys/${a.id}`, ShowTitle: false }],
    };
    if (a.controllers.includes("Encoder")) {
      action.Encoder = {
        Icon: `imgs/dials/${a.id}`,
        layout: exists(`layouts/${a.id}-dial.json`) ? `layouts/${a.id}-dial.json` : "$X1",
        TriggerDescription: { Rotate: a.dial?.rotate, Push: a.dial?.push, Touch: a.dial?.touch, LongTouch: a.dial?.longTouch },
      };
    }
    return action;
  }),
};

fs.writeFileSync(path.join(sd, "manifest.json"), JSON.stringify(manifest, null, "\t"));
console.log(`wrote ${PLUGIN_UUID}.sdPlugin/manifest.json (${ACTIONS.length} actions, ${profiles.length} profiles)`);
