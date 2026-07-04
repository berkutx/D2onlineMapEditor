"""Tests for the D2 asset pipeline.

Runs under pytest *or* plain ``python -m unittest`` (pytest is not installed on the
3.7 interpreter). Tests that need the real game assets skip gracefully when the
game directory is absent.
"""
import io
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
REPO = os.path.normpath(os.path.join(PKG, "..", ".."))
sys.path.insert(0, PKG)

import build_animations
import build_atlases
import decode_images
import extract_ff
import manifest as manifest_mod
from fflib import mqdb, optindex, packer, shaders

GAME_DIR = os.environ.get("D2_GAME_DIR_GAME", os.path.join(os.environ.get("D2_GAME_DIR", "."), "Game"))
OUT_DIR = os.path.join(REPO, "public", "assets")


def _have_game():
    return extract_ff.find_archive(GAME_DIR, "IsoTerrn.ff") is not None


class TestMqdbParse(unittest.TestCase):
    """MQDB container walk + id->name table on a real archive."""

    @unittest.skipUnless(_have_game(), "game assets not available")
    def test_parse_real_archive(self):
        path = extract_ff.find_archive(GAME_DIR, "IsoTerrn.ff")
        recs = mqdb.parse_ff(path)
        self.assertGreater(len(recs), 0)
        pngs = mqdb.png_records(recs)
        self.assertGreater(len(pngs), 50)
        # every PNG record payload really starts with the PNG signature
        for r in pngs[:10]:
            self.assertEqual(r.payload[:8], mqdb.PNG_SIG)

    @unittest.skipUnless(_have_game(), "game assets not available")
    def test_name_table_high_coverage(self):
        path = extract_ff.find_archive(GAME_DIR, "GrBorder.ff")
        recs = mqdb.parse_ff(path)
        names = optindex.png_name_index(recs)
        png_ids = {r.id for r in mqdb.png_records(recs)}
        named = {i for i, n in names.items() if not n.startswith("@")}
        # >= 95% of PNG records resolve to a real name (verified ~99%)
        self.assertGreaterEqual(len(named) / float(len(png_ids)), 0.95)
        # the .PNG.PNG quirk must collapse cleanly
        from fflib import naming
        self.assertEqual(naming.frame_key("FOO.PNG.PNG"), "FOO")


class TestColorKey(unittest.TestCase):
    """Magenta color-key yields real transparency for P and RGB tiles."""

    @unittest.skipUnless(_have_game(), "game assets not available")
    def test_palette_tile_keyed(self):
        # City.ff first PNG is mode 'P' with magenta palette index 0.
        _n, imgs = extract_ff.extract(extract_ff.find_archive(GAME_DIR, "City.ff"))
        im = imgs[0].open()
        self.assertEqual(im.mode, "P")
        rgba, ntrans = shaders.colorkey(im)
        self.assertEqual(rgba.shape[2], 4)
        self.assertGreater(ntrans, 0)  # P tile must have keyed (transparent) pixels
        self.assertTrue((rgba[..., 3] == 0).any())

    @unittest.skipUnless(_have_game(), "game assets not available")
    def test_rgb_tile_keyed(self):
        # GrBorder.ff tiles are mode 'RGB' with per-pixel magenta.
        _n, imgs = extract_ff.extract(extract_ff.find_archive(GAME_DIR, "GrBorder.ff"))
        rgb_img = next(i for i in imgs if i.open().mode == "RGB")
        im = rgb_img.open()
        rgba, ntrans = shaders.colorkey(im)
        self.assertEqual(rgba.shape[2], 4)
        self.assertGreater(ntrans, 0)
        self.assertTrue((rgba[..., 3] == 0).any())

    def test_synthetic_magenta(self):
        # No game assets needed: a hand-built magenta image must key out.
        from PIL import Image
        import numpy as np
        arr = np.zeros((4, 4, 3), dtype=np.uint8)
        arr[:, :, 0] = 255  # R
        arr[:, :, 2] = 255  # B  -> magenta everywhere, g=0
        im = Image.fromarray(arr, "RGB")
        rgba, ntrans = shaders.colorkey(im)
        self.assertEqual(ntrans, 16)
        self.assertTrue((rgba[..., 3] == 0).all())


