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
        --game "<D2_GAME_DIR>/Game" --out public/assets

GOTCHA: Tglobal.dbf is CP866 (like the decoration names), NOT CP1251 like .sg strings.
"""
import argparse
import json
import os
import re
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
        # DBF record marker: 0x20 (space) = active, 0x2A ('*') = deleted. GItem.DBF carries
        # 22 deleted records — stale ghost duplicates of live items (same ITEM_ID, usually with
        # an empty DESC_TXT) plus a few removed-from-game rows. Skipping them keeps the catalog
        # to live game items only and drops the desc-less ghosts (e.g. the summon scrolls).
        if d[off] == 0x2A:
            continue
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


# GmodifL.TYPE (= LmodifE enum) -> (bonusKind, RU label, value mode).
#   value mode: True = use PERCENT ("+N%"), False = use NUMBER ("+N"), "auto" = NUMBER else
#   PERCENT, None = flag/special (label only). RU labels are from the in-game UI (no Tglobal
#   tokens for the enum); per-modifier prose lives in Gmodif.DESC_TXT.
SOURCE_MAP = {
    1: ("scout", "обзор", False),
    2: ("leadership", "лидерство", False),
    3: ("attack", "точность", True),
    4: ("attack", "урон", True),
    5: ("armor", "броня", False),
    6: ("hp", "здоровье", "auto"),
    7: ("move", "ход", True),
    8: ("morale", "мораль", False),
    9: ("initiative", "инициатива", True),
    10: ("move", "передвижение", None),
    11: ("ability", "способность лидера", None),
    12: ("immunity", "иммунитет", None),
    13: ("regen", "регенерация", True),
    14: ("immunity", "иммунитет", None),
    15: ("drain", "вытягивание жизни", True),
    16: ("retreat", "отступление", None),
    17: ("cost", "стоимость", True),
}
NULL_REF = "G000000000"
SUMMON_CATS = {"L_TALISMAN", "L_ORB", "L_SPECIAL"}


def _int(b):
    try:
        return int(ascii_(b) or "0")
    except ValueError:
        return 0


def clean_desc(texts, token):
    """Resolve a Tglobal token, stripping the leading rich-text prefix (e.g. '\\fNormal;')."""
    t = texts.get(token.lower(), "")
    return re.sub(r"^\\f\w+;", "", t).strip() if t else ""


def resolve_modif(modif_id, gmodif, gmodifL, texts):
    """A Gmodif id -> (bonusKind set, [human effect parts]). Structured (GmodifL) modifiers
    yield stat+magnitude; .lua-scripted ones fall back to the modifier's DESC_TXT prose."""
    mid = modif_id.lower()
    kinds, parts = set(), []
    details = gmodifL.get(mid, [])
    for d in details:
        sm = SOURCE_MAP.get(_int(d["TYPE"]))
        if not sm:
            continue
        kind, ru, use_pct = sm
        kinds.add(kind)
        pct, num = _int(d["PERCENT"]), _int(d["NUMBER"])
        if use_pct is None:
            parts.append(ru)
        elif use_pct == "auto":
            parts.append("+%d к %s" % (num, ru) if num else ("+%d%% к %s" % (pct, ru) if pct else ru))
        elif use_pct:
            v = pct or num
            parts.append("+%d%% к %s" % (v, ru) if v else ru)
        else:
            v = num or pct
            parts.append("+%d к %s" % (v, ru) if v else ru)
    if not parts:  # scripted modifier or no structured detail -> prose fallback
        m = gmodif.get(mid)
        if m:
            cd = clean_desc(texts, ascii_(m["DESC_TXT"]))
            if cd:
                parts.append(cd)
    return kinds, parts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", default="public/assets")
    args = ap.parse_args()

    globals_dir = os.path.join(args.game, "Globals")
    gitem = read_dbf(_find(globals_dir, "GItem.DBF"))
    tglobal = read_dbf(_find(globals_dir, "Tglobal.dbf"))
    lmagitm = read_dbf(_find(globals_dir, "LmagItm.dbf"))

    # effect-resolution tables (bonus tags + "what it does" string)
    gmodif = {ascii_(r["MODIF_ID"]).lower(): r for r in read_dbf(_find(globals_dir, "Gmodif.dbf"))}
    gmodifL = {}
    for r in read_dbf(_find(globals_dir, "GmodifL.dbf")):
        gmodifL.setdefault(ascii_(r["BELONGS_TO"]).lower(), []).append(r)
    gspells = {ascii_(r["SPELL_ID"]).lower(): r for r in read_dbf(_find(globals_dir, "Gspells.dbf"))}
    gunits = {ascii_(r["UNIT_ID"]).lower(): r for r in read_dbf(_find(globals_dir, "Gunits.dbf"))}

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
        catKey = cat_keys.get(cat, "")
        entry = {
            "id": iid,
            "name": texts.get(name_key, ""),
            "cat": cat,
            "catKey": catKey,
            "gold": parse_gold(row["VALUE"]),
            "image": ascii_(row["IMAGE_ID"]),
        }

        # --- bonus tags + "what it does" string (from the GItem effect fields) ---
        kinds, parts = set(), []
        for fld in ("MOD_EQUIP", "MOD_POTION"):
            ref = ascii_(row[fld])
            if ref and ref.upper() != NULL_REF:
                k, p = resolve_modif(ref, gmodif, gmodifL, texts)
                kinds |= k
                parts += p
        hp = _int(row["HP_POTION"])
        if hp > 0:
            kinds.add("heal")
            parts.append("Лечит %d ОЗ" % hp)
        spell = ascii_(row["SPELL_ID"])
        if spell and spell.upper() != NULL_REF:
            gs = gspells.get(spell.lower())
            if gs:
                nm = texts.get(ascii_(gs["NAME_TXT"]).lower(), "")
                kinds.add("spell")
                parts.append("Сотворяет: %s" % nm if nm else "заклинание")
        unit = ascii_(row["UNIT_ID"])
        if unit and unit.upper() != NULL_REF and catKey in SUMMON_CATS:
            gu = gunits.get(unit.lower())
            if gu:
                nm = texts.get(ascii_(gu["NAME_TXT"]).lower(), "")
                kinds.add("summon")
                parts.append("Призывает: %s" % nm if nm else "призыв")
        if kinds:
            entry["bonus"] = sorted(kinds)
        effect = "; ".join(dict.fromkeys(parts))  # dedup, keep order
        if effect:
            entry["effect"] = effect

        # desc: prefer Tglobal[DESC_TXT]; fall back to the spell desc, then the derived effect
        desc = texts.get(desc_key, "")
        if not desc and gspells.get(spell.lower()):
            desc = texts.get(ascii_(gspells[spell.lower()]["DESC_TXT"]).lower(), "")
        if not desc and effect:
            desc = effect
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
