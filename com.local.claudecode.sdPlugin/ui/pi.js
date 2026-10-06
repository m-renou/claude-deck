// Claude Code — shared Property Inspector script for every ui/*.html page.
//
// Load order (every page): ./vendor/sdpi-components.js in <head>, ./pi.js as the last element of <body>. The settings
// are static sdpi-components markup in each page (sdpi persists them); this script only adds behaviour:
//   • data-show-if="setting=a|b" / "setting!=a"  shows a block only for those values (value, else the default)
//   • data-controller="Keypad|Encoder|Neo"       shows a block only on that kind of control
//   • data-copy-to="<setting>"                    a picker (sdpi-select with a datasource, no setting of its own) that
//                                                 fills that setting's text field; it mirrors the field back
//                                                 (data-strip-slash: compare without a leading "/")
//   • data-list-for="<setting>"                   an sdpi-checkbox-list kept in sync with a comma-list text setting
//                                                 (effort levels; empty = all ticked, the last tick can't be removed)
//   • data-array-of="<a>,<b>,…"                   on a hidden field (setting="<x>"): keeps <x> = the array of those
//                                                 settings' values (as shown, defaults included; "none" and repeats
//                                                 dropped) — Model slots → settings.slots. Written through sdpi, and
//                                                 only once one of them was saved. A key that has only the array
//                                                 (profiles, older settings) gets the dropdowns filled from it.
//   • [data-chats]                                the live chat list (Activity), from the plugin's getChats replies
//   • #cc-status                                  the status box: Claude app, Accessibility, selected chat, last result
//                                                 (data-rows="keepAwake,result": KeepingYouAwake instead of the Claude rows)
//   • [data-live-usage]                           the Usage page's live usage: its status line #cc-live and, while
//                                                 Claude Code is signed out, #cc-login with the sign-in command to copy
//                                                 (#cc-login-cmd / #cc-login-copy)
//
// Plugin messages: sends {event:"getStatus"} / {event:"getChats"} (on load, then every 4 s while visible); the plugin
// answers and also pushes {event:"status"} / {event:"getChats"} when something changes.
// Privacy: everything goes through SDPIComponents.streamDeckClient to the local Stream Deck app — no fetch, no remote
// resources. Text from the plugin is always inserted as text (never parsed as HTML). No page takes a password or token.

