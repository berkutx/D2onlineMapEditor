"""Derived mods: build_mod's --parent, derive_mod's checks and clean-up, and store_upload's
choice of what goes to a server. Synthetic stores and installs in a temp dir; no game needed.

    py -3.7 -W ignore -m unittest tests.test_derive        (from tools/asset-pipeline)
"""
import io
import json
import os
import shutil
import stat
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stderr

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import build_mod  # noqa: E402
import derive_mod  # noqa: E402
import store_upload  # noqa: E402
from fflib.blobstore import BlobStore  # noqa: E402

FP = "a" * 64


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="d2-derive-")

    def tearDown(self):
        for root, _dirs, names in os.walk(self.tmp):
            for n in names:
                p = os.path.join(root, n)
                os.chmod(p, os.stat(p).st_mode | stat.S_IWRITE)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def path(self, *parts):
        p = os.path.join(self.tmp, *parts)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p

    def write(self, data, *parts):
        p = self.path(*parts)
        with open(p, "wb") as fp:
            fp.write(data if isinstance(data, bytes) else data.encode("utf-8"))
        return p

    def store_with(self, mods, default):
        """A store of mods {id: (family, order, {logical: bytes}, parent or None)}."""
        root = os.path.join(self.tmp, "store")
        store = BlobStore(root)
        rows = []
        for mod_id, (family, order, files, parent) in mods.items():
            table = {name: store.put_bytes(data, os.path.splitext(name)[1][1:] or "bin") for name, data in files.items()}
            mod = {"schemaVersion": 1, "id": mod_id, "name": mod_id, "family": family, "familyOrder": order,
                   "status": "data-only", "contentFingerprint": FP, "files": table}
            if parent:
                mod["parent"] = {"modId": parent, "contentFingerprint": FP}
            self.write(build_mod.dump_json(mod), "store", "mods", mod_id, "mod.json")
            rows.append({k: mod[k] for k in ("id", "name", "family", "familyOrder", "status", "contentFingerprint")})
        self.write(build_mod.dump_json({"schemaVersion": 1, "defaultModId": default, "mods": rows}), "store", "mods", "index.json")
        return root


def quiet(fn, *a):
    with redirect_stderr(io.StringIO()):
        return fn(*a)


class TestBuildModParent(Case):
    def run_main(self, *extra):
        game = os.path.dirname(self.path("game", "Globals", "x"))
        os.makedirs(game, exist_ok=True)
        argv = ["--game", os.path.dirname(game), "--mod-id", "child", "--store", os.path.join(self.tmp, "store")] + list(extra)
        return quiet(build_mod.main, argv)

    def test_refuses_flags_a_derived_mod_cannot_have(self):
        for flags in (["--parent", "child"], ["--parent", "semga", "--default"], ["--parent", "semga", "--source-url", "http://x"],
                      ["--parent", "semga", "--engine-fingerprint", FP], ["--parent", "semga", "--reference"]):
            with self.assertRaises(SystemExit, msg=" ".join(flags)):
                self.run_main(*flags)

    def test_needs_a_parent_in_the_store_that_is_not_derived(self):
        self.store_with({"semga": ("semga", 1, {"a.json": b"{}"}, None), "semga-x": ("semga", 0, {"a.json": b"{}"}, "semga")}, "semga")
        with self.assertRaisesRegex(build_mod.BuildError, "no mods/nope/mod.json"):
            self.run_main("--parent", "nope")
        with self.assertRaisesRegex(build_mod.BuildError, "itself derived from semga"):
            self.run_main("--parent", "semga-x")
        self.assertEqual(build_mod.load_parent(os.path.join(self.tmp, "store"), "semga")["id"], "semga")

    def test_one_reference_mod_per_store(self):
        root = self.store_with({"vanilla": ("vanilla", 1, {"a.json": b"{}"}, None)}, "vanilla")
        index_path = os.path.join(root, "mods", "index.json")
        with open(index_path, encoding="utf-8") as fp:
            index = json.load(fp)
        index["mods"][0]["reference"] = True
        self.write(build_mod.dump_json(index), "store", "mods", "index.json")
        with self.assertRaisesRegex(build_mod.BuildError, "vanilla is the store's reference already"):
            self.run_main("--reference")

    def test_is_inside_ignores_case_and_other_drives(self):
        self.assertTrue(build_mod.is_inside(r"C:\GOG Games\X\var", r"c:\gog games\x"))
        self.assertFalse(build_mod.is_inside(r"D:\x", r"C:\x"))
        self.assertFalse(build_mod.is_inside(r"C:\xy", r"C:\x"))

    def test_game_data_never_becomes_a_blob(self):
        for name in ("Globals/GUnits.DBF", "x/IsoUnit.ff", "-INDEX.OPT", "Discipl2.exe"):
            self.assertTrue(name.lower().endswith(build_mod.GAME_DATA_EXTENSIONS), name)
        for name in ("unitCatalog.json", "modscripts/a.lua", "blobs/aa/x.png"):
            self.assertFalse(name.lower().endswith(build_mod.GAME_DATA_EXTENSIONS), name)


