"""Tests for the mod data-set build: the shared DBF reader, the blob store and build_mod's
generators. Everything runs on small synthetic tables written to a temp dir — no game
install needed. One end-to-end dry run against a real install is skipped when absent.

    python -m unittest discover -s tests        (from tools/asset-pipeline)
"""
import json
import os
import shutil
import struct
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)

import build_mod  # noqa: E402
from fflib import dbf  # noqa: E402
from fflib.blobstore import BlobStore, sha256_bytes  # noqa: E402

GAME_DIR = os.environ.get("D2_GAME_DIR_GAME", os.path.join(os.environ.get("D2_GAME_DIR", "."), "Game"))


def make_dbf(path, fields, rows, deleted=()):
    """Write a dBASE III file. fields: [(name, type, length)], rows: [dict], deleted: row indexes."""
    rlen = 1 + sum(f[2] for f in fields)
    hlen = 32 + 32 * len(fields) + 1
    out = bytearray(32)
    out[0] = 0x03
    struct.pack_into("<I", out, 4, len(rows))
    struct.pack_into("<H", out, 8, hlen)
    struct.pack_into("<H", out, 10, rlen)
    for name, ftype, flen in fields:
        d = bytearray(32)
        d[0:len(name)] = name.encode("ascii")
        d[11] = ord(ftype)
        d[16] = flen
        out += d
    out.append(0x0D)
    for i, row in enumerate(rows):
        out.append(0x2A if i in deleted else 0x20)
        for name, ftype, flen in fields:
            v = row.get(name, "")
            raw = v if isinstance(v, bytes) else str(v).encode("cp866")
            out += (raw.rjust(flen) if ftype == "N" else raw.ljust(flen))[:flen]
    out.append(0x1A)
    with open(path, "wb") as fp:
        fp.write(bytes(out))


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="d2-mod-build-")
        dbf.REPORT.reset()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def path(self, *parts):
        p = os.path.join(self.tmp, *parts)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p


class TestDbf(TempDirCase):
    def test_reads_live_rows_and_skips_deleted(self):
        p = self.path("Gunits.dbf")
        make_dbf(p, [("UNIT_ID", "C", 10), ("LEVEL", "N", 2)],
                 [{"UNIT_ID": "g000uu0001", "LEVEL": 1}, {"UNIT_ID": "g000uu0002", "LEVEL": 2},
                  {"UNIT_ID": "g000uu0003", "LEVEL": 3}], deleted=(1,))
        rows = dbf.read_dbf(p)
        self.assertEqual([r["UNIT_ID"] for r in rows], [b"g000uu0001", b"g000uu0003"])
        self.assertEqual(rows[0]["LEVEL"], b" 1")  # raw bytes, padded as stored
        text = dbf.read_dbf_text(p)
        self.assertEqual(text[1]["LEVEL"], "3")
        self.assertEqual(dbf.id_column(rows, "UNIT_ID"), ["G000UU0001", "G000UU0003"])

    def test_field_widths_come_from_each_files_own_header(self):
        # the same column is C40 in one mod and C64 in another (Gmodif.SCRIPT)
        narrow, wide = self.path("a", "Gmodif.dbf"), self.path("b", "Gmodif.dbf")
        make_dbf(narrow, [("MODIF_ID", "C", 10), ("SCRIPT", "C", 40)], [{"MODIF_ID": "g000um0001", "SCRIPT": "a.lua"}])
        make_dbf(wide, [("MODIF_ID", "C", 10), ("SCRIPT", "C", 64), ("EXTRA", "N", 3)],
                 [{"MODIF_ID": "g000um0001", "SCRIPT": "a.lua", "EXTRA": 7}])
        self.assertEqual(dbf.ascii_(dbf.read_dbf(narrow)[0]["SCRIPT"]), "a.lua")
        self.assertEqual(dbf.ascii_(dbf.read_dbf(wide)[0]["SCRIPT"]), "a.lua")
        self.assertEqual(dbf.int_(dbf.read_dbf(wide)[0]["EXTRA"]), 7)

    def test_missing_column_reads_empty_and_is_reported(self):
        p = self.path("GmodifL.dbf")
        make_dbf(p, [("BELONGS_TO", "C", 10)], [{"BELONGS_TO": "g000um0001"}, {"BELONGS_TO": "g000um0002"}])
        report = dbf.SchemaReport()
        rows = dbf.read_dbf(p, report)
        self.assertEqual(rows[0]["IMMUNITYC"], b"")  # the builder keeps running
        self.assertEqual(dbf.int_(rows[1]["IMMUNITYC"]), 0)
        self.assertIsNone(rows[0].get("NOPE"))
        self.assertEqual(report.missing_columns(), ["GMODIFL.IMMUNITYC", "GMODIFL.NOPE"])
        self.assertEqual(report.tables["GMODIFL"], [["BELONGS_TO", "C", 10, 0]])
        text = dbf.read_dbf_text(p, report)
        self.assertEqual(text[0]["IMMUNITYC"], "")
        self.assertEqual(text[0].get("IMMUNITYC", "1"), "1")

    def test_find_table_is_case_insensitive_and_reports_absence(self):
        make_dbf(self.path("Globals", "GITEM.DBF"), [("ITEM_ID", "C", 10)], [])
        g = os.path.join(self.tmp, "Globals")
        self.assertTrue(dbf.find_table(g, "GItem.dbf").lower().endswith("gitem.dbf"))
        self.assertTrue(dbf.has_table(g, "gitem.dbf"))
        report = dbf.SchemaReport()
        with self.assertRaises(FileNotFoundError):
            dbf.find_table(g, "Gnope.dbf", report)
        self.assertEqual(report.absent, ["Gnope.dbf"])

    def test_text_is_cp866(self):
        p = self.path("Tglobal.dbf")
        make_dbf(p, [("TXT_ID", "C", 10), ("TEXT", "C", 20)], [{"TXT_ID": "x000tg0001", "TEXT": u"Империя"}])
        self.assertEqual(dbf.cp866_(dbf.read_dbf(p)[0]["TEXT"]), u"Империя")


