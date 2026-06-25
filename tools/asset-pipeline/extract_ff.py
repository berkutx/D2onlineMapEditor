"""extract_ff: walk a .ff archive into named PNG records.

Combines mqdb (container walk) + optindex (id->name) into a single helper the
higher stages consume. Pure data extraction - no Pillow needed here.
"""
import io
import os

from fflib import mqdb, optindex


class FFImage(object):
    """A named, embedded PNG inside a .ff archive."""

    __slots__ = ("id", "name", "png_bytes")

    def __init__(self, rid, name, png_bytes):
        self.id = rid
        self.name = name
        self.png_bytes = png_bytes

    def open(self):
        """Open as a Pillow image (lazy import to keep this module Pillow-free)."""
        from PIL import Image

        return Image.open(io.BytesIO(self.png_bytes))


def extract(path):
    """Return ``(archive_name, [FFImage, ...])`` for a ``.ff`` file."""
    recs = mqdb.parse_ff(path)
    names = optindex.png_name_index(recs)
    images = []
    for r in mqdb.png_records(recs):
        images.append(FFImage(r.id, names.get(r.id, "id_%d.PNG" % r.id), r.payload))
    return os.path.basename(path), images


def find_archive(game_dir, basename):
    """Locate ``basename`` (e.g. ``IsoTerrn.ff``) under ``Game/Imgs`` or ``Game/Interf``."""
    for sub in ("Imgs", "Interf"):
        cand = os.path.join(game_dir, sub, basename)
        if os.path.isfile(cand):
            return cand
    return None