class TestDeriveChecks(Case):
    def edits(self, **over):
        e = {"kind": "d2-mod-edits", "version": 1, "modId": "semga-x", "name": "X", "parent": {"modId": "semga"},
             "tables": {}, "journal": [], "cursor": 0}
        e.update(over)
        return self.write(json.dumps(e), "edits.json")

    def test_reads_only_an_edit_file(self):
        self.assertEqual(derive_mod.load_edits(self.edits())["modId"], "semga-x")
        for bad in ({"kind": "other"}, {"version": 2}, {"modId": "Semga X"}, {"parent": {"modId": "semga-x"}}, {"parent": {}}):
            with self.assertRaises(derive_mod.DeriveError, msg=str(bad)):
                derive_mod.load_edits(self.edits(**bad))

    def test_ranks_below_the_parent_unless_told(self):
        self.assertEqual(derive_mod.family_order({}, {"familyOrder": 2}), 1)
        self.assertEqual(derive_mod.family_order({"familyOrder": 5}, {"familyOrder": 2}), 5)

    def test_refuses_a_closed_parent_and_an_install_of_another_build(self):
        self.store_with({"semga": ("semga", 1, {"a.json": b"{}"}, None)}, "semga")
        cfg = self.write(json.dumps({"closedMods": ["semga"]}), "mods.local.json")
        saved = derive_mod.local_config
        derive_mod.local_config = lambda path=None: saved(cfg)
        try:
            with self.assertRaisesRegex(derive_mod.DeriveError, "closed mod"):
                quiet(derive_mod.main, ["--edits", self.edits(), "--store", os.path.join(self.tmp, "store")])
        finally:
            derive_mod.local_config = saved
        game = os.path.dirname(self.write(b"x", "game", "Globals", "Gunits.dbf"))
        with self.assertRaisesRegex(derive_mod.DeriveError, "is not the store's semga"):
            derive_mod.check_install_matches(os.path.dirname(game), {"id": "semga", "contentFingerprint": FP})

    def test_refuses_to_overwrite_a_mod_that_is_not_derived(self):
        root = self.store_with({"semga": ("semga", 1, {"a.json": b"{}"}, None), "smns3": ("smns", 3, {"a.json": b"{}"}, None)}, "semga")
        with self.assertRaisesRegex(derive_mod.DeriveError, "not a derived mod"):
            quiet(derive_mod.main, ["--edits", self.edits(modId="smns3"), "--store", root])

    def test_finds_the_files_the_edits_change(self):
        game = os.path.join(self.tmp, "game")
        self.write(b"t", "game", "Globals", "GUnits.dbf")
        self.write(b"t", "game", "Interf", "TApp.dbf")
        self.write(b"f", "game", "Imgs", "IsoUnit.ff")
        ops = [{"op": "dbf.set", "table": "Gunits", "key": ["G000UU0001"], "field": "LEVEL", "value": 2},
               {"op": "dbf.set", "table": "TApp", "key": ["X"], "field": "TEXT", "value": "a"},
               {"op": "ff.deleteRecord", "archive": "isounit.ff", "name": "A"},
               {"op": "dbf.delete", "table": "Gbuild", "key": ["G000BB0001"]}]
        e = {"journal": [{"ops": ops[:3]}, {"ops": ops[3:]}], "cursor": 1}
        got = [os.path.relpath(p, game).replace("\\", "/") for p in derive_mod.edited_files(e, game)]
        self.assertEqual(got, ["Globals/GUnits.dbf", "Imgs/IsoUnit.ff", "Interf/TApp.dbf"])

    def test_removing_the_work_folder_leaves_the_parents_files(self):
        game = os.path.join(self.tmp, "game")
        plain = self.write(b"plain", "game", "Globals", "a.dbf")
        locked = self.write(b"locked", "game", "Imgs", "b.ff")
        os.chmod(locked, stat.S_IREAD)
        work = os.path.join(self.tmp, "work")
        os.makedirs(os.path.join(work, "Globals"))
        os.makedirs(os.path.join(work, "Imgs"))
        os.link(plain, os.path.join(work, "Globals", "a.dbf"))
        os.link(locked, os.path.join(work, "Imgs", "b.ff"))
        self.write(b"new", "work", "Globals", "c.dbf")
        derive_mod.remove_work(work, game)
        self.assertFalse(os.path.exists(work))
        with open(plain, "rb") as fp:
            self.assertEqual(fp.read(), b"plain")
        with open(locked, "rb") as fp:
            self.assertEqual(fp.read(), b"locked")
        self.assertFalse(os.stat(locked).st_mode & stat.S_IWRITE)


