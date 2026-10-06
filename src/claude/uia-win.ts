// The Windows counterpart of ax.ts: a small C# program that drives the Claude desktop app through Windows UI
// Automation (UIA3, the COM IUIAutomation client — the managed System.Windows.Automation client doesn't see
// Chromium's native UIA tree), SendInput and the Win32 clipboard. control.ts builds it once (win-helper.ts: the C#
// compiler of the .NET Framework that ships with Windows 10/11) and runs it with the request JSON on stdin; it prints
// one JSON reply. Requests, replies and error codes are those of ax.ts, so control.ts treats both alike.
//
// What it knows about the app (Windows build of Claude for desktop, Code tab; checked against an Electron stand-in,
// test/e2e-win):
//   • The prompt box is a UIA Edit named "Prompt". Chromium only builds the web page's accessibility tree once a UIA
//     client asks for it, so the first search of a session may come up empty for a moment: it is retried briefly.
//     The box's place is reported as an index path (window → raw-view child index → …) like the macOS program's, so
//     control.ts caches it the same way; it is verified on use and only searched again when it no longer fits.
//   • Ctrl+Shift+E opens the effort slider and focuses it (UIA Slider "Effort", RangeValue = stop index); Left / Right
//     move one stop; Ctrl+Shift+E again closes it. Ctrl+Shift+I opens the model menu; a digit picks a row — typed only
//     once focus left the text input it was in (evidence the menu opened).
//   • Esc stops a running response: it's only sent when the caller asks for it (the Stop key).
// Safety: before every keystroke Claude's window must be the foreground window ("not-frontmost" otherwise). Return is
// only pressed while the located prompt box has keyboard focus, and only after the pasted text was read back from
// it. The clipboard is saved with every format (and only put back while it still holds our text); our text is kept
// out of Windows' clipboard history and cloud clipboard.
//
// Requests ({ op, exe: ["claude.exe"], … }) — as in ax.ts, plus:
//   keys / dictate: keys are { key: "return" | "escape" | … | one character, mods: ["ctrl", "shift", "alt", "win"] }
//   dictate { path?, scan?, keys }   focus the box, then press `keys` (Win+H: Windows voice typing)
//   running {}                       { ok, running, window }: is the desktop app (not the CLI) running?
// `claude-deck-uia.exe keepawake <seconds>` keeps the PC (and display) awake until stdin closes or <seconds> (0 =
// no limit) pass — the Keep Awake key on Windows (src/system/keep-awake-win.ts).

export const UIA_CS_SOURCE = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Interop.UIAutomationClient;

namespace ClaudeDeck {

class Fail : Exception {
  public readonly string Code, Extra;
  public Fail(string code, string extra) : base(code) { Code = code; Extra = extra; }
}

static class Native {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern short VkKeyScanEx(char c, IntPtr layout);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyEx(uint code, uint type, IntPtr layout);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder s, ref uint n);

  [DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll")] public static extern bool CloseClipboard();
  [DllImport("user32.dll")] public static extern bool EmptyClipboard();
  [DllImport("user32.dll")] public static extern uint EnumClipboardFormats(uint format);
  [DllImport("user32.dll")] public static extern IntPtr GetClipboardData(uint format);
  [DllImport("user32.dll")] public static extern IntPtr SetClipboardData(uint format, IntPtr mem);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern uint RegisterClipboardFormat(string name);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalAlloc(uint flags, UIntPtr size);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr mem);
  [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr mem);
  [DllImport("kernel32.dll")] public static extern UIntPtr GlobalSize(IntPtr mem);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr mem);

  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
}

static class Program {
  // UIA ids (UIAutomationClient.h)
  const int NameProp = 30005, ControlTypeProp = 30003;
  const int ValuePattern = 10002, RangeValuePattern = 10003, TextPattern = 10014;
  const int Edit = 50004, Slider = 50015, ComboBox = 50003;
  const ushort VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_LWIN = 0x5B, VK_RETURN = 0x0D, VK_LEFT = 0x25, VK_RIGHT = 0x27;

