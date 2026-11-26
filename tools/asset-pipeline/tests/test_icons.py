"""Tests for the icon builders: the archive's name table, a picture read by name through the
index, the scroll rule, and the item / unit builders end to end. Everything runs on small
synthetic archives and tables written to a temp dir — no game install needed.

    python -m unittest discover -s tests        (from tools/asset-pipeline)
"""
import io
import json
import os
import struct
import sys
import unittest
from unittest import mock

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)
sys.path.insert(0, HERE)

import build_item_icons  # noqa: E402
import build_lord_icons  # noqa: E402
import build_spell_icons  # noqa: E402
import build_unit_icons  # noqa: E402
import extract_ff  # noqa: E402
from fflib import pictures  # noqa: E402
from test_mod_build import TempDirCase, make_dbf  # noqa: E402

MAGENTA = (255, 0, 255)
RED, GREEN, BLUE, WHITE = (200, 30, 30), (30, 200, 30), (30, 30, 200), (240, 240, 240)


def png(rows):
    """PNG bytes of a true-colour image given as rows of (r, g, b)."""
    im = Image.fromarray(np.array(rows, dtype=np.uint8), "RGB")
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def solid(color, w=2, h=2):
    return png([[color] * w for _ in range(h)])


def _record(rid, payload):
    return b"MQRC" + struct.pack("<6i", 0, rid, len(payload), len(payload), 0, 0) + payload


def make_ff(path, records, index=None):
    """Write an MQDB archive.

    records: [(file name, png bytes)] — the image records, in archive order.
    index:   [(picture name, file name of its record, (w, h), [(sx, sy, tx, ty, pw, ph), ...])]
             or None for an archive without an index.
    """
    ids = {name: 10 + n for n, (name, _png) in enumerate(records)}
    named = []  # (name, record id) in table order
    blobs = []
    if index is not None:
        images = b""
        table = struct.pack("<i", len(index))
        for (pic, rec, (w, h), parts) in index:
            block = b"\x00" * (11 + 1024) + struct.pack("<i", 1) + pic.encode("latin1") + b"\x00"
            block += struct.pack("<3i", len(parts), w, h)
            for part in parts:
                block += struct.pack("<6i", *part)
            table += struct.pack("<i", ids[rec]) + pic.encode("latin1") + b"\x00"
            table += struct.pack("<2i", len(images), len(block))
            images += block
        named += [("-INDEX.OPT", 3), ("-IMAGES.OPT", 4)]
        blobs += [_record(3, table), _record(4, images)]
    for (name, data) in records:
        named.append((name, ids[name]))
        blobs.append(_record(ids[name], data))
    names = struct.pack("<i", len(named))
    for (name, rid) in named:
        names += name.encode("latin1").ljust(256, b"\x00") + struct.pack("<i", rid)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fp:
        fp.write(b"MQDB" + b"\x00" * 24 + _record(2, names) + b"".join(blobs))


def whole(w, h):
    """The parts of a picture that is its record as it lies."""
    return [(0, 0, 0, 0, w, h)]


def rgb_of(rgba):
    return [[tuple(int(v) for v in px[:3]) if px[3] else None for px in row] for row in rgba]


def run(module, *argv):
    with mock.patch.object(sys, "argv", [module.__name__ + ".py"] + list(argv)), \
            mock.patch("sys.stdout", new_callable=io.StringIO) as out:
        module.main()
    return out.getvalue()


def folder(case, *parts):
    """A directory under the test's temp dir, made on the way."""
    p = os.path.join(case.tmp, *parts)
    os.makedirs(p, exist_ok=True)
    return p


def pixel(path):
    """The colour of an icon file's first pixel."""
    return Image.open(path).convert("RGBA").getpixel((0, 0))[:3]


class TestNameTable(TempDirCase):
    def test_a_record_carries_its_own_name_not_its_neighbours(self):
        ff = self.path("Imgs", "Faces.ff")
        make_ff(ff, [("A.PNG", solid(RED)), ("B.PNG", solid(GREEN)), ("C.PNG", solid(BLUE))])
        _name, images = extract_ff.extract(ff)
        got = {i.name: i.open().convert("RGB").getpixel((0, 0)) for i in images}
        self.assertEqual(got, {"A.PNG": RED, "B.PNG": GREEN, "C.PNG": BLUE})