class TestBlobStore(TempDirCase):
    def test_put_file_is_content_addressed_and_idempotent(self):
        store = BlobStore(self.path("store", "x")[:-2])
        a = self.path("in", "a.PNG")
        with open(a, "wb") as fp:
            fp.write(b"pixels")
        rel = store.put_file(a)
        sha = sha256_bytes(b"pixels")
        self.assertEqual(rel, "blobs/%s/%s.png" % (sha[:2], sha))
        self.assertTrue(os.path.isfile(a))  # the source keeps its place
        self.assertEqual((store.new_count, store.shared_count), (1, 0))

        b = self.path("in", "same-bytes.png")
        with open(b, "wb") as fp:
            fp.write(b"pixels")
        self.assertEqual(store.put_file(b, move=True), rel)
        self.assertFalse(os.path.exists(b))  # moved in (already present -> just removed)
        self.assertEqual((store.new_count, store.shared_count, store.shared_bytes), (1, 1, 6))
        with open(store.abspath(rel), "rb") as fp:
            self.assertEqual(fp.read(), b"pixels")

    def test_copy_does_not_share_bytes_with_the_source(self):
        store = BlobStore(self.path("store", "x")[:-2])
        src = self.path("foreign", "sheet.png")
        with open(src, "wb") as fp:
            fp.write(b"v1")
        rel = store.put_file(src, link=False)
        with open(src, "wb") as fp:  # somebody rewrites the source in place
            fp.write(b"v2-longer")
        with open(store.abspath(rel), "rb") as fp:
            self.assertEqual(fp.read(), b"v1")

    def test_put_bytes_and_dry_run_accounting(self):
        store = BlobStore(self.path("store", "x")[:-2])
        rel = store.put_bytes(b"{}", "json")
        self.assertTrue(store.has(rel))
        probe = self.path("in", "p.json")
        with open(probe, "wb") as fp:
            fp.write(b"{}")
        self.assertEqual(store.would_put(probe), rel)
        self.assertEqual((store.new_count, store.shared_count), (1, 1))
        other = self.path("in", "q")
        with open(other, "wb") as fp:
            fp.write(b"no extension")
        self.assertTrue(store.would_put(other).endswith(".bin"))
        self.assertFalse(store.has(store.would_put(other)))  # a dry run writes nothing


