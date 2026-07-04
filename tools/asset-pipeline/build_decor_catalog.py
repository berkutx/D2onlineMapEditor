"""build_decor_catalog: the reproducible builder for public/assets/decorCatalog.json.

The decoration catalog classifies every placeable landmark (GLmark.dbf) + terrain
mountain (MOMNE* in IsoTerrn) for the editor's decoration palette and the future
copilot agent. Each entry carries:
  - shape + D2-faction `style` + english name  <- the decoded RU landmark name
  - tone/biome  <- the name when explicit (lava/ice/swamp), else the sprite's colours
  - slope       <- sprite geometry (h/w);  size <- footprint
  - iso.orient  <- PCA on the opaque mass (walls/fences/gates: which diagonal it runs)
  - thumb       <- {page,x,y,w,h} so the web palette CSS-crops from the atlas pages

Run AFTER pipeline.py (atlases) — it reads the atlas pages + page jsons under --out.

    python tools/asset-pipeline/build_decor_catalog.py \
        --game "<D2_GAME_DIR>/Game" --out public/assets

GOTCHA: Tglobal.dbf (the name text table) is CP866 (DOS Cyrillic), NOT CP1251 like the
.sg strings. Decoding it as CP1251 yields mojibake.
"""
import argparse
import glob
import json
import os
import struct

import numpy as np
from PIL import Image


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
        # DBF record marker: 0x20 (space) = active, 0x2A ('*') = deleted. GLmark.dbf carries
        # 6 deleted ghost records (e.g. G000MG8014, whose stale empty-NAME_TXT copy comes after
        # its live twin and would otherwise win the last-wins `cat` dict -> a nameless landmark).
        # Skipping deleted rows keeps the catalog to live game landmarks.
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