class TestPictures(TempDirCase):
    def test_a_picture_is_put_together_from_its_parts_and_loses_its_margins(self):
        # The record packs two 2x2 blocks side by side; the picture has them on a diagonal
        # of an 8x8 canvas.
        ff = self.path("Imgs", "IconItem.ff")
        packed = png([[RED, RED, BLUE, BLUE], [RED, RED, BLUE, BLUE]])
        make_ff(ff, [("ART.PNG", packed)],
                [("G000IG0001", "ART.PNG", (8, 8), [(2, 1, 0, 0, 2, 2), (4, 3, 2, 0, 2, 2)])])
        rgba = pictures.PictureArchive(ff).picture("G000IG0001")
        self.assertEqual(rgb_of(rgba), [
            [RED, RED, None, None],
            [RED, RED, None, None],
            [None, None, BLUE, BLUE],
            [None, None, BLUE, BLUE],
        ])

    def test_the_index_says_which_record_a_name_means(self):
        # A mod gave the item new art: the old record still lies under the item's id.
        ff = self.path("Imgs", "IconItem.ff")
        make_ff(ff, [("G000IG0002.PNG", solid(RED)), ("G000IG0002RC2.PNG.PNG", solid(BLUE))],
                [("G000IG0002", "G000IG0002RC2.PNG.PNG", (2, 2), whole(2, 2))])
        arc = pictures.PictureArchive(ff)
        self.assertEqual(rgb_of(arc.picture("G000IG0002"))[0][0], BLUE)
        self.assertEqual(rgb_of(arc.picture("g000ig0002"))[0][0], BLUE)  # any case
        self.assertFalse(arc.has("G000IG0002RC2"))  # a record name is not a picture name
        self.assertIsNone(arc.picture("G000IG0002RC2"))

    def test_the_colour_key_is_transparent(self):
        ff = self.path("Imgs", "IconItem.ff")
        make_ff(ff, [("A.PNG", png([[MAGENTA, RED, MAGENTA]]))], [("A", "A.PNG", (3, 1), whole(3, 1))])
        self.assertEqual(rgb_of(pictures.PictureArchive(ff).picture("A")), [[RED]])

    def test_an_unknown_name_and_an_empty_picture_give_nothing(self):
        ff = self.path("Imgs", "IconItem.ff")
        make_ff(ff, [("A.PNG", solid(MAGENTA))], [("EMPTY", "A.PNG", (2, 2), whole(2, 2))])
        arc = pictures.PictureArchive(ff)
        self.assertIsNone(arc.picture("NOPE"))
        self.assertIsNone(arc.picture("EMPTY"))
        self.assertIsNone(arc.picture(""))

    def test_without_an_index_a_picture_is_its_record(self):
        ff = self.path("Imgs", "Faces.ff")
        make_ff(ff, [("G000UU0001FACE.PNG", solid(RED)), ("G000UU0001FACEB.PNG", solid(GREEN))])
        arc = pictures.PictureArchive(ff)
        self.assertEqual(rgb_of(arc.picture("G000UU0001FACE"))[0][0], RED)
        self.assertEqual(arc.first(["G000UU0009FACE", "G000UU0001FACEB"])[0], "G000UU0001FACEB")
        self.assertEqual(arc.first(["NOPE"]), (None, None))


def write_item_tables(g, lords=None, research=None, items=None):
    """The tables the scroll rule reads. lords: [(lord, race)], research: [(lord, spell)],
    items: [(item, category, spell)]."""
    def t(name, fields, rows):
        make_dbf(os.path.join(g, name), fields, rows)

    os.makedirs(g, exist_ok=True)
    t("LmagItm.dbf", [("ID", "N", 4), ("TEXT", "C", 20)],
      [{"ID": 0, "TEXT": "L_ARMOR"}, {"ID": 8, "TEXT": "L_SCROLL"}])
    t("Lrace.dbf", [("ID", "N", 4), ("TEXT", "C", 20)],
      [{"ID": 0, "TEXT": "L_HUMAN"}, {"ID": 1, "TEXT": "L_UNDEAD"}, {"ID": 2, "TEXT": "L_HERETIC"},
       {"ID": 3, "TEXT": "L_DWARF"}, {"ID": 4, "TEXT": "L_NEUTRAL"}, {"ID": 14, "TEXT": "L_ELF"}])
    t("Grace.dbf", [("RACE_ID", "C", 10), ("RACE_TYPE", "N", 4)],
      [{"RACE_ID": "G000RR0000", "RACE_TYPE": 0}, {"RACE_ID": "G000RR0001", "RACE_TYPE": 3},
       {"RACE_ID": "G000RR0003", "RACE_TYPE": 1}, {"RACE_ID": "G000RR0004", "RACE_TYPE": 4},
       {"RACE_ID": "G000RR0005", "RACE_TYPE": 14}])
    t("Glord.dbf", [("LORD_ID", "C", 10), ("RACE_ID", "C", 10)],
      [{"LORD_ID": l, "RACE_ID": r} for (l, r) in (lords or [])])
    t("GspellR.dbf", [("LORD_ID", "C", 10), ("SPELL_ID", "C", 10)],
      [{"LORD_ID": l, "SPELL_ID": s} for (l, s) in (research or [])])
    t("GItem.dbf", [("ITEM_ID", "C", 10), ("ITEM_CAT", "N", 4), ("SPELL_ID", "C", 10)],
      [{"ITEM_ID": i, "ITEM_CAT": c, "SPELL_ID": s} for (i, c, s) in (items or [])])


