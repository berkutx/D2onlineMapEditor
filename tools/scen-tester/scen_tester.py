# -*- coding: utf-8 -*-
"""
scen_tester.py  --  ScenEdit.exe "why won't this map save?" tester.

Launches the Disciples 2 map editor (ScenEdit.exe) under a native Win32 debugger,
breakpoints the scenario-validation exception chokepoints, and when the editor rejects
a map ("Обнаружена несовместимость сценария") prints the EXACT reason
(e.g.  Scenario: Value '7' from 'SUBRACE' is out of bound [0:4])  plus the symbolized
C++ call stack that names the offending object.

Self-contained: pure ctypes over the Windows debug API. NO pip installs.
Requires a 32-bit Python (to match the 32-bit target's CONTEXT layout, no WOW64).

Typical use (assisted trigger -- you click Load+Save in the editor, the debugger watches):

    py-32 scen_tester.py --map "C:\\path\\to\\any_map.sg" --hold

The map is COPIED to a temp name inside the editor's Exports folder before launch, so the
original sample is never overwritten by the editor's save.  Point --map at any location.

See README.md for the full mechanism and the reverse-engineering behind the addresses.
"""
from __future__ import print_function
import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import shutil
import struct
import sys
import time

import scen_symbols as S

# ---------------------------------------------------------------------------
# Win32 debug API via ctypes
# ---------------------------------------------------------------------------
kernel32 = ctypes.windll.kernel32
LPVOID = ctypes.c_void_p
DWORD = wt.DWORD
WORD = wt.WORD
BYTE = wt.BYTE
HANDLE = wt.HANDLE
ULONG_PTR = ctypes.c_size_t

DEBUG_ONLY_THIS_PROCESS = 0x00000002
DBG_CONTINUE = 0x00010002
DBG_EXCEPTION_NOT_HANDLED = 0x80010001
INFINITE = 0xFFFFFFFF

EXCEPTION_DEBUG_EVENT = 1
CREATE_THREAD_DEBUG_EVENT = 2
CREATE_PROCESS_DEBUG_EVENT = 3
EXIT_THREAD_DEBUG_EVENT = 4
EXIT_PROCESS_DEBUG_EVENT = 5
LOAD_DLL_DEBUG_EVENT = 6
UNLOAD_DLL_DEBUG_EVENT = 7
OUTPUT_DEBUG_STRING_EVENT = 8
RIP_EVENT = 9

EXCEPTION_BREAKPOINT = 0x80000003
EXCEPTION_SINGLE_STEP = 0x80000004
EXCEPTION_ACCESS_VIOLATION = 0xC0000005