class TestStoreUpload(Case):
    def test_leaves_derived_mods_and_unnamed_blobs_out(self):
        root = self.store_with({
            "semga": ("semga", 1, {"a.json": b"semga", "shared.json": b"same"}, None),
            "semga-x": ("semga", 0, {"a.json": b"mine", "shared.json": b"same"}, "semga"),
            "smns3": ("smns", 3, {"a.json": b"smns"}, None),
        }, "semga")
        BlobStore(root).put_bytes(b"an old atlas page", "png")
        index, mods, blobs = store_upload.select(root)
        self.assertEqual([m for m, _ in mods], ["semga", "smns3"])
        self.assertEqual([m["id"] for m in index["mods"]], ["semga", "smns3"])
        self.assertEqual(len(blobs), 3)
        buf = io.BytesIO()
        store_upload.write_tar(buf, root, index, mods, blobs)
        buf.seek(0)
        with tarfile.open(fileobj=buf, mode="r:gz") as tar:
            names = tar.getnames()
            self.assertEqual(names[-1], "mods/index.json")
            self.assertGreater(tar.getmember("mods/index.json").mtime, 1700000000)
            self.assertEqual(json.loads(tar.extractfile("mods/index.json").read().decode("utf-8")), index)
        self.assertEqual(sorted(names), sorted(blobs + ["mods/semga/mod.json", "mods/smns3/mod.json", "mods/index.json"]))

    def test_a_derived_mod_goes_up_only_when_named_and_allowed(self):
        root = self.store_with({"semga": ("semga", 1, {"a.json": b"semga"}, None),
                                "semga-x": ("semga", 0, {"a.json": b"mine"}, "semga")}, "semga")
        with self.assertRaisesRegex(store_upload.UploadError, "include-derived"):
            store_upload.select(root, ["semga", "semga-x"])
        _index, mods, _blobs = store_upload.select(root, ["semga", "semga-x"], include_derived=True)
        self.assertEqual([m for m, _ in mods], ["semga", "semga-x"])
        with self.assertRaisesRegex(store_upload.UploadError, "default mod semga"):
            store_upload.select(root, ["semga-x"], include_derived=True)

    def test_refuses_a_store_with_a_blob_missing(self):
        root = self.store_with({"semga": ("semga", 1, {"a.json": b"semga"}, None)}, "semga")
        mod = build_mod.load_mod(root, "semga")
        os.remove(os.path.join(root, *mod["files"]["a.json"].split("/")))
        with self.assertRaisesRegex(store_upload.UploadError, "missing"):
            store_upload.select(root)


if __name__ == "__main__":
    unittest.main()
