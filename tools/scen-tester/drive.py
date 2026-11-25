# -*- coding: utf-8 -*-
"""
drive.py -- drive ScenEdit's custom UI purely by code (no input emulation, no computer-use).

Posts real WM_LBUTTONDOWN/UP window messages straight to the "Scenario Editor" window's
message queue (its WndProc hit-tests custom buttons from the message lParam -- verified in
the engine's own wndproc logs). Positions are given as fractions of the live client rect so
they hold regardless of where/how big the window is.

Sequence: main menu "Загрузить сценарий" -> pick first scenario -> Ok -> ОПЦИИ -> Сохранить.

Run scen_tester.py (the debugger) first; it prints [trace] scenario_open_read when the Load
lands, and "SCENARIO REJECTED ... REASON: ..." when Save trips the validation.
"""
from __future__ import print_function
import argparse
import ctypes
import ctypes.wintypes as wt
import time

u32 = ctypes.windll.user32
u32.FindWindowA.restype = wt.HWND
u32.FindWindowA.argtypes = [wt.LPCSTR, wt.LPCSTR]
u32.FindWindowExA.restype = wt.HWND
u32.FindWindowExA.argtypes = [wt.HWND, wt.HWND, wt.LPCSTR, wt.LPCSTR]
u32.GetWindowThreadProcessId.restype = wt.DWORD
u32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
u32.PostMessageA.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
u32.GetClientRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
u32.SetForegroundWindow.argtypes = [wt.HWND]
u32.IsWindow.argtypes = [wt.HWND]
u32.IsWindowVisible.argtypes = [wt.HWND]
u32.IsWindowEnabled.argtypes = [wt.HWND]
u32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
u32.EnumWindows.argtypes = [WNDENUMPROC, wt.LPARAM]

WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_LBUTTONDBLCLK = 0x0203
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
VK_RETURN = 0x0D
VK_ESCAPE = 0x1B
MK_LBUTTON = 0x0001
SW_RESTORE = 9

# button positions as (fx, fy) fractions of the client rectangle, read off the editor's
# layout. Tweak with --dump / repeated runs if a click misses (the debugger shows feedback).
# These are the STOCK layout; use_layout() replaces them with the positions of the editor
# actually being driven (a mod may redraw its dialogs -- see LAYOUT below).
POINTS = {
    "menu_load":  (0.497, 0.617),   # main menu: "Загрузить сценарий"
    "list_item0": (0.371, 0.158),   # load list: first scenario row
    "list_ok":    (0.453, 0.858),   # load list: "Ok" (centre of the button at 1024x768)
    "opt":        (0.919, 0.056),   # map view: "ОПЦИИ" (top-right)
    "opt_save":   (0.494, 0.444),   # options popup: "Сохранить"
    "opt_exit":   (0.494, 0.492),   # options popup: "Выход" (leave scenario -> main menu)
    "dialog_ok":  (0.500, 0.620),   # СООБЩ. message box: "Ok"
}

# The editor does not scale its dialogs: each is laid out in its own pixel box (given in
# Interf\ScenEdit.dlg) and placed on the 1024x768 screen -- centred, except the palette column,
# which hugs the top-right corner. So a click point can be COMPUTED from the editor's own
# dialog file instead of being read off a screenshot:
#   point -> (dialog, control, how the dialog is placed, where inside the control)
# Needed because mods redraw dialogs: Nazar's Legacy made the scenario list twice as wide
# (DLG_EDIT_MAP 680x600 instead of 340x600), which put the stock "Ok" point on its "Back".
SCREEN = (1024, 768)
LAYOUT = {
    "menu_load":  ("DLG_MAIN_MENU", "BTN_LOAD", "centre", "middle"),
    "list_item0": ("DLG_EDIT_MAP", "TLBOX_CHOOSE", "centre", "first_row"),
    "list_ok":    ("DLG_EDIT_MAP", "BTN_OK", "centre", "middle"),
    "opt":        ("DLG_ISO_PAL", "BTN_OPTIONS", "top_right", "middle"),
    "opt_save":   ("DLG_OPTIONS", "BTN_SAVE", "centre", "middle"),
    "opt_exit":   ("DLG_OPTIONS", "BTN_QUIT", "centre", "middle"),
}