  static readonly Dictionary<string, ushort> NAMED = new Dictionary<string, ushort> {
    { "return", 0x0D }, { "enter", 0x0D }, { "escape", 0x1B }, { "esc", 0x1B }, { "tab", 0x09 }, { "space", 0x20 },
    { "delete", 0x08 }, { "backspace", 0x08 }, { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
    { "home", 0x24 }, { "end", 0x23 }, { "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 }, { "f5", 0x74 },
    { "f6", 0x75 }, { "f7", 0x76 }, { "f8", 0x77 }, { "f9", 0x78 }, { "f10", 0x79 }, { "f11", 0x7A }, { "f12", 0x7B } };

  class Ctx {
    public Dictionary<string, object> Req;
    public IUIAutomation U;
    public HashSet<uint> Pids = new HashSet<uint>();
    public IntPtr Hwnd;
    public int Pressed;
  }

  static void Fail(string code) { throw new Fail(code, null); }
  static void Fail(string code, string extra) { throw new Fail(code, extra); }

  // ── request helpers ──────────────────────────────────────────────────────────────────────────────────────

  static object Get(Ctx c, string k) { object v; return c.Req.TryGetValue(k, out v) ? v : null; }
  static bool Flag(Ctx c, string k) { var v = Get(c, k); return v is bool && (bool)v; }
  static bool IsFalse(Ctx c, string k) { var v = Get(c, k); return v is bool && !(bool)v; }
  static double Num(object v, double dflt) {
    if (v == null) return dflt;
    try { return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); } catch { return dflt; }
  }
  static int[] PathOf(object v) {
    var list = v as IList;
    if (list == null || list.Count > 80) return null;
    var outp = new int[list.Count];
    for (int i = 0; i < list.Count; i++) {
      if (!(list[i] is int)) return null;
      outp[i] = (int)list[i];
      if (outp[i] < 0) return null;
    }
    return outp;
  }

  // ── pure helpers (as in ax.ts) ───────────────────────────────────────────────────────────────────────────

  static string DraftOf(string value) { var s = value ?? ""; return s.EndsWith("\n") ? s.Substring(0, s.Length - 1) : s; }
  static string Norm(string s) { return System.Text.RegularExpressions.Regex.Replace(s ?? "", "\\s+", " ").Trim(); }
  static bool Holds(string value, string text) {
    var t = Norm(text); if (t.Length > 40) t = t.Substring(0, 40);
    return value != null && t != "" && Norm(value).IndexOf(t, StringComparison.Ordinal) >= 0;
  }

  // ── timing ───────────────────────────────────────────────────────────────────────────────────────────────

  static void Delay(double secs) { Thread.Sleep((int)(secs * 1000)); }
  static bool WaitFor(Func<bool> fn, double secs, double step) {
    var end = DateTime.UtcNow.AddSeconds(secs);
    for (;;) {
      try { if (fn()) return true; } catch (Fail) { throw; } catch { }
      if (DateTime.UtcNow >= end) return false;
      Delay(step);
    }
  }

  // ── the app's processes and window ───────────────────────────────────────────────────────────────────────

  static string ImagePath(uint pid) {
    var h = Native.OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return null;
    try { var sb = new StringBuilder(1024); uint n = 1024; return Native.QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : null; }
    finally { Native.CloseHandle(h); }
  }

  /** The desktop app's processes: the given executables, minus Claude Code CLIs (same file name, other folders). */
  static void FindProcesses(Ctx c) {
    var names = Get(c, "exe") as IList;
    var list = new List<string>();
    if (names != null) foreach (var n in names) if (n is string) list.Add((string)n);
    if (list.Count == 0) list.Add("claude.exe");
    foreach (var exe in list) {
      var bare = exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? exe.Substring(0, exe.Length - 4) : exe;
      foreach (var p in Process.GetProcessesByName(bare)) {
        var path = ImagePath((uint)p.Id);
        var low = (path ?? "").ToLowerInvariant();
        if (low.Contains("\\claude-code\\") || low.Contains("\\.local\\bin\\") || low.Contains("\\node_modules\\@anthropic-ai\\")) continue;
        c.Pids.Add((uint)p.Id);
      }
    }
  }

  static bool IsAppWindow(Ctx c, IntPtr h) {
    uint pid; Native.GetWindowThreadProcessId(h, out pid);
    if (!c.Pids.Contains(pid) || !Native.IsWindowVisible(h) || Native.GetWindowTextLength(h) == 0) return false;
    var sb = new StringBuilder(256); Native.GetClassName(h, sb, 256);
    return sb.ToString() == "Chrome_WidgetWin_1";
  }

  /** The app's main window: the foreground one when it's Claude's, else the topmost visible one. */
  static IntPtr FindWindow(Ctx c) {
    var fg = Native.GetForegroundWindow();
    if (fg != IntPtr.Zero && IsAppWindow(c, fg)) return fg;
    IntPtr found = IntPtr.Zero;
    Native.EnumWindows((h, l) => { if (IsAppWindow(c, h)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }

  // ── front + guarded keystrokes ───────────────────────────────────────────────────────────────────────────

  static bool IsFront(Ctx c) {
    var fg = Native.GetForegroundWindow(); if (fg == IntPtr.Zero) return false;
    uint pid; Native.GetWindowThreadProcessId(fg, out pid);
    return c.Pids.Contains(pid);
  }

  /** Windows only hands the foreground to the process that sent the last input: a key event no program acts on (an
   *  unassigned virtual key) makes it this one. */
  static void ClaimInput() {
    var none = new[] { Key(0xE8, false, IntPtr.Zero), Key(0xE8, true, IntPtr.Zero) };
    Native.SendInput((uint)none.Length, none, Marshal.SizeOf(typeof(Native.INPUT)));
  }

  /** Bring Claude to the front only when it isn't already (no settle delay when it is). */
  static bool Front(Ctx c) {
    if (IsFront(c)) return true;
    if (c.Hwnd == IntPtr.Zero) return false;
    for (int attempt = 0; attempt < 3; attempt++) {
      if (Native.IsIconic(c.Hwnd)) Native.ShowWindow(c.Hwnd, 9); // SW_RESTORE
      ClaimInput();
      uint pid;
      var fgThread = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out pid);
      var me = Native.GetCurrentThreadId();
      var attached = fgThread != 0 && fgThread != me && Native.AttachThreadInput(me, fgThread, true);
      try { Native.BringWindowToTop(c.Hwnd); Native.SetForegroundWindow(c.Hwnd); }
      finally { if (attached) Native.AttachThreadInput(me, fgThread, false); }
      if (WaitFor(() => IsFront(c), 0.5, 0.05)) { Delay(0.2); return true; }
    }
    return false;
  }

  static void Guard(Ctx c) { if (!IsFront(c)) Fail("not-frontmost"); }

  static Native.INPUT Key(ushort vk, bool up, IntPtr layout) {
    var i = new Native.INPUT { type = 1 };
    i.u.ki.wVk = vk;
    i.u.ki.wScan = (ushort)Native.MapVirtualKeyEx(vk, 0, layout);
    uint flags = up ? 2u : 0u; // KEYEVENTF_KEYUP
    if ((vk >= 0x21 && vk <= 0x2E) || vk == VK_LWIN) flags |= 1; // KEYEVENTF_EXTENDEDKEY (arrows, home/end, delete, win)
    i.u.ki.dwFlags = flags;
    return i;
  }

  /** One key press, only while Claude is frontmost: { key: name | character, mods: [ctrl, shift, alt, win] }. */
  static void Press(Ctx c, IDictionary k) {
    Guard(c);
    uint pid;
    var layout = Native.GetKeyboardLayout(Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out pid));
    var key = Convert.ToString(k["key"] ?? "");
    var mods = new List<ushort>();
    var modList = k.Contains("mods") ? k["mods"] as IList : null;
    if (modList != null) foreach (var m in modList) {
      var s = Convert.ToString(m);
      if (s == "ctrl" && !mods.Contains(VK_CONTROL)) mods.Add(VK_CONTROL);
      else if (s == "shift" && !mods.Contains(VK_SHIFT)) mods.Add(VK_SHIFT);
      else if (s == "alt" && !mods.Contains(VK_MENU)) mods.Add(VK_MENU);
      else if (s == "win" && !mods.Contains(VK_LWIN)) mods.Add(VK_LWIN);
    }
    ushort vk;
    if (!NAMED.TryGetValue(key.ToLowerInvariant(), out vk)) {
      if (key.Length != 1) Fail("failed", "unknown key " + key);
      var scan = Native.VkKeyScanEx(key[0], layout);
      if (scan == -1) Fail("failed", "the key " + key + " isn't on this keyboard layout");
      vk = (ushort)(scan & 0xFF);
      int state = (scan >> 8) & 0xFF; // the character's own modifiers on this layout (Shift for "1" on AZERTY …)
      if ((state & 1) != 0 && !mods.Contains(VK_SHIFT)) mods.Add(VK_SHIFT);
      if ((state & 2) != 0 && !mods.Contains(VK_CONTROL)) mods.Add(VK_CONTROL);
      if ((state & 4) != 0 && !mods.Contains(VK_MENU)) mods.Add(VK_MENU);
    }
    var seq = new List<Native.INPUT>();
    foreach (var m in mods) seq.Add(Key(m, false, layout));
    seq.Add(Key(vk, false, layout));
    seq.Add(Key(vk, true, layout));
    for (int i = mods.Count - 1; i >= 0; i--) seq.Add(Key(mods[i], true, layout));
    var arr = seq.ToArray();
    if (Native.SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(Native.INPUT))) != arr.Length) Fail("accessibility", "SendInput was blocked");
    c.Pressed++;
  }

