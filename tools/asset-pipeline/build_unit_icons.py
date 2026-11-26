"""build_unit_icons: a face for every unit, from Imgs/Faces.ff.

Faces.ff has no index: its records are the pictures, named UNIT_ID + a suffix.
  <id>FACE   the small portrait (70x85; 150x85 for nearly every big unit),
  <id>FACEB  the big round one (130x142),
  <id>FACES  a third record a few dozen units carry.
The icon is the small portrait, FACE, and the others stand in where a unit lacks it.

(An older version of this file held that FACE records were "shifted by one unit" and took
FACEB instead. The shift was in the reading of the archive's name table — see fflib/optindex.py
— and what it called FACEB was this very FACE record.)

Only about half the units ship a face of their OWN; the rest are upgrades/variants that reuse a
base unit's portrait. Gunits.BASE_UNIT chains every such unit to a base that has one, so a
faceless unit gets its base's portrait under its own id.

Writes public/assets/uniticons/<id>.png (lowercased) so the unit picker can render <img>.

    python tools/asset-pipeline/build_unit_icons.py --game "<D2_GAME_DIR>/Game" --out public/assets

Needs the 3.7 interpreter (Pillow + numpy). Run AFTER build_unit_catalog.py.
"""
import argparse
import json
import os

from fflib import pictures
from fflib.dbf import read_dbf, find_table, ascii_

NULL_ID = "G000000000"
FACE_SUFFIXES = ("FACE", "FACEB", "FACES")
#: How far a BASE_UNIT chain is followed before giving up (a guard against a loop in the table).
MAX_CHAIN = 6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", default="public/assets")
    ap.add_argument("--catalog", default=None)
    args = ap.parse_args()

    catalog = args.catalog or os.path.join(args.out, "unitCatalog.json")
    with open(catalog, encoding="utf-8") as f:
        wanted = sorted({e["id"].upper() for e in json.load(f) if e.get("id")})

    # BASE_UNIT chain (variant/upgrade -> base unit) so faceless units can reuse a base portrait.
    base_of = {}
    for r in read_dbf(find_table(os.path.join(args.game, "Globals"), "Gunits.dbf")):
        uid = ascii_(r["UNIT_ID"]).upper()
        if uid and uid != NULL_ID:
            base_of[uid] = ascii_(r["BASE_UNIT"]).upper()

    archive = pictures.open_archive(args.game, "Faces.ff")
    faces = {}

    def face(uid):
        if uid not in faces:
            faces[uid] = archive.first([uid + s for s in FACE_SUFFIXES])[1]
        return faces[uid]

    def resolve(uid):
        """(portrait, came from a base unit) — the unit's own face, else its BASE_UNIT chain's."""
        cur = uid
        for depth in range(MAX_CHAIN + 1):
            rgba = face(cur)
            if rgba is not None:
                return rgba, depth > 0
            cur = base_of.get(cur, NULL_ID)
            if not cur or cur == NULL_ID:
                break
        return None, False

    outdir = os.path.join(args.out, "uniticons")
    os.makedirs(outdir, exist_ok=True)
    seen = via_base = 0
    for uid in wanted:
        rgba, borrowed = resolve(uid)
        if rgba is None:
            continue
        pictures.save(rgba, os.path.join(outdir, uid.lower() + ".png"))
        seen += 1
        via_base += borrowed
    print("wrote %d unit icons -> %s (%d wanted, %d via BASE_UNIT, %d without portrait)" % (
        seen, outdir, len(wanted), via_base, len(wanted) - seen))


if __name__ == "__main__":
    main()
