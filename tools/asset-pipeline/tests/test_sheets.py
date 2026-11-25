"""build_sheets: per-record palette sheets.

The synthetic tests need nothing. The equality test needs a real game install (D2_GAME_DIR or
game-dir.local) and is skipped without one: it rebuilds every frame of the object archives
from the new sheets and compares it, pixel for pixel, with what GameResource.get_frames — the
faithful port of the editor's decoder that pipeline.py uses — returns for the same id.
"""
import io
import os
import sys
import unittest

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

import build_sheets  # noqa: E402
import extract_ff  # noqa: E402
from decode_resource import _shader_for  # noqa: E402
from fflib.gameresource import GameResource, SH_DEFAULT, SH_TRANSP_BLACK, transparent_colors  # noqa: E402

MAGENTA = (255, 0, 255)


def palette(*colors):
    pal = np.zeros((256, 3), np.uint8)
    for i, c in enumerate(colors):
        pal[i] = c
    return pal


def indexed(key, rows, pal, shader=SH_DEFAULT):
    return build_sheets.RawFrame(key, idx=np.array(rows, np.uint8), palette=pal,
                                 transp=transparent_colors(pal, shader))


def decode(sheet):
    """A sheet's PNG as RGBA, the way a browser sees it."""
    return np.array(Image.open(io.BytesIO(sheet.png)).convert("RGBA"))


def frame_rgba(sheet, pixels, entry):
    """One frame restored to its untrimmed size (transparent where it was trimmed)."""
    _key, x, y, w, h, tx, ty, sw, sh = entry
    out = np.zeros((sh, sw, 4), np.uint8)
    out[ty:ty + h, tx:tx + w] = pixels[y:y + h, x:x + w]
    return out


def same_picture(a, b):
    """Equal where it shows: same alpha, same colour under every visible pixel."""
    if a.shape != b.shape or not np.array_equal(a[..., 3], b[..., 3]):
        return False
    visible = a[..., 3] != 0
    return np.array_equal(a[visible], b[visible])


class TestMakeSheets(unittest.TestCase):
    def setUp(self):
        self.pal = palette(MAGENTA, (10, 20, 30), (200, 100, 50), (0, 0, 0))

    def test_palette_sheet_keeps_indices_and_keys_out_the_colour_key(self):
        raw = indexed("A", [[0, 0, 0, 0], [0, 1, 2, 0], [0, 3, 1, 0], [0, 0, 0, 0]], self.pal)
        (sheet,) = build_sheets.make_sheets("t/1", [raw])
        self.assertEqual(sheet.mode, "P")
        self.assertEqual(Image.open(io.BytesIO(sheet.png)).mode, "P")
        # trimmed to the 2x2 that shows; the offset restores the original placement
        self.assertEqual(sheet.frames, [("A", 0, 0, 2, 2, 1, 1, 4, 4)])
        self.assertTrue(same_picture(frame_rgba(sheet, decode(sheet), sheet.frames[0]), raw.to_rgba()))
        # black is ordinary art under the default shader ...
        self.assertEqual(decode(sheet)[1, 0].tolist(), [0, 0, 0, 255])
        # ... and transparent under the crystals' one
        black = indexed("B", [[1, 3], [3, 3]], self.pal, SH_DEFAULT | SH_TRANSP_BLACK)
        (sheet2,) = build_sheets.make_sheets("t/2", [black])
        self.assertEqual(sheet2.frames, [("B", 0, 0, 1, 1, 0, 0, 2, 2)])

    def test_same_frames_give_the_same_bytes(self):
        def frames():
            return [indexed("A", [[1, 2], [2, 1]], self.pal), indexed("B", [[0, 1, 1], [2, 2, 2]], self.pal)]
        a = build_sheets.make_sheets("t/1", frames())
        b = build_sheets.make_sheets("t/1", list(reversed(frames())))  # input order does not matter
        self.assertEqual([s.png for s in a], [s.png for s in b])
        self.assertEqual(sorted(a[0].frames), sorted(b[0].frames))

    def test_frames_do_not_overlap_and_all_survive(self):
        rng = np.random.RandomState(7)
        raws = [indexed("F%02d" % i, rng.randint(1, 3, size=(rng.randint(3, 40), rng.randint(3, 60))), self.pal)
                for i in range(40)]
        (sheet,) = build_sheets.make_sheets("t/many", raws)
        pixels = decode(sheet)
        used = np.zeros(pixels.shape[:2], bool)
        by_key = dict((r.key, r) for r in raws)
        for entry in sheet.frames:
            _k, x, y, w, h = entry[:5]
            self.assertFalse(used[y:y + h, x:x + w].any(), "frames overlap")
            used[y:y + h, x:x + w] = True
            self.assertTrue(same_picture(frame_rgba(sheet, pixels, entry), by_key[entry[0]].to_rgba()))
        self.assertEqual(len(sheet.frames), 40)

    def test_frames_with_different_palettes_fall_back_to_rgba(self):
        other = palette(MAGENTA, (1, 2, 3), (4, 5, 6))
        a = indexed("A", [[1, 2]], self.pal)
        b = indexed("B", [[1, 2]], other)
        (sheet,) = build_sheets.make_sheets("t/mixed", [a, b])
        self.assertEqual(sheet.mode, "RGBA")
        pixels = decode(sheet)
        for entry in sheet.frames:
            raw = a if entry[0] == "A" else b
            self.assertTrue(same_picture(frame_rgba(sheet, pixels, entry), raw.to_rgba()))

    def test_a_palette_without_a_transparent_entry_falls_back_to_rgba(self):
        opaque = palette((9, 9, 9), (10, 20, 30))
        (sheet,) = build_sheets.make_sheets("t/opaque", [indexed("A", [[0, 1], [1, 0]], opaque)])
        self.assertEqual(sheet.mode, "RGBA")
        self.assertEqual(sheet.frames, [("A", 0, 0, 2, 2, 0, 0, 2, 2)])

    def test_an_empty_frame_keeps_a_stub(self):
        (sheet,) = build_sheets.make_sheets("t/empty", [indexed("A", [[0, 0], [0, 0]], self.pal)])
        self.assertEqual(sheet.frames, [("A", 0, 0, 1, 1, 0, 0, 2, 2)])
        self.assertEqual(int(decode(sheet)[0, 0, 3]), 0)

    def test_true_colour_sources_are_keyed_by_colour_and_coverage(self):
        rgb = np.zeros((2, 3, 3), np.uint8)
        rgb[0, 0] = MAGENTA
        rgb[0, 1] = (7, 8, 9)
        rgb[1, 2] = (0, 0, 0)
        # the frame is 3x2 but its one part covers only the first two columns
        raw = build_sheets.raw_frame("A", ("RGB", rgb, None), 3, 2, [(0, 0, 0, 0, 2, 2)], SH_DEFAULT)
        self.assertEqual(raw.rgba[..., 3].tolist(), [[0, 255, 0], [255, 255, 0]])