  static IDictionary Spec(string key, params string[] mods) { var d = new Hashtable(); d["key"] = key; d["mods"] = mods; return d; }

  // ── UIA helpers ──────────────────────────────────────────────────────────────────────────────────────────

  static int TypeOf(IUIAutomationElement e) { try { return e.CurrentControlType; } catch { return 0; } }
  static string NameOf(IUIAutomationElement e) { try { return e.CurrentName ?? ""; } catch { return ""; } }
  static bool IsPrompt(IUIAutomationElement e) { return e != null && TypeOf(e) == Edit && NameOf(e) == "Prompt"; }
  static bool IsEffortSlider(IUIAutomationElement e) { return e != null && TypeOf(e) == Slider && NameOf(e) == "Effort"; }
  static bool IsTextInput(IUIAutomationElement e) { var t = e == null ? 0 : TypeOf(e); return t == Edit || t == ComboBox; }
  static string FocusKey(IUIAutomationElement e) { return e == null ? "" : TypeOf(e) + "|" + NameOf(e); }
  static bool Visible(IUIAutomationElement e) {
    try { if (e.CurrentIsOffscreen != 0) return false; var r = e.CurrentBoundingRectangle; return r.right > r.left && r.bottom > r.top; } catch { return true; }
  }
  static IUIAutomationElement Focused(Ctx c) { try { return c.U.GetFocusedElement(); } catch { return null; } }
  static bool Same(Ctx c, IUIAutomationElement a, IUIAutomationElement b) {
    try { return a != null && b != null && c.U.CompareElements(a, b) != 0; } catch { return false; }
  }
  /** Does this very element have keyboard focus? (Not just "some prompt box": the side chat has one too.) */
  static bool HasFocus(Ctx c, IUIAutomationElement e) {
    try { if (e.CurrentHasKeyboardFocus != 0) return true; } catch { }
    return Same(c, Focused(c), e);
  }

