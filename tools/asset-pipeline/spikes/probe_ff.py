"""
De-risk spike (Stage 0): prove the .ff (MQDB) decode pipeline on real bytes.

Validates the three risky assumptions before we build the real pipeline:
  1. MQDB/MQRC container walk (marker scan).
  2. name -> record-id resolution, INCLUDING the OPT-less archives (GrBorder.ff).
  3. embedded palette-PNG + magenta color-key (palette index transparency).

Pure stdlib for parsing; Pillow only for the color-key proof. Run with the
3.7 interpreter that has Pillow:  python tools/asset-pipeline/spikes/probe_ff.py
"""
import io
import os
import re
import struct
import sys

GAME_IMGS = os.path.join(os.environ.get("D2_GAME_DIR", "."), "Game", "Imgs")
OUT = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)


def parse_ff(path):
    with open(path, "rb") as f:
        d = f.read()
    assert d[:4] == b"MQDB", "bad magic: %r" % d[:4]
    recs = []
    starts = [m.start() for m in re.finditer(b"MQRC", d)]
    for o in starts:
        # header: 'MQRC'(4) reserved(4) id(4) sizeA(4) sizeB(4) flag(4) reserved(4)
        _res0, rid, sizeA, sizeB, flag, _res1 = struct.unpack_from("<6i", d, o + 4)
        payload = d[o + 28 : o + 28 + sizeA]
        recs.append(dict(off=o, id=rid, sizeA=sizeA, sizeB=sizeB, flag=flag,
                         payload=payload, is_png=payload[:4] == b"\x89PNG"))
    return d, recs


def try_name_table(payload):
    """Return id->NAME map if payload looks like a 260-byte (i32 id + char[256]) table.
    Tries both a leading name-area prefix layout and a raw-from-0 layout."""
    best = {}
    for base in _candidate_table_starts(payload):
        out = {}
        off = base
        n = len(payload)
        while off + 260 <= n:
            rid = struct.unpack_from("<i", payload, off)[0]
            raw = payload[off + 4 : off + 260].split(b"\x00")[0]
            try:
                name = raw.decode("latin1")
            except Exception:
                name = ""
            if name and all(32 <= ord(c) < 127 for c in name):
                out[rid] = name
            off += 260
        if len(out) > len(best):
            best = out
    return best


def _candidate_table_starts(payload):
    starts = {0}
    if len(payload) >= 4:
        name_area = struct.unpack_from("<i", payload, 0)[0]
        if 0 < name_area < len(payload):
            starts.add(4 + name_area)
    return sorted(starts)


def probe(archive):
    path = os.path.join(GAME_IMGS, archive)
    print("\n" + "=" * 70)
    print("ARCHIVE:", archive, "(%d bytes)" % os.path.getsize(path))
    d, recs = parse_ff(path)
    pngs = [r for r in recs if r["is_png"]]
    nonpng = [r for r in recs if not r["is_png"]]
    print("records=%d  pngs=%d  non-png=%d" % (len(recs), len(pngs), len(nonpng)))

    # classify non-png records
    name_map = {}
    for r in nonpng:
        p = r["payload"]
        head = p[:16]
        tbl = try_name_table(p)
        tag = ""
        if p[:4] == b"MFF\x00":
            tag = "MFF-root count=%d" % (struct.unpack_from("<i", p, 4)[0] if len(p) >= 8 else -1)
        if tbl:
            tag += "  name-table(%d entries)" % len(tbl)
            name_map.update(tbl)
        print("  rec id=%-6d size=%-8d head=%r %s" % (r["id"], r["sizeA"], head, tag))

    # how many png ids are covered by names?
    png_ids = set(r["id"] for r in pngs)
    named_ids = set(name_map.keys()) & png_ids
    print("name->id coverage of PNG records: %d / %d" % (len(named_ids), len(png_ids)))
    sample_names = [name_map[i] for i in list(named_ids)[:8]]
    print("sample names:", sample_names)
    if not name_map:
        print("  !! NO name table found -> names must come from external index / naming convention")

    # color-key proof on the first PNG
    r0 = pngs[0]
    raw_png = r0["payload"]
    with open(os.path.join(OUT, "%s_%d_raw.png" % (archive, r0["id"])), "wb") as f:
        f.write(raw_png)
    _colorkey_proof(archive, r0, raw_png)
    return name_map, png_ids


def _colorkey_proof(archive, rec, raw_png):
    try:
        from PIL import Image
    except Exception as e:
        print("  (Pillow unavailable, skipping color-key proof:", e, ")")
        return
    im = Image.open(io.BytesIO(raw_png))
    print("  first PNG id=%d mode=%s size=%s" % (rec["id"], im.mode, im.size))
    pal = im.getpalette()
    magenta_idx = []
    if pal:
        for i in range(len(pal) // 3):
            r, g, b = pal[3 * i : 3 * i + 3]
            if r > 247 and b > 247 and g < 8:
                magenta_idx.append(i)
    print("  palette entries=%s  magenta indices=%s" % (len(pal) // 3 if pal else 0, magenta_idx))
    # build RGBA with magenta keyed to alpha=0
    if im.mode == "P" and magenta_idx:
        alpha = im.point(lambda px: 0 if px in magenta_idx else 255).convert("L")
        rgba = im.convert("RGBA")
        rgba.putalpha(alpha)
        keyed = rgba
    else:
        keyed = im.convert("RGBA")
    out = os.path.join(OUT, "%s_%d_keyed.png" % (archive, rec["id"]))
    keyed.save(out)
    # count transparent px
    a = keyed.split()[-1]
    trans = sum(1 for v in a.getdata() if v == 0)
    print("  keyed -> %s  transparent_px=%d / %d" % (os.path.basename(out), trans, im.size[0] * im.size[1]))


def main():
    archives = ["IsoTerrn.ff", "GrBorder.ff", "Ground.ff", "City.ff", "IsoAnim.ff"]
    summary = {}
    for a in archives:
        try:
            nm, ids = probe(a)
            summary[a] = (len(nm), len(ids))
        except Exception as e:
            print("  ERROR on", a, ":", e)
            summary[a] = ("ERR", str(e))
    print("\n" + "=" * 70)
    print("SUMMARY (archive -> names, png_count):")
    for a, v in summary.items():
        print("  %-14s %s" % (a, v))


if __name__ == "__main__":
    main()