# RU landmark name -> (shape, style, tone_or_None, english). tone None => from colour.
NAME_MAP = {
    "Поселение": ("ruin-building", "neutral", None, "Settlement"),
    "Поселение Кланов": ("ruin-building", "clans", None, "Clans settlement"),
    "Поселение Империи": ("ruin-building", "empire", None, "Empire settlement"),
    "Поселение Нежити": ("ruin-building", "undead", None, "Undead settlement"),
    "Поселение Полчищ": ("ruin-building", "legions", None, "Legions settlement"),
    "Нейтральное поселение": ("ruin-building", "neutral", None, "Neutral settlement"),
    "Брошенное поселение": ("ruin-building", "neutral", None, "Abandoned settlement"),
    "Запустевший город": ("ruin-building", "neutral", None, "Desolate city"),
    "Укрепленный город": ("ruin-building", "neutral", None, "Fortified city"),
    "Город в огне": ("ruin-building", "neutral", "volcanic", "Burning city"),
    "Город эльфов": ("ruin-building", "elves", None, "Elven city"),
    "Дом": ("ruin-building", "neutral", None, "House"),
    "Дом Эльфов": ("ruin-building", "elves", None, "Elf house"),
    "Дом Темных Эльфов": ("ruin-building", "elves", None, "Dark Elf house"),
    "Замок Духов": ("ruin-building", "undead", None, "Spirit castle"),
    "Форт": ("ruin-building", "neutral", None, "Fort"),
    "Барак": ("ruin-building", "neutral", None, "Barracks"),
    "Склад": ("ruin-building", "neutral", None, "Warehouse"),
    "Брошенная шахта": ("ruin-building", "neutral", None, "Abandoned mine"),
    "Руины Ликоса": ("ruin-building", "neutral", None, "Ruins of Lycos"),
    "Темница Хугина": ("ruin-building", "undead", None, "Dungeon of Hugin"),
    "Мортуарий": ("ruin-building", "undead", None, "Mortuary"),
    "Гробница": ("ruin-building", "undead", None, "Tomb"),
    "Святилище": ("ruin-building", "arcane", None, "Sanctuary"),
    "Провал": ("crater", "neutral", "dark", "Chasm"),
    "Провал с водопадом": ("waterfall", "neutral", "temperate", "Chasm with waterfall"),
    "Провал с колонной": ("crater", "arcane", "dark", "Chasm with a column"),
    "Провал с гробницей": ("crater", "undead", "dark", "Chasm with a tomb"),
    "Плато": ("ground-patch", "neutral", None, "Plateau"),
    "Мертвая равнина": ("ground-patch", "undead", "dark", "Dead plain"),
    "Скала": ("rock", "neutral", None, "Rock"),
    "Гора": ("mountain", "clans", None, "Mountain"),
    "Вулкан": ("mountain", "legions", "volcanic", "Volcano"),
    "Водопад": ("waterfall", "neutral", "temperate", "Waterfall"),
    "Топь": ("swamp", "neutral", "swamp", "Mire"),
    "Грядка": ("vegetation", "neutral", "temperate", "Plant bed"),
    "Риф": ("water-feature", "neutral", None, "Reef"),
    "Водоросль": ("vegetation", "neutral", None, "Seaweed"),
    "Водоворот": ("water-feature", "neutral", None, "Whirlpool"),
    "Разлом": ("crater", "neutral", None, "Rift"),
    "Разлом с лавой": ("lava-flow", "legions", "volcanic", "Lava rift"),
    "Лед": ("ice", "neutral", "ice", "Ice"),
    "Яма": ("crater", "neutral", None, "Pit"),
    "Маяк": ("tower", "neutral", None, "Lighthouse"),
    "Обломки корабля": ("debris", "neutral", None, "Shipwreck"),
    "Обелиск": ("obelisk", "arcane", None, "Obelisk"),
    "Колонна": ("standing-stone", "arcane", None, "Column"),
    "Рунный монолит": ("standing-stone", "arcane", "magic", "Rune monolith"),
    "Рунная печать": ("magic-node", "arcane", "magic", "Rune seal"),
    "Каменная чаша": ("well", "arcane", None, "Stone bowl"),
    "Крест": ("grave", "neutral", None, "Cross"),
    "Статуя Империи": ("statue", "empire", None, "Empire statue"),
    "Статуя Кланов": ("statue", "clans", None, "Clans statue"),
    "Ст. Кланов": ("statue", "clans", None, "Clans statue"),
    "Ст. Кланов Разр.": ("statue", "clans", None, "Clans statue (ruined)"),
    "Ст. Империи": ("statue", "empire", None, "Empire statue"),
    "Ст. Империи Разр.": ("statue", "empire", None, "Empire statue (ruined)"),
    "Ст. Нежити": ("statue", "undead", None, "Undead statue"),
    "Ст. Нежити Разр.": ("statue", "undead", None, "Undead statue (ruined)"),
    "Ст. Эльфов": ("statue", "elves", None, "Elven statue"),
    "Ст. Эльфов Разр.": ("statue", "elves", None, "Elven statue (ruined)"),
    "Ст. Легионов": ("statue", "legions", None, "Legions statue"),
    "Ст. Легионов Разр.": ("statue", "legions", None, "Legions statue (ruined)"),
    "Идол Бетрезена": ("totem", "legions", None, "Idol of Bethrezen"),
    "Капище Агшлизга": ("totem", "neutral", None, "Shrine of Ashlizg"),
    "Змеиный алтарь": ("totem", "neutral", None, "Serpent altar"),
    "Алтарь": ("statue", "arcane", None, "Altar"),
    "Алтарь Талдера": ("statue", "arcane", None, "Altar of Talder"),
    "Алтарь Дорагона": ("statue", "arcane", None, "Altar of Doragon"),
    "Скелет": ("bones", "undead", None, "Skeleton"),
    "Скелет на колу": ("bones", "undead", None, "Skeleton on a stake"),
    "Кентавр-скелет": ("bones", "undead", None, "Centaur skeleton"),
    "Груда черепов": ("bones", "undead", None, "Pile of skulls"),
    "Мертвец": ("bones", "undead", None, "Corpse"),
    "Гроб": ("grave", "undead", None, "Coffin"),
    "Кладбище": ("grave", "undead", None, "Cemetery"),
    "Могила": ("grave", "undead", None, "Grave"),
    "Колодец": ("well", "neutral", None, "Well"),
    "Высохший колодец": ("well", "neutral", None, "Dry well"),
    "Фонтан": ("well", "neutral", None, "Fountain"),
    "Замерзший фонтан": ("well", "neutral", "ice", "Frozen fountain"),
    "Кровавый фонтан": ("well", "undead", None, "Blood fountain"),
    "Кровавая чаша": ("well", "undead", None, "Blood bowl"),
    "Большой магический колодец": ("well", "arcane", "magic", "Great magic well"),
    "Магический колодец": ("well", "arcane", "magic", "Magic well"),
    "Зачарованный сундук": ("misc", "arcane", "magic", "Enchanted chest"),
    "Стена": ("wall", "neutral", None, "Wall"),
    "Частокол": ("fence", "neutral", None, "Palisade"),
    "Ворота": ("gate", "neutral", None, "Gate"),
    "Ворота (левая половина)": ("gate", "neutral", None, "Gate (left half)"),
    "Ворота (правая половина)": ("gate", "neutral", None, "Gate (right half)"),
    "Врата Скверны": ("gate", "legions", None, "Gates of Corruption"),
    "Древо жизни": ("tree", "elves", "forest", "Tree of Life"),
    "Засохшее древо жизни": ("dead-tree", "elves", None, "Withered Tree of Life"),
    "Священная роща": ("tree", "elves", "forest", "Sacred grove"),
    "Башня": ("tower", "neutral", None, "Tower"),
    "Башенка": ("tower", "neutral", None, "Small tower"),
    "Вышка": ("tower", "neutral", None, "Watchtower"),
    "Башня великанов": ("tower", "neutral", None, "Giants' tower"),
    "Костер": ("camp", "neutral", None, "Campfire"),
    "Повозка": ("debris", "neutral", None, "Cart"),
    "Дорожный указатель": ("misc", "neutral", None, "Signpost"),
    "Знамя": ("misc", "neutral", None, "Banner"),
    "Фонарь": ("misc", "neutral", None, "Lantern"),
    "Паучье гнездо": ("misc", "neutral", None, "Spider nest"),
    "Паучья кладка": ("misc", "neutral", None, "Spider clutch"),
}

