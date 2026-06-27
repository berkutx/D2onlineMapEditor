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


def _id_num(s):
    digits = "".join(ch for ch in (s or "") if ch.isdigit())
    return int(digits) if digits else None


def _int_or_none(s):
    s = (s or "").strip()
    return int(s) if s.lstrip("-").isdigit() else None


def _unit_boat(globals_dir, server):
    """leader impl (UPPER) -> boat race (Lrace key), for boat-eligible leaders only.

    The editor draws a boat for a stack on water UNLESS the leader is water_only or
    flying (mobilAbil has plains(0) AND forest(1) AND water(3)). Boat race =
    Gunit.race_id -> Grace.race_type.key (ObjectAccessors.cpp StackObjectAccessor).
    Scoped to the leader impls the map actually uses (fetched from the map server).
    """
    import json as _json
    import urllib.request
    try:
        scen = _json.load(urllib.request.urlopen(server + "/api/scenarios"))
        riders = next((s for s in scen if "Rider" in s.get("name", "")), scen[0])
        doc = _json.load(urllib.request.urlopen(server + "/api/maps/" + riders["id"]))
    except Exception as e:  # noqa: BLE001
        import sys
        sys.stderr.write("  unitBoat: map fetch failed (%s); skipping boats\n" % e)
        return {}

    units = {r["UNIT_ID"].lower(): r for r in read_dbf(_find(globals_dir, "Gunits.dbf"))}
    grace_rt = {r["RACE_ID"].lower(): _int_or_none(r.get("RACE_TYPE"))
                for r in read_dbf(_find(globals_dir, "Grace.dbf"))}
    mabi = {}
    for r in read_dbf(_find(globals_dir, "GMabi.dbf")):
        a = _int_or_none(r.get("M_ABILITY"))
        if a is not None:
            mabi.setdefault(r["UNIT_ID"].lower(), set()).add(a)

    impls = {o["leaderImage"] for o in doc.get("objects", [])
             if o.get("type") == "stack" and o.get("leaderImage")}
    boat = {}
    for impl in impls:
        u = units.get(impl.lower())
        if not u:
            continue
        race = grace_rt.get((u.get("RACE_ID") or "").lower())
        if race is None:
            continue
        water_only = (u.get("WATER_ONLY") or "").strip().upper() == "T"
        ab = mabi.get(impl.lower(), set())
        flying = (0 in ab) and (1 in ab) and (3 in ab)
        if water_only or flying:
            continue  # swims / flies -> no boat, shows its STOP sprite
        boat[impl.upper()] = race
    return boat


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--server", default="http://localhost:3000",
                    help="map server, for the leader boat-eligibility table")
    args = ap.parse_args(argv)
    globals_dir = os.path.join(args.game, "Globals")

    # GLmark: landmark footprints (cx, cy). Key uppercase to match lmarkId.toUpper().
    # MOUNTAIN flag (GLmark.mountain) feeds the editor's terraforming overlay (mountain
    # landmarks count as non-terraformable, GridView::reloadMaps).
    lm = {}
    lm_mountain = []
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
        if (row.get("MOUNTAIN", "") or "").strip().upper() == "T":
            lm_mountain.append(lid)

    # Grace race index -> 2-letter FORT code, the EXACT editor chain for capitals
    # (ObjectAccessors.cpp FortObjectAccessor) and villages (shortRaceByPlayerId2):
    #   key = Grace[player.raceId].race_type.value->text   # race_type is IntLink<Lrace>!
    #   key = key.mid(2, 2)                                  # "L_HUMAN" -> "HU"
    # i.e. Grace.RACE_ID(num) -> Grace.RACE_TYPE(int) -> Lrace[that].TEXT -> strip L_ -> 2.
    # NOTE: race_type links to Lrace (HU/UN/HE/DW/NE/EL), NOT Lterrain (GO/HU/DW/HE/UN/NE/EL).
    lrace = {}
    for row in read_dbf(_find(globals_dir, "Lrace.dbf")):
        try:
            lid = int(row.get("ID", ""))
        except ValueError:
            continue
        lrace[lid] = row.get("TEXT", "").replace("L_", "").strip()[:2]

    grace_race_type = {}  # Grace idx -> RACE_TYPE (Lrace key); used by the rod sprite
    grace_fort_codes = {}  # Grace idx -> 2-char fort code
    for row in read_dbf(_find(globals_dir, "Grace.dbf")):
        gidx = _id_num(row.get("RACE_ID", ""))
        rtype = _int_or_none(row.get("RACE_TYPE"))
        if gidx is None or rtype is None:
            continue
        grace_race_type[gidx] = rtype
        if rtype in lrace:
            grace_fort_codes[gidx] = lrace[rtype]

    unit_boat = _unit_boat(globals_dir, args.server)

    # GVars.GU_RANGE: the single global guard range -> guard overlay radius
    # (gu_range-1)/2 (GridView::reloadMaps). One row in GVars.dbf.
    guard_range = None
    gv = read_dbf(_find(globals_dir, "GVars.dbf"))
    if gv:
        guard_range = _int_or_none(gv[0].get("GU_RANGE"))

    data = {
        "landmarkFootprints": lm,
        "landmarkMountain": lm_mountain,
        "graceFortCodes": grace_fort_codes,
        "graceRaceType": grace_race_type,
        "unitBoat": unit_boat,
        "guardRange": guard_range,
    }
    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, "objectdata.json")
    json.dump(data, open(out_path, "w"), separators=(",", ":"))
    print("wrote", out_path, "- landmarks:", len(lm),
          "- graceFortCodes:", grace_fort_codes,
          "- unitBoat:", len(unit_boat))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
