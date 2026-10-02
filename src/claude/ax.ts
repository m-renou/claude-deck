// The JXA (JavaScript for Automation) program that drives the Claude desktop app through macOS Accessibility
// (System Events). control.ts runs it with `osascript -l JavaScript -e <JXA> -- <request JSON>`: every request —
// including any text to type — arrives as argv, never interpolated into the source. It prints one JSON reply.
//
// What it knows about the app (measured on the live app, Code tab, Claude for desktop):
//   • The prompt box is an AXTextArea whose AXDescription is "Prompt" (AXValue "\n" when empty), ~32 levels deep in
//     the front window. Electron only builds its AX tree after AXManualAccessibility = true on the process.
//     Finding it takes seconds, so callers pass the box's cached index path (window → child index → …); it is
//     verified on use and only re-searched when it no longer points at the box (nearest-first around the old path).
//   • ⌘⇧E opens the effort SLIDER and focuses it: AXSlider "Effort", AXValue = stop index (low … max, Ultracode
//     last). Left / Right move one stop and apply at once; ⌘⇧E again closes it. Number keys do nothing there.
//   • ⌘⇧I opens the model menu; a digit picks that row. The digit is only typed once focus has moved off the text
//     input it was in (evidence the menu opened): otherwise it would land in the prompt box or the terminal.
//   • Esc stops a running response — so this program never presses Esc unless the caller explicitly asks for it
//     (the Stop key).
// Safety: before every keystroke the Claude process must be frontmost (else it throws "not-frontmost" and stops).
// Return is only pressed while the located prompt box itself has keyboard focus, and only after the pasted text was
// read back from it. The clipboard is saved with every item and type (images, files, rich text) and put back.
//
// Requests ({ op, bundle, … }):
//   locate  { path? }                                     find the prompt box, read-only (no activation, no keys)
//   prompt  { path?, scan?, text?, submit, requireEmpty } focus the box; paste text and/or press Return
//   effort  { target, stops? }                            move the effort slider to stop `target`
//   model   { index }                                     ⌘⇧I, then digit index+1 (only once the menu has focus)
//   keys    { keys: [{ code? | key?, mods? }], gap?, checkPath? }  plain shortcuts (panels, fast mode, Esc for Stop)
//   dictate { path?, scan?, menu, items }                 focus the box, then click the dictation menu item
// `scan: false` = use the cached path only (fail fast with prompt-not-found instead of searching the window).
// `checkPath` = press nothing unless that cached path still points at a visible prompt box (a Code chat is shown).
// Replies: { ok, error?, detail?, path?, stale?, rescanned?, draft?, cleared?, from?, to?, max?, closed?, ms }.
//
// Pure helpers (planPrompt, arrowPlan) are plain functions in the same source, so tests evaluate this exact text.