def read_dialogs(path):
    """Interf\\ScenEdit.dlg -> {dialog: ((w, h), {control: (x0, y0, x1, y1)})}.
    The file is plain text: `DIALOG <name>,x0,y0,x1,y1,...`, then one control per line as
    `<KIND> <name>,x0,y0,x1,y1,...` until `END`."""
    import io
    import re
    head = re.compile(r"^\s*DIALOG\s+(\w+),(-?\d+),(-?\d+),(-?\d+),(-?\d+)")
    ctl = re.compile(r"^\s*\w+\s+(\w+),(-?\d+),(-?\d+),(-?\d+),(-?\d+)")
    out, cur = {}, None
    with io.open(path, "r", encoding="latin-1") as f:
        for line in f:
            m = head.match(line)
            if m:
                x0, y0, x1, y1 = (int(v) for v in m.groups()[1:])
                cur = ((x1 - x0, y1 - y0), {})
                out[m.group(1)] = cur
            elif line.strip().upper() == "END":
                cur = None
            elif cur is not None:
                m = ctl.match(line)
                if m:
                    cur[1][m.group(1)] = tuple(int(v) for v in m.groups()[1:])
    return out


def points_from_layout(dlg_path, screen=SCREEN):
    """Click points (fractions of the screen) computed from one editor's dialog file.
    Returns only the points whose dialog and control were found."""
    dialogs = read_dialogs(dlg_path)
    sw, sh = screen
    points = {}
    for name, (dlg, control, anchor, spot) in LAYOUT.items():
        if dlg not in dialogs or control not in dialogs[dlg][1]:
            continue
        (w, h), controls = dialogs[dlg]
        x0, y0, x1, y1 = controls[control]
        ox, oy = (sw - w, 0) if anchor == "top_right" else ((sw - w) / 2.0, (sh - h) / 2.0)
        if spot == "first_row":
            x, y = x0 + 30, y0 + 8        # inside the first row of the list
        else:
            x, y = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        points[name] = (round((ox + x) / sw, 3), round((oy + y) / sh, 3))
    return points


def use_layout(workdir, log=print):
    """Aim the clicks at the dialogs of the editor in `workdir` (read from its
    Interf\\ScenEdit.dlg). Points that cannot be computed keep their stock value.
    Returns the names of the points that moved by more than a few pixels."""
    import os
    path = os.path.join(workdir, "Interf", "ScenEdit.dlg")
    try:
        found = points_from_layout(path)
    except (IOError, OSError) as e:
        log("[drive] layout: cannot read %s (%s) -- using the stock click points" % (path, e))
        return []
    moved = []
    for name, (fx, fy) in sorted(found.items()):
        sx, sy = POINTS[name]
        if abs(fx - sx) * SCREEN[0] > 12 or abs(fy - sy) * SCREEN[1] > 12:
            moved.append(name)
        POINTS[name] = (fx, fy)
    log("[drive] layout: %d click point(s) from %s%s" % (
        len(found), path,
        "; differs from stock: " + ", ".join(
            "%s=(%d,%d)" % (n, POINTS[n][0] * SCREEN[0], POINTS[n][1] * SCREEN[1]) for n in moved)
        if moved else " (stock layout)"))
    return moved