class TestPacker(unittest.TestCase):
    def test_pack_within_cap(self):
        rects = [("a", 100, 100), ("b", 50, 200), ("c", 300, 80)]
        placements, pages = packer.pack(rects, max_size=512)
        self.assertEqual(len(placements), 3)
        for w, h in pages:
            self.assertLessEqual(w, 512)
            self.assertLessEqual(h, 512)
        # no overlaps on a single page
        for i, a in enumerate(placements):
            for b in placements[i + 1:]:
                if a.page != b.page:
                    continue
                overlap = not (a.x + a.w <= b.x or b.x + b.w <= a.x
                               or a.y + a.h <= b.y or b.y + b.h <= a.y)
                self.assertFalse(overlap, "overlap %r/%r" % (a.key, b.key))

    def test_split_into_multiple_pages(self):
        # 10 tiles of 600x600 cannot all fit a 1024 page -> multiple pages.
        rects = [("t%d" % i, 600, 600) for i in range(10)]
        placements, pages = packer.pack(rects, max_size=1024)
        self.assertEqual(len(placements), 10)
        self.assertGreater(len(pages), 1)


class TestAnimations(unittest.TestCase):
    def test_group_and_fps(self):
        # trailing digit run is the frame index; the prefix is the group.
        keys = ["BEACONA11", "BEACONA12", "BEACONA13", "LONELY1"]
        anims = build_animations.group_animations(keys)
        self.assertIn("BEACONA", anims)
        self.assertEqual(anims["BEACONA"], ["BEACONA11", "BEACONA12", "BEACONA13"])
        self.assertNotIn("LONELY", anims)  # single frame -> not an animation
        defs = build_animations.animation_defs(anims, "iso-anim")
        self.assertTrue(defs)
        for d in defs:
            self.assertAlmostEqual(d["fps"], 1000.0 / 42, places=4)  # ~23.81
            self.assertAlmostEqual(d["fps"], 23.80952, places=4)
            self.assertEqual(d["frameDurationMs"], 42)


class TestManifest(unittest.TestCase):
    """The emitted manifest.json validates against the Contract-B JSON Schema."""

    @classmethod
    def setUpClass(cls):
        cls.manifest_path = os.path.join(OUT_DIR, "manifest.json")
        if not os.path.isfile(cls.manifest_path) and _have_game():
            # generate it on demand
            import pipeline
            pipeline.run_stage1(GAME_DIR, OUT_DIR)

    def _load(self):
        if not os.path.isfile(self.manifest_path):
            self.skipTest("manifest.json not generated (no game assets)")
        with open(self.manifest_path) as fp:
            return json.load(fp)

    def test_validates_against_schema(self):
        m = self._load()
        ok, msg = manifest_mod.validate(m)
        self.assertTrue(ok, msg)

    def test_structure(self):
        m = self._load()
        self.assertEqual(m["manifestVersion"], manifest_mod.MANIFEST_VERSION)
        self.assertEqual(m["tickMs"], 42)
        self.assertTrue(m["spritesheets"])
        self.assertIn("terrain", m)
        # at least one animation with frames and fps ~= 23.81
        self.assertTrue(m["animations"])
        anim = m["animations"][0]
        self.assertTrue(anim["frames"])
        self.assertAlmostEqual(anim["fps"], 23.80952, places=4)

    def test_index_resolves_animation_frames(self):
        m = self._load()
        for a in m["animations"]:
            for fr in a["frames"]:
                self.assertIn(fr, m["index"])

    def test_validator_rejects_bad_manifest(self):
        # the builtin schema walker must actually reject malformed input
        schema = manifest_mod.load_schema()
        if schema is None:
            self.skipTest("schema file not present")
        root = schema["definitions"]["AssetManifest"]
        errs = []
        bad = {"manifestVersion": 1, "bogus": True}  # wrong type + extra prop
        manifest_mod.validate_against_schema(bad, root, "m", errs)
        self.assertTrue(errs)

    def test_spritesheets_validate(self):
        m = self._load()
        schema_path = os.path.join(
            REPO, "packages", "asset-manifest", "gen", "spritesheet.schema.json")
        if not os.path.isfile(schema_path):
            self.skipTest("spritesheet schema not present")
        with open(schema_path) as fp:
            sheet_schema = json.load(fp)["definitions"]["Spritesheet"]
        for ref in m["spritesheets"][:8]:
            path = os.path.join(OUT_DIR, ref["meta"])
            if not os.path.isfile(path):
                continue
            with open(path) as fp:
                sheet = json.load(fp)
            errs = []
            manifest_mod.validate_against_schema(sheet, sheet_schema, ref["meta"], errs)
            self.assertEqual(errs, [], "%s: %s" % (ref["meta"], errs[:3]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
