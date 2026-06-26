"""extract_gamedata: pull the DBF facts the renderer needs for object placement
into a small JSON the web loads (public/assets/objectdata.json).

Stage: landmark footprints from GLmark.dbf (LMARK_ID -> cx,cy). The editor's
LandmarkObjectAccessor::getW/getH read exactly these (mark->cx / mark->cy), and
CustomMapObject centres the sprite on that footprint, so we need them to place
landmarks correctly. Keyed UPPERCASE to match objectSpriteKey (lmarkId.toUpper()).

    python tools/asset-pipeline/extract_gamedata.py \
        --game "C:/GOG Games/last_version/Game" --out public/assets
"""
import argparse
import json
import os
import struct


def read_dbf(path):
    d = open(path, "rb").read()
    nrec = struct.unpack_from("<I", d, 4)[0]
    hlen = struct.unpack_from("<H", d, 8)[0]
    rlen = struct.unpack_from("<H", d, 10)[0]
    fields = []
    i = 32
    while d[i] != 0x0D:
        fields.append((d[i:i + 11].split(b"\x00")[0].decode("latin1"), d[i + 16]))
        i += 32
    rows = []
    for r in range(nrec):
        off = hlen + r * rlen
        if off + rlen > len(d):
            break
        pos = off + 1
        row = {}
        for (name, flen) in fields:
            row[name] = d[pos:pos + flen].decode("latin1").strip()
            pos += flen
        rows.append(row)
    return rows


def _find(globals_dir, name):
    for nm in (name, name.upper(), name.lower()):
        p = os.path.join(globals_dir, nm)
        if os.path.exists(p):
            return p
    raise FileNotFoundError(name + " in " + globals_dir)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    globals_dir = os.path.join(args.game, "Globals")

    # GLmark: landmark footprints (cx, cy). Key uppercase to match lmarkId.toUpper().
    lm = {}
    for row in read_dbf(_find(globals_dir, "GLmark.dbf")):
        lid = row.get("LMARK_ID", "").strip().upper()
        if not lid:
            continue
        try:
            cx = int(row.get("CX", "1") or "1")
            cy = int(row.get("CY", "1") or "1")
        except ValueError:
            cx = cy = 1
        lm[lid] = [cx, cy]

    # Grace race index -> 2-letter FORT code, the EXACT editor chain for capitals
    # (ObjectAccessors.cpp FortObjectAccessor) and villages (shortRaceByPlayerId2):
    #   key = Grace[player.raceId].race_type.value->text   # race_type is IntLink<Lrace>!
    #   key = key.mid(2, 2)                                  # "L_HUMAN" -> "HU"
    # i.e. Grace.RACE_ID(num) -> Grace.RACE_TYPE(int) -> Lrace[that].TEXT -> strip L_ -> 2.
    # NOTE: race_type links to Lrace (HU/UN/HE/DW/NE/EL), NOT Lterrain (GO/HU/DW/HE/UN/NE/EL).
    def _id_num(s):
        digits = "".join(ch for ch in (s or "") if ch.isdigit())
        return int(digits) if digits else None

    lrace = {}
    for row in read_dbf(_find(globals_dir, "Lrace.dbf")):
        try:
            lid = int(row.get("ID", ""))
        except ValueError:
            continue
        lrace[lid] = row.get("TEXT", "").replace("L_", "").strip()[:2]

    grace_fort_codes = {}
    for row in read_dbf(_find(globals_dir, "Grace.dbf")):
        gidx = _id_num(row.get("RACE_ID", ""))
        try:
            rtype = int(row.get("RACE_TYPE", ""))
        except ValueError:
            continue
        if gidx is None or rtype not in lrace:
            continue
        grace_fort_codes[gidx] = lrace[rtype]

    data = {"landmarkFootprints": lm, "graceFortCodes": grace_fort_codes}
    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, "objectdata.json")
    json.dump(data, open(out_path, "w"), separators=(",", ":"))
    print("wrote", out_path, "- landmarks:", len(lm),
          "- graceFortCodes:", grace_fort_codes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