def write_globals(globals_dir, guardian_hp=900, extra_units=(), lrace_width=20):
    """A minimal Globals directory shaped like the real one."""
    def t(name, fields, rows, deleted=()):
        make_dbf(os.path.join(globals_dir, name), fields, rows, deleted)

    os.makedirs(globals_dir)
    t("Tglobal.dbf", [("TXT_ID", "C", 10), ("TEXT", "C", 30)],
      [{"TXT_ID": "x000tg0001", "TEXT": u"\\fNormal;Империя"}, {"TXT_ID": "x000tg0002", "TEXT": u"Нейтралы"}])
    t("Lrace.dbf", [("ID", "N", 2), ("TEXT", "C", lrace_width)],
      [{"ID": 0, "TEXT": "L_HUMAN"}, {"ID": 4, "TEXT": "L_NEUTRAL"}])
    t("Lterrain.dbf", [("ID", "N", 2), ("TEXT", "C", 20)],
      [{"ID": 0, "TEXT": "L_GOLD"}, {"ID": 1, "TEXT": "L_HUMAN"}, {"ID": 5, "TEXT": "L_NEUTRAL"}])
    units = [{"UNIT_ID": "g000uu3001", "HIT_POINT": guardian_hp}, {"UNIT_ID": "g000uu0019", "HIT_POINT": 135},
             {"UNIT_ID": "g000000000", "HIT_POINT": 0}] + [{"UNIT_ID": u, "HIT_POINT": 10} for u in extra_units]
    t("Gunits.dbf", [("UNIT_ID", "C", 10), ("HIT_POINT", "N", 4)], units + [{"UNIT_ID": "g000uu7777", "HIT_POINT": 1}],
      deleted=(len(units),))
    t("Grace.dbf", [("RACE_ID", "C", 10), ("GUARDIAN", "C", 10), ("LEADER_1", "C", 10), ("NAME_TXT", "C", 10),
                    ("RACE_TYPE", "N", 2), ("PLAYABLE", "L", 1)],
      [{"RACE_ID": "g000rr0000", "GUARDIAN": "g000uu3001", "LEADER_1": "g000uu0019", "NAME_TXT": "x000tg0001",
        "RACE_TYPE": 0, "PLAYABLE": "T"},
       {"RACE_ID": "g000rr0004", "GUARDIAN": "g000000000", "LEADER_1": "g000000000", "NAME_TXT": "x000tg0002",
        "RACE_TYPE": 4, "PLAYABLE": "F"}])
    t("Glord.dbf", [("LORD_ID", "C", 10), ("RACE_ID", "C", 10), ("CATEGORY", "N", 1)],
      [{"LORD_ID": "g000lr0001", "RACE_ID": "g000rr0000", "CATEGORY": 1},
       {"LORD_ID": "g000lr0003", "RACE_ID": "g000rr0000", "CATEGORY": 0}])
    t("GItem.dbf", [("ITEM_ID", "C", 10)], [{"ITEM_ID": "g000ig0006"}, {"ITEM_ID": "g000ig0001"}])
    t("GSpells.dbf", [("SPELL_ID", "C", 10)], [{"SPELL_ID": "g000ss0001"}])
    t("GLmark.dbf", [("LMARK_ID", "C", 10)], [{"LMARK_ID": "g000mg0001"}])
    t("Gmodif.dbf", [("MODIF_ID", "C", 10)], [{"MODIF_ID": "g201um9378"}])
    t("Gbuild.dbf", [("BUILD_ID", "C", 10)], [{"BUILD_ID": "g000bb0001"}])
    t("LAttR.dbf", [("ID", "N", 3), ("TEXT", "C", 12), ("MELEE", "L", 1)],
      [{"ID": 1, "TEXT": "L_ALL", "MELEE": "F"}, {"ID": 2, "TEXT": "L_ANY", "MELEE": "T"}])


