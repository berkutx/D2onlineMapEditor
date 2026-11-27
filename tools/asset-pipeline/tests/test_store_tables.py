"""The install's own files in the store: build_mod takes the tables and capital.dat in by name,
as copies; store_upload leaves a closed mod's tables on this machine. Synthetic installs and
stores in a temp dir; no game needed.

    py -3.7 -W ignore -m unittest tests.test_store_tables        (from tools/asset-pipeline)
"""
import hashlib
import io
import json
import os
import sys
import tarfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import build_mod  # noqa: E402
import store_upload  # noqa: E402
from fflib.blobstore import BlobStore  # noqa: E402
from tests.test_derive import Case  # noqa: E402
from tests.test_mod_build import make_dbf, write_globals  # noqa: E402


def run_quiet(fn, *a, **kw):
    """(result, stdout, stderr) of fn."""
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        result = fn(*a, **kw)
    return result, out.getvalue(), err.getvalue()


class TestTableFiles(Case):
    def test_globals_then_the_interf_tables_globals_lacks(self):
        game = os.path.join(self.tmp, "game")
        self.write(b"u", "game", "globals", "GUNITS.DBF")
        self.write(b"t", "game", "globals", "tapp.dbf")  # Globals has a TApp: Interf's is not taken
        self.write(b"x", "game", "globals", "notes.txt")
        self.write(b"a", "game", "INTERF", "TApp.dbf")
        self.write(b"e", "game", "INTERF", "TAppEdit.DBF")
        self.write(b"o", "game", "INTERF", "Other.dbf")  # the game's own UI
        # the folders are found ignoring case; a table's name is its file's name as on disk
        got = {k: os.path.relpath(v, game).replace("\\", "/") for k, v in build_mod.table_files(game).items()}
        self.assertEqual({k: v.split("/")[0].lower() + "/" + v.split("/")[1] for k, v in got.items()},
                         {"GUNITS": "globals/GUNITS.DBF", "tapp": "globals/tapp.dbf", "TAppEdit": "interf/TAppEdit.DBF"})

    def test_a_bare_folder_of_tables(self):
        folder = os.path.dirname(self.write(b"u", "edited", "Gunits.dbf"))
        self.assertEqual(list(build_mod.table_files(folder)), ["Gunits"])

    def test_install_files_name_tables_and_capital_dat(self):
        game = os.path.join(self.tmp, "game")
        self.write(b"u", "game", "Globals", "Gunits.dbf")
        self.assertEqual([n for n, _ in build_mod.install_files(game)], ["tables/Gunits.dbf"])
        self.write(b"c", "game", "Imgs", "Capital.DAT")
        self.assertEqual([n for n, _ in build_mod.install_files(game)], ["tables/Gunits.dbf", "capital.dat"])
        self.assertTrue(build_mod.is_install_file("tables/Gunits.dbf"))
        self.assertTrue(build_mod.is_install_file("capital.dat"))
        self.assertFalse(build_mod.is_install_file("unitCatalog.json"))
        self.assertFalse(build_mod.is_install_file("sheets/capital.dat.png"))


