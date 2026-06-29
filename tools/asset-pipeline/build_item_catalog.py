"""build_item_catalog: the reproducible builder for public/assets/itemCatalog.json.

Catalogs every item (GItem.DBF) for the editor's object inspector — the chest/city
item lists and the ruin artifact picker. Each entry carries:
  - id        <- ITEM_ID (10-char compound uid, UPPER; matches the .sg ITEM/ITEM_ID refs)
  - name      <- Tglobal[NAME_TXT]  (CP866 / DOS-Cyrillic — NOT CP1251)
  - desc      <- Tglobal[DESC_TXT]
  - cat       <- ITEM_CAT (D2 item category int)
  - catKey    <- LmagItm.dbf[cat] (authoritative enum name, e.g. L_ARMOR / L_WEAPON);
                 the RU label lives in the frontend picker so the catalog stays game-sourced data
  - gold      <- the 'g####' part of VALUE
  - image     <- IMAGE_ID (icon record name in Imgs/IconItem.ff; thumbnails are a later step)

Phase A: names + category + gold (stdlib only, no Pillow). Phase B will add icon thumbs
extracted from IconItem.ff.

    python tools/asset-pipeline/build_item_catalog.py \
        --game "C:/GOG Games/last_version/Game" --out public/assets

GOTCHA: Tglobal.dbf is CP866 (like the decoration names), NOT CP1251 like .sg strings.
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
            row[name] = d[pos:pos + flen]
            pos += flen
        rows.append(row)
    return rows


def _find(globals_dir, name):
    for nm in (name, name.upper(), name.lower()):
        p = os.path.join(globals_dir, nm)
        if os.path.exists(p):
            return p
    raise FileNotFoundError(name + " in " + globals_dir)


def ascii_(b):
    return b.decode("latin1").split("\x00")[0].strip()


def cp866_(b):
    return b.decode("cp866").rstrip("\x00").strip()


def parse_gold(value_bytes):
    # VALUE = "g0400:r0000:y0000:e0000:w0000" -> gold = 400
    s = ascii_(value_bytes).lower()
    for part in s.split(":"):
        if part.startswith("g"):
            try:
                return int(part[1:])
            except ValueError:
                return 0
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", default="public/assets")
    args = ap.parse_args()

    globals_dir = os.path.join(args.game, "Globals")
    gitem = read_dbf(_find(globals_dir, "GItem.DBF"))
    tglobal = read_dbf(_find(globals_dir, "Tglobal.dbf"))
    lmagitm = read_dbf(_find(globals_dir, "LmagItm.dbf"))

    texts = {}
    for row in tglobal:
        key = ascii_(row["TXT_ID"]).lower()
        if key:
            texts[key] = cp866_(row["TEXT"])

    # LmagItm.dbf is the authoritative ITEM_CAT -> enum-name table (L_ARMOR/L_WEAPON/...).
    # id 11 has two rows (L_COIN, L_ORB); the cat-11 items are mana orbs, so prefer L_ORB.
    cat_keys = {}
    for row in lmagitm:
        try:
            cid = int(ascii_(row["ID"]))
        except ValueError:
            continue
        key = ascii_(row["TEXT"])
        if cid not in cat_keys or key == "L_ORB":
            cat_keys[cid] = key

    out = []
    for row in gitem:
        iid = ascii_(row["ITEM_ID"]).upper()
        if not iid or iid == "G000000000":
            continue
        name_key = ascii_(row["NAME_TXT"]).lower()
        desc_key = ascii_(row["DESC_TXT"]).lower()
        try:
            cat = int(ascii_(row["ITEM_CAT"]) or "0")
        except ValueError:
            cat = 0
        entry = {
            "id": iid,
            "name": texts.get(name_key, ""),
            "cat": cat,
            "catKey": cat_keys.get(cat, ""),
            "gold": parse_gold(row["VALUE"]),
            "image": ascii_(row["IMAGE_ID"]),
        }
        desc = texts.get(desc_key, "")
        if desc:
            entry["desc"] = desc
        out.append(entry)

    out.sort(key=lambda e: (e["cat"], e["name"], e["id"]))
    os.makedirs(args.out, exist_ok=True)
    dest = os.path.join(args.out, "itemCatalog.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    cats = sorted({e["cat"] for e in out})
    print("wrote %d items -> %s (categories: %s)" % (len(out), dest, cats))


if __name__ == "__main__":
    main()