class TestFrameTable(unittest.TestCase):
    """Keys from several archives in one table (the rules of build_sheets.FrameTable)."""

    def sheet(self, sid, *keys):
        frames = [(k, 10 * i, 0, 8, 8, 0, 0, 8, 8) for i, k in enumerate(keys)]
        return build_sheets.Sheet(sid, b"png", 10 * len(keys), 8, frames, "P")

    def test_an_animation_uses_the_frames_of_its_own_archive(self):
        # Both archives have a frame called "0H": a screen picture in the first, a frame of
        # the capital's animation in the second. Short frame names repeat like that.
        t = build_sheets.FrameTable()
        first, second = {}, {}
        t.add_sheet(self.sheet("iso-cmon/1", "0H", "G000FT0000HU0"), "a.png", own=first, scope="iso-cmon")
        t.add_animations([], first)
        t.add_sheet(self.sheet("iso-anim/7", "0H", "1H"), "b.png", lazy=True, own=second, scope="iso-anim")
        t.add_animations([("G000FT0000HU0", ["0H", "1H"])], second)

        self.assertEqual(t.frames["0H"][0], 0)            # the plain key stays the first archive's
        self.assertEqual(t.frames["iso-anim:0H"][0], 1)   # the second one is kept, qualified
        (anim,) = t.animations
        self.assertEqual(anim["frames"], ["iso-anim:0H", "1H"])
        self.assertEqual(anim["atlas"], "iso-anim/7")
        # the animation shares its id with the still of the first archive: both exist
        self.assertEqual(t.frames["G000FT0000HU0"][0], 0)
        self.assertEqual(t.shadowed, 1)
        self.assertEqual([r.get("lazy", False) for r in t.refs], [False, True])

    def test_frames_an_archive_lacks_and_one_frame_animations(self):
        t = build_sheets.FrameTable()
        own = {}
        t.add_sheet(self.sheet("x/1", "A", "B"), "a.png", own=own, scope="x")
        t.add_animations([
            ("TWO", ["A", "MISSING", "B"]),  # a name without an image is skipped
            ("ONE", ["B"]),                  # one frame: another name of that frame
            ("NONE", ["MISSING"]),
            ("TWO", ["B", "A"]),             # an id is defined once
        ], own)
        self.assertEqual([(a["id"], a["frames"]) for a in t.animations], [("TWO", ["A", "B"])])
        self.assertEqual(t.frames["ONE"], t.frames["B"])
        self.assertNotIn("NONE", t.frames)

    def test_a_taken_key_without_a_scope_is_dropped(self):
        t = build_sheets.FrameTable()
        t.add_sheet(self.sheet("a", "K"), "a.png")
        t.add_sheet(self.sheet("b", "K", "L"), "b.png")
        self.assertEqual(sorted(t.frames), ["K", "L"])
        self.assertEqual(t.frames["K"][0], 0)


