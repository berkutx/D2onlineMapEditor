# scen-tester — "why won't ScenEdit save this map?"

A self-contained tester that drives the Disciples 2 map editor (`ScenEdit.exe`) **entirely by
code** — no mouse/keyboard emulation, no screen automation — launches it under a native Win32
debugger, feeds it any `.sg` map, triggers Save, and captures the **exact reason** the editor
rejects it (the generic *"Обнаружена несовместимость сценария. Он не может быть сохранён"*
popup hides the real cause).

Pure `ctypes`, **32-bit Python** (matches the 32-bit target — no WOW64, no pip installs).

## Files
- `scen_tester.py` — the debugger + the `--auto` (one map) and `--batch` (folder) drivers.
  Launches ScenEdit, arms breakpoints, walks/symbolizes stacks, captures rejection reasons,
  relays the editor's `OutputDebugString` log, and grabs the call stack whenever it logs an
  object as invalid. `--batch` reuses one editor across maps (relaunching on a wedge) and
  reads the on-load verdict — see the Run section.
- `drive.py`    — drives ScenEdit's **custom** UI by posting real `WM_LBUTTONDOWN/UP`
  window messages straight to the window (its WndProc hit-tests buttons from the message
  `lParam`). Primitives: `open_editor`, `do_load` (menu→list→pick→Ok, feedback-driven with
  delta checks so re-loads are detected), `to_main_menu` (ОПЦИИ→Выход), `do_save`. Button
  positions are fractions of the live client rect, so they hold at any window size/position.
  (No keyboard/input emulation — `main_window_disabled` only *detects* a wedging modal; the
  batch relaunches rather than key-dismissing, since keys into D2's SHW32 UI crash it.)
- `scen_symbols.py` — reverse-engineered address table (breakpoints, reason branches, the
  scenario/serializer functions) baked in so the debugger can symbolize without IDA at runtime.
- `plan_check.py` — offline root-cause: diffs footprints vs MidgardPlan cells from the .sg
  bytes, no editor/debugger needed. Explains *why* an object is rejected and which cells.

## Run — pick a mode

**Everything below is 32-bit Python.** On this machine the interpreter is
`C:\Users\berkut\AppData\Local\Programs\Python\Python37-32\python.exe` — the tool refuses to
run under 64-bit Python (it must match the 32-bit target's CONTEXT layout). Substitute that path
for `python` below, or put it first on PATH.

### A) ONE map, full reason  (`--auto`)
```
python scen_tester.py --auto --map "C:\any\path\map.sg" --log run.log --result out.json
```
Launches ScenEdit, self-drives **Load + Save** by posted messages, and prints the exact rejection
under a `SCENARIO REJECTED` banner (both classes: the mod's per-object check *and* the editor's
save-time field-bounds exceptions), then cleans up. Feedback-driven — retries the Load click until
the list opens and waits for the load to finish before Save, so a slow load never desyncs it.
`--map` may point **anywhere**; it's copied into `Exports` first, so the original is never touched.

### B) A WHOLE FOLDER, fast  (`--batch`) — the throughput mode
```
python scen_tester.py --batch "C:\maps\folder" --result summary.json --log batch.log
```
Validates **every `*.sg` in the folder** by loading each in ONE reused editor and reading the
verdict the editor produces **on load** (no Save UI — much faster, and the load-time check is the
same one that blocks a save). Prints a running line per map and writes `summary.json` (defaults to
`<folder>\batch_summary.json`). Statuses:

| status | meaning |
|--------|---------|
| `PASS` | the editor loaded & validated it cleanly (would save) |
| `REJECT` + `invalid_obj` | a scenario object is invalid — e.g. a plan/footprint mismatch (`S143MM0005`) |
| `REJECT` + `reason` | the load threw — e.g. `MidUnit: Missing modifier 'G201UM9378'` |
| `UNKNOWN` | the load landed but validation never ran (rare) |
| `LOAD_FAIL` | the load never landed / the editor didn't come up |

A map that merely has invalid objects keeps the reused editor going; a map whose load **throws**
pops a fatal modal, so the batch records it and **relaunches a fresh editor for the rest** — fully
automatic, no per-map restart needed for the common case. The batch **isolates the Load list**: it
stashes the real scenarios into `Exports\_scentest_stash\` (and purges stale staged copies) so the
first-row click always selects the map it just wrote, then **restores them on exit** — crash-safe
(a later run recovers a stash left behind).

### C) Debug / assisted (two processes)
```
python scen_tester.py --map "C:\any\path\map.sg" --log run.log   # then, once up (~13s):
python drive.py
```

### D) PARALLEL relaunch batch (max throughput on a big corpus)
`--batch` reuses ONE editor sequentially. For a very large corpus, N junction clones each running
their own editor beat a single reused one:
```
powershell -File make_clones.ps1 -Count 4
set GC_PAR=4 && python batch_runner.py "C:\maps\folder"   # resumable summary.json
powershell -File make_clones.ps1 -Count 0                 # remove the clones afterwards
```

**Target-editor prerequisites** (found the hard way): the load list must be in folder-browse mode
— `ScenEditDatabase=0` in `Disciple.ini` (`=1` lists the DATABASE scenarios, so the staged copy
never appears and the first-row click loads the wrong map). Headless = the null-render wrapper:
cnc-ddraw built as `C4dll-R.dll` + `ddraw.ini` with `renderer=null` (see the slasher dir). The
driver binds its window lookup to the debuggee PID, so parallel editors don't steal each other's
clicks.

**Headless?** Unattended — yes: no mouse/keyboard emulation, no focus needed (posted messages
go to the window's queue), the window may be minimized/background. It does need a live
interactive desktop session (the editor renders via DirectDraw); it won't run under session-0
/ a disconnected RDP with no console.

### Offline root-cause (no editor at all)
```
python plan_check.py "C:\path\map.sg"
```
Reconstructs *why* from the .sg bytes alone: diffs every land object's footprint against its
MidgardPlan cells and prints every object the editor would reject, with the exact missing cells.

## How the editor validates (reverse-engineered)
Two independent rejection mechanisms exist:

1. **Base editor (ScenEdit.exe)** — an *exception-based field-stream* validator. Typed field
   readers bounds/enum-check every value; on violation they build a reason string and throw
   `CMidScenException` (ctor `sub_505F63` @ `0x505F63`), caught by the Save handler. Reason
   strings: `Scenario: Value '<n>' from '<FIELD>' is out of bound [<min>:<max>]`,
   `... Invalid Stream`, etc. The debugger breakpoints the ctor + reporters to read these.

2. **The mod (`mss32.dll`, a proxy-DLL injection loaded at `0x74000000`)** — a *per-object
   validity* check. It iterates each scenario object's positions/parts; if one is invalid it
   logs `Scenario object <ID> is invalid` and blocks the save. This is what rejects the
   sample map. The debugger catches that diagnostic (via `OutputDebugString`) and snapshots
   the logging thread's stack.

**Why `--batch` doesn't need Save at all** (the key finding that makes it fast): *both* checks
also run **on load** — the mod's `checkObjects` runs on the main thread inside the load handler
(`sub_404DCF` → mod hook → native `isValid`) and logs the same `is invalid`, and the field-stream
readers bounds-check as they read, throwing the same `CMidScenException` mid-load. So loading a map
already produces the verdict a save would. `--batch` reads exactly that and never touches Save.
(Two dead ends ruled out along the way: driving Save per map is flaky UI; and *injecting*
`checkObjects(getMap(editorCtx))` on a remote thread works once but the captured `editorCtx` is
**freed on unload**, so reusing it across a reload access-violates the editor. Loading is the clean,
crash-free signal.)

## Sample finding (`s4sn7hba…-edited.sg`, a from-scratch maze, 144×144) — SOLVED
Runtime capture: `[E] Scenario object S143MM0005 is invalid`.
`plan_check.py` then pins it exactly, offline:

- `S143MM0005` = a **2×2 stone wall** (`G000MG0048`) at cell **(12,0)**.
- Its MidgardPlan occupancy lists **1 cell `(12,0)` instead of all 4** (`(12,0),(12,1),(13,0),(13,1)`).
- The mod validator cross-checks each object's footprint against its plan cells, finds the
  mismatch, and rejects the **first** offender (S143MM0005) → save blocked.
- Not a one-off: **1705 landmarks** are under-declared the same way (every 2×2 wall got 1/4
  plan cells). This is the from-scratch bug where the plan was written 1×1 for a 2×2 wall.

**Fix (in the generator, not the editor):** write the object's FULL footprint into the
MidgardPlan — one `{POS_X,POS_Y,ELEMENT}` entry per occupied cell (the `landmarkSize` resolver
in `@d2/map-edit`). This `-edited.sg` predates/omits that fix.

The mod's validator is fmtlib/sol2 + inlined (cold copy `sub_101F4F60` holds the
`"Scenario object {:s} is invalid"` format string) — not cleanly breakpointable, which is why
the reason is captured from `OutputDebugString` and the exact cell is derived offline.

## Notes / limits
- Requires 32-bit Python (the tool asserts this).
- The editor's UI is fully custom (no HMENU, no child controls, no command-line map arg), so
  navigation is by posted mouse messages, verified at runtime by breakpoint feedback
  (`scenario_read_header` fires when the load list populates; `scenario_open_read` on load).
- A crash-proof UTF-8 logger is essential: the mod emits Cyrillic debug strings and a naive
  `print()` to a cp1252 console throws `UnicodeEncodeError`, which — inside the debug loop —
  would kill the debugger and, via kill-on-exit, the editor.
