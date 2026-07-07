# -*- coding: utf-8 -*-
"""
plan_check.py -- OFFLINE, deterministic explanation of *why* ScenEdit rejects a map.

The editor's mod validator rejects an object when its footprint disagrees with the
MidgardPlan (the game's per-cell occupancy table: one {POS_X, POS_Y, ELEMENT->objectId}
entry per occupied cell). It reports only the first offender's id (e.g. "S143MM0005") and
hides the reason. This script reconstructs the reason from the .sg bytes alone -- no editor,
no debugger -- by diffing every land object's true footprint (decorCatalog cx/cy) against the
plan cells that reference it.

    python plan_check.py "C:\\path\\map.sg"

Prints every object whose plan occupancy != its footprint (the classic from-scratch bug:
a 2x2 wall written into the plan as a single 1x1 cell), plus off-map and doubly-claimed cells.
"""
from __future__ import print_function
import json, os, struct, sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
CAT = os.path.join(HERE, "..", "..", "public", "assets", "decorCatalog.json")


def load(path):
    b = open(path, "rb").read()
    cat = json.load(open(CAT, encoding="utf-8", errors="replace"))
    return b, cat


def i32(b, off):
    return struct.unpack_from("<i", b, off)[0]


def read_int(b, tag, frm, to):
    j = b.find(tag, frm, to)
    return i32(b, j + len(tag)) if j >= 0 else None


def read_str(b, tag, frm, to):
    j = b.find(tag, frm, to)
    if j < 0:
        return None
    ln = i32(b, j + len(tag))
    if 0 < ln < 64:
        return b[j + len(tag) + 4: j + len(tag) + 4 + ln].decode("latin1", "replace").rstrip("\x00").strip()
    return None


def analyze(path):
    b, cat = load(path)
    N = read_int(b, b"MAP_SIZE", 0, len(b)) or 144
    foot = lambda t: (int(cat[t]["cx"]), int(cat[t]["cy"])) if t in cat else (1, 1)

    # --- MidgardPlan entries: (x, y, objectId) ---
    pbeg = b.find(b".?AVCMidgardPlan")
    beg = b.find(b"BEGOBJECT", pbeg)
    end = b.find(b"ENDOBJECT", beg)
    plan = []
    q = beg
    while True:
        px = b.find(b"POS_X", q, end)
        if px < 0:
            break
        x = i32(b, px + 5)
        py = b.find(b"POS_Y", px, end)
        y = i32(b, py + 5)
        el = b.find(b"ELEMENT", py, end)
        ln = i32(b, el + 7)
        eid = b[el + 11: el + 11 + ln].decode("latin1", "replace").rstrip("\x00").strip() if 0 < ln < 64 else ""
        plan.append((x, y, eid))
        q = el + 11 + max(ln, 0)

    plan_cells = set((x, y) for x, y, _ in plan)
    plan_by_id = defaultdict(set)
    for x, y, eid in plan:
        plan_by_id[eid].add((x, y))

    # --- landmarks: footprint per anchor ---
    idx = []
    i = b.find(b"MidLandmark")
    while i != -1:
        idx.append(i); i = b.find(b"MidLandmark", i + 1)
    lms = []
    for k, i in enumerate(idx):
        nxt = idx[k + 1] if k + 1 < len(idx) else i + 2000
        t = read_str(b, b"TYPE", i, nxt); x = read_int(b, b"POS_X", i, nxt); y = read_int(b, b"POS_Y", i, nxt)
        if None in (t, x, y):
            continue
        w, h = foot(t)
        lms.append((t, x, y, w, h, {(x + dx, y + dy) for dx in range(w) for dy in range(h)}))

    # --- diffs ---
    under = []   # footprint cells missing from the plan (plan under-declares the object)
    for t, x, y, w, h, cells in lms:
        miss = cells - plan_cells
        if miss:
            under.append((len(miss), w * h, t, x, y, w, h, sorted(miss)))
    under.sort(reverse=True)

    offmap = [(x, y, e) for x, y, e in plan if x < 0 or y < 0 or x >= N or y >= N]
    dbl = [(c, n) for c, n in Counter((x, y) for x, y, _ in plan).items() if n > 1]

    print("map: %s   size %dx%d" % (os.path.basename(path), N, N))
    print("landmarks: %d   plan entries: %d   plan-referenced objects: %d"
          % (len(lms), len(plan), len(plan_by_id)))
    print("\n== objects whose footprint is UNDER-declared in the plan ==")
    print("count: %d landmarks (total %d missing cells)" % (len(under), sum(u[0] for u in under)))
    for u in under[:25]:
        m, tot, t, x, y, w, h, miss = u
        print("  TYPE=%s POS=(%d,%d) %dx%d : plan has %d/%d cells, MISSING %s"
              % (t, x, y, w, h, tot - m, tot, miss[:6]))
    print("\nplan cells off-map: %d %s" % (len(offmap), offmap[:5]))
    print("plan cells claimed by >1 object: %d %s" % (len(dbl), dbl[:5]))
    if under:
        m, tot, t, x, y, w, h, miss = under[0]
        print("\n=> ScenEdit rejects the FIRST such object. Fix: write the object's full %dx%d"
              " footprint into the MidgardPlan (one {POS_X,POS_Y,ELEMENT} entry per cell)." % (w, h))


if __name__ == "__main__":
    p = sys.argv[1] if len(sys.argv) > 1 else \
        r"C:\GOG Games\slasher_mns_2_4 - C4dll\Exports\s4sn7hba5ghvbqvgqygrargucofq5jai-edited.sg"
    analyze(p)
