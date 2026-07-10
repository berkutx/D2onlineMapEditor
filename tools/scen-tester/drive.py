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
u32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]

WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_LBUTTONDBLCLK = 0x0203
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


def run_sequence(title="Scenario Editor", log=print, wait_window=60,
                 loaded_check=None, list_check=None, pid=None):
    """Drive the whole load+save flow by posted messages. Feedback-driven so it can't
    desync: retry the Load click until the list actually opens (list_check), then wait for
    the scenario to finish loading (loaded_check) before OPTIONS/Save. Both checks are wired
    by the debugger from its scenario_read_header / scenario_open_read breakpoints.
    `pid` binds the window lookup to ONE editor process (required for parallel runs)."""
    hwnd = find_ready_hwnd(title, wait_window, log, pid)
    if not hwnd:
        log("[drive] window '%s' not found" % title); return False
    log("[drive] hwnd=0x%X client=%dx%d" % (hwnd, *client_size(hwnd)))
    u32.ShowWindow(hwnd, SW_RESTORE); u32.SetForegroundWindow(hwnd)
    time.sleep(1.0)

    # 1) open the Load list — retry until the editor's menu is ready and the list populates.
    # The window may still be destroyed/recreated under us early on — re-find, don't give up.
    opened = False
    for attempt in range(20):
        if not u32.IsWindow(hwnd):
            log("[drive] window recreated -- re-finding")
            hwnd = find_ready_hwnd(title, 20, log, pid)
            if not hwnd:
                log("[drive] window gone for good"); return False
            log("[drive] re-found hwnd=0x%X client=%dx%d" % (hwnd, *client_size(hwnd)))
            u32.ShowWindow(hwnd, SW_RESTORE)
        click(hwnd, *POINTS["menu_load"])
        if _wait(list_check, 2.0) or list_check is None:
            opened = True
            log("[drive] load list opened (attempt %d)" % (attempt + 1)); break
    if list_check and not opened:
        log("[drive] load list never opened"); return False

    # 2) pick first scenario + Ok, then wait for it to actually load
    click(hwnd, *POINTS["list_item0"]); time.sleep(0.6)
    click(hwnd, *POINTS["list_ok"])
    log("[drive] load confirmed=%s" % _wait(loaded_check, 25.0))
    time.sleep(1.0)

    # 3) OPTIONS -> Save
    click(hwnd, *POINTS["opt"]); time.sleep(1.5)
    click(hwnd, *POINTS["opt_save"]); time.sleep(3.0)
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