def find_hwnd(title, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        h = u32.FindWindowA(None, title.encode("mbcs"))
        if h:
            return h
        time.sleep(0.5)
    return None


def client_size(hwnd):
    r = wt.RECT()
    u32.GetClientRect(hwnd, ctypes.byref(r))
    return r.right, r.bottom


def lparam(x, y):
    return (int(y) & 0xFFFF) << 16 | (int(x) & 0xFFFF)


def click(hwnd, fx, fy, dbl=False):
    w, h = client_size(hwnd)
    x, y = int(w * fx), int(h * fy)
    lp = lparam(x, y)
    u32.PostMessageA(hwnd, WM_MOUSEMOVE, 0, lp)
    time.sleep(0.05)
    u32.PostMessageA(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lp)
    time.sleep(0.05)
    u32.PostMessageA(hwnd, WM_LBUTTONUP, 0, lp)
    if dbl:
        time.sleep(0.05)
        u32.PostMessageA(hwnd, WM_LBUTTONDBLCLK, MK_LBUTTON, lp)
        time.sleep(0.05)
        u32.PostMessageA(hwnd, WM_LBUTTONUP, 0, lp)
    return x, y


def _wait(check, secs, step=0.5):
    if not check:
        time.sleep(secs); return None
    for _ in range(int(secs / step)):
        if check():
            return True
        time.sleep(step)
    return bool(check())


def _hwnd_pid(hwnd):
    pid = wt.DWORD(0)
    u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def _find_titled(title, pid=None):
    """First top-level window with this exact title (and owning PID, when given).
    PID-bound lookup makes PARALLEL editors safe: FindWindowA alone returns an arbitrary
    same-titled window, so 4 concurrent drivers would grab each other's editors."""
    target = title.encode("mbcs")
    hwnd = u32.FindWindowExA(None, None, None, target)
    while hwnd:
        if pid is None or _hwnd_pid(hwnd) == pid:
            return hwnd
        hwnd = u32.FindWindowExA(None, hwnd, None, target)
    return None


def main_window_disabled(main_hwnd):
    """A modal error dialog (e.g. a load that threw 'Missing modifier ...') DISABLES its owner.
    That's the reliable 'the editor is wedged' signal — note the mod's always-present plugin
    overlay is a second visible top-level, so 'an extra window exists' is NOT a modal signal.
    We do NOT try to click/key the modal shut: posting keys into D2's SHW32 custom UI
    access-violates the process. The batch relaunches the editor instead."""
    return bool(main_hwnd) and not u32.IsWindowEnabled(main_hwnd)


def find_ready_hwnd(title, timeout, log, pid=None):
    """Find the editor's REAL window: at startup a small stub window with the same title
    briefly exists and is then destroyed/recreated at full size. Re-find on invalidation
    and require a sane client size before driving (a 222x117 stub eats the clicks)."""
    end = time.time() + timeout
    while time.time() < end:
        hwnd = _find_titled(title, pid)
        if hwnd:
            w, h = client_size(hwnd)
            if w >= 500 and h >= 300:
                return hwnd
            log("[drive] stub window 0x%X (%dx%d) -- waiting for the real one" % (hwnd, w, h))
        time.sleep(0.7)
    return None


def open_editor(title, wait_window, log, pid=None):
    """Locate the editor's real window (past the startup stub), restore + foreground it."""
    hwnd = find_ready_hwnd(title, wait_window, log, pid)
    if not hwnd:
        log("[drive] window '%s' not found" % title); return None
    log("[drive] hwnd=0x%X client=%dx%d" % (hwnd, *client_size(hwnd)))
    u32.ShowWindow(hwnd, SW_RESTORE); u32.SetForegroundWindow(hwnd)
    time.sleep(1.0)
    return hwnd


def do_load(hwnd, log, list_check, loaded_check, pid=None, title="Scenario Editor"):
    """From the MAIN MENU: open the Load list, pick the first row, Ok, wait for the load.
    Feedback-driven — retries the Load click until the list (re)populates (list_check), then
    waits for the scenario to finish loading (loaded_check). For RE-loads pass DELTA checks
    (fresh closures over the current counts) so a second load is detected, not the first.
    Returns (hwnd, loaded_bool); hwnd may change if the window was recreated."""
    opened = False
    for attempt in range(20):
        if not u32.IsWindow(hwnd):
            log("[drive] window recreated -- re-finding")
            hwnd = find_ready_hwnd(title, 20, log, pid)
            if not hwnd:
                log("[drive] window gone for good"); return hwnd, False
            log("[drive] re-found hwnd=0x%X client=%dx%d" % (hwnd, *client_size(hwnd)))
            u32.ShowWindow(hwnd, SW_RESTORE)
        click(hwnd, *POINTS["menu_load"])
        if _wait(list_check, 2.0) or list_check is None:
            opened = True
            log("[drive] load list opened (attempt %d)" % (attempt + 1)); break
    if list_check and not opened:
        log("[drive] load list never opened"); return hwnd, False

    # scenario_read_header() is our signal that the list has started populating, not that its
    # custom controls have finished becoming interactive.  Clicking immediately after that signal
    # is racy: the row becomes visibly selected, but an early Ok mouse-up is occasionally ignored.
    time.sleep(1.5)
    loaded = False
    for confirm_attempt in range(4):
        click(hwnd, *POINTS["list_item0"]); time.sleep(0.9)
        click(hwnd, *POINTS["list_ok"])
        # A successful Ok reaches scenario_open_read almost immediately, even when parsing the
        # map itself takes longer.  Retry the same visible button instead of waiting 45 seconds or
        # clicking menu coordinates while the list dialog is still open.
        loaded = _wait(loaded_check, 5.0)
        if loaded or loaded_check is None:
            break
        log("[drive] Ok was not accepted — re-picking (attempt %d/4)" %
            (confirm_attempt + 1))
    log("[drive] load confirmed=%s" % loaded)
    time.sleep(1.0)
    return hwnd, loaded


def do_save(hwnd, log):
    """From the MAP VIEW: ОПЦИИ -> Сохранить (triggers the editor's validate+save path)."""
    click(hwnd, *POINTS["opt"]); time.sleep(1.5)
    click(hwnd, *POINTS["opt_save"]); time.sleep(3.0)
    log("[drive] Save clicked")


def to_main_menu(hwnd, log):
    """From the MAP VIEW: ОПЦИИ -> Выход (leave the open scenario, back to the main menu),
    so a new scenario can be loaded. Blind (no BP feedback here) — do_load's list-open retry
    is what actually confirms we reached the menu."""
    log("[drive] leaving scenario -> main menu (OPTIONS/Exit)")
    # generous pauses: on a 144x144 map the options popup needs more than 1.5 s to appear, and
    # an "Exit" clicked before it is there lands on the map -- the editor then never leaves it
    click(hwnd, *POINTS["opt"]); time.sleep(3.0)
    click(hwnd, *POINTS["opt_exit"]); time.sleep(3.5)


def run_sequence(title="Scenario Editor", log=print, wait_window=60,
                 loaded_check=None, list_check=None, pid=None):
    """One-shot: find the editor, load the first scenario, Save. Feedback-driven throughout.
    `pid` binds the window lookup to ONE editor process (required for parallel runs)."""
    hwnd = open_editor(title, wait_window, log, pid)
    if not hwnd:
        return False
    hwnd, _loaded = do_load(hwnd, log, list_check, loaded_check, pid, title)
    do_save(hwnd, log)
    log("[drive] sequence done")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", default="Scenario Editor")
    ap.add_argument("--step-delay", type=float, default=1.5)
    ap.add_argument("--only", default=None,
                    help="post a single named/point click and exit, e.g. menu_load or '0.5,0.6'")
    args = ap.parse_args()

    hwnd = find_hwnd(args.title)
    if not hwnd:
        raise SystemExit("window '%s' not found" % args.title)
    print("[drive] hwnd=0x%X  client=%dx%d" % (hwnd, *client_size(hwnd)))
    u32.ShowWindow(hwnd, SW_RESTORE)
    u32.SetForegroundWindow(hwnd)
    time.sleep(0.3)

    if args.only:
        if "," in args.only:
            fx, fy = [float(v) for v in args.only.split(",")]
        else:
            fx, fy = POINTS[args.only]
        x, y = click(hwnd, fx, fy)
        print("[drive] clicked (%.3f,%.3f) -> client (%d,%d)" % (fx, fy, x, y))
        return

    seq = [
        ("menu: Load-scenario", "menu_load", False, 2.0),
        ("list: first item",    "list_item0", False, 0.6),
        ("list: Ok",            "list_ok", False, 4.0),
        ("map: OPTIONS",        "opt", False, 1.2),
        ("options: Save",       "opt_save", False, 2.5),
    ]
    for desc, pt, dbl, wait in seq:
        if not u32.IsWindow(hwnd):
            print("[drive] window gone before: %s" % desc); return
        x, y = click(hwnd, *POINTS[pt], dbl=dbl)
        print("[drive] %-22s @ client (%d,%d)" % (desc, x, y))
        time.sleep(wait)
    print("[drive] sequence done -- check the debugger log for the captured reason.")


if __name__ == "__main__":
    main()