class TestBuildModGenerators(TempDirCase):
    def test_ids_profile_and_dictionaries(self):
        g = os.path.join(self.tmp, "Globals")
        write_globals(g, extra_units=("g070uu9000",))

        ids = build_mod.build_ids(g)["tables"]
        self.assertEqual(ids["UU"], ["G000UU0019", "G000UU3001", "G070UU9000"])  # no nil id, no deleted row
        self.assertEqual(ids["IG"], ["G000IG0001", "G000IG0006"])
        self.assertEqual(sorted(ids), ["BB", "IG", "LR", "MG", "RR", "SS", "UM", "UU"])

        profile = build_mod.build_profile(g)
        self.assertEqual(profile["unitCount"], 3)
        self.assertEqual(profile["capitalItem"], "G000IG0006")
        empire, neutral = profile["races"]
        self.assertEqual(empire, {
            "key": "empire", "raceId": "G000RR0000", "raceType": 0, "name": u"Империя", "playable": True,
            "guardian": "G000UU3001", "guardianHp": 900, "leader": "G000UU0019", "leaderHp": 135,
            "lord": "G000LR0003", "terrain": 1,
        })
        self.assertEqual(neutral["key"], "neutral")
        self.assertFalse(neutral["playable"])
        self.assertNotIn("guardian", neutral)  # the nil id is "no unit", not a unit

        d = build_mod.build_dictionaries(g)["tables"]
        self.assertEqual(sorted(d), ["LATTR", "LRACE", "LTERRAIN"])
        self.assertEqual(d["LATTR"], [{"ID": 1, "TEXT": "L_ALL", "MELEE": False}, {"ID": 2, "TEXT": "L_ANY", "MELEE": True}])
        self.assertEqual(dbf.REPORT.missing_columns(), [])

    def test_reports_races_that_depart_from_the_editors_reference_table(self):
        ref = {k: {"key": k, "raceId": v[0], "raceType": v[1], "guardian": v[2], "leader": v[3], "lord": v[4],
                   "terrain": v[5], "guardianHp": 1, "leaderHp": 2} for k, v in build_mod.REFERENCE_RACES.items()}
        same = {"races": list(ref.values())}
        self.assertEqual(build_mod.race_table_differences(same), [])  # hit points are free to differ
        changed = dict(ref)
        changed["elves"] = dict(ref["elves"], guardian="G070UU9000")
        del changed["undead"]
        diffs = build_mod.race_table_differences({"races": list(changed.values())})
        self.assertEqual(len(diffs), 2)
        self.assertTrue(diffs[0].startswith("elves: ") and "G070UU9000" in diffs[0])
        self.assertEqual(diffs[1], "undead: absent")

    def test_profile_follows_each_mods_own_tables(self):
        a, b = os.path.join(self.tmp, "a", "Globals"), os.path.join(self.tmp, "b", "Globals")
        os.makedirs(os.path.dirname(a))
        os.makedirs(os.path.dirname(b))
        write_globals(a, guardian_hp=900)
        write_globals(b, guardian_hp=250, lrace_width=12)  # another mod: other stats, other widths
        self.assertEqual(build_mod.build_profile(a)["races"][0]["guardianHp"], 900)
        self.assertEqual(build_mod.build_profile(b)["races"][0]["guardianHp"], 250)

    def test_generated_json_is_deterministic(self):
        g = os.path.join(self.tmp, "Globals")
        write_globals(g)
        first = build_mod.dump_json(build_mod.build_profile(g))
        self.assertEqual(first, build_mod.dump_json(build_mod.build_profile(g)))
        self.assertEqual(build_mod.dump_json({"b": 1, "a": u"я"}), u'{"a":"я","b":1}'.encode("utf-8"))

    def test_lua_variable_scan_and_catalog(self):
        with open(self.path("game", "Scripts", "modules", "b.lua"), "wb") as fp:
            fp.write(b"local v = variables:getVariable('ENABLE_GLOBAL_CUSTOM_MAPMOD')\n"
                     b"local p = variables:getVariable('PERK_LVL_'..race..'_'..id)\n"
                     b"local q = scen.variables:getVariable( \"MY_OWN_SWITCH\" )\n")
        with open(self.path("game", "Scripts", "a.lua"), "wb") as fp:
            fp.write(b"x = variables:getVariable('ENABLE_GLOBAL_CUSTOM_MAPMOD')\n")
        with open(self.path("game", "mss32.dll"), "wb") as fp:
            fp.write(b"\x00junk{:s}MULTIPLE_BUILD_CAPITAL\x00HIRE_UNIT_ANY_RACE\x00")
        game = os.path.join(self.tmp, "game")
        scripts = os.path.join(game, "Scripts")

        found = build_mod.scan_lua_variables(scripts)
        self.assertEqual(found[("ENABLE_GLOBAL_CUSTOM_MAPMOD", False)], "a.lua")  # first file by path
        self.assertIn(("PERK_LVL_", True), found)

        cat = build_mod.build_scen_variables(game, scripts)
        names = [(v["name"], v["source"]) for v in cat["variables"]]
        self.assertIn(("MULTIPLE_BUILD_CAPITAL", "mss32"), names)
        self.assertIn(("HIRE_UNIT_ANY_RACE", "mss32"), names)
        self.assertNotIn(("HIRE_UNIT_TIER_MAX", "mss32"), names)  # this dll does not know it
        self.assertNotIn(("SMNS_INFO_TURN", "lua"), names)  # curated, but this mod never reads it
        self.assertIn(("MY_OWN_SWITCH", "lua"), names)  # read by the mod, not curated: listed bare
        perk = [v for v in cat["variables"] if v["name"] == "PERK_LVL_"][0]
        self.assertTrue(perk["prefix"])
        self.assertEqual(perk["origin"], "modules/b.lua")
        self.assertEqual(cat["racePrefixes"]["undead"], "HORDES_")

    def test_no_toolset_means_no_builtin_variables(self):
        os.makedirs(os.path.join(self.tmp, "game", "Scripts"))
        cat = build_mod.build_scen_variables(os.path.join(self.tmp, "game"), os.path.join(self.tmp, "game", "Scripts"))
        self.assertEqual(cat["variables"], [])
        self.assertEqual(cat["racePrefixes"], {})
        self.assertEqual(cat["groups"], [])

    def test_series_are_written_out_and_matched_by_their_format_string(self):
        os.makedirs(os.path.join(self.tmp, "game", "Scripts"))
        with open(self.path("game", "mss32.dll"), "wb") as fp:
            # the toolset builds these names at run time: the dll holds the format strings only
            fp.write(b"\x00{:s}TIER_{:d}_CITY_GOLD_INCOME\x00TIER_{:d}_CITY_GOLD_INCOME\x00{:s}_MANA_INCOME\x00")
        game = os.path.join(self.tmp, "game")
        cat = build_mod.build_scen_variables(game, os.path.join(game, "Scripts"))
        by_name = dict((v["name"], v) for v in cat["variables"])
        self.assertEqual(sorted(by_name), sorted(
            ["TIER_%d_CITY_GOLD_INCOME" % i for i in range(6)]
            + ["WARRIOR_MANA_INCOME", "MAGE_MANA_INCOME", "GUILDMASTER_MANA_INCOME"]))
        capital = by_name["TIER_0_CITY_GOLD_INCOME"]
        self.assertEqual((capital["group"], capital["scope"], capital["raceMode"]), ("cityGold", "perRace", "add"))
        self.assertEqual(capital["title"], u"Столица")
        self.assertNotIn("probe", capital)  # builder-only keys stay out of the mod's catalog
        self.assertNotIn("each", capital)
        # only the groups this mod has variables in
        self.assertEqual([g["id"] for g in cat["groups"]], ["cityGold", "lordIncome"])

    def test_curated_catalog_is_consistent(self):
        with open(os.path.join(os.path.dirname(build_mod.__file__), "data", "scen_variables.json"), encoding="utf-8") as fp:
            curated = json.load(fp)
        entries = build_mod.expand_curated(curated["variables"])
        names = [(e["name"], bool(e.get("prefix"))) for e in entries]
        self.assertEqual(len(names), len(set(names)), "a variable is described twice")
        groups = set(g["id"] for g in curated["groups"])
        for e in entries:
            self.assertNotIn("{", e["name"], "unexpanded series")
            if e.get("group"):
                self.assertIn(e["group"], groups)
                self.assertNotIn("presets", e)  # a group is a table of plain numbers
            for p in e.get("presets", []):
                self.assertTrue(p["value"] is None or isinstance(p["value"], int))
            # the choice "no variable" is offered exactly when presets exist
            if e.get("presets"):
                self.assertEqual([p["value"] for p in e["presets"]].count(None), 1, e["name"])

    def test_settings_keeps_numbers_and_flags_only(self):
        with open(self.path("Scripts", "settings.lua"), "wb") as fp:
            fp.write(b"settings = {\n"
                     b"    unitMaxDamage = 300, -- cap\n"
                     b"    criticalHitChance = 70,\n"
                     b"    debugHooks = true,\n"
                     b"    ratio = 0.5,\n"
                     b"    lobby = {\n"
                     b"        server = {\n"
                     b"            ip = \"203.0.113.7\",\n"
                     b"            port = 61111,\n"
                     b"        },\n"
                     b"    },\n"
                     b"    list = { 1, 2, 3 },\n"
                     b"    fn = function() return 1 end,\n"
                     b"    after = -4,\n"
                     b"}\n")
        values = build_mod.build_settings(os.path.join(self.tmp, "Scripts"))["values"]
        self.assertEqual(values, {
            "unitMaxDamage": 300, "criticalHitChance": 70, "debugHooks": True, "ratio": 0.5,
            "lobby.server.port": 61111, "after": -4,
        })

    def test_fingerprint_tracks_the_data_not_the_file_name_case(self):
        def install(root, script=b"return 1", table_name="Gunits.dbf"):
            make_dbf(os.path.join(self._mk(root, "Globals"), table_name), [("UNIT_ID", "C", 10)], [{"UNIT_ID": "g000uu0001"}])
            with open(os.path.join(self._mk(root, "Scripts"), "settings.lua"), "wb") as fp:
                fp.write(script)
            return os.path.join(self.tmp, root)

        fp_a, src_a = build_mod.fingerprint(install("a"))
        fp_b, _ = build_mod.fingerprint(install("b", table_name="GUNITS.DBF"))
        fp_c, src_c = build_mod.fingerprint(install("c", script=b"return 2"))
        self.assertEqual(fp_a, fp_b)  # same data under differently-cased names = same mod
        self.assertNotEqual(fp_a, fp_c)
        self.assertEqual(src_a["globals"], src_c["globals"])
        self.assertNotEqual(src_a["scripts"], src_c["scripts"])
        self.assertRegex(fp_a, r"^[0-9a-f]{64}$")

    def _mk(self, *parts):
        p = os.path.join(self.tmp, *parts)
        os.makedirs(p)
        return p

    def test_index_rows_validate_against_contract_d(self):
        index = {"schemaVersion": 1, "defaultModId": "semga", "mods": [
            {"id": "semga", "name": "S", "family": "semga", "familyOrder": 1, "status": "ready", "contentFingerprint": "a" * 64}]}
        build_mod.validate(index, "mod-index.schema.json", "ModIndex")  # must not raise
        with self.assertRaises(build_mod.BuildError):
            build_mod.validate({"schemaVersion": 1, "mods": [{"id": "semga", "status": "half-built"}]},
                               "mod-index.schema.json", "ModIndex")


@unittest.skipUnless(os.path.isdir(os.path.join(GAME_DIR, "Globals")), "game install not available")
class TestRealInstallDryRun(TempDirCase):
    def test_dry_run_builds_everything_and_leaves_the_store_untouched(self):
        store = os.path.join(self.tmp, "store")
        os.makedirs(store)
        rc = build_mod.main(["--game", GAME_DIR, "--mod-id", "probe", "--store", store, "--dry-run"])
        self.assertEqual(rc, 0)
        self.assertEqual(os.listdir(store), [])
        self.assertEqual(dbf.REPORT.missing_columns(), [])


if __name__ == "__main__":
    unittest.main()