(() => {
  "use strict";

  const SD = window.SDPIComponents;
  const client = SD && SD.streamDeckClient;
  const ACTION = document.body.dataset.action || "";
  const POLL_MS = 4000;

  // ── Tiny DOM helpers ──────────────────────────────────────────────────────────────────────────────────────

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const str = (v) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

  /** h("span", {class: "x"}, "text", node) — strings become text nodes. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
    for (const c of children.flat()) {
      if (c === undefined || c === null || c === false || c === "") continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const fill = (el, ...children) => el && el.replaceChildren(...children.flat().filter((c) => c !== undefined && c !== null && c !== false && c !== "").map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
  const sub = (...c) => h("span", { class: "cc-sub" }, ...c);
  const dot = (kind) => h("span", { class: `cc-dot${kind ? ` is-${kind}` : ""}` });
  /** Only the plugin's own inline SVG icons are shown. */
  const iconImg = (uri) => (typeof uri === "string" && uri.startsWith("data:image/svg+xml") ? h("img", { class: "cc-ico", src: uri, alt: "" }) : null);

  function send(payload) {
    if (!client) return;
    try {
      const p = client.send("sendToPlugin", payload);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* not connected (opened outside Stream Deck) */
    }
  }

  function ago(at) {
    const s = Math.max(0, Math.round((Date.now() - num(at)) / 1000));
    if (s < 10) return "just now";
    if (s < 60) return `${s} s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const hr = Math.round(m / 60);
    return hr < 24 ? `${hr} h ago` : `${Math.round(hr / 24)} d ago`;
  }

  // ── Platform: data-os="mac|win" blocks show on that OS only; data-win-text replaces a text on Windows ────────

  const WIN = /Windows/i.test(navigator.userAgent || "");
  document.documentElement.dataset.os = WIN ? "win" : "mac";
  for (const el of $$("[data-os]")) el.hidden = el.dataset.os !== (WIN ? "win" : "mac");
  if (WIN) {
    for (const el of $$("[data-win-text]")) el.textContent = el.dataset.winText;
    // sdpi-select draws its own copy of the options: rename those too once it has.
    if (window.customElements)
      customElements.whenDefined("sdpi-select").then(() =>
        setTimeout(() => {
          for (const s of $$("sdpi-select")) {
            for (const o of $$("option[data-win-text]", s)) {
              const copy = s.shadowRoot && Array.from(s.shadowRoot.querySelectorAll("option")).find((x) => x.value === o.value);
              if (copy) copy.textContent = o.dataset.winText;
            }
          }
        }, 0),
      );
  }

  // ── Settings mirror (for show-if) ─────────────────────────────────────────────────────────────────────────

  const settings = {};
  let controller = "";
  /** Latest {event:"status"} payload from the plugin. */
  let status = null;
  let gotStatus = false;
  const settingEl = (key) => document.querySelector(`[setting="${CSS.escape(key)}"]`);

  /** Current value of a setting: the latest one received / edited, else the element's default. */
  function current(key) {
    const v = settings[key];
    if (v !== undefined && v !== null && v !== "") return str(v);
    const el = settingEl(key);
    return el ? str(el.getAttribute("default")) : "";
  }

  function applyVisibility() {
    for (const el of $$("[data-show-if]")) {
      const m = /^([\w.-]+)(!?=)(.*)$/.exec(el.dataset.showIf || "");
      if (!m) continue;
      const hit = m[3].split("|").includes(current(m[1]));
      el.hidden = m[2] === "=" ? !hit : hit;
    }
    for (const el of $$("[data-controller]")) {
      const kinds = (el.dataset.controller || "").split("|");
      // Until Stream Deck says which control this is, show the key (Keypad) version.
      el.hidden = !kinds.includes(controller || "Keypad");
    }
  }

  for (const el of $$("[setting]")) {
    el.addEventListener("valuechange", () => {
      settings[el.getAttribute("setting")] = el.value;
      applyVisibility();
    });
  }

  // ── Pickers and lists bound to a text setting ─────────────────────────────────────────────────────────────

  let syncing = false;
  function quietly(fn) {
    syncing = true;
    try {
      fn();
    } finally {
      syncing = false;
    }
  }

  for (const picker of $$("[data-copy-to]")) {
    const field = settingEl(picker.dataset.copyTo);
    if (!field) continue;
    const norm = (v) => (picker.hasAttribute("data-strip-slash") ? str(v).trim().replace(/^\/+/, "") : str(v).trim());
    picker.addEventListener("valuechange", () => {
      if (syncing) return;
      const v = str(picker.value).trim();
      if (v && norm(field.value) !== v) field.value = v; // sdpi saves the field's new value
    });
    field.addEventListener("valuechange", () => quietly(() => (picker.value = norm(field.value) || undefined)));
  }

  // Effort levels in the app's order; aliases as src/actions/logic.ts parseCycle reads them.
  const LEVELS = ["low", "medium", "high", "xhigh", "max", "ultracode"];
  const LEVEL_ALIAS = { extra: "xhigh", "extra high": "xhigh", "x-high": "xhigh", "x high": "xhigh", ultra: "ultracode", med: "medium" };
  const parseLevels = (t) =>
    str(t)
      .split(/[,;\n]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .map((s) => LEVEL_ALIAS[s] || s)
      .filter((s) => LEVELS.includes(s));
  /** Ticked levels for a cycle setting: empty (never saved, or cleared) = every level, as the key reads it. */
  const levelsOf = (t) => {
    const l = parseLevels(t);
    return l.length ? l : LEVELS.slice();
  };

  const lists = [];
  for (const list of $$("[data-list-for]")) {
    const key = list.dataset.listFor;
    const field = settingEl(key);
    if (!field) continue;
    const sync = () => quietly(() => (list.value = levelsOf(current(key))));
    lists.push(sync);
    list.addEventListener("valuechange", () => {
      if (syncing) return;
      const chosen = Array.isArray(list.value) ? list.value.map(str) : [];
      if (!chosen.some((l) => LEVELS.includes(l))) {
        sync(); // the last ticked level stays: a key always has something to step to
        return;
      }
      field.value = LEVELS.filter((l) => chosen.includes(l)).join(", ");
    });
    field.addEventListener("valuechange", sync);
    sync();
  }

  // Arrays of other settings (Model slots → settings.slots).
  const arrays = [];
  for (const field of $$("[data-array-of]")) {
    const key = field.getAttribute("setting");
    const parts = (field.dataset.arrayOf || "").split(",").map((k) => k.trim()).filter(Boolean);
    const els = parts.map((k) => settingEl(k)).filter(Boolean);
    if (!key || els.length !== parts.length) continue;
    const NONE = "none";
    const effective = () => {
      const out = [];
      for (const k of parts) {
        const v = current(k).trim();
        if (v && v !== NONE && !out.includes(v)) out.push(v);
      }
      return out;
    };
    const anySaved = () => parts.some((k) => typeof settings[k] === "string");
    /** Write the array when it differs from what is saved — only after one of its settings was saved. Deferred, so
     * settings arriving from Stream Deck (one field at a time) are all in before it compares. */
    let timer = 0;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!anySaved()) return;
        const next = effective();
        if (JSON.stringify(settings[key]) === JSON.stringify(next)) return;
        settings[key] = next;
        field.value = next; // sdpi saves it with the rest of the settings
      }, 0);
    };
    /** A key with only the array: show it in the dropdowns (sdpi then saves them). */
    const adopt = () => {
      const arr = settings[key];
      if (!Array.isArray(arr) || !arr.length || anySaved()) return;
      els.forEach((el, i) => {
        const v = str(arr[i]).trim() || NONE;
        settings[parts[i]] = v;
        el.value = v;
      });
    };
    for (const el of els) el.addEventListener("valuechange", update);
    arrays.push(adopt);
  }

  // ── Chat list (Activity) ──────────────────────────────────────────────────────────────────────────────────

  const chatsHost = $("[data-chats]");
  const chatsHint = $("[data-chats-hint]");
  let lastFollow = 0;

  function renderChats(items, follow) {
    if (!chatsHost) return;
    lastFollow = num(follow);
    const list = Array.isArray(items) ? items.filter((it) => it && typeof it === "object") : [];
    if (!list.length) {
      fill(chatsHost, h("li", { class: "cc-empty" }, "No Claude Code chats yet. Open the Code tab in the Claude app."));
    } else {
      fill(
        chatsHost,
        list.map((it) => {
          const pos = num(it.position) || num(it.value);
          const diff = it.diff && typeof it.diff === "object" ? it.diff : null;
          const meta = diff
            ? h("span", { class: "cc-meta" }, num(diff.added) > 0 ? h("span", { class: "cc-add" }, `+${num(diff.added)}`) : "", num(diff.removed) > 0 ? h("span", { class: "cc-del" }, `-${num(diff.removed)}`) : "")
            : h("span", { class: "cc-meta" }, str(it.time));
          const li = h(
            "li",
            {
              class: `cc-chat${it.selected ? " is-selected" : ""}${pos === lastFollow ? " is-mine" : ""}`,
              title: `${pos}. ${str(it.title)} — ${str(it.statusLabel)}`,
            },
            iconImg(it.icon),
            h("span", { class: "cc-pos" }, String(pos)),
            h("span", { class: "cc-title" }, str(it.title)),
            meta,
          );
          if (typeof it.tile === "string" && /^#[0-9a-f]{3,8}$/i.test(it.tile)) li.style.setProperty("--tile", it.tile);
          return li;
        }),
      );
      const mine = $(".cc-chat.is-mine", chatsHost);
      if (mine) mine.scrollIntoView({ block: "nearest" });
    }
    renderChatsHint();
  }

  function renderChatsHint() {
    if (!chatsHint) return;
    const f = status && status.follow;
    const parts = [];
    if (f && num(f.position) > 0) {
      parts.push(h("span", { class: "cc-swatch is-mine" }), `This key: chat ${num(f.position)}${f.auto ? " (auto, key order)" : ""}. `);
    }
    parts.push(h("span", { class: "cc-swatch is-selected" }), "Open in Claude.");
    fill(chatsHint, parts);
  }

  // ── Live usage (Usage page) ───────────────────────────────────────────────────────────────────────────────

  const liveCell = $("#cc-live");
  const loginBox = $("#cc-login");
  const loginCmd = $("#cc-login-cmd");
  const loginCopy = $("#cc-login-copy");

  /** Copy the sign-in command. It is selected first, so ⌘C works where the page may not write the clipboard. */
  let copyTimer = 0;
  function copyLogin() {
    if (!loginCmd || !loginCopy) return;
    const label = (text) => {
      clearTimeout(copyTimer);
      loginCopy.textContent = text;
      copyTimer = setTimeout(() => (loginCopy.textContent = "Copy command"), 2500);
    };
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(loginCmd);
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    if (copied) return label("Copied");
    const cb = navigator.clipboard;
    if (cb && typeof cb.writeText === "function") {
      cb.writeText(str(loginCmd.textContent)).then(
        () => label("Copied"),
        () => label("Press ⌘C"),
      );
    } else label("Press ⌘C");
  }

  if (loginCopy) loginCopy.addEventListener("click", copyLogin);
  if (liveCell) fill(liveCell, dot(), client ? "Waiting for the plugin…" : "Open this panel from Stream Deck.");

  /** The live-usage status line (the plugin words it: "Live · updated 21:41", "Sign in once: run this in Terminal") and,
   *  while Claude Code is signed out, the sign-in command. */
  function renderLive() {
    if (!liveCell) return;
    const lu = status && status.liveUsage && typeof status.liveUsage === "object" ? status.liveUsage : null;
    if (!lu) {
      // Same as the status box: the plugin never answered.
      if (!gotStatus && client) fill(liveCell, dot("bad"), "No answer from the plugin", sub("Is the Claude Code plugin running? Reopen this panel."));
      return;
    }
    fill(liveCell, dot(lu.tone === "good" ? "good" : lu.tone === "bad" ? "bad" : ""), str(lu.text), str(lu.detail) ? sub(str(lu.detail)) : "");
    const cmd = str(lu.loginCommand);
    if (loginBox) loginBox.hidden = !cmd;
    if (loginCmd && cmd && loginCmd.textContent !== cmd) loginCmd.textContent = cmd;
  }

  // ── Status box ────────────────────────────────────────────────────────────────────────────────────────────

  const statusHost = $("#cc-status");
  const ROWS = {
    app: ["Claude", "cc-s-app"],
    access: ["Accessibility", "cc-s-access"],
    chat: ["Chat", "cc-s-chat"],
    keepAwake: ["Keep awake", "cc-s-awake"],
    result: ["Last result", "cc-s-result"],
  };
  const rows = ((statusHost && statusHost.dataset.rows) || "app,access,chat,result")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => ROWS[r])
    .filter((r) => !(WIN && r === "access")); // Windows asks for no permission
  /** The first row's cell carries "waiting for the plugin" / "no answer". */
  const firstCell = rows.length ? ROWS[rows[0]][1] : "";

  const row = (label, id) => h("div", { class: "cc-row" }, h("span", { class: "cc-k" }, label), h("span", { class: "cc-v", id }));
  if (statusHost) {
    statusHost.classList.add("cc-status");
    statusHost.setAttribute("aria-live", "polite");
    fill(statusHost, rows.map((r) => row(ROWS[r][0], ROWS[r][1])));
    fill(cell(firstCell), dot(), client ? "Waiting for the plugin…" : "Open this panel from Stream Deck.");
  }
  function cell(id) {
    return id ? document.getElementById(id) : null;
  }

  /** "14:32" for a time later today. */
  const clock = (at) => new Date(num(at)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function renderStatus() {
    renderLive();
    if (!statusHost) return;
    const p = status;
    if (!p) {
      if (!gotStatus && client) fill(cell(firstCell), dot("bad"), "No answer from the plugin", sub("Is the Claude Code plugin running? Reopen this panel."));
      return;
    }

    const app = p.app && typeof p.app === "object" ? p.app : {};
    const note = str(p.note) ? sub(str(p.note)) : "";
    if (app.installed === false) fill(cell("cc-s-app"), dot("bad"), "Not installed", sub("Install the Claude desktop app."), note);
    else if (app.running) fill(cell("cc-s-app"), dot("good"), "Running", note);
    else fill(cell("cc-s-app"), dot(), "Not running", sub("Open the Claude app."), note);

    const fix = h("span", { class: "cc-fix" }, str(p.accessFix));
    if (p.access === "granted") fill(cell("cc-s-access"), dot("good"), "Granted");
    else if (p.access === "missing") fill(cell("cc-s-access"), dot("bad"), "Missing", p.needsAccess ? "" : sub("This key doesn't need it; most other keys do."), fix);
    else fill(cell("cc-s-access"), dot(), "Checking…");

    const c = p.chat && typeof p.chat === "object" ? p.chat : null;
    if (c) {
      fill(
        cell("cc-s-chat"),
        h("span", { class: "cc-line" }, iconImg(c.icon), str(c.title)),
        sub(str(c.statusLabel), str(c.detail) ? ` · ${str(c.detail)}` : ""),
      );
    } else {
      fill(cell("cc-s-chat"), h("span", { class: "cc-sub" }, "None yet — open the Code tab in the Claude app."));
    }

    const k = p.keepAwake && typeof p.keepAwake === "object" ? p.keepAwake : null;
    if (k) {
      const err = str(k.error) ? sub(`Couldn't read its state: ${str(k.error)}`) : "";
      if (WIN) fill(cell("cc-s-awake"), dot(k.active ? "good" : ""), k.active ? (num(k.until) > 0 ? `On until ${clock(k.until)}` : "On") : "Off", sub(k.pending ? "Switching…" : k.active ? "Your PC won't go to sleep." : "Press the key to keep your PC awake."), err);
      else if (!k.installed) fill(cell("cc-s-awake"), dot("bad"), "KeepingYouAwake isn't installed", sub("Get it from keepingyouawake.app (or Homebrew), then press the key."), err);
      else if (k.active) fill(cell("cc-s-awake"), dot("good"), num(k.until) > 0 ? `On until ${clock(k.until)}` : "On", sub(k.pending ? "Switching…" : "Your Mac won't go to sleep."), err);
      else fill(cell("cc-s-awake"), dot(), "Off", sub(k.pending ? "Switching…" : k.running ? "KeepingYouAwake is running." : "KeepingYouAwake isn't running (turning on starts it)."), err);
    }

    const r = p.result && typeof p.result === "object" ? p.result : null;
    if (r) {
      fill(
        cell("cc-s-result"),
        h("span", { class: r.ok ? "cc-ok" : "cc-alert" }, h("span", { class: "cc-mark" }, r.ok ? "✓" : "⚠")),
        str(r.message),
        sub(ago(r.at)),
      );
    } else {
      fill(cell("cc-s-result"), h("span", { class: "cc-sub" }, "Press the key to see what it did."));
    }
    renderChatsHint();
  }

  function onStatus(p) {
    gotStatus = true;
    status = p;
    if (str(p.controller) && p.controller !== controller) {
      controller = p.controller;
      applyVisibility();
    }
    renderStatus();
  }

  // ── Wire up ───────────────────────────────────────────────────────────────────────────────────────────────

  applyVisibility();
  renderChatsHint();
  if (!client) return;

  client.didReceiveSettings.subscribe((ev) => {
    const s = ev && ev.payload && ev.payload.settings;
    if (!s || typeof s !== "object") return;
    for (const k of Object.keys(settings)) delete settings[k];
    Object.assign(settings, s);
    applyVisibility();
    for (const sync of lists) sync();
    // After sdpi has put the received values into its fields.
    setTimeout(() => {
      for (const adopt of arrays) adopt();
    }, 0);
  });

  client.sendToPropertyInspector.subscribe((msg) => {
    const p = msg && msg.payload;
    if (!p || typeof p !== "object") return;
    if (p.event === "status") onStatus(p);
    else if (p.event === "getChats") renderChats(p.items, p.follow);
  });

  client
    .getConnectionInfo()
    .then((info) => {
      const c = str(info && info.actionInfo && info.actionInfo.payload && info.actionInfo.payload.controller);
      if (c && c !== controller) {
        controller = c;
        applyVisibility();
      }
    })
    .catch(() => {});

  function poll() {
    send({ event: "getStatus" });
    if (chatsHost) send({ event: "getChats" });
  }
  poll();
  setTimeout(() => {
    if (!gotStatus) renderStatus();
  }, 4000);
  setInterval(() => {
    if (document.hidden) return;
    poll();
    if (status) renderStatus(); // keeps "x min ago" current between replies
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) poll();
  });
})();