  /** The box's text: Value, else its text range. null = unreadable. */
  static string ValueOf(IUIAutomationElement e) {
    try { var v = e.GetCurrentPattern(ValuePattern) as IUIAutomationValuePattern; if (v != null) return v.CurrentValue ?? ""; } catch { }
    try { var t = e.GetCurrentPattern(TextPattern) as IUIAutomationTextPattern; if (t != null) return t.DocumentRange.GetText(-1) ?? ""; } catch { }
    return null;
  }

  static double? RangeNum(IUIAutomationElement e, bool max) {
    try {
      var r = e.GetCurrentPattern(RangeValuePattern) as IUIAutomationRangeValuePattern;
      if (r == null) return null;
      var v = max ? r.CurrentMaximum : r.CurrentValue;
      return double.IsNaN(v) || double.IsInfinity(v) ? (double?)null : v;
    } catch { return null; }
  }

  // ── finding the prompt box ───────────────────────────────────────────────────────────────────────────────

  static IUIAutomationElement Child(IUIAutomationTreeWalker w, IUIAutomationElement e, int idx) {
    var k = w.GetFirstChildElement(e);
    for (int i = 0; k != null && i < idx; i++) k = w.GetNextSiblingElement(k);
    return k;
  }

  /** The visible prompt box at a cached index path, or null. */
  static IUIAutomationElement AtPath(Ctx c, IUIAutomationElement win, int[] path) {
    try {
      var w = c.U.RawViewWalker;
      var e = win;
      foreach (var i in path) { e = Child(w, e, i); if (e == null) return null; }
      return IsPrompt(e) && Visible(e) ? e : null;
    } catch { return null; }
  }

  /** The element's index path from the window. */
  static int[] PathTo(Ctx c, IUIAutomationElement win, IUIAutomationElement e) {
    var w = c.U.RawViewWalker;
    var outp = new List<int>();
    var cur = e;
    for (int depth = 0; depth < 80; depth++) {
      if (Same(c, cur, win)) { outp.Reverse(); return outp.ToArray(); }
      var parent = w.GetParentElement(cur);
      if (parent == null) return null;
      int idx = 0; var k = w.GetFirstChildElement(parent);
      while (k != null && !Same(c, k, cur)) { idx++; k = w.GetNextSiblingElement(k); }
      if (k == null) return null;
      outp.Add(idx);
      cur = parent;
    }
    return null;
  }

  static int CommonPrefix(int[] a, int[] b) { int n = 0; while (n < a.Length && n < b.Length && a[n] == b[n]) n++; return n; }

  class Located { public IUIAutomationElement El; public int[] Path; public bool Rescanned; public string Error; }