# tones the colour pass is allowed to OVERRIDE a generic name with.
_COLOUR_TONES = ("snow", "volcanic", "ice", "dark", "earth")
_STRUCTURAL = ("ruin-building", "statue", "wall", "fence", "gate", "grave", "bones", "tower")
MNT_RU = {"snow": "Заснеженная гора", "ice": "Ледяная гора", "grey": "Скалистая гора",
          "dark": "Тёмная гора", "volcanic": "Вулкан", "earth": "Скалистая гора", "neutral": "Гора"}
MNT_EN = {"snow": "Snow-capped mountain", "ice": "Icy mountain", "grey": "Grey rocky mountain",
          "dark": "Dark mountain", "volcanic": "Volcano", "earth": "Rocky mountain", "neutral": "Mountain"}


def tone_from_color(s):
    if s["snow"] > 0.30:
        return "snow"
    if s["red"] > 0.12 and s["val"] > 0.30:
        return "volcanic"
    if s["blue"] > 0.06 and s["val"] > 0.45:
        return "ice"
    if s["val"] < 0.22:
        return "dark"
    if s["red"] > 0.04 and s["sat"] > 0.25:
        return "earth"
    return "neutral"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build public/assets/decorCatalog.json")
    ap.add_argument("--game", required=True, help="path to the Game directory")
    ap.add_argument("--out", required=True, help="assets dir with the built atlases (public/assets)")
    args = ap.parse_args(argv)
    globals_dir = os.path.join(args.game, "Globals")
    A = os.path.abspath(args.out)

    # names: Tglobal TXT_ID -> TEXT (CP866!)
    names = {}
    for r in read_dbf(_find(globals_dir, "Tglobal.dbf")):
        names[r["TXT_ID"].decode("latin1").strip().lower()] = r["TEXT"].decode("cp866", "replace").strip()

    # frame key -> {page,x,y,w,h} across the decoration atlases (first occurrence wins)
    floc = {}
    page_cache = {}
    for grp in ("iso-still", "iso-cmon", "iso-anim", "iso-terrn"):
        for jp in sorted(glob.glob(os.path.join(A, grp + "-*.json"))):
            j = json.load(open(jp))
            page = os.path.basename(j["meta"]["image"])
            for k, v in j["frames"].items():
                if k not in floc:
                    f = v["frame"]
                    floc[k] = {"page": page, "x": f["x"], "y": f["y"], "w": f["w"], "h": f["h"]}

    def page_img(page):
        if page not in page_cache:
            page_cache[page] = np.asarray(Image.open(os.path.join(A, page)).convert("RGBA"))
        return page_cache[page]

    def stats(key):
        t = floc[key]
        a = page_img(t["page"])[t["y"]:t["y"] + t["h"], t["x"]:t["x"] + t["w"]].astype(np.float32)
        rgb, al = a[..., :3], a[..., 3]
        m = al > 40
        if int(m.sum()) < 20:
            return None
        px = rgb[m] / 255.0
        mx, mn = px.max(1), px.min(1)
        val = float(mx.mean())
        sat = float(((mx - mn) / (mx + 1e-6)).mean())
        blue = float((px[:, 2] - px[:, 0]).mean())
        red = float((px[:, 0] - px[:, 1]).mean())
        return {"val": val, "sat": sat, "blue": blue, "red": red,
                "snow": val - sat * 1.2 + blue * 0.5, "w": t["w"], "h": t["h"]}

    def wall_orient(key):
        t = floc[key]
        a = page_img(t["page"])[t["y"]:t["y"] + t["h"], t["x"]:t["x"] + t["w"]]
        ys, xs = np.nonzero(a[..., 3] > 40)
        if len(xs) < 30 or xs.std() < 1 or ys.std() < 1:
            return "none"
        r = float(np.corrcoef(xs, ys)[0, 1])
        return "corner" if abs(r) < 0.25 else ("NW-SE" if r > 0 else "NE-SW")

    # landmark rows from GLmark
    landmarks = []
    for r in read_dbf(_find(globals_dir, "GLmark.dbf")):
        lid = r["LMARK_ID"].decode("latin1").strip().upper()
        if not lid:
            continue
        try:
            cx = int(r["CX"].decode("latin1").strip() or "1")
            cy = int(r["CY"].decode("latin1").strip() or "1")
        except ValueError:
            cx = cy = 1
        landmarks.append({
            "id": lid,
            "name_ru": names.get(r["NAME_TXT"].decode("latin1").strip().lower(), ""),
            "cx": cx, "cy": cy,
            "isMountain": r["MOUNTAIN"].decode("latin1").strip().upper() == "T",
        })

    cat = {}

    def emit(rec):
        cat[rec["id"]] = rec

    for b in landmarks:
        if b["id"] not in floc:
            continue
        s = stats(b["id"])
        if not s:
            continue
        ctone = tone_from_color(s)
        hw = s["h"] / s["w"]
        slope = "tall" if hw > 0.7 else ("flat" if hw < 0.52 else "low")
        size = ("landmark" if b["cx"] >= 4 else "feature" if b["cx"] == 3
                else "small" if b["cx"] == 2 else "clutter")
        meta = NAME_MAP.get(b["name_ru"])
        if meta:
            shape, style, t, en = meta
            tone = t if t else (ctone if ctone in _COLOUR_TONES else "neutral")
            conf = "high" if (t or shape in _STRUCTURAL) else "med"
            desc_en, desc_ru = en, b["name_ru"]
        else:
            shape, style, tone = "misc", "neutral", ctone
            conf = "low"
            desc_en, desc_ru = (b["name_ru"] or "object"), (b["name_ru"] or "объект")
        orient = wall_orient(b["id"]) if shape in ("wall", "fence", "gate") else "none"
        tags = sorted(set([shape, style] + ([tone] if tone != "neutral" else [])))
        emit({"id": b["id"], "name_ru": b["name_ru"], "cx": b["cx"], "cy": b["cy"],
              "isMountain": b["isMountain"], "shape": shape, "tone": tone, "style": style,
              "size": size, "iso": {"orient": orient, "slope": slope}, "conf": conf,
              "desc_en": desc_en, "desc_ru": desc_ru, "tags": tags, "thumb": floc[b["id"]]})

    # MOMNE terrain mountains
    for k in sorted(floc):
        if not k.startswith("MOMNE"):
            continue
        s = stats(k)
        if not s:
            continue
        tone = tone_from_color(s)
        hw = s["h"] / s["w"]
        slope = "tall" if hw > 0.7 else ("flat" if hw < 0.52 else "low")
        style = "legions" if tone == "volcanic" else "clans"
        emit({"id": k, "name_ru": "", "cx": 0, "cy": 0, "isMountain": True,
              "shape": "mountain", "tone": tone, "style": style, "size": "clutter",
              "iso": {"orient": "none", "slope": slope}, "conf": "med",
              "desc_en": MNT_EN.get(tone, "Mountain"), "desc_ru": MNT_RU.get(tone, "Гора"),
              "tags": sorted(set(["mountain", tone])), "thumb": floc[k]})

    out_path = os.path.join(A, "decorCatalog.json")
    json.dump(cat, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    from collections import Counter
    print("wrote", out_path, "-", len(cat), "decorations")
    print("  by shape:", dict(Counter(r["shape"] for r in cat.values()).most_common()))
    print("  by conf :", dict(Counter(r["conf"] for r in cat.values())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
