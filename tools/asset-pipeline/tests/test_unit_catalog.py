"""Tests for build_unit_catalog: what the editor's guard composer reads off a unit — its strength,
branch, whether it fights in the front line, whether it hits several targets, its growth per level.
Runs on small synthetic tables in a temp dir; no game install needed.

    python -m unittest discover -s tests        (from tools/asset-pipeline)
"""
import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)
sys.path.insert(0, HERE)

import build_unit_catalog  # noqa: E402
from test_mod_build import TempDirCase, make_dbf  # noqa: E402

ENUM = [("ID", "N", 4), ("TEXT", "C", 24)]

# reach id -> what the unit with that reach must come out as
STOCK_REACHES = [
    {"ID": 1, "TEXT": "L_ALL"},
    {"ID": 2, "TEXT": "L_ANY"},
    {"ID": 3, "TEXT": "L_ADJACENT"},
]
MOD_REACHES = [
    {"ID": 4, "TEXT": "L_ADJACENT_C", "MELEE": "T", "MAX_TARGTS": 1},  # a scripted melee
    {"ID": 5, "TEXT": "L_ALL_ADJACENT", "MELEE": "T", "MAX_TARGTS": 3},  # melee that hits three
    {"ID": 6, "TEXT": "L_SPLASH", "MELEE": "F", "MAX_TARGTS": 4},  # ranged, several targets
    {"ID": 7, "TEXT": "L_ANY_C", "MELEE": "F", "MAX_TARGTS": 6},  # "any one", whatever MAX_TARGTS says
    {"ID": 8, "TEXT": "L_ANY_SCRIPT", "MELEE": "F", "MAX_TARGTS": 6},
]


