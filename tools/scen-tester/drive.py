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
POINTS = {
    "menu_load":  (0.497, 0.617),   # main menu: "Загрузить сценарий"
    "list_item0": (0.371, 0.158),   # load list: first scenario row
    "list_ok":    (0.450, 0.847),   # load list: "Ok"
    "opt":        (0.919, 0.056),   # map view: "ОПЦИИ" (top-right)
    "opt_save":   (0.494, 0.444),   # options popup: "Сохранить"
    "opt_exit":   (0.494, 0.492),   # options popup: "Выход" (leave scenario -> main menu)
    "dialog_ok":  (0.500, 0.620),   # СООБЩ. message box: "Ok"
}


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

    loaded = False
    for _ in range(2):
        click(hwnd, *POINTS["list_item0"]); time.sleep(0.6)
        click(hwnd, *POINTS["list_ok"])
        loaded = _wait(loaded_check, 45.0)
        if loaded or loaded_check is None:
            break
        log("[drive] load did not start — re-picking")
        click(hwnd, *POINTS["menu_load"]); time.sleep(1.0)
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
    click(hwnd, *POINTS["opt"]); time.sleep(1.5)
    click(hwnd, *POINTS["opt_exit"]); time.sleep(2.0)


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