  /** The prompt box of Claude's window: the cached path when it still points at it, else a search (unless scan: false). */
  static Located Locate(Ctx c) {
    if (c.Hwnd == IntPtr.Zero) return new Located { Error = "no-window" };
    var win = c.U.ElementFromHandle(c.Hwnd);
    var old = PathOf(Get(c, "path")) ?? new int[0];
    if (old.Length > 0) {
      var el = AtPath(c, win, old);
      if (el != null) return new Located { El = el, Path = old };
    }
    if (IsFalse(c, "scan")) return new Located { Error = "prompt-not-found" };
    var cond = c.U.CreateAndCondition(c.U.CreatePropertyCondition(ControlTypeProp, Edit), c.U.CreatePropertyCondition(NameProp, "Prompt"));
    var deadline = DateTime.UtcNow.AddSeconds(Math.Min(Num(Get(c, "scanSecs"), 15), 15));
    // Chromium builds the page's tree once a UIA client asks: an empty first answer is retried for a few seconds.
    var settle = DateTime.UtcNow.AddSeconds(4);
    for (;;) {
      IUIAutomationElement best = null; int[] bestPath = null; int bestScore = -1;
      var all = win.FindAll(TreeScope.TreeScope_Descendants, cond);
      for (int i = 0; all != null && i < all.Length; i++) {
        var e = all.GetElement(i);
        if (!Visible(e)) continue;
        var p = PathTo(c, win, e);
        if (p == null) continue;
        var score = CommonPrefix(p, old);
        if (score > bestScore) { best = e; bestPath = p; bestScore = score; }
      }
      if (best != null) return new Located { El = best, Path = bestPath, Rescanned = true };
      if (DateTime.UtcNow >= settle || DateTime.UtcNow >= deadline) return new Located { Error = "prompt-not-found", Rescanned = true };
      Delay(0.25);
    }
  }

  static bool FocusPrompt(Ctx c, IUIAutomationElement e) {
    if (HasFocus(c, e)) return true;
    try { e.SetFocus(); } catch { }
    return WaitFor(() => HasFocus(c, e), 0.8, 0.05);
  }

  // ── clipboard (every format saved; put back only while it still holds our text) ────────────────────────────

  static bool OpenClip() { for (int i = 0; i < 20; i++) { if (Native.OpenClipboard(IntPtr.Zero)) return true; Delay(0.025); } return false; }

  /** Formats whose data is a GDI handle, not memory (Windows re-creates them from the memory formats). */
  static bool IsHandleFormat(uint f) { return f == 2 || f == 3 || f == 9 || f == 14 || f == 0x80 || f == 0x82 || f == 0x83 || f == 0x8E; }

  static List<KeyValuePair<uint, byte[]>> ClipSave() {
    if (!OpenClip()) return null;
    try {
      var outp = new List<KeyValuePair<uint, byte[]>>();
      uint f = 0;
      while ((f = Native.EnumClipboardFormats(f)) != 0) {
        if (IsHandleFormat(f)) continue;
        var h = Native.GetClipboardData(f);
        if (h == IntPtr.Zero) continue;
        var size = (long)Native.GlobalSize(h).ToUInt64();
        var p = Native.GlobalLock(h);
        if (p == IntPtr.Zero) continue;
        try { var b = new byte[size]; Marshal.Copy(p, b, 0, (int)size); outp.Add(new KeyValuePair<uint, byte[]>(f, b)); }
        finally { Native.GlobalUnlock(h); }
      }
      return outp;
    } catch { return null; }
    finally { Native.CloseClipboard(); }
  }

  static void PutData(uint format, byte[] data) {
    var mem = Native.GlobalAlloc(0x0002, new UIntPtr((ulong)Math.Max(1, data.Length))); // GMEM_MOVEABLE
    var p = Native.GlobalLock(mem);
    Marshal.Copy(data, 0, p, data.Length);
    Native.GlobalUnlock(mem);
    if (Native.SetClipboardData(format, mem) == IntPtr.Zero) Native.GlobalFree(mem);
  }

  static void ClipRestore(List<KeyValuePair<uint, byte[]>> saved) {
    if (saved == null) return; // couldn't read it: leave it alone rather than clear it
    if (!OpenClip()) return;
    try {
      Native.EmptyClipboard();
      foreach (var kv in saved) PutData(kv.Key, kv.Value);
    } finally { Native.CloseClipboard(); }
  }

