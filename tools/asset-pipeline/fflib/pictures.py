"""Interface pictures by name, read the way the game reads them.

Items, spells and lords take their pictures from interface archives (IconItem, IconSpel, Lords)
that carry an index: a NAME -> the record holding its pixels and the parts the picture is put
together from. Two things follow, and the icon builders once got both wrong by walking the
records themselves:

  * a record's file name is not the picture's name. A mod repoints a name at new art and leaves
    the old record lying in the archive, and some names have no record called after them at all;
  * a record's pixels are not the picture. Its parts lie packed side by side; the index says
    where each goes on the canvas (70x85 for an inventory slot).

So a picture is always asked for by name. An archive without an index (Faces) has plain records
and there the name is the record's.
"""
import os

import numpy as np
from PIL import Image

from .gameresource import GameResource, SH_DEFAULT


def find_archive(game_dir, basename):
    """Path of an archive under ``Imgs`` or ``Interf`` of a game root, or None."""
    for sub in ("Imgs", "Interf"):
        cand = os.path.join(game_dir, sub, basename)
        if os.path.isfile(cand):
            return cand
    return None


def trim(rgba):
    """The picture without its transparent margins; None when nothing of it is visible.

    The canvas of an interface picture is the slot it is drawn in, far larger than a potion.
    An icon shown at 22 px wants the picture itself."""
    ys, xs = np.nonzero(rgba[..., 3])
    if not len(ys):
        return None
    return rgba[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]


class PictureArchive(object):
    """One archive of interface pictures."""

    def __init__(self, path):
        self.path = path
        self.res = GameResource(path)

    def has(self, name):
        return bool(name) and self.res.has(name)

    def picture(self, name):
        """A named picture as an RGBA array, colour key applied and margins trimmed; None when
        the archive does not know the name (or holds nothing visible under it)."""
        if not self.has(name):
            return None
        frame = self.res.picture(name, SH_DEFAULT)
        return trim(frame) if frame is not None else None

    def first(self, names):
        """The first of ``names`` that has a picture: ``(name, rgba)`` or ``(None, None)``."""
        for name in names:
            rgba = self.picture(name)
            if rgba is not None:
                return name, rgba
        return None, None


def open_archive(game_dir, basename):
    """The archive ``basename`` of a game root; SystemExit when the install has none."""
    path = find_archive(game_dir, basename)
    if not path:
        raise SystemExit("%s not found under Game/Imgs|Interf" % basename)
    return PictureArchive(path)


def save(rgba, path):
    Image.fromarray(np.ascontiguousarray(rgba), "RGBA").save(path)
