# scen-tester — "why won't ScenEdit save this map?"

A self-contained tester that drives the Disciples 2 map editor (`ScenEdit.exe`) **entirely by
code** — no mouse/keyboard emulation, no screen automation — launches it under a native Win32
debugger, feeds it any `.sg` map, triggers Save, and captures the **exact reason** the editor
rejects it (the generic *"Обнаружена несовместимость сценария. Он не может быть сохранён"*
popup hides the real cause).

Pure `ctypes`, **32-bit Python** (matches the 32-bit target — no WOW64, no pip installs).

## Files
- `scen_tester.py` — the debugger. Launches ScenEdit, arms breakpoints, walks/symbolizes
  stacks, captures rejection reasons. Also relays the editor's `OutputDebugString` log
  (the mod is chatty) and grabs the call stack whenever it logs an object as invalid.
- `drive.py`    — drives ScenEdit's **custom** UI by posting real `WM_LBUTTONDOWN/UP`
  window messages straight to the window (its WndProc hit-tests buttons from the message
  `lParam`). Menu path: *Загрузить сценарий → pick → Ok → ОПЦИИ → Сохранить*. Button
  positions are fractions of the live client rect, so they hold at any window size/position.
- `scen_symbols.py` — reverse-engineered address table (breakpoints, reason branches, the
  scenario/serializer functions) baked in so the debugger can symbolize without IDA at runtime.
- `plan_check.py` — offline root-cause: diffs footprints vs MidgardPlan cells from the .sg
  bytes, no editor/debugger needed. Explains *why* an object is rejected and which cells.

## Run
```
# ONE hands-off command (unattended): launches ScenEdit, waits for it to be ready,
# self-drives Load+Save by posted messages, prints the reason under a "SCENARIO REJECTED"
# banner, cleans up. Feedback-driven (retries the Load click until the list opens; waits
# for the load to finish before Save) so a slow load never desyncs it.
python scen_tester.py --auto --map "C:\any\path\to\map.sg" --log run.log --result out.json

# Or two processes (debugger watches; you drive when ready):
python scen_tester.py --map "C:\any\path\to\map.sg" --log run.log   # then, once up (~13s):
python drive.py
```
`--map` may point anywhere; the file is copied to `Exports\_scentest_<pid>.sg` first, so the
original is NEVER overwritten by the editor's save.

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