class TestBuildModTakesTheTables(Case):
    """build_mod.main over a synthetic install; the catalog and icon builders are skipped (they
    need a real game), everything else runs."""

    def install(self):
        game = os.path.join(self.tmp, "game")
        write_globals(os.path.join(game, "Globals"))
        make_dbf(self.path("game", "Interf", "TApp.dbf"), [("TXT_ID", "C", 10), ("TEXT", "C", 20)],
                 [{"TXT_ID": "x100ta0001", "TEXT": "app"}])
        make_dbf(self.path("game", "Interf", "TAppEdit.DBF"), [("TXT_ID", "C", 10)], [{"TXT_ID": "x160ta0001"}])
        self.write(b"capital screens", "game", "Imgs", "capital.dat")
        return game

    def build(self, game, store, *extra):
        argv = ["--game", game, "--mod-id", "probe", "--store", store] + list(extra)
        with mock.patch.object(build_mod, "DATA_BUILDERS", []), mock.patch.object(build_mod, "GRAPHICS_BUILDERS", []):
            return run_quiet(build_mod.main, argv)

    def test_tables_and_capital_dat_are_copied_in_by_name(self):
        game = self.install()
        store = os.path.join(self.tmp, "store")
        rc, out, _err = self.build(game, store)
        self.assertEqual(rc, 0)
        mod = build_mod.load_mod(store, "probe")
        sources = dict(build_mod.install_files(game))
        globals_names = sorted(os.listdir(os.path.join(game, "Globals")))
        self.assertEqual(len(globals_names), 12)
        want = ["tables/%s.dbf" % n[:-4] for n in globals_names] + ["tables/TApp.dbf", "tables/TAppEdit.dbf", "capital.dat"]
        self.assertEqual(sorted(n for n in mod["files"] if build_mod.is_install_file(n)), sorted(want))
        self.assertIn("ids.json", mod["files"])  # the built files are still there
        for logical, src in sources.items():
            blob = os.path.join(store, *mod["files"][logical].split("/"))
            with open(blob, "rb") as a, open(src, "rb") as b:
                self.assertEqual(a.read(), b.read(), logical)
            # a copy, not a second name of the game's file
            self.assertFalse(os.path.samefile(blob, src), logical)
            self.assertNotEqual(os.stat(blob).st_ino, os.stat(src).st_ino, logical)
            self.assertEqual(os.stat(src).st_nlink, 1, logical)
            self.assertTrue(mod["files"][logical].endswith("." + logical.rsplit(".", 1)[1]))
        self.assertIn("  tables       14 files + capital.dat, ", out)

    def test_without_capital_dat_the_report_says_tables_only(self):
        game = self.install()
        os.remove(os.path.join(game, "Imgs", "capital.dat"))
        rc, out, _err = self.build(game, os.path.join(self.tmp, "store"))
        self.assertEqual(rc, 0)
        self.assertNotIn("capital.dat", build_mod.load_mod(os.path.join(self.tmp, "store"), "probe")["files"])
        self.assertRegex(out, r"\n  tables       14 files, \d+\.\d MB\n")

    def test_a_dry_run_writes_nothing(self):
        game = self.install()
        store = os.path.join(self.tmp, "store")
        os.makedirs(store)
        rc, out, _err = self.build(game, store, "--dry-run")
        self.assertEqual(rc, 0)
        self.assertEqual(os.listdir(store), [])
        self.assertIn("  tables       14 files + capital.dat, ", out)
        self.assertIn("dry run: the store was not changed", out)

    def test_a_builder_may_not_take_a_name_of_the_install_files(self):
        game = self.install()
        stage_writer = mock.Mock(side_effect=lambda name, g, out_dir: open(os.path.join(out_dir, "capital.dat"), "wb").close())
        with mock.patch.object(build_mod, "DATA_BUILDERS", ["x"]), mock.patch.object(build_mod, "run_builder", stage_writer):
            with self.assertRaisesRegex(build_mod.BuildError, "capital.dat"):
                run_quiet(build_mod.main, ["--game", game, "--mod-id", "probe", "--store", os.path.join(self.tmp, "store")])