class TestUnitCatalog(TempDirCase):
    def write_globals(self, reach_fields, reaches):
        g = self.path("Game", "Globals", "x")
        g = os.path.dirname(g)

        def t(name, fields, rows):
            make_dbf(os.path.join(g, name), fields, rows)

        t("Tglobal.dbf", [("TXT_ID", "C", 10), ("TEXT", "C", 40)],
          [{"TXT_ID": "x000tg0001", "TEXT": "Squire"}, {"TXT_ID": "x000tg0002", "TEXT": "Empire"}])
        t("LunitC.dbf", ENUM, [{"ID": 0, "TEXT": "L_SOLDIER"}, {"ID": 2, "TEXT": "L_LEADER"}])
        t("LleadC.dbf", ENUM, [{"ID": 1, "TEXT": "L_FIGHTER"}])
        t("LunitB.dbf", ENUM, [{"ID": 0, "TEXT": "L_FIGHTER"}, {"ID": 1, "TEXT": "L_ARCHER"}, {"ID": 5, "TEXT": "L_HERO"}])
        t("LattC.dbf", ENUM, [{"ID": 1, "TEXT": "L_DAMAGE"}, {"ID": 6, "TEXT": "L_HEAL"}])
        t("LattR.dbf", reach_fields, reaches)
        t("Gattacks.dbf", [("ATT_ID", "C", 10), ("REACH", "N", 4), ("CLASS", "N", 4)],
          [{"ATT_ID": "g000aa%04d" % r["ID"], "REACH": r["ID"], "CLASS": 6 if r["ID"] == 2 else 1} for r in reaches])
        t("GDynUpgr.dbf", [("UPGRADE_ID", "C", 10), ("HIT_POINT", "N", 6), ("XP_KILLED", "N", 6)],
          [{"UPGRADE_ID": "g000du0001", "HIT_POINT": 10, "XP_KILLED": 2}, {"UPGRADE_ID": "g000du0002", "HIT_POINT": 5, "XP_KILLED": 1}])
        t("Grace.dbf", [("RACE_ID", "C", 10), ("NAME_TXT", "C", 10)], [{"RACE_ID": "g000rr0000", "NAME_TXT": "x000tg0002"}])
        t("GSubRace.dbf", [("RACE_TYPE", "N", 4), ("NAME_TXT", "C", 10)], [{"RACE_TYPE": 1, "NAME_TXT": "x000tg0002"}])
        units = []
        for r in reaches:
            units.append({
                "UNIT_ID": "g000uu%04d" % r["ID"], "UNIT_CAT": 0, "LEVEL": 1, "RACE_ID": "g000rr0000", "SUBRACE": 1,
                "BRANCH": 0, "SIZE_SMALL": "T", "NAME_TXT": "x000tg0001", "DESC_TXT": "", "ATTACK_ID": "g000aa%04d" % r["ID"],
                "HIT_POINT": 100, "ARMOR": 0, "XP_KILLED": 20, "LEADERSHIP": 0, "LEADER_CAT": 0,
                "DYN_UPG1": "g000du0001", "DYN_UPG_LV": 10, "DYN_UPG2": "g000du0002", "WATER_ONLY": "F",
            })
        # a big leader of the sea with one growth set only, and a unit with no attack and no growth
        units.append({
            "UNIT_ID": "g000uu0100", "UNIT_CAT": 2, "LEVEL": 3, "RACE_ID": "g000rr0000", "SUBRACE": 1, "BRANCH": 5,
            "SIZE_SMALL": "F", "NAME_TXT": "x000tg0001", "DESC_TXT": "", "ATTACK_ID": "g000aa0003", "HIT_POINT": 400,
            "ARMOR": 10, "XP_KILLED": 300, "LEADERSHIP": 6, "LEADER_CAT": 1,
            "DYN_UPG1": "g000du0001", "DYN_UPG_LV": 5, "DYN_UPG2": "g000000000", "WATER_ONLY": "T",
        })
        units.append({
            "UNIT_ID": "g000uu0101", "UNIT_CAT": 0, "LEVEL": 1, "RACE_ID": "g000rr0000", "SUBRACE": 1, "BRANCH": 1,
            "SIZE_SMALL": "T", "NAME_TXT": "x000tg0001", "DESC_TXT": "", "ATTACK_ID": "g000000000", "HIT_POINT": 50,
            "ARMOR": 0, "XP_KILLED": 15, "LEADERSHIP": 0, "LEADER_CAT": 0,
            "DYN_UPG1": "g000000000", "DYN_UPG_LV": 0, "DYN_UPG2": "g000000000", "WATER_ONLY": "F",
        })
        t("Gunits.dbf", [
            ("UNIT_ID", "C", 10), ("UNIT_CAT", "N", 4), ("LEVEL", "N", 4), ("RACE_ID", "C", 10), ("SUBRACE", "N", 4),
            ("BRANCH", "N", 4), ("SIZE_SMALL", "L", 1), ("NAME_TXT", "C", 10), ("DESC_TXT", "C", 10), ("ATTACK_ID", "C", 10),
            ("HIT_POINT", "N", 6), ("ARMOR", "N", 4), ("XP_KILLED", "N", 6), ("LEADERSHIP", "N", 4), ("LEADER_CAT", "N", 4),
            ("DYN_UPG1", "C", 10), ("DYN_UPG_LV", "N", 4), ("DYN_UPG2", "C", 10), ("WATER_ONLY", "L", 1),
        ], units)
        return os.path.dirname(g)

    def build(self, reach_fields, reaches):
        game = self.write_globals(reach_fields, reaches)
        out = self.path("out", "x")
        out = os.path.dirname(out)
        with mock.patch.object(sys, "argv", ["build_unit_catalog.py", "--game", game, "--out", out]):
            build_unit_catalog.main()
        with open(os.path.join(out, "unitCatalog.json"), encoding="utf-8") as fp:
            return {u["id"]: u for u in json.load(fp)}

    def test_stock_reaches_without_the_mod_columns(self):
        cat = self.build(ENUM, STOCK_REACHES)
        all_, any_, adjacent = cat["G000UU0001"], cat["G000UU0002"], cat["G000UU0003"]
        self.assertEqual((all_.get("melee"), all_.get("area")), (None, True))
        self.assertEqual((any_.get("melee"), any_.get("area")), (None, None))
        self.assertEqual((adjacent.get("melee"), adjacent.get("area")), (True, None))
        self.assertEqual(any_["atk"], "L_HEAL")
        self.assertEqual(adjacent["atk"], "L_DAMAGE")

    def test_stock_reaches_keep_their_meaning_when_a_mod_fills_the_columns_for_them(self):
        fields = ENUM + [("MAX_TARGTS", "N", 4), ("MELEE", "L", 1)]
        stock = [dict(r, MELEE="F", MAX_TARGTS=0) for r in STOCK_REACHES]  # as one of the mods has it
        cat = self.build(fields, stock + MOD_REACHES)
        self.assertEqual(cat["G000UU0003"].get("melee"), True)  # L_ADJACENT with MELEE = F is still melee
        self.assertEqual(cat["G000UU0001"].get("area"), True)  # L_ALL with MAX_TARGTS = 0 still hits all
        self.assertIsNone(cat["G000UU0002"].get("area"))

    def test_a_mods_own_reaches_go_by_their_columns(self):
        fields = ENUM + [("MAX_TARGTS", "N", 4), ("MELEE", "L", 1)]
        blank_stock = [dict(r, MELEE="", MAX_TARGTS="") for r in STOCK_REACHES]  # as another mod has it
        cat = self.build(fields, blank_stock + MOD_REACHES)
        flags = {uid[-1]: (u.get("melee"), u.get("area")) for uid, u in cat.items() if uid < "G000UU0100"}
        self.assertEqual(flags["3"], (True, None))
        self.assertEqual(flags["4"], (True, None))  # scripted melee, one target
        self.assertEqual(flags["5"], (True, True))  # melee that hits three
        self.assertEqual(flags["6"], (None, True))  # ranged, several targets
        self.assertEqual(flags["7"], (None, None))  # "any one target" in spite of MAX_TARGTS = 6
        self.assertEqual(flags["8"], (None, None))

    def test_strength_branch_growth_water_and_size(self):
        cat = self.build(ENUM, STOCK_REACHES)
        soldier = cat["G000UU0003"]
        self.assertEqual(soldier["xp"], 20)
        self.assertEqual(soldier["branch"], "L_FIGHTER")
        self.assertEqual(soldier["dyn"], [10, 10, 2, 5, 1])
        self.assertNotIn("water", soldier)
        self.assertNotIn("large", soldier)
        leader = cat["G000UU0100"]
        self.assertEqual((leader["catKey"], leader["leaderKey"], leader["branch"]), ("L_LEADER", "L_FIGHTER", "L_HERO"))
        self.assertEqual((leader["xp"], leader["leadership"], leader["level"]), (300, 6, 3))
        self.assertEqual(leader["dyn"], [5, 10, 2, 10, 2])  # no second set: the first one goes on
        self.assertTrue(leader["water"])
        self.assertTrue(leader["large"])
        self.assertTrue(leader["melee"])
        bare = cat["G000UU0101"]  # no attack row, no growth rows
        for key in ("melee", "area", "atk", "dyn"):
            self.assertNotIn(key, bare)
        self.assertEqual(bare["branch"], "L_ARCHER")


if __name__ == "__main__":
    unittest.main()
