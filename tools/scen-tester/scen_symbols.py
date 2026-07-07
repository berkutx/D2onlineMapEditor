# -*- coding: utf-8 -*-
"""
Reverse-engineered address/symbol table for ScenEdit.exe (Disciples 2 map editor).

All addresses are the VA the binary is linked at (image base 0x400000). ScenEdit.exe
has no ASLR (no DYNAMICBASE), so the runtime base is 0x400000 as well, but the debugger
still rebases everything against the base reported by the loader, so this stays correct
even if that ever changes.

Facts established by IDA (session "scenedit", md5 6d9dfa89f8687360ebf5745a80c9f0da):

  ScenEdit validates a scenario through an EXCEPTION-BASED field-streaming framework.
  Every per-object Stream() method reads its fields through typed helpers that bounds/
  enum-check each value. On any violation a human-readable reason is formatted and passed
  to the CMidScenException constructor, then a C++ exception is thrown. The Save handler
  catches CMidScenException and shows the generic, reason-less popup
  "Обнаружена несовместимость сценария. Он не может быть сохранён".

  => Breakpoint the ONE chokepoint (the exception ctor) and the 5 reporters to read the
     exact field / value / bounds that tripped, plus the call stack that names the object.
"""

IMAGE_BASE = 0x400000

# --- The primary capture chokepoints -----------------------------------------
# CMidScenException(this, const char* reasonMessage): the single funnel for EVERY
# scenario rejection. At its entry, [ESP]=caller retaddr, [ESP+4]=reasonMessage ptr.
EXC_CTOR = 0x505F63          # sub_505F63  CMidScenException::ctor(reason)
EXC_CTOR2 = 0x505FA4         # sub_505FA4  CMidScenException::ctor (copy variant)
THROW_SHIM = 0x505F20        # sub_505F20  logs str (or "Unknown error") then throws

# --- The reporters (their args are the STRUCTURED reason) --------------------
# signature notes give the stack args at entry: a1=[ESP+4], a2=[ESP+8], ...
REPORTERS = {
    0x506168: ("report_out_of_bound",  ["field", "value", "min", "max"]),
    0x506123: ("report_bad_value_int", ["value", "field"]),
    0x5060DE: ("report_bad_value_str", ["value", "field"]),
    0x50609C: ("report_invalid_stream", ["name"]),
    0x506057: ("report_scenario_error", ["name", "message"]),
}

# --- Typed field readers that call the reporters -----------------------------
STREAM_HELPERS = {
    0x504444: "StreamInt(this, field, &out, min, max)",
    0x5046ED: "StreamTyped_A(this, field, ...)",
    0x504785: "StreamTyped_B(this, field, ...)",
    0x504384: "StreamField(this, field, ...)",
    0x504615: "StreamField_C(this, field, ...)",
    0x504681: "StreamField_D(this, field, ...)",
}

# --- Serializer / scenario plumbing ------------------------------------------
NAMED = {
    0x401000: "WinMain",
    0x4874AD: "AppMain(\"Scenario Editor\")",
    0x483E43: "FileDialogWrapper(OFN)  # GetOpen/SaveFileNameA; this[17]=lpstrFile",
    0x4C4C28: "GetSaveFileNameA(thunk)",
    0x4C4C2E: "GetOpenFileNameA(thunk)",
    0x4DF0A0: "Scenario_ReadHeader(hFile,...)  # magic MidFile/D2EESFISIG, ver==35",
    0x4DEE63: "Scenario_WriteHeader_magic",
    0x4DED84: "Scenario_WriteHeader",
    0x4E2AC6: "CScenarioInfo::Stream",
    0x4E2DBD: "CScenarioInfo::StreamRaces",
    0x505F63: "CMidScenException::ctor(reason)",
    0x505FA4: "CMidScenException::ctor2",
    0x505F20: "CMidScenException::throw_shim",
    0x506057: "report_scenario_error",
    0x50609C: "report_invalid_stream",
    0x5060DE: "report_bad_value_str",
    0x506123: "report_bad_value_int",
    0x506168: "report_out_of_bound",
    0x504444: "StreamInt",
    0x5714AE: "_CxxThrowException",
    0x5712E0: "start(CRT)",
}