  /** Put text on the clipboard, kept out of the clipboard history and the cloud clipboard. Returns the sequence number. */
  static uint ClipSetText(string text) {
    if (!OpenClip()) Fail("paste-failed", "the clipboard is busy");
    try {
      Native.EmptyClipboard();
      PutData(13, Encoding.Unicode.GetBytes(text + "\0")); // CF_UNICODETEXT
      var zero = BitConverter.GetBytes(0);
      PutData(Native.RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"), zero);
      PutData(Native.RegisterClipboardFormat("CanIncludeInClipboardHistory"), zero);
      PutData(Native.RegisterClipboardFormat("CanUploadToCloudClipboard"), zero);
    } finally { Native.CloseClipboard(); }
    return Native.GetClipboardSequenceNumber();
  }

  static bool Paste(Ctx c, IUIAutomationElement el, string text, string before) {
    var saved = ClipSave();
    var mine = ClipSetText(text);
    // Landed = the box (read back, not just "changed") holds the text. A box that can't be read never counts.
    Func<bool> arrived = () => { var v = ValueOf(el); return v != null && v != before && Holds(v, text); };
    var landed = false;
    try {
      Press(c, Spec("v", "ctrl"));
      landed = WaitFor(arrived, 1.5, 0.05);
      // A busy app may take Ctrl+V late: give it a moment more before the user's own clipboard comes back.
      if (!landed) { Delay(0.5); landed = arrived(); }
    } finally {
      if (Native.GetClipboardSequenceNumber() == mine) ClipRestore(saved);
    }
    return landed;
  }

  /** Return, then wait for the box to empty. A slash command's first Return can be taken by the command menu: if the
   *  box still holds just that command, Return once more. Return only while the box itself has keyboard focus. */
  static bool Submit(Ctx c, IUIAutomationElement el, string text) {
    Func<bool> empty = () => { var v = ValueOf(el); return v != null && DraftOf(v).Trim() == ""; };
    Action enter = () => { if (!HasFocus(c, el)) Fail("focus-lost"); Press(c, Spec("return")); };
    enter();
    var cleared = WaitFor(empty, 0.8, 0.05);
    if (!cleared && text != null && text.StartsWith("/")) {
      var cmd = text.Trim().Split(new[] { ' ', '\t', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries)[0];
      var now = DraftOf(ValueOf(el) ?? "").Trim();
      if (now == cmd || now.StartsWith(cmd + " ")) { enter(); cleared = WaitFor(empty, 0.8, 0.05); }
    }
    return cleared;
  }

  // ── operations ───────────────────────────────────────────────────────────────────────────────────────────

  static Dictionary<string, object> Reply(bool ok) { var d = new Dictionary<string, object>(); d["ok"] = ok; return d; }
  static Dictionary<string, object> Err(string code) { var d = Reply(false); d["error"] = code; return d; }
  static Dictionary<string, object> LocError(Located l) { var d = Err(l.Error); d["path"] = null; d["rescanned"] = l.Rescanned; return d; }
  static Dictionary<string, object> FocusFailed(Located l) {
    var d = Err("focus-failed"); d["path"] = null; d["stale"] = !l.Rescanned; d["rescanned"] = l.Rescanned; return d;
  }

  static Dictionary<string, object> OpLocate(Ctx c) {
    var l = Locate(c);
    if (l.El == null) return LocError(l);
    var d = Reply(true); d["path"] = l.Path; d["rescanned"] = l.Rescanned; return d;
  }

  static Dictionary<string, object> OpPrompt(Ctx c) {
    if (!Front(c)) return Err("not-frontmost");
    var l = Locate(c);
    if (l.El == null) return LocError(l);
    var outp = Reply(false); outp["path"] = l.Path; outp["rescanned"] = l.Rescanned;
    if (!FocusPrompt(c, l.El)) return FocusFailed(l);
    var before = ValueOf(l.El) ?? "";
    var draft = DraftOf(before);
    outp["draft"] = draft.Length > 200 ? draft.Substring(0, 200) : draft;
    var hasDraft = draft.Trim() != "";
    outp["hadDraft"] = hasDraft;
    var text = Get(c, "text") as string;
    var submit = Flag(c, "submit");
    bool doPaste = false, doSubmit = false;
    if (text != null && text.Trim() != "") {
      if (Flag(c, "requireEmpty") && hasDraft) { outp["error"] = "draft-not-empty"; return outp; }
      doPaste = true; doSubmit = submit;
    } else if (submit) {
      if (!hasDraft) { outp["error"] = "prompt-empty"; return outp; }
      doSubmit = true;
    }
    if (doPaste && !Paste(c, l.El, text, before)) { outp["error"] = "paste-failed"; return outp; }
    if (doSubmit) outp["cleared"] = Submit(c, l.El, doPaste ? text : draft);
    outp["ok"] = true;
    return outp;
  }

  static Dictionary<string, object> OpEffort(Ctx c) {
    if (!Front(c)) return Err("not-frontmost");
    // (tests: "toggleKey" replaces the shortcut, for machines where another app holds Ctrl+Shift+E system-wide)
    var toggleKey = Get(c, "toggleKey") as IDictionary ?? Spec("e", "ctrl", "shift");
    Action toggle = () => Press(c, toggleKey);
    // Never leave the slider open: while it has focus, arrow keys move it, and every stop applies at once.
    Func<bool> close = () => {
      if (IsEffortSlider(Focused(c))) toggle();
      return WaitFor(() => !IsEffortSlider(Focused(c)), 0.5, 0.05);
    };
    var f = Focused(c);
    if (!IsEffortSlider(f)) {
      toggle();
      if (!WaitFor(() => { f = Focused(c); return IsEffortSlider(f); }, 1.2, 0.05)) {
        Delay(0.15);
        if (IsEffortSlider(Focused(c))) close(); // it opened late
        return Err("effort-not-open");
      }
    }
    try {
      var from = RangeNum(f, false);
      var max = RangeNum(f, true);
      var target = Num(Get(c, "target"), -1);
      Func<string, Dictionary<string, object>> bad = (code) => {
        var d = Err(code); d["from"] = from; d["max"] = max; d["closed"] = close(); return d;
      };
      if (from == null || !(target >= 0)) return bad("effort-unreadable");
      var stops = Get(c, "stops");
      var stopsOk = stops == null || max == Num(stops, 0) - 1 || max == Num(stops, 0) - 2;
      if (max != null && (target > max || !stopsOk)) return bad("effort-range");
      var d0 = (int)(target - from.Value);
      for (int i = 0; i < Math.Abs(d0); i++) {
        if (!IsEffortSlider(Focused(c))) break; // focus moved away: the arrows would go elsewhere
        Press(c, Spec(d0 < 0 ? "left" : "right"));
        Delay(0.06);
      }
      WaitFor(() => RangeNum(f, false) == target, 0.6, 0.05);
      var to = RangeNum(f, false);
      var closed = close();
      var r = Reply(to == target);
      if (to != target) r["error"] = "effort-stuck";
      r["from"] = from; r["to"] = to; r["max"] = max; r["closed"] = closed;
      return r;
    } catch {
      try { if (IsFront(c) && IsEffortSlider(Focused(c))) toggle(); } catch { }
      throw;
    }
  }

  static Dictionary<string, object> OpModel(Ctx c) {
    var idx = (int)Num(Get(c, "index"), -1);
    if (!(idx >= 0 && idx <= 8)) { var b = Err("failed"); b["detail"] = "bad model index"; return b; }
    if (!Front(c)) return Err("not-frontmost");
    var before = FocusKey(Focused(c));
    Press(c, Get(c, "menuKey") as IDictionary ?? Spec("i", "ctrl", "shift")); // (tests: "menuKey" replaces it)
    // The menu takes focus when it opens. Type the digit only on that evidence: focus moved, and not to a text input.
    IUIAutomationElement f = null;
    var open = WaitFor(() => { f = Focused(c); return f != null && FocusKey(f) != before && !IsTextInput(f); }, 0.8, 0.04);
    if (!open) {
      var d = Err("model-menu-not-open");
      d["detail"] = "focus " + (FocusKey(Focused(c)) == "" ? "none" : FocusKey(Focused(c))) + " (was " + (before == "" ? "none" : before) + ")";
      return d;
    }
    Press(c, Spec((idx + 1).ToString()));
    var r = Reply(true); r["detail"] = "menu focus " + FocusKey(f); return r;
  }

  static Dictionary<string, object> OpKeys(Ctx c) {
    if (!Front(c)) return Err("not-frontmost");
    var check = PathOf(Get(c, "checkPath"));
    if (check != null && check.Length > 0) {
      if (c.Hwnd == IntPtr.Zero) return Err("no-window");
      if (AtPath(c, c.U.ElementFromHandle(c.Hwnd), check) == null) return Err("prompt-not-found");
    }
    var keys = Get(c, "keys") as IList ?? new object[0];
    var gap = Num(Get(c, "gap"), 0.08);
    for (int i = 0; i < keys.Count; i++) { Press(c, (IDictionary)keys[i]); if (i < keys.Count - 1) Delay(gap); }
    return Reply(true);
  }

  static Dictionary<string, object> OpDictate(Ctx c) {
    if (!Front(c)) return Err("not-frontmost");
    var l = Locate(c);
    if (l.El == null) return LocError(l);
    if (!FocusPrompt(c, l.El)) return FocusFailed(l);
    var keys = Get(c, "keys") as IList;
    if (keys == null || keys.Count == 0) { var m = Err("menu-not-found"); m["path"] = l.Path; return m; }
    foreach (var k in keys) Press(c, (IDictionary)k);
    var r = Reply(true); r["path"] = l.Path; r["rescanned"] = l.Rescanned; return r;
  }

  static Dictionary<string, object> Run(string input, Stopwatch sw) {
    var ser = new JavaScriptSerializer();
    var c = new Ctx();
    Dictionary<string, object> outp;
    try { c.Req = ser.DeserializeObject(input) as Dictionary<string, object>; } catch { c.Req = null; }
    if (c.Req == null) { outp = Err("failed"); outp["detail"] = "bad request"; return outp; }
    try {
      var op = Get(c, "op") as string;
      FindProcesses(c);
      if (op == "running") {
        outp = Reply(true); outp["running"] = c.Pids.Count > 0; outp["window"] = c.Pids.Count > 0 && FindWindow(c) != IntPtr.Zero;
      } else {
        if (op != "locate" && op != "prompt" && op != "effort" && op != "model" && op != "keys" && op != "dictate") Fail("failed", "unknown op " + op);
        if (c.Pids.Count == 0) Fail("not-running");
        c.Hwnd = FindWindow(c);
        if (c.Hwnd == IntPtr.Zero && op != "keys" && op != "effort" && op != "model") Fail("no-window");
        c.U = new CUIAutomation();
        if (op == "locate") outp = OpLocate(c);
        else if (op == "prompt") outp = OpPrompt(c);
        else if (op == "effort") outp = OpEffort(c);
        else if (op == "model") outp = OpModel(c);
        else if (op == "keys") outp = OpKeys(c);
        else outp = OpDictate(c);
      }
    } catch (Fail f) {
      outp = Err(f.Code); if (f.Extra != null) outp["detail"] = f.Extra;
    } catch (Exception e) {
      outp = Err("exception"); outp["detail"] = e.GetType().Name + ": " + e.Message;
    }
    outp["pressed"] = c.Pressed;
    outp["ms"] = sw.ElapsedMilliseconds;
    return outp;
  }

  /** Keep the PC and its display awake until stdin closes (the plugin quit) or the time is up. */
  static int KeepAwake(string[] args) {
    double secs = args.Length > 1 ? Num(args[1], 0) : 0;
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED (like caffeinate -di): undone when this process ends.
    if (Native.SetThreadExecutionState(0x80000000u | 0x1u | 0x2u) == 0) { Console.Out.WriteLine("failed"); return 1; }
    Console.Out.WriteLine("on");
    Console.Out.Flush();
    var reader = new Thread(() => { try { while (Console.In.Read() >= 0) { } } catch { } });
    reader.IsBackground = true;
    reader.Start();
    if (secs > 0) reader.Join(TimeSpan.FromSeconds(secs)); else reader.Join();
    return 0;
  }

  [STAThread]
  static int Main(string[] args) {
    var utf8 = new UTF8Encoding(false);
    Console.OutputEncoding = utf8;
    if (args.Length > 0 && args[0] == "keepawake") return KeepAwake(args);
    var sw = Stopwatch.StartNew();
    string input;
    using (var stdin = new StreamReader(Console.OpenStandardInput(), utf8)) input = stdin.ReadToEnd();
    var reply = Run(input, sw);
    var json = new JavaScriptSerializer().Serialize(reply);
    var sb = new StringBuilder(json.Length);
    foreach (var ch in json) { if (ch > 126) sb.Append("\\u").Append(((int)ch).ToString("x4")); else sb.Append(ch); }
    Console.Out.Write(sb.ToString());
    return 0;
  }
}
}
`;

/**
 * Builds the program (run once per program version by win-helper.ts, with Windows PowerShell):
 *   1. Interop.UIAutomationClient.dll from the UIAutomationCore.dll type library (no SDK needed),
 *   2. claude-deck-uia.exe from the C# source, with the .NET Framework's own compiler.
 * Both land in -Out (the plugin's folder in %LOCALAPPDATA%), next to each other.
 */
export const BUILD_PS_SOURCE = String.raw`
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = "Stop"
$interop = Join-Path $Out "Interop.UIAutomationClient.dll"
$exe = Join-Path $Out "claude-deck-uia.exe"
if (-not (Test-Path $interop)) {
  Add-Type -TypeDefinition @"
using System; using System.Reflection; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
public class DeckTlbSink : ITypeLibImporterNotifySink {
  public void ReportEvent(ImporterEventKind k, int c, string m) {}
  public Assembly ResolveRef(object t) { return null; }
}
public static class DeckTlb {
  [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)] static extern void LoadTypeLibEx(string f, int kind, out ITypeLib tl);
  public static void Gen(string dir, string file) {
    ITypeLib tl; LoadTypeLibEx(System.IO.Path.Combine(Environment.SystemDirectory, "UIAutomationCore.dll"), 2, out tl);
    var ab = new TypeLibConverter().ConvertTypeLibToAssembly(tl, System.IO.Path.Combine(dir, file), TypeLibImporterFlags.SafeArrayAsSystemArray, new DeckTlbSink(), null, null, "Interop.UIAutomationClient", null);
    ab.Save(file);
  }
}
"@
  [DeckTlb]::Gen($Out, "Interop.UIAutomationClient.dll")
}
$src = Get-Content -Raw -Encoding UTF8 (Join-Path $Out "claude-deck-uia.cs")
$tmp = Join-Path $Out ("build-" + [guid]::NewGuid().ToString("N") + ".exe")
Add-Type -TypeDefinition $src -Language CSharp -OutputAssembly $tmp -OutputType ConsoleApplication -ReferencedAssemblies @($interop, "System.Web.Extensions")
Move-Item -Force $tmp $exe
Write-Output "built $exe"
`;