def _game_dir():
    for cand in (os.environ.get("D2_GAME_DIR"),):
        if cand and os.path.isdir(cand):
            return cand
    marker = os.path.join(HERE, "..", "..", "..", "game-dir.local")
    if os.path.isfile(marker):
        with open(marker, encoding="utf-8") as fp:
            cand = fp.read().strip()
        for sub in ("Game", ""):
            if os.path.isdir(os.path.join(cand, sub, "Imgs")):
                return os.path.join(cand, sub)
    return None


GAME = _game_dir()


@unittest.skipUnless(GAME, "needs a game install (D2_GAME_DIR or game-dir.local)")
class TestAgainstTheEditorDecoder(unittest.TestCase):
    """Every frame of an archive, rebuilt from the sheets, equals GameResource.get_frames.

    The frames are found the way a client finds them — through ONE table holding all the
    archives (build_sheets.FrameTable), in the build's order — so a frame name that repeats
    in another archive must still lead an animation to its own picture."""

    @classmethod
    def setUpClass(cls):
        cls.table = build_sheets.FrameTable()
        cls.archives = {}  # bundle -> (path, sheets, animations, own keys)
        for bundle, archive, lazy in build_sheets.OBJECT_ARCHIVES:
            path = extract_ff.find_archive(GAME, archive)
            if not path:
                continue
            sheets, animations = build_sheets.archive_sheets(path, bundle)
            own = {}
            for s in sheets:
                cls.table.add_sheet(s, s.id + ".png", archive, lazy, own, bundle)
            cls.table.add_animations(animations, own)
            cls.archives[bundle] = (path, sheets, animations, own)

    def check_archive(self, archive, bundle):
        if bundle not in self.archives:
            self.skipTest("%s not in this install" % archive)
        path, sheets, animations, own = self.archives[bundle]
        pixels = dict((s.id, decode(s)) for s in sheets)
        seen = set()
        for s in sheets:
            for entry in s.frames:
                self.assertNotIn(entry[0], seen, "a key is defined twice in one archive")
                seen.add(entry[0])
        anims = dict(animations)
        table = self.table

        def rebuilt(table_key):
            entry = table.frames[table_key]
            sid = table.refs[entry[0]]["id"]
            return frame_rgba(None, pixels[sid], [table_key] + entry[1:])

        gr = GameResource(path)
        compared = 0
        for name in gr.all_names():
            try:
                old = gr.get_frames(name, _shader_for(name))
            except Exception:  # noqa: BLE001 - pipeline.py drops these names too
                old = []
            key = name.upper()
            if not old:
                self.assertNotIn(key, own, "%s: the editor decoder yields nothing" % key)
                continue
            # an image is its own key; an animation is the frames of its list that resolve
            keys = [own[key]] if key in own else [own[k] for k in anims.get(key, []) if k in own]
            self.assertEqual(len(keys), len(old), "%s: frame count" % key)
            for k, frame in zip(keys, old):
                self.assertTrue(same_picture(rebuilt(k), frame), "%s (%s) differs" % (key, k))
                compared += 1
            # ... and the manifest's own animation of this archive lists exactly those frames
            for anim in table.animations:
                if anim["id"] == key and anim["atlas"].startswith(bundle + "/") and len(old) > 1:
                    self.assertEqual(anim["frames"], keys, "%s: manifest animation" % key)
        self.assertGreater(compared, 0)
        return compared

    def test_iso_terrn(self):
        self.check_archive("IsoTerrn.ff", "iso-terrn")

    def test_iso_still(self):
        self.check_archive("IsoStill.ff", "iso-still")

    def test_iso_cmon(self):
        self.check_archive("IsoCmon.ff", "iso-cmon")

    def test_city(self):
        self.check_archive("City.ff", "city")

    def test_iso_anim(self):
        self.check_archive("IsoAnim.ff", "iso-anim")


if __name__ == "__main__":
    unittest.main()