# --- The ~40 per-object Stream() methods (callers of report_invalid_stream) ---
# A stack frame landing in one of these tells you WHICH object type failed.
# (Not yet individually identified; labelled by address. Resolve in IDA on demand.)
STREAM_METHODS = [
    0x4DDC01, 0x4DE18C, 0x4E121D, 0x4E2AC6, 0x4E51B4, 0x4E654C, 0x4E6DD4, 0x4E713C,
    0x4E76E8, 0x4E7C3C, 0x4EDAF3, 0x4EDD46, 0x4EEC84, 0x4EF5C3, 0x4F069A, 0x4F1A7F,
    0x4F27B1, 0x4F2D8D, 0x4F2EEF, 0x4F3469, 0x4F35B9, 0x4F391B, 0x4F5CD7, 0x4F618F,
    0x4F7461, 0x4F7CDF, 0x4F8024, 0x4F8584, 0x4FAD79, 0x4FB8A4, 0x4FC64A, 0x4FCADC,
    0x4FCF81, 0x4FD700, 0x4FE15A, 0x4FE912, 0x4FF15E, 0x4FF680, 0x4FF742, 0x4FFF35,
]

# Mid-function branches inside the per-object validator (the code that makes the editor
# log "Scenario object <id> is invalid" and reject the save). Each address sits right where
# a specific defect is about to be reported, so hitting it tells you EXACTLY why the object
# failed. At these points ESI = the object being validated.
REASON_BRANCHES = {
    0x404778: "Invalid MidgardPlan  (object's plan/occupancy footprint is illegal)",
    0x4047AC: "Invalid object position",
}

# Windows C++ exception SEH code (throw)
EXCEPTION_CPP = 0xE06D7363

# Non-capturing trace breakpoints: log when hit (for driving feedback), no finding.
# sub_4DEF80 = CMidStreamEnvFile read-ctor: fires when a scenario file is OPENED FOR
# READ, i.e. a Load actually happened -> confirms our "click Load" worked. arg1 = path.
TRACE_BREAKPOINTS = [
    ("scenario_open_read", 0x4DEF80, [("path", "s")]),
    # header reader: fires per-scenario while the Load LIST populates (so it confirms the
    # "Load" menu click landed) and again on the actual load. Great click-feedback signal.
    ("scenario_read_header", 0x4DF0A0, []),
]


def build_name_index():
    """Return a sorted list of (va, name) function starts used to snap a return
    address to 'name+offset'.  STREAM_METHODS get a synthetic descriptive name."""
    idx = {}
    idx.update(NAMED)
    for va in STREAM_METHODS:
        idx.setdefault(va, "objStream@0x%X" % va)
    for va, name in STREAM_HELPERS.items():
        idx.setdefault(va, name.split("(")[0])
    for va, (name, _args) in REPORTERS.items():
        idx.setdefault(va, name)
    return sorted(idx.items())


# Breakpoints the tester arms, with how many args to read at entry for the report.
# name -> (va, [arg labels])   arg label "" means "pointer to C-string", "#" means int.
CAPTURE_BREAKPOINTS = [
    ("CMidScenException::ctor(reason)", EXC_CTOR, [("reason", "s")]),
    ("report_out_of_bound",  0x506168, [("field", "s"), ("value", "#"), ("min", "#"), ("max", "#")]),
    ("report_bad_value_int", 0x506123, [("value", "#"), ("field", "s")]),
    ("report_bad_value_str", 0x5060DE, [("value", "s"), ("field", "s")]),
    ("report_invalid_stream", 0x50609C, [("name", "s")]),
    ("report_scenario_error", 0x506057, [("name", "s"), ("message", "s")]),
    ("throw_shim", THROW_SHIM, [("str", "s")]),
]