export const JXA_SOURCE = String.raw`
var MODS = { cmd: "command down", ctrl: "control down", shift: "shift down", alt: "option down" };
// Roles whose subtree can't hold the prompt box: the search doesn't descend into them.
var LEAF = { AXStaticText: 1, AXImage: 1, AXButton: 1, AXLink: 1, AXHeading: 1, AXCheckBox: 1, AXRadioButton: 1,
  AXTextField: 1, AXTextArea: 1, AXScrollBar: 1, AXSlider: 1, AXPopUpButton: 1, AXMenuButton: 1, AXMenuItem: 1,
  AXValueIndicator: 1, AXIncrementor: 1, AXProgressIndicator: 1, AXDisclosureTriangle: 1 };
var KEY_RETURN = 36, KEY_LEFT = 123, KEY_RIGHT = 124;
// Roles that take typed characters (a digit meant for a menu must never reach one).
var TEXT_INPUT = { AXTextArea: 1, AXTextField: 1, AXComboBox: 1 };

function Fail(code, extra) { this.code = code; this.extra = extra; }
function fail(code, extra) { throw new Fail(code, extra); }

// ── pure helpers (unit-tested in Node) ────────────────────────────────────────────────────────────────────

/** What to do with the prompt box: paste text and/or press Return, or why not. */
function planPrompt(draft, text, opts) {
  var hasDraft = String(draft || "").trim() !== "";
  if (typeof text === "string" && text.trim() !== "") {
    if (opts.requireEmpty && hasDraft) return { error: "draft-not-empty" };
    return { paste: true, submit: !!opts.submit };
  }
  if (!opts.submit) return { paste: false, submit: false };
  if (!hasDraft) return { error: "prompt-empty" };
  return { paste: false, submit: true };
}

/** Arrow presses that move the effort slider from stop "from" to stop "to". */
function arrowPlan(from, to) {
  var d = to - from;
  return { code: d < 0 ? KEY_LEFT : KEY_RIGHT, count: Math.abs(d) };
}

/** The prompt box text without the trailing newline the app keeps in it. */
function draftOf(value) { return String(value || "").replace(/\n$/, ""); }

/** Whitespace-insensitive form of a text (the box may render line breaks differently). */
function norm(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

/** Does a value read from the box hold the pasted text (its first 40 characters)? Unreadable values never do. */
function holds(value, text) {
  var t = norm(text).slice(0, 40);
  return typeof value === "string" && t !== "" && norm(value).indexOf(t) >= 0;
}

// ── small AX helpers ────────────────────────────────────────────────────────────────────────────────────

function waitFor(fn, secs, step) {
  var end = Date.now() + secs * 1000;
  for (;;) {
    try { if (fn()) return true; } catch (e) {}
    if (Date.now() >= end) return false;
    delay(step || 0.05);
  }
}
function attr(el, name) { try { return el.attributes.byName(name).value(); } catch (e) { return undefined; } }
function roleOf(el) { try { return el.role(); } catch (e) { return ""; } }
function descOf(el) { var d = attr(el, "AXDescription"); return typeof d === "string" ? d : ""; }
function valueOf(el) { var v = attr(el, "AXValue"); return typeof v === "string" ? v : ""; }
function numOf(el, name) { var v = attr(el, name); var n = Number(v); return v === undefined || v === null || v === "" || !isFinite(n) ? undefined : n; }
function isPrompt(el) { return !!el && roleOf(el) === "AXTextArea" && descOf(el) === "Prompt"; }
function isEffortSlider(el) { return !!el && roleOf(el) === "AXSlider" && descOf(el) === "Effort"; }
function visible(el) {
  try { var s = el.size(); return !s || (s[0] > 0 && s[1] > 0); } catch (e) { return true; }
}
function focused(ctx) { var f = attr(ctx.p, "AXFocusedUIElement"); return f || null; }
function focusKey(el) { return el ? roleOf(el) + "|" + descOf(el) : ""; }
function isTextInput(el) { return !!el && TEXT_INPUT[roleOf(el)] === 1; }
function samePlace(a, b) {
  try { var pa = a.position(), pb = b.position(), sa = a.size(), sb = b.size(); return pa[0] === pb[0] && pa[1] === pb[1] && sa[0] === sb[0] && sa[1] === sb[1]; } catch (e) { return false; }
}
/** Does this very element have keyboard focus? (Not just "some prompt box": the side chat has one too.) */
function hasFocus(ctx, el) {
  if (attr(el, "AXFocused") === true) return true;
  // AXFocused unreadable or stale: the focused element must be a prompt box in the same place.
  var f = focused(ctx);
  return isPrompt(f) && samePlace(f, el);
}

// ── front + guarded keystrokes ──────────────────────────────────────────────────────────────────────────

function isFront(ctx) { try { return ctx.p.frontmost() === true; } catch (e) { return false; } }

/** Bring Claude to the front only when it isn't already (no settle delay when it is). */
function front(ctx) {
  if (isFront(ctx)) return true;
  try { Application(ctx.req.bundle).activate(); } catch (e) {}
  if (waitFor(function () { return isFront(ctx); }, 1.5)) { delay(0.2); return true; }
  try { ctx.p.frontmost = true; } catch (e) {}
  if (waitFor(function () { return isFront(ctx); }, 1.0)) { delay(0.2); return true; }
  return false;
}

function guard(ctx) { if (!isFront(ctx)) fail("not-frontmost"); }

/** One keystroke, only while Claude is frontmost. k = { code } (key code) or { key } (a character), + mods. */
function press(ctx, k) {
  guard(ctx);
  var using = [];
  for (var i = 0; k.mods && i < k.mods.length; i++) if (MODS[k.mods[i]]) using.push(MODS[k.mods[i]]);
  if (typeof k.code === "number") {
    if (using.length) ctx.se.keyCode(k.code, { using: using }); else ctx.se.keyCode(k.code);
  } else {
    if (using.length) ctx.se.keystroke(String(k.key), { using: using }); else ctx.se.keystroke(String(k.key));
  }
  ctx.pressed++;
}

// ── finding the prompt box ──────────────────────────────────────────────────────────────────────────────

function chain(root, path) { var el = root; for (var i = 0; i < path.length; i++) el = el.uiElements[path[i]]; return el; }
function stepwise(root, path) {
  var el = root;
  for (var i = 0; i < path.length; i++) { var kids = el.uiElements(); if (path[i] >= kids.length) return null; el = kids[path[i]]; }
  return el;
}
function childRoles(el) {
  try { var r = el.uiElements.role(); if (r && typeof r.length === "number") return r; } catch (e) {}
  try { var kids = el.uiElements(); var out = []; for (var i = 0; i < kids.length; i++) out.push(roleOf(kids[i])); return out; } catch (e) {}
  return [];
}

/** Depth-first under root (its child skipIdx excluded): index path of the first visible prompt box, or null. */
function dfs(root, rootPath, skipIdx, st) {
  var stack = [{ el: root, path: rootPath, skip: skipIdx }];
  while (stack.length) {
    var node = stack.pop();
    if (++st.visited > st.budget || Date.now() > st.deadline) { st.exhausted = true; return null; }
    var roles = childRoles(node.el);
    for (var i = 0; i < roles.length; i++) {
      if (i === node.skip || roles[i] !== "AXTextArea") continue;
      var c = node.el.uiElements[i];
      if (descOf(c) === "Prompt" && visible(c)) return node.path.concat([i]);
    }
    for (var j = roles.length - 1; j >= 0; j--) {
      if (j === node.skip || LEAF[roles[j]]) continue;
      stack.push({ el: node.el.uiElements[j], path: node.path.concat([j]), skip: -1 });
    }
  }
  return null;
}

/** Nearest-first search: around the old path (deepest ancestor first), then outwards — each node at most once. */
function search(win, old, st) {
  if (!old.length) return dfs(win, [], -1, st);
  for (var k = old.length - 1; k >= 0; k--) {
    var hit = dfs(chain(win, old.slice(0, k)), old.slice(0, k), k < old.length - 1 ? old[k] : -1, st);
    if (hit || st.exhausted) return hit;
  }
  return null;
}

function validPath(p) {
  if (!p || typeof p.length !== "number" || p.length > 80) return null;
  for (var i = 0; i < p.length; i++) if (typeof p[i] !== "number" || p[i] < 0 || p[i] % 1 !== 0) return null;
  return p;
}

/** The visible prompt box at a cached index path, or null. */
function atPath(win, path) {
  var el = chain(win, path);
  if (isPrompt(el) && visible(el)) return el;
  try { el = stepwise(win, path); if (el && isPrompt(el) && visible(el)) return el; } catch (e) {}
  return null;
}

/** The prompt box of the front window: the cached path when it still points at it, else a search (unless scan: false). */
function locate(ctx) {
  // (not wrapped in try: a missing Accessibility permission must surface here, not look like "no window")
  if (!ctx.p.windows.length) return { error: "no-window" };
  var win = ctx.p.windows[0];
  var old = validPath(ctx.req.path) || [];
  if (old.length) {
    var el = atPath(win, old);
    if (el) return { el: el, path: old, rescanned: false };
  }
  if (ctx.req.scan === false) return { error: "prompt-not-found", rescanned: false };
  var st = { visited: 0, budget: ctx.req.budget || 12000, deadline: Date.now() + (ctx.req.scanSecs || 15) * 1000, exhausted: false };
  var found = search(win, old, st);
  if (!found) return { error: "prompt-not-found", rescanned: true, visited: st.visited };
  return { el: chain(win, found), path: found, rescanned: true, visited: st.visited };
}

/** Put keyboard focus in the located box itself (another focused "Prompt" — the side chat's — doesn't count). */
function focusPrompt(ctx, el) {
  if (hasFocus(ctx, el)) return true;
  try { el.attributes.byName("AXFocused").value = true; } catch (e) {}
  return waitFor(function () { return hasFocus(ctx, el); }, 0.8, 0.05);
}

// ── clipboard (every item with all its types: saved, restored only while it still holds our text) ─────

/** The clipboard's items, each as [{ t: type, d: data }] (images, files, rich text, concealed markers), or null. */
function clipSave(pb) {
  try {
    var items = pb.pasteboardItems, out = [];
    var n = Number(items.count);
    for (var i = 0; i < n; i++) {
      var it = items.objectAtIndex(i), types = it.types, entry = [];
      var m = Number(types.count);
      for (var j = 0; j < m; j++) {
        var t = types.objectAtIndex(j), d = it.dataForType(t);
        if (d && !(typeof d.isNil === "function" && d.isNil())) entry.push({ t: t, d: d });
      }
      if (entry.length) out.push(entry);
    }
    return out;
  } catch (e) { return null; }
}

function clipRestore(pb, saved) {
  if (!saved) return; // couldn't read it: leave it alone rather than clear it
  pb.clearContents;
  if (!saved.length) return;
  var arr = $.NSMutableArray.array;
  for (var i = 0; i < saved.length; i++) {
    var item = $.NSPasteboardItem.alloc.init;
    for (var j = 0; j < saved[i].length; j++) item.setDataForType(saved[i][j].d, saved[i][j].t);
    arr.addObject(item);
  }
  pb.writeObjects(arr);
}

function paste(ctx, el, text, before) {
  ObjC.import("AppKit");
  var pb = $.NSPasteboard.generalPasteboard;
  var T = $.NSPasteboardTypeString;
  var saved = clipSave(pb);
  pb.clearContents;
  pb.setStringForType($(text), T);
  var mine = String(pb.changeCount);
  // Landed = the box (read back, not just "changed") holds the text. A box that can't be read never counts.
  var arrived = function () { var v = attr(el, "AXValue"); return typeof v === "string" && v !== before && holds(v, text); };
  var landed = false;
  try {
    press(ctx, { key: "v", mods: ["cmd"] });
    landed = waitFor(arrived, 1.5, 0.05);
    // A busy app may take ⌘V late: give it a moment more before the user's own clipboard comes back.
    if (!landed) { delay(0.5); landed = arrived(); }
  } finally {
    if (String(pb.changeCount) === mine) clipRestore(pb, saved);
  }
  return landed;
}

/** Return, then wait for the box to empty (the app took the message). A slash command's first Return can be taken
 *  by the command menu: if the box still holds just that command, press Return once more. Return is only pressed
 *  while the box itself has keyboard focus (else "focus-lost": nothing is sent). */
function submit(ctx, el, text) {
  var empty = function () { var v = attr(el, "AXValue"); return typeof v === "string" && draftOf(v).trim() === ""; };
  var enter = function () {
    if (!hasFocus(ctx, el)) fail("focus-lost");
    press(ctx, { code: KEY_RETURN });
  };
  enter();
  var cleared = waitFor(empty, 0.8, 0.05);
  if (!cleared && typeof text === "string" && text.charAt(0) === "/") {
    var cmd = text.trim().split(/\s+/)[0];
    var now = draftOf(valueOf(el)).trim();
    if (now === cmd || now.indexOf(cmd + " ") === 0) {
      enter();
      cleared = waitFor(empty, 0.8, 0.05);
    }
  }
  return cleared;
}

// ── operations ──────────────────────────────────────────────────────────────────────────────────────────

function opLocate(ctx) {
  var loc = locate(ctx);
  if (!loc.el) return { ok: false, error: loc.error, path: null, rescanned: !!loc.rescanned, visited: loc.visited };
  return { ok: true, path: loc.path, rescanned: loc.rescanned, visited: loc.visited };
}

/** The box at the cached path wouldn't take focus: tell the caller to drop that path (the retry searches again). */
function focusFailed(loc) {
  return { ok: false, error: "focus-failed", path: null, stale: !loc.rescanned, rescanned: loc.rescanned };
}

function opPrompt(ctx) {
  var req = ctx.req;
  if (!front(ctx)) return { ok: false, error: "not-frontmost" };
  var loc = locate(ctx);
  if (!loc.el) return { ok: false, error: loc.error, path: null, rescanned: !!loc.rescanned };
  var out = { ok: false, path: loc.path, rescanned: loc.rescanned };
  if (!focusPrompt(ctx, loc.el)) return focusFailed(loc);
  var before = valueOf(loc.el);
  var draft = draftOf(before);
  out.draft = draft.slice(0, 200);
  out.hadDraft = draft.trim() !== "";
  var plan = planPrompt(draft, req.text, req);
  if (plan.error) { out.error = plan.error; return out; }
  if (plan.paste && !paste(ctx, loc.el, req.text, before)) { out.error = "paste-failed"; return out; }
  if (plan.submit) out.cleared = submit(ctx, loc.el, plan.paste ? req.text : draft);
  out.ok = true;
  return out;
}

function opEffort(ctx) {
  var req = ctx.req;
  if (!front(ctx)) return { ok: false, error: "not-frontmost" };
  var toggle = function () { press(ctx, { key: "e", mods: ["cmd", "shift"] }); };
  // Never leave the slider open: while it has focus, arrow keys move it, and every stop applies at once. ⌘⇧E is a
  // toggle, so it's only pressed while the slider is what has focus.
  var close = function () {
    if (isEffortSlider(focused(ctx))) toggle();
    return waitFor(function () { return !isEffortSlider(focused(ctx)); }, 0.5, 0.05);
  };
  var f = focused(ctx);
  if (!isEffortSlider(f)) {
    toggle();
    if (!waitFor(function () { f = focused(ctx); return isEffortSlider(f); }, 1.2, 0.05)) {
      delay(0.15);
      if (isEffortSlider(focused(ctx))) close(); // it opened late
      return { ok: false, error: "effort-not-open" };
    }
  }
  try {
    var from = numOf(f, "AXValue");
    var max = numOf(f, "AXMaxValue");
    var target = Number(req.target);
    if (from === undefined || !(target >= 0)) return { ok: false, error: "effort-unreadable", from: from, max: max, closed: close() };
    // The slider has the model's levels, plus Ultracode where the app offers it (so stops-1 or stops-2 as its max).
    var stopsOk = typeof req.stops !== "number" || max === req.stops - 1 || max === req.stops - 2;
    if (max !== undefined && (target > max || !stopsOk)) return { ok: false, error: "effort-range", from: from, max: max, closed: close() };
    var plan = arrowPlan(from, target);
    for (var i = 0; i < plan.count; i++) {
      if (!isEffortSlider(focused(ctx))) break; // focus moved away: the arrows would go elsewhere
      press(ctx, { code: plan.code });
      delay(0.06);
    }
    waitFor(function () { return numOf(f, "AXValue") === target; }, 0.6, 0.05);
    var to = numOf(f, "AXValue");
    var closed = close();
    return { ok: to === target, error: to === target ? undefined : "effort-stuck", from: from, to: to, max: max, closed: closed };
  } catch (e) {
    try { if (isFront(ctx)) close(); } catch (x) {}
    throw e;
  }
}

function opModel(ctx) {
  var idx = Number(ctx.req.index);
  if (!(idx >= 0 && idx <= 8)) return { ok: false, error: "failed", detail: "bad model index" };
  if (!front(ctx)) return { ok: false, error: "not-frontmost" };
  var before = focusKey(focused(ctx));
  press(ctx, { key: "i", mods: ["cmd", "shift"] });
  // The menu takes focus when it opens. Type the digit only on that evidence: focus moved, and not to a text input
  // (else the digit would land in the prompt box, the terminal, or a card that takes digits).
  var f = null;
  var open = waitFor(function () { f = focused(ctx); return !!f && focusKey(f) !== before && !isTextInput(f); }, 0.8, 0.04);
  if (!open) return { ok: false, error: "model-menu-not-open", detail: "focus " + (focusKey(focused(ctx)) || "none") + " (was " + (before || "none") + ")" };
  press(ctx, { key: String(idx + 1) });
  return { ok: true, detail: "menu focus " + focusKey(f) };
}

function opKeys(ctx) {
  if (!front(ctx)) return { ok: false, error: "not-frontmost" };
  var check = validPath(ctx.req.checkPath);
  if (check && check.length) {
    if (!ctx.p.windows.length) return { ok: false, error: "no-window" };
    if (!atPath(ctx.p.windows[0], check)) return { ok: false, error: "prompt-not-found" };
  }
  var keys = ctx.req.keys || [];
  for (var i = 0; i < keys.length; i++) { press(ctx, keys[i]); if (i < keys.length - 1) delay(ctx.req.gap || 0.08); }
  return { ok: true };
}

function clickMenuItem(ctx, menuName, items) {
  var bar = ctx.p.menuBars[0];
  var names = [menuName];
  try { var all = bar.menuBarItems.name(); for (var a = 1; a < all.length; a++) if (all[a] !== menuName) names.push(all[a]); } catch (e) {}
  for (var m = 0; m < names.length; m++) {
    var menu, titles;
    try { menu = bar.menuBarItems.byName(names[m]).menus[0]; titles = menu.menuItems.name(); } catch (e) { continue; }
    for (var i = 0; i < titles.length; i++) {
      var t = titles[i];
      if (typeof t !== "string") continue;
      for (var j = 0; j < items.length; j++) {
        if (t.indexOf(items[j]) === 0) { guard(ctx); menu.menuItems[i].click(); ctx.pressed++; return true; }
      }
    }
  }
  return false;
}

function opDictate(ctx) {
  if (!front(ctx)) return { ok: false, error: "not-frontmost" };
  var loc = locate(ctx);
  if (!loc.el) return { ok: false, error: loc.error, path: null, rescanned: !!loc.rescanned };
  var out = { ok: false, path: loc.path, rescanned: loc.rescanned };
  if (!focusPrompt(ctx, loc.el)) return focusFailed(loc);
  if (!clickMenuItem(ctx, ctx.req.menu || "Edit", ctx.req.items || [])) { out.error = "menu-not-found"; return out; }
  out.ok = true;
  return out;
}

var OPS = { locate: opLocate, prompt: opPrompt, effort: opEffort, model: opModel, keys: opKeys, dictate: opDictate };

function run(argv) {
  var t0 = Date.now();
  var req, out;
  try { req = JSON.parse(argv[0] || "{}"); } catch (e) { return JSON.stringify({ ok: false, error: "failed", detail: "bad request" }); }
  var ctx = { req: req, se: null, p: null, pressed: 0 };
  try {
    var op = OPS[req.op];
    if (!op) fail("failed", "unknown op " + req.op);
    ctx.se = Application("System Events");
    var list = ctx.se.applicationProcesses.whose({ bundleIdentifier: req.bundle })();
    if (!list.length) fail("not-running");
    ctx.p = list[0];
    try { ctx.p.attributes.byName("AXManualAccessibility").value = true; } catch (e) {}
    out = op(ctx);
  } catch (e) {
    if (e instanceof Fail) out = { ok: false, error: e.code, detail: e.extra };
    else out = { ok: false, error: "exception", detail: String((e && e.message) || e) + (e && e.errorNumber ? " (" + e.errorNumber + ")" : "") };
  }
  out.pressed = ctx.pressed;
  out.ms = Date.now() - t0;
  return JSON.stringify(out);
}
`;