class TestUploadLeavesClosedTablesHere(Case):
    def store(self):
        return self.store_with({
            "semga": ("semga", 1, {"a.json": b"semga", "tables/Lrace.dbf": b"same races",
                                   "tables/Gunits.dbf": b"semga units", "capital.dat": b"semga capital"}, None),
            "semga-2": ("semga", 2, {"a.json": b"semga-2", "tables/Lrace.dbf": b"same races",
                                     "tables/Gunits.dbf": b"closed units", "capital.dat": b"closed capital",
                                     "tables/TApp.dbf": b"semga capital"}, None),
        }, "semga")

    def blob(self, data, ext):
        return BlobStore.rel(hashlib.sha256(data).hexdigest(), ext)

    def tar_of(self, root, closed):
        index, mods, blobs = store_upload.select(root, closed=closed)
        buf = io.BytesIO()
        store_upload.write_tar(buf, root, index, mods, blobs)
        buf.seek(0)
        out = {}
        with tarfile.open(fileobj=buf, mode="r:gz") as tar:
            for m in tar.getmembers():
                out[m.name] = tar.extractfile(m).read()
        return out, blobs

    def test_a_closed_mod_goes_up_without_its_tables(self):
        root = self.store()
        members, blobs = self.tar_of(root, {"semga-2"})
        closed = json.loads(members["mods/semga-2/mod.json"].decode("utf-8"))
        self.assertEqual(sorted(closed["files"]), ["a.json"])
        local = build_mod.load_mod(root, "semga-2")
        self.assertEqual(dict(closed, files=local["files"]), local)  # nothing else differs
        self.assertIn("tables/Gunits.dbf", local["files"])  # the local mod.json keeps them
        # the open mod's mod.json is the local file, byte for byte
        with open(os.path.join(root, "mods", "semga", "mod.json"), "rb") as fp:
            self.assertEqual(members["mods/semga/mod.json"], fp.read())
        # only the closed mod's own table blobs stay here; the ones semga names go
        self.assertNotIn(self.blob(b"closed units", "dbf"), members)
        self.assertNotIn(self.blob(b"closed capital", "dat"), members)
        for data, ext in ((b"same races", "dbf"), (b"semga units", "dbf"), (b"semga capital", "dat"),
                          (b"semga-2", "json")):
            self.assertIn(self.blob(data, ext), members)
        # the closed mod's TApp has the bytes of semga's capital.dat, but with another
        # extension it is another blob, which nobody else names
        self.assertNotIn(self.blob(b"semga capital", "dbf"), members)
        self.assertEqual(sorted(members), sorted(blobs + ["mods/semga/mod.json", "mods/semga-2/mod.json", "mods/index.json"]))

    def test_an_open_mod_keeps_its_tables(self):
        root = self.store()
        members, _blobs = self.tar_of(root, set())
        for mod_id in ("semga", "semga-2"):
            with open(os.path.join(root, "mods", mod_id, "mod.json"), "rb") as fp:
                self.assertEqual(members["mods/%s/mod.json" % mod_id], fp.read())
        self.assertIn(self.blob(b"closed units", "dbf"), members)
        self.assertIn(self.blob(b"closed capital", "dat"), members)

    def test_a_mod_derived_from_a_closed_mod_is_closed_too(self):
        root = self.store_with({
            "semga-2": ("semga", 2, {"a.json": b"x", "tables/Gunits.dbf": b"closed units"}, None),
            "semga-2x": ("semga", 1, {"a.json": b"y", "tables/Gunits.dbf": b"edited units"}, "semga-2"),
        }, "semga-2")
        _index, mods, blobs = store_upload.select(root, ["semga-2", "semga-2x"], include_derived=True, closed={"semga-2"})
        self.assertEqual([sorted(m["files"]) for _, m in mods], [["a.json"], ["a.json"]])
        self.assertNotIn(self.blob(b"edited units", "dbf"), blobs)

    def test_main_reads_closed_mods_from_the_local_config_and_lists_the_same_set(self):
        root = self.store()
        cfg = self.write(json.dumps({"closedMods": ["semga-2"]}), "mods.local.json")
        rc, out, err = run_quiet(store_upload.main, ["--store", root, "--list", "--local-config", cfg])
        self.assertEqual(rc, 0)
        members, _blobs = self.tar_of(root, {"semga-2"})
        self.assertEqual(sorted(out.split()), sorted(members))
        self.assertIn("closed mod semga-2: 4 files left out of its mod.json", err)
        self.assertIn("3 blobs not sent", err)  # closed units, closed capital, the .dbf of semga capital

        tgz = os.path.join(self.tmp, "up.tgz")
        rc, _out, _err = run_quiet(store_upload.main, ["--store", root, "--tar", tgz, "--local-config", cfg])
        self.assertEqual(rc, 0)
        with tarfile.open(tgz, mode="r:gz") as tar:
            self.assertEqual(sorted(tar.getnames()), sorted(members))
            closed = json.loads(tar.extractfile("mods/semga-2/mod.json").read().decode("utf-8"))
        self.assertEqual(sorted(closed["files"]), ["a.json"])

    def test_with_closed_tables_a_closed_mod_goes_up_whole(self):
        root = self.store()
        cfg = self.write(json.dumps({"closedMods": ["semga-2"]}), "mods.local.json")
        rc, out, err = run_quiet(store_upload.main, ["--store", root, "--list", "--local-config", cfg, "--with-closed-tables"])
        self.assertEqual(rc, 0)
        self.assertIn("closed mods semga-2 go up WITH their tables", err)
        self.assertNotIn("files left out", err)
        members, _blobs = self.tar_of(root, set())
        self.assertEqual(sorted(out.split()), sorted(members))
        self.assertIn(self.blob(b"closed units", "dbf"), out.split())
        self.assertIn(self.blob(b"closed capital", "dat"), out.split())

    def test_without_a_local_config_no_mod_is_closed(self):
        root = self.store()
        with mock.patch.object(store_upload, "DEFAULT_LOCAL_CONFIG", os.path.join(self.tmp, "absent.json")):
            rc, out, err = run_quiet(store_upload.main, ["--store", root, "--list"])
        self.assertEqual(rc, 0)
        self.assertIn("no mod is treated as closed", err)
        self.assertIn(self.blob(b"closed units", "dbf"), out.split())
        # a config named on the command line has to be there
        with self.assertRaisesRegex(store_upload.UploadError, "no local config"):
            run_quiet(store_upload.main, ["--store", root, "--list", "--local-config", os.path.join(self.tmp, "typo.json")])


if __name__ == "__main__":
    unittest.main()