LORDS = [("G000LR0001", "G000RR0000"),   # Empire
         ("G000LR0010", "g000rr0003"),   # Undead — the tables mix the case of ids
         ("G000LR0013", "G000RR0004"),   # neutral
         ("G000LR0016", "G000RR0005")]   # Elves
RESEARCH = [("G000LR0010", "G000SS0002"), ("G000LR0016", "G000SS0002"),   # undead first, elves too
            ("g000lr0016", "g000ss0003"),
            ("G000LR0013", "G000SS0004")]
ITEMS = [("G000IG0001", 0, "G000000000"),
         ("G000IG5001", 8, "G000SS0001"),   # a spell no lord learns
         ("G000IG5002", 8, "g000ss0002"),
         ("G000IG5003", 8, "G000SS0003"),
         ("G000IG5004", 8, "G000SS0004")]


class TestScrollPictures(TempDirCase):
    def names(self):
        g = folder(self, "Game", "Globals")
        write_item_tables(g, LORDS, RESEARCH, ITEMS)
        return build_item_icons.picture_names(g)

    def test_an_item_is_named_by_its_id(self):
        self.assertEqual(self.names()["G000IG0001"], "G000IG0001")

    def test_a_scroll_takes_the_race_of_the_first_lord_who_learns_its_spell(self):
        names = self.names()
        self.assertEqual(names["G000IG5002"], "SCROLLUN")
        self.assertEqual(names["G000IG5003"], "SCROLLEL")

    def test_a_spell_no_lord_learns_gets_the_empires_scroll(self):
        self.assertEqual(self.names()["G000IG5001"], "SCROLLHU")

    def test_a_race_without_a_scroll_picture_gets_none(self):
        self.assertEqual(self.names()["G000IG5004"], "")

    def test_the_scroll_category_is_read_from_the_mods_own_table(self):
        g = folder(self, "Game", "Globals")
        write_item_tables(g, LORDS, RESEARCH, [("G000IG5001", 8, "G000SS0001"), ("G000IG7001", 5, "G000SS0002")])
        make_dbf(os.path.join(g, "LmagItm.dbf"), [("ID", "N", 4), ("TEXT", "C", 20)],
                 [{"ID": 5, "TEXT": "L_SCROLL"}, {"ID": 8, "TEXT": "L_WAND"}])
        names = build_item_icons.picture_names(g)
        self.assertEqual(names["G000IG5001"], "G000IG5001")
        self.assertEqual(names["G000IG7001"], "SCROLLUN")