# explicit prototypes so HANDLEs / addresses are not truncated to c_int
BOOL = wt.BOOL
kernel32.ReadProcessMemory.argtypes = [HANDLE, LPVOID, LPVOID, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
kernel32.ReadProcessMemory.restype = BOOL
kernel32.WriteProcessMemory.argtypes = [HANDLE, LPVOID, LPVOID, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
kernel32.WriteProcessMemory.restype = BOOL
kernel32.GetThreadContext.argtypes = [HANDLE, LPVOID]
kernel32.GetThreadContext.restype = BOOL
kernel32.SetThreadContext.argtypes = [HANDLE, LPVOID]
kernel32.SetThreadContext.restype = BOOL
kernel32.FlushInstructionCache.argtypes = [HANDLE, LPVOID, ctypes.c_size_t]
kernel32.FlushInstructionCache.restype = BOOL
kernel32.WaitForDebugEvent.argtypes = [LPVOID, DWORD]
kernel32.WaitForDebugEvent.restype = BOOL
kernel32.ContinueDebugEvent.argtypes = [DWORD, DWORD, DWORD]
kernel32.ContinueDebugEvent.restype = BOOL
kernel32.CloseHandle.argtypes = [HANDLE]
kernel32.CloseHandle.restype = BOOL
kernel32.DebugActiveProcessStop.argtypes = [DWORD]
kernel32.DebugActiveProcessStop.restype = BOOL
kernel32.GetFinalPathNameByHandleA.argtypes = [HANDLE, wt.LPSTR, DWORD, DWORD]
kernel32.GetFinalPathNameByHandleA.restype = DWORD

CONTEXT_i386 = 0x00010000
CONTEXT_FULL = CONTEXT_i386 | 0x07   # control | integer | segments
TRAP_FLAG = 0x100


class FLOATING_SAVE_AREA(ctypes.Structure):
    _fields_ = [
        ("ControlWord", DWORD), ("StatusWord", DWORD), ("TagWord", DWORD),
        ("ErrorOffset", DWORD), ("ErrorSelector", DWORD), ("DataOffset", DWORD),
        ("DataSelector", DWORD), ("RegisterArea", BYTE * 80), ("Cr0NpxState", DWORD),
    ]


class CONTEXT(ctypes.Structure):
    _fields_ = [
        ("ContextFlags", DWORD),
        ("Dr0", DWORD), ("Dr1", DWORD), ("Dr2", DWORD), ("Dr3", DWORD),
        ("Dr6", DWORD), ("Dr7", DWORD),
        ("FloatSave", FLOATING_SAVE_AREA),
        ("SegGs", DWORD), ("SegFs", DWORD), ("SegEs", DWORD), ("SegDs", DWORD),
        ("Edi", DWORD), ("Esi", DWORD), ("Ebx", DWORD), ("Edx", DWORD),
        ("Ecx", DWORD), ("Eax", DWORD), ("Ebp", DWORD), ("Eip", DWORD),
        ("SegCs", DWORD), ("EFlags", DWORD), ("Esp", DWORD), ("SegSs", DWORD),
        ("ExtendedRegisters", BYTE * 512),
    ]


class EXCEPTION_RECORD(ctypes.Structure):
    _fields_ = [
        ("ExceptionCode", DWORD), ("ExceptionFlags", DWORD),
        ("ExceptionRecord", LPVOID), ("ExceptionAddress", LPVOID),
        ("NumberParameters", DWORD), ("ExceptionInformation", ULONG_PTR * 15),
    ]


class EXCEPTION_DEBUG_INFO(ctypes.Structure):
    _fields_ = [("ExceptionRecord", EXCEPTION_RECORD), ("dwFirstChance", DWORD)]


class CREATE_THREAD_DEBUG_INFO(ctypes.Structure):
    _fields_ = [("hThread", HANDLE), ("lpThreadLocalBase", LPVOID), ("lpStartAddress", LPVOID)]


class CREATE_PROCESS_DEBUG_INFO(ctypes.Structure):
    _fields_ = [
        ("hFile", HANDLE), ("hProcess", HANDLE), ("hThread", HANDLE),
        ("lpBaseOfImage", LPVOID), ("dwDebugInfoFileOffset", DWORD),
        ("nDebugInfoSize", DWORD), ("lpThreadLocalBase", LPVOID),
        ("lpStartAddress", LPVOID), ("lpImageName", LPVOID), ("fUnicode", WORD),
    ]


class LOAD_DLL_DEBUG_INFO(ctypes.Structure):
    _fields_ = [
        ("hFile", HANDLE), ("lpBaseOfDll", LPVOID), ("dwDebugInfoFileOffset", DWORD),
        ("nDebugInfoSize", DWORD), ("lpImageName", LPVOID), ("fUnicode", WORD),
    ]


class EXIT_PROCESS_DEBUG_INFO(ctypes.Structure):
    _fields_ = [("dwExitCode", DWORD)]


class OUTPUT_DEBUG_STRING_INFO(ctypes.Structure):
    _fields_ = [("lpDebugStringData", LPVOID), ("fUnicode", WORD), ("nDebugStringLength", WORD)]


class DEBUG_EVENT_UNION(ctypes.Union):
    _fields_ = [
        ("Exception", EXCEPTION_DEBUG_INFO),
        ("CreateThread", CREATE_THREAD_DEBUG_INFO),
        ("CreateProcessInfo", CREATE_PROCESS_DEBUG_INFO),
        ("LoadDll", LOAD_DLL_DEBUG_INFO),
        ("ExitProcess", EXIT_PROCESS_DEBUG_INFO),
        ("DebugString", OUTPUT_DEBUG_STRING_INFO),
        ("raw", BYTE * 168),
    ]


class DEBUG_EVENT(ctypes.Structure):
    _fields_ = [
        ("dwDebugEventCode", DWORD), ("dwProcessId", DWORD),
        ("dwThreadId", DWORD), ("u", DEBUG_EVENT_UNION),
    ]


class STARTUPINFO(ctypes.Structure):
    _fields_ = [
        ("cb", DWORD), ("lpReserved", wt.LPSTR), ("lpDesktop", wt.LPSTR),
        ("lpTitle", wt.LPSTR), ("dwX", DWORD), ("dwY", DWORD), ("dwXSize", DWORD),
        ("dwYSize", DWORD), ("dwXCountChars", DWORD), ("dwYCountChars", DWORD),
        ("dwFillAttribute", DWORD), ("dwFlags", DWORD), ("wShowWindow", WORD),
        ("cbReserved2", WORD), ("lpReserved2", LPVOID), ("hStdInput", HANDLE),
        ("hStdOutput", HANDLE), ("hStdError", HANDLE),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", HANDLE), ("hThread", HANDLE),
                ("dwProcessId", DWORD), ("dwThreadId", DWORD)]


# ---------------------------------------------------------------------------
class Debugger(object):
    def __init__(self, exe, workdir, log):
        self.exe = exe
        self.workdir = workdir
        self.log = log
        self.hProcess = None
        self.pid = None
        self.base = S.IMAGE_BASE                 # ScenEdit.exe load base
        self.threads = {}                        # tid -> hThread
        self.bps = {}                            # abs_addr -> original_byte
        self.bp_meta = {}                        # abs_addr -> (name, argspec, va)
        self.pending = {}                        # tid -> abs_addr awaiting re-arm
        self.modules = []                        # list of dicts base/size/name
        self.name_index = S.build_name_index()   # sorted [(va, name)]
        self.findings = []                       # captured rejection reasons
        self.trace_addrs = set()                 # non-capturing (feedback) breakpoints
        self.reason_addrs = {}                   # abs_addr -> "why invalid" text
        self.mod_base = {}                        # dll name (lower) -> load base
        self.invalid_obj_addr = None              # BP at the mod's per-object invalid-exit
        self.logger_addr = None                   # BP at the mod's fmt logger entry
        self.isinvalid_fmt = None                 # runtime addr of "Scenario object {:s} is invalid"
        self._hotsite_seen = set()                # de-dup hot call sites
        self.loaded_files = []                   # scenarios the editor opened for read
        self.headers_read = 0                    # scenario headers parsed (load list populated)
        self._first_bp_seen = False

    # -- process memory helpers ---------------------------------------------
    def read(self, addr, size):
        buf = (ctypes.c_char * size)()
        n = ctypes.c_size_t(0)
        ok = kernel32.ReadProcessMemory(self.hProcess, LPVOID(addr), buf,
                                        size, ctypes.byref(n))
        if not ok:
            return None
        return buf.raw[:n.value]

    def read_u32(self, addr):
        b = self.read(addr, 4)
        if not b or len(b) < 4:
            return None
        return struct.unpack("<I", b)[0]

    def read_cstr(self, addr, maxlen=512):
        if not addr:
            return None
        out = bytearray()
        while len(out) < maxlen:
            chunk = self.read(addr + len(out), 32)
            if not chunk:
                break
            nul = chunk.find(b"\x00")
            if nul >= 0:
                out += chunk[:nul]
                break
            out += chunk
        try:
            return bytes(out).decode("cp1251")
        except Exception:
            return bytes(out).decode("latin-1", "replace")

    def write(self, addr, data):
        n = ctypes.c_size_t(0)
        return kernel32.WriteProcessMemory(self.hProcess, LPVOID(addr), data,
                                           len(data), ctypes.byref(n))

    def get_ctx(self, tid):
        h = self.threads.get(tid)
        if not h:
            return None
        ctx = CONTEXT()
        ctx.ContextFlags = CONTEXT_FULL
        if not kernel32.GetThreadContext(h, ctypes.byref(ctx)):
            return None
        return ctx

    def set_ctx(self, tid, ctx):
        h = self.threads.get(tid)
        return h and kernel32.SetThreadContext(h, ctypes.byref(ctx))

    # -- breakpoints ---------------------------------------------------------
    def set_bp(self, abs_addr, name=None, argspec=None, va=None):
        orig = self.read(abs_addr, 1)
        if orig is None:
            self.log("  ! could not read for BP @ 0x%X" % abs_addr)
            return False
        self.bps[abs_addr] = orig[0] if isinstance(orig[0], int) else ord(orig[0])
        self.bp_meta[abs_addr] = (name or "0x%X" % abs_addr, argspec or [], va)
        self.write(abs_addr, b"\xCC")
        kernel32.FlushInstructionCache(self.hProcess, LPVOID(abs_addr), 1)
        back = self.read(abs_addr, 1)
        planted = back and (back[0] if isinstance(back[0], int) else ord(back[0])) == 0xCC
        if not planted:
            self.log("  ! BP write FAILED @ 0x%X (%s)" % (abs_addr, name))
        return bool(planted)

    # -- module / symbol -----------------------------------------------------
    def _image_size(self, base):
        e_lfanew = self.read_u32(base + 0x3C)
        if not e_lfanew:
            return 0x1000
        sz = self.read_u32(base + e_lfanew + 0x50)  # OptionalHeader.SizeOfImage
        return sz or 0x1000

    def add_module(self, base, name):
        if base is None:
            return
        size = self._image_size(base)
        self.modules.append({"base": base, "size": size, "name": name})

    def module_of(self, addr):
        for m in self.modules:
            if m["base"] <= addr < m["base"] + m["size"]:
                return m
        return None

    def in_code(self, addr):
        return self.module_of(addr) is not None

    def symbolize(self, addr):
        m = self.module_of(addr)
        if not m:
            return "0x%08X ???" % addr
        rva = addr - m["base"]
        if m["name"].lower() == "scenedit.exe":
            va = m["base"] and (S.IMAGE_BASE + rva) or addr
            # snap to nearest known function start <= va
            lo, hi, best = 0, len(self.name_index), None
            while lo < hi:
                mid = (lo + hi) // 2
                if self.name_index[mid][0] <= va:
                    best = self.name_index[mid]
                    lo = mid + 1
                else:
                    hi = mid
            if best and (va - best[0]) <= 0x2400:
                off = va - best[0]
                return "ScenEdit.exe+0x%X  %s%s" % (rva, best[1],
                                                    ("+0x%X" % off if off else ""))
            return "ScenEdit.exe+0x%X  (sub_%X)" % (rva, va)
        return "%s+0x%X" % (m["name"], rva)

    # -- stack walk ----------------------------------------------------------
    def _looks_like_call_ret(self, ret):
        pre = self.read(ret - 7, 7)
        if not pre or len(pre) < 7:
            return False
        b = bytearray(pre)  # bytes ret-7 .. ret-1
        if b[2] == 0xE8:                                   # call rel32 (5 bytes)
            return True
        if b[1] == 0xFF and ((b[2] >> 3) & 7) == 2:        # call r/m32, FF /2 (6B disp32)
            return True
        if b[4] == 0xFF and ((b[5] >> 3) & 7) == 2:        # FF /2 (3B) call [reg+disp8]
            return True
        if b[5] == 0xFF and 0xD0 <= b[6] <= 0xD7:          # call reg (2 bytes)
            return True
        return False

    def walk_stack(self, ctx, at_entry_addr=None, max_frames=24):
        frames = []
        seen = set()

        def add(a):
            if a and a not in seen and self.in_code(a):
                seen.add(a)
                frames.append(a)

        # exact immediate caller: at a fresh BP entry [ESP] is the return address
        if at_entry_addr is not None:
            r = self.read_u32(ctx.Esp)
            add(r)

        # frame-pointer chain (clean when present)
        ebp = ctx.Ebp
        for _ in range(max_frames):
            if not ebp or not self.in_code(ebp) and ebp < 0x10000:
                break
            ret = self.read_u32(ebp + 4)
            nxt = self.read_u32(ebp)
            if ret is None or nxt is None:
                break
            add(ret)
            if nxt <= ebp:      # stack grows down; saved EBP must increase
                break
            ebp = nxt

        # heuristic scan of the raw stack for anything that looks like a return addr
        if len(frames) < max_frames:
            blob = self.read(ctx.Esp, 0x600) or b""
            for i in range(0, len(blob) - 3, 4):
                val = struct.unpack_from("<I", blob, i)[0]
                if val in seen or not self.in_code(val):
                    continue
                if self._looks_like_call_ret(val):
                    add(val)
                    if len(frames) >= max_frames:
                        break
        return frames

    # -- capture a rejection at a breakpoint --------------------------------
    def _capture(self, tid, abs_addr):
        ctx = self.get_ctx(tid)
        if not ctx:
            return
        if abs_addr == self.logger_addr:
            return self._on_logger(tid, ctx)
        if abs_addr == self.invalid_obj_addr:
            return self._capture_invalid_object(tid, ctx)
        if abs_addr in self.reason_addrs:
            return self._capture_reason(tid, abs_addr, ctx)
        name, argspec, va = self.bp_meta[abs_addr]
        args = {}
        for idx, (label, kind) in enumerate(argspec):
            raw = self.read_u32(ctx.Esp + 4 + idx * 4)   # [ESP+4]=arg1, ...
            if raw is None:
                continue
            if kind == "s":
                args[label] = self.read_cstr(raw)
            else:
                # signed int
                args[label] = raw - 0x100000000 if raw >= 0x80000000 else raw
        if abs_addr in self.trace_addrs:
            if name == "scenario_open_read":
                self.loaded_files.append(args.get("path"))
            elif name == "scenario_read_header":
                self.headers_read += 1
            self.log("[trace] %s(%s)" % (name, ", ".join("%s=%r" % kv for kv in args.items())))
            return
        stack = self.walk_stack(ctx, at_entry_addr=abs_addr)
        sym = [self.symbolize(a) for a in stack]
        finding = {"bp": name, "va": "0x%X" % (va or 0), "args": args, "stack": sym}
        self.findings.append(finding)

        self.log("")
        self.log("=" * 78)
        self.log("  SCENARIO REJECTED  --  caught at %s" % name)
        if name.startswith("CMidScenException") and args.get("reason"):
            self.log("  REASON: %s" % args["reason"])
        elif name == "report_out_of_bound":
            self.log("  REASON: field '%s' value %s out of bound [%s:%s]" % (
                args.get("field"), args.get("value"), args.get("min"), args.get("max")))
        elif name in ("report_bad_value_int", "report_bad_value_str"):
            self.log("  REASON: invalid value %r in field '%s'" % (
                args.get("value"), args.get("field")))
        elif name == "report_invalid_stream":
            self.log("  REASON: '%s' Invalid Stream" % args.get("name"))
        elif name == "report_scenario_error":
            self.log("  REASON: '%s' %s" % (args.get("name"), args.get("message")))
        else:
            self.log("  args: %r" % args)
        self.log("  --- C++ call stack (most-recent first) ---")
        for i, fr in enumerate(sym):
            self.log("   #%-2d %s" % (i, fr))
        self.log("=" * 78)
        self.log("")

    def _dbgstr_reject(self, tid, s):
        """The editor/mod just logged a per-object rejection. The logging thread is parked
        inside OutputDebugString -> walk its stack to name the validator + save chain."""
        ctx = self.get_ctx(tid)
        sym = [self.symbolize(a) for a in self.walk_stack(ctx)] if ctx else []
        self.findings.append({"bp": "editor-diagnostic", "reason": s, "stack": sym})
        self.log("")
        self.log("#" * 78)
        self.log("  SCENARIO REJECTED  --  editor diagnostic")
        self.log("  REASON: %s" % s)
        self.log("  --- call stack at the log point (most-recent first) ---")
        for i, fr in enumerate(sym[:24]):
            self.log("   #%-2d %s" % (i, fr))
        self.log("#" * 78)
        self.log("")

    def read_rtti(self, obj):
        """MSVC RTTI: obj -> vtable -> [vtable-4]=CompleteObjectLocator -> [+12]=TypeDescriptor
        -> name at +8 (e.g. '.?AVMidLandmark@@')."""
        try:
            vt = self.read_u32(obj)
            col = self.read_u32(vt - 4)
            td = self.read_u32(col + 12)
            nm = self.read_cstr(td + 8, 128)
            return nm
        except Exception:
            return None

    def _on_logger(self, tid, ctx):
        """Fires on every mod log call (filtered fast by the format string). When it's the
        'Scenario object {:s} is invalid' one, [ESP] = the HOT inlined validator call site."""
        esp = ctx.Esp
        fmt = self.read_u32(esp + 4)
        if fmt != self.isinvalid_fmt:
            return
        ret = self.read_u32(esp)
        arg2 = self.read_u32(esp + 8)
        mss = self.mod_base.get("mss32.dll", 0)
        hot_rva = (ret - mss) if (ret and mss and ret >= mss) else 0
        idstr = None
        for cand in (arg2, self.read_u32(arg2) if arg2 else None, esp + 8):
            s = self.read_cstr(cand, 32) if cand else None
            if s and any(c in s for c in ("S143", "MM", "OB")) and len(s) >= 5:
                idstr = s
                break
        if hot_rva in self._hotsite_seen:
            return
        self._hotsite_seen.add(hot_rva)
        frames = self.walk_stack(ctx, at_entry_addr=self.logger_addr)
        sym = [self.symbolize(a) for a in frames]
        self.findings.append({"bp": "invalid-hotsite", "hot_site": "mss32+0x%X" % hot_rva,
                              "id": idstr, "stack": sym})
        self.log("")
        self.log("#" * 78)
        self.log("  INVALID-OBJECT HOT SITE (deterministic)")
        self.log("  logged id : %r" % idstr)
        self.log("  HOT VALIDATOR CALL SITE: mss32.dll+0x%X   (IDA VA 0x%08X)"
                 % (hot_rva, 0x10000000 + hot_rva))
        self.log("  --- clean caller frames ---")
        for i, fr in enumerate(sym[:16]):
            self.log("   #%-2d %s" % (i, fr))
        self.log("#" * 78)
        self.log("")

    def _capture_invalid_object(self, tid, ctx):
        """The mod's per-object validator reached its INVALID exit. v12 (ebp-0x58) = the
        scenario object that failed. Read its exact C++ type so we know WHAT is broken."""
        obj = self.read_u32(ctx.Ebp - 0x58)
        rtti = self.read_rtti(obj) if obj else None
        typ = (rtti or "").replace(".?AV", "").rstrip("@")
        stack = [self.symbolize(a) for a in self.walk_stack(ctx)]
        self.findings.append({"bp": "invalid-object-type", "object_type": typ,
                              "object_ptr": "0x%X" % (obj or 0)})
        self.log("")
        self.log("#" * 78)
        self.log("  INVALID OBJECT IDENTIFIED  (mod per-object validator, invalid exit)")
        self.log("  C++ TYPE : %s   (raw RTTI %r)" % (typ or "?", rtti))
        self.log("  object   : 0x%X" % (obj or 0))
        self.log("  -> this object type is what the editor rejects; pair with the")
        self.log("     '[dbgstr] ... Scenario object <ID> is invalid' id above.")
        self.log("#" * 78)
        self.log("")

    def _capture_reason(self, tid, abs_addr, ctx):
        """A mid-validator 'why invalid' branch fired. ESI = the object being validated.
        Record the specific defect + the stack that names the calling save routine."""
        reason = self.reason_addrs[abs_addr]
        obj = ctx.Esi
        stack = self.walk_stack(ctx)
        sym = [self.symbolize(a) for a in stack]
        # try to read an object-id / typename string reachable from the object
        objinfo = None
        vtbl = self.read_u32(obj) if obj else None
        finding = {"bp": "object-validator", "reason": reason,
                   "object_ptr": "0x%X" % (obj or 0), "stack": sym}
        self.findings.append(finding)
        self.log("")
        self.log("#" * 78)
        self.log("  SCENARIO REJECTED  --  an object failed validation")
        self.log("  WHY: %s" % reason)
        self.log("  object @ 0x%X (vtable 0x%X)" % (obj or 0, vtbl or 0))
        self.log("  (pair with the '[dbgstr] ... Scenario object <ID> is invalid' line above")
        self.log("   for the object id)")
        self.log("  --- call stack (most-recent first) ---")
        for i, fr in enumerate(sym):
            self.log("   #%-2d %s" % (i, fr))
        self.log("#" * 78)
        self.log("")

    def _extract_cpp_message(self, obj_ptr):
        """A CMidScenException stores its formatted reason string. Recover it: scan the
        object for an inline C-string and follow each dword as a possible char*."""
        if not obj_ptr:
            return None
        blob = self.read(obj_ptr, 0x60) or b""
        # inline string (SSO-style)?
        for probe in (b"Scenario", b"StreamLimit"):
            p = blob.find(probe)
            if p >= 0:
                return self.read_cstr(obj_ptr + p)
        # pointer members -> char*
        best = None
        for off in range(0, len(blob) - 3, 4):
            ptr = struct.unpack_from("<I", blob, off)[0]
            if not self._readable(ptr):
                continue
            s = self.read_cstr(ptr, 300)
            if s and ("Scenario" in s or "Stream" in s or "field" in s or "bound" in s):
                return s
            if s and best is None and 3 < len(s) < 200 and s.isprintable():
                best = s
        return best

    def _readable(self, addr):
        if not addr or addr < 0x10000 or addr > 0x7FFFFFFF:
            return False
        return self.read(addr, 1) is not None

    def _on_cpp_throw(self, ev, rec, tid):
        info = rec.ExceptionInformation
        obj_ptr = info[1] if rec.NumberParameters >= 2 else 0
        msg = self._extract_cpp_message(obj_ptr)
        ctx = self.get_ctx(tid)
        stack = self.walk_stack(ctx) if ctx else []
        sym = [self.symbolize(a) for a in stack]
        looks_scenario = bool(msg and ("Scenario" in msg or "Stream" in msg or "bound" in msg)) \
            or any(("report_" in s or "Stream" in s or "ScenException" in s) for s in sym)
        if not looks_scenario:
            self._benign_throws = getattr(self, "_benign_throws", 0) + 1
            if self._benign_throws <= 12:
                top = sym[0] if sym else "?"
                self.log("[c++throw #%d] msg=%r top=%s" % (self._benign_throws, msg, top))
            return
        self.findings.append({"bp": "C++ throw (CMidScenException)", "reason": msg, "stack": sym})
        self.log("")
        self.log("=" * 78)
        self.log("  SCENARIO REJECTED  --  CMidScenException thrown during save")
        self.log("  REASON: %s" % (msg if msg else "(message not recoverable from object)"))
        self.log("  --- C++ call stack (most-recent first) ---")
        for i, fr in enumerate(sym):
            self.log("   #%-2d %s" % (i, fr))
        self.log("=" * 78)
        self.log("")

    # -- launch + main loop --------------------------------------------------
    def launch(self, cmdline_args=""):
        si = STARTUPINFO()
        si.cb = ctypes.sizeof(si)
        pi = PROCESS_INFORMATION()
        cmd = '"%s"' % self.exe
        if cmdline_args:
            cmd += " " + cmdline_args
        cmdbuf = ctypes.create_string_buffer(cmd.encode("mbcs"))
        ok = kernel32.CreateProcessA(
            self.exe.encode("mbcs"), cmdbuf, None, None, False,
            DEBUG_ONLY_THIS_PROCESS, None, self.workdir.encode("mbcs"),
            ctypes.byref(si), ctypes.byref(pi))
        if not ok:
            raise ctypes.WinError(kernel32.GetLastError())
        self.hProcess = pi.hProcess
        self.pid = pi.dwProcessId
        self.log("[*] launched %s  pid=%d" % (os.path.basename(self.exe), self.pid))

    def _arm_all(self):
        for name, va, argspec in S.CAPTURE_BREAKPOINTS:
            abs_addr = self.base + (va - S.IMAGE_BASE)
            self.set_bp(abs_addr, name=name, argspec=argspec, va=va)
        for name, va, argspec in getattr(S, "TRACE_BREAKPOINTS", []):
            abs_addr = self.base + (va - S.IMAGE_BASE)
            if self.set_bp(abs_addr, name=name, argspec=argspec, va=va):
                self.trace_addrs.add(abs_addr)
        for va, reason in getattr(S, "REASON_BRANCHES", {}).items():
            abs_addr = self.base + (va - S.IMAGE_BASE)
            if self.set_bp(abs_addr, name="reason", va=va):
                self.reason_addrs[abs_addr] = reason
        self.log("[*] armed %d breakpoints at base 0x%X (%d trace, %d reason)" %
                 (len(self.bps), self.base, len(self.trace_addrs), len(self.reason_addrs)))

    def run(self, deadline=None):
        ev = DEBUG_EVENT()
        self._ev = 0
        self._last_code = None
        last_hb = time.time()
        self.log("[run] loop started")
        while True:
            if not kernel32.WaitForDebugEvent(ctypes.byref(ev), 1000):
                err = kernel32.GetLastError()
                if err not in (121, 0):   # 121 = ERROR_SEM_TIMEOUT (normal 1s timeout)
                    self.log("[run] WaitForDebugEvent failed err=%d -> returning" % err)
                    return
                if time.time() - last_hb > 5:
                    last_hb = time.time()
                    self.log("[run] heartbeat: events=%d last_code=%s alive" % (self._ev, self._last_code))
                if deadline and time.time() > deadline:
                    self.log("[*] deadline reached, detaching")
                    self.detach()
                    return
                continue
            self._ev += 1
            code = ev.dwDebugEventCode
            self._last_code = code
            tid = ev.dwThreadId
            status = DBG_CONTINUE

            try:
                if code == CREATE_PROCESS_DEBUG_EVENT:
                    info = ev.u.CreateProcessInfo
                    self.threads[tid] = info.hThread
                    self.base = info.lpBaseOfImage or S.IMAGE_BASE
                    self.add_module(self.base, "ScenEdit.exe")
                    self._arm_all()
                    if info.hFile:
                        kernel32.CloseHandle(info.hFile)

                elif code == CREATE_THREAD_DEBUG_EVENT:
                    self.threads[tid] = ev.u.CreateThread.hThread

                elif code == EXIT_THREAD_DEBUG_EVENT:
                    self.threads.pop(tid, None)

                elif code == LOAD_DLL_DEBUG_EVENT:
                    dll = ev.u.LoadDll
                    nm = self._dll_name(dll)
                    base = dll.lpBaseOfDll or 0
                    self.add_module(base, nm)
                    self.mod_base[nm.lower()] = base
                    self.log("[dll] 0x%08X  %s" % (base, nm))
                    # NB: the save-rejection ('Scenario object <id> is invalid') is emitted by
                    # this mss32 proxy mod, but it's built with fmtlib (compiled format strings)
                    # + inlined validators, so it can't be breakpointed cleanly. We capture the
                    # reason reliably from the OutputDebugString it also emits (see _dbgstr_reject).
                    if dll.hFile:
                        kernel32.CloseHandle(dll.hFile)

                elif code == OUTPUT_DEBUG_STRING_EVENT:
                    ds = ev.u.DebugString
                    if not ds.fUnicode:
                        s = self.read_cstr(ds.lpDebugStringData, ds.nDebugStringLength + 1)
                        if s and s.strip():
                            s = s.strip()
                            self.log("[dbgstr] %s" % s)
                            low = s.lower()
                            if ("is invalid" in low or "scenario object" in low
                                    or "несовмест" in low or "invalid plan" in low
                                    or "invalid object" in low):
                                self._dbgstr_reject(tid, s)

                elif code == EXCEPTION_DEBUG_EVENT:
                    status = self._on_exception(ev)

                elif code == EXIT_PROCESS_DEBUG_EVENT:
                    self.log("[*] editor exited (code %d)" % ev.u.ExitProcess.dwExitCode)
                    kernel32.ContinueDebugEvent(ev.dwProcessId, tid, DBG_CONTINUE)
                    return
            except Exception as e:
                # a handler bug must NEVER kill the debugger (which would kill the editor)
                import traceback
                self.log("[!] handler error on event %d: %r" % (code, e))
                self.log(traceback.format_exc())
                status = DBG_EXCEPTION_NOT_HANDLED if code == EXCEPTION_DEBUG_EVENT else DBG_CONTINUE

            kernel32.ContinueDebugEvent(ev.dwProcessId, tid, status)
            if deadline and time.time() > deadline:
                self.log("[*] deadline reached, detaching")
                self.detach()
                return

    def _dll_name(self, dll):
        # most reliable: resolve the mapped file path from the load event's file handle
        try:
            if dll.hFile:
                buf = ctypes.create_string_buffer(600)
                n = kernel32.GetFinalPathNameByHandleA(dll.hFile, buf, 600, 0)
                if n:
                    p = buf.value.decode("mbcs", "replace").lstrip("\\\\?").lstrip("\\")
                    return os.path.basename(p) or p
        except Exception:
            pass
        try:
            if dll.lpImageName:
                p = self.read_u32(dll.lpImageName)
                if p:
                    s = self.read_cstr(p, 260) if not dll.fUnicode else None
                    if s:
                        return os.path.basename(s)
        except Exception:
            pass
        return "0x%X.dll" % (dll.lpBaseOfDll or 0)

    def _on_exception(self, ev):
        rec = ev.u.Exception.ExceptionRecord
        first = ev.u.Exception.dwFirstChance
        code = rec.ExceptionCode & 0xFFFFFFFF
        addr = rec.ExceptionAddress or 0
        tid = ev.dwThreadId

        if code == EXCEPTION_BREAKPOINT:
            if addr in self.bps:
                # our validation breakpoint fired
                self._capture(tid, addr)
                # restore original instruction, back EIP up, single-step to re-arm
                self.write(addr, bytes(bytearray([self.bps[addr]])))
                kernel32.FlushInstructionCache(self.hProcess, LPVOID(addr), 1)
                ctx = self.get_ctx(tid)
                if ctx:
                    ctx.Eip = addr
                    ctx.EFlags |= TRAP_FLAG
                    self.set_ctx(tid, ctx)
                    self.pending[tid] = addr
                return DBG_CONTINUE
            # the initial loader breakpoint (first one) -- swallow it
            if not self._first_bp_seen:
                self._first_bp_seen = True
                return DBG_CONTINUE
            return DBG_CONTINUE

        if code == EXCEPTION_SINGLE_STEP:
            addr2 = self.pending.pop(tid, None)
            if addr2 is not None:
                # re-plant the 0xCC we temporarily removed
                self.write(addr2, b"\xCC")
                kernel32.FlushInstructionCache(self.hProcess, LPVOID(addr2), 1)
                return DBG_CONTINUE
            return DBG_CONTINUE

        if code == S.EXCEPTION_CPP and first:
            # first-chance MSVC C++ throw. ExceptionInformation[1] = thrown object ptr.
            # This is the guaranteed catch-all for CMidScenException regardless of which
            # reporter built it. Extract the message + stack; let the app then handle it.
            self._on_cpp_throw(ev, rec, tid)
            return DBG_EXCEPTION_NOT_HANDLED

        if code == EXCEPTION_ACCESS_VIOLATION and first:
            ctx = self.get_ctx(tid)
            self.log("[!] first-chance ACCESS_VIOLATION @ %s" % self.symbolize(addr))
            if ctx:
                for fr in self.walk_stack(ctx)[:10]:
                    self.log("       %s" % self.symbolize(fr))
            return DBG_EXCEPTION_NOT_HANDLED

        # everything else: let the app handle it
        return DBG_EXCEPTION_NOT_HANDLED

    def detach(self):
        try:
            kernel32.DebugActiveProcessStop(self.pid)
        except Exception:
            pass


# ---------------------------------------------------------------------------
def make_logger(logfile):
    # UTF-8 log file so Cyrillic (scenario names, field values) round-trips; the console
    # may be cp1252 -> guard every print so a non-encodable char can NEVER crash the loop
    # (that would kill the debugger and, via kill-on-exit, the editor).
    fh = open(logfile, "a", buffering=1, encoding="utf-8", errors="replace") if logfile else None

    def log(msg):
        line = msg if isinstance(msg, str) else str(msg)
        try:
            print(line)
        except UnicodeEncodeError:
            enc = getattr(sys.stdout, "encoding", None) or "ascii"
            sys.stdout.write(line.encode(enc, "replace").decode(enc, "replace") + "\n")
        except Exception:
            pass
        try:
            sys.stdout.flush()
        except Exception:
            pass
        if fh:
            fh.write(line + "\n")
    return log


def stage_map(src, exports_dir, log):
    if not os.path.isfile(src):
        raise SystemExit("map not found: %s" % src)
    base = "_scentest_%d.sg" % os.getpid()
    dst = os.path.join(exports_dir, base)
    shutil.copyfile(src, dst)
    log("[*] staged '%s' -> %s (%d bytes; original untouched)" %
        (os.path.basename(src), dst, os.path.getsize(dst)))
    return dst, base


def main():
    ap = argparse.ArgumentParser(description="ScenEdit save-rejection tester")
    ap.add_argument("--editor", default=r"C:\GOG Games\slasher_mns_2_4 - C4dll\ScenEdit.exe")
    ap.add_argument("--map", default=r"C:\GOG Games\slasher_mns_2_4 - C4dll\Exports\s4sn7hba5ghvbqvgqygrargucofq5jai-edited.sg")
    ap.add_argument("--exports", default=None, help="Exports dir (default: <editor>\\Exports)")
    ap.add_argument("--timeout", type=float, default=0, help="auto-detach after N seconds (0=until exit)")
    ap.add_argument("--hold", action="store_true", help="keep running so you can click Load+Save")
    ap.add_argument("--auto", action="store_true",
                    help="self-drive load+save by posted messages (one-shot, unattended)")
    ap.add_argument("--log", default=None)
    ap.add_argument("--result", default=None, help="write JSON findings here")
    ap.add_argument("--no-stage", action="store_true", help="load --map path as-is (must be in Exports)")
    args = ap.parse_args()

    if struct.calcsize("P") * 8 != 32:
        raise SystemExit("ERROR: run with 32-bit Python (target is a 32-bit process). "
                         "Try:  C:\\Users\\berkut\\AppData\\Local\\Programs\\Python\\Python37-32\\python.exe")

    log = make_logger(args.log)
    editor = os.path.abspath(args.editor)
    workdir = os.path.dirname(editor)
    exports = args.exports or os.path.join(workdir, "Exports")

    staged_name = None
    staged_path = None
    if not args.no_stage:
        staged_path, staged_name = stage_map(args.map, exports, log)
    else:
        log("[*] --no-stage: using %s directly" % args.map)

    log("[*] editor : %s" % editor)
    log("[*] load this map in the editor: Exports\\%s" % (staged_name or os.path.basename(args.map)))
    log("[*] then Save -> the debugger prints the exact rejection reason below.")

    dbg = Debugger(editor, workdir, log)
    dbg.launch()
    if args.auto:
        import threading
        import drive
        threading.Thread(target=drive.run_sequence,
                         kwargs={"log": log,
                                 "list_check": lambda: dbg.headers_read > 0,
                                 "loaded_check": lambda: len(dbg.loaded_files) > 0},
                         daemon=True).start()
        log("[*] --auto: self-drive thread started (waits for the window, then posts Load+Save)")
    deadline = time.time() + args.timeout if args.timeout else None
    try:
        dbg.run(deadline=deadline)
    except KeyboardInterrupt:
        log("[*] interrupted")
    except Exception as e:
        import traceback
        log("[FATAL] debugger loop crashed: %r" % e)
        log(traceback.format_exc())
    finally:
        if args.result:
            with open(args.result, "w") as f:
                json.dump(dbg.findings, f, indent=2, ensure_ascii=False)
            log("[*] wrote %d finding(s) to %s" % (len(dbg.findings), args.result))
        if staged_path and os.path.isfile(staged_path):
            try:
                os.remove(staged_path)
                log("[*] cleaned up staged copy")
            except Exception:
                pass


if __name__ == "__main__":
    main()