class TestBuilders(TempDirCase):
    def game(self):
        return folder(self, "Game")

    def catalog(self, name, ids):
        out = self.path("out", name)
        with open(out, "w", encoding="utf-8") as fp:
            json.dump([{"id": i} for i in ids], fp)
        return os.path.dirname(out)

    def test_items_scrolls_and_what_the_archive_lacks(self):
        game = self.game()
        write_item_tables(os.path.join(game, "Globals"), LORDS, RESEARCH,
                          ITEMS + [("G000IG0002", 0, "G000000000")])
        make_ff(os.path.join(game, "Imgs", "IconItem.ff"),
                # the record under the item's own file name is its neighbour's old art
                [("G000IG0001.PNG", solid(WHITE)), ("NEW.PNG", solid(RED)),
                 ("SCROLLHU.PNG", solid(GREEN)), ("SCROLLUN.PNG", solid(BLUE))],
                [("G000IG0001", "NEW.PNG", (2, 2), whole(2, 2)),
                 ("SCROLLHU", "SCROLLHU.PNG", (2, 2), whole(2, 2)),
                 ("SCROLLUN", "SCROLLUN.PNG", (2, 2), whole(2, 2))])
        out = self.catalog("itemCatalog.json", [i for (i, _c, _s) in ITEMS] + ["G000IG0002"])
        log = run(build_item_icons, "--game", game, "--out", out)
        icons = os.path.join(out, "itemicons")
        self.assertEqual(sorted(os.listdir(icons)), ["g000ig0001.png", "g000ig5001.png", "g000ig5002.png"])
        self.assertEqual(pixel(os.path.join(icons, "g000ig0001.png")), RED)
        self.assertEqual(pixel(os.path.join(icons, "g000ig5001.png")), GREEN)
        self.assertEqual(pixel(os.path.join(icons, "g000ig5002.png")), BLUE)
        # no elven scroll in the archive, no picture for a neutral lord's spell, no art for an item
        self.assertIn("3 missing: g000ig0002, g000ig5003, g000ig5004", log)

    def test_a_spell_is_named_by_its_id(self):
        game = self.game()
        make_ff(os.path.join(game, "Imgs", "IconSpel.ff"),
                [("G000SS0002.PNG", solid(WHITE)), ("FIX1.PNG", solid(RED))],
                [("G000SS0001", "FIX1.PNG", (2, 2), whole(2, 2))])
        out = self.catalog("spellCatalog.json", ["G000SS0001", "G000SS0002"])
        log = run(build_spell_icons, "--game", game, "--out", out)
        self.assertEqual(os.listdir(os.path.join(out, "spellicons")), ["g000ss0001.png"])
        self.assertEqual(pixel(os.path.join(out, "spellicons", "g000ss0001.png")), RED)
        self.assertIn("1 missing: g000ss0002", log)

    def test_a_unit_shows_its_small_face_or_its_base_units(self):
        game = self.game()
        g = folder(self, "Game", "Globals")
        make_dbf(os.path.join(g, "Gunits.dbf"), [("UNIT_ID", "C", 10), ("BASE_UNIT", "C", 10)], [
            {"UNIT_ID": "G000UU0001", "BASE_UNIT": "G000000000"},
            {"UNIT_ID": "G000UU0002", "BASE_UNIT": "G000000000"},
            {"UNIT_ID": "g000uu0003", "BASE_UNIT": "g000uu0001"},   # an upgrade of the first
            {"UNIT_ID": "G000UU0004", "BASE_UNIT": "G000UU0003"},   # and an upgrade of that
            {"UNIT_ID": "G000UU0005", "BASE_UNIT": "G000000000"},   # no face anywhere
        ])
        make_ff(os.path.join(game, "Imgs", "Faces.ff"), [
            ("G000UU0001FACE.PNG", solid(RED)), ("G000UU0001FACEB.PNG", solid(WHITE)),
            ("G000UU0002FACEB.PNG", solid(BLUE)),
        ])
        out = self.catalog("unitCatalog.json", ["G000UU000%d" % n for n in range(1, 6)])
        log = run(build_unit_icons, "--game", game, "--out", out)
        icons = os.path.join(out, "uniticons")
        self.assertEqual(sorted(os.listdir(icons)),
                         ["g000uu0001.png", "g000uu0002.png", "g000uu0003.png", "g000uu0004.png"])
        self.assertEqual(pixel(os.path.join(icons, "g000uu0001.png")), RED)
        self.assertEqual(pixel(os.path.join(icons, "g000uu0002.png")), BLUE)
        self.assertEqual(pixel(os.path.join(icons, "g000uu0003.png")), RED)
        self.assertEqual(pixel(os.path.join(icons, "g000uu0004.png")), RED)
        self.assertIn("2 via BASE_UNIT, 1 without portrait", log)

    def test_a_races_lords_get_its_portraits_in_order(self):
        game = self.game()
        g = folder(self, "Game", "Globals")
        make_dbf(os.path.join(g, "Glord.dbf"), [("LORD_ID", "C", 10), ("RACE_ID", "C", 10)], [
            {"LORD_ID": "G000LR0001", "RACE_ID": "G000RR0000"},
            {"LORD_ID": "G000LR0002", "RACE_ID": "G000RR0000"},
            {"LORD_ID": "G000LR0010", "RACE_ID": "G000RR0003"},
        ])
        make_ff(os.path.join(game, "Imgs", "Lords.ff"),
                [("A.PNG", solid(RED)), ("B.PNG", solid(GREEN)), ("C.PNG", solid(BLUE))],
                [("LORDHUL01", "A.PNG", (2, 2), whole(2, 2)), ("LORDHUS02", "B.PNG", (2, 2), whole(2, 2)),
                 ("LORDUNL01", "C.PNG", (2, 2), whole(2, 2))])
        out = folder(self, "out")
        run(build_lord_icons, "--game", game, "--out", out)
        icons = os.path.join(out, "lordicons")
        self.assertEqual(pixel(os.path.join(icons, "g000lr0001.png")), RED)
        self.assertEqual(pixel(os.path.join(icons, "g000lr0002.png")), GREEN)   # only a small one
        self.assertEqual(pixel(os.path.join(icons, "g000lr0010.png")), BLUE)


if __name__ == "__main__":
    unittest.main()
