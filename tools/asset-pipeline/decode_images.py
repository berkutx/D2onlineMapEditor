"""decode_images: color-key + trim embedded PNGs into atlas-ready frames.

A :class:`Frame` carries the trimmed RGBA pixels plus the trim metadata Pixi needs
(``spriteSourceSize`` / ``sourceSize``) so the renderer can restore the original iso
anchor after the transparent margins were cropped away.
"""
import numpy as np

from fflib import shaders


class Frame(object):
    """One decoded, color-keyed, trimmed sprite."""

    __slots__ = ("key", "rgba", "src_w", "src_h", "trim_x", "trim_y", "shader")

    def __init__(self, key, rgba, src_w, src_h, trim_x, trim_y, shader):
        self.key = key            # frame key (e.g. "HU_00")
        self.rgba = rgba          # trimmed HxWx4 uint8 numpy array
        self.src_w = src_w        # original (untrimmed) width
        self.src_h = src_h        # original height
        self.trim_x = trim_x      # left offset of trimmed content in the original
        self.trim_y = trim_y      # top offset
        self.shader = shader

    @property
    def w(self):
        return int(self.rgba.shape[1])

    @property
    def h(self):
        return int(self.rgba.shape[0])

    @property
    def trimmed(self):
        return (self.trim_x != 0 or self.trim_y != 0
                or self.w != self.src_w or self.h != self.src_h)


def _trim_bbox(alpha):
    """Return ``(x0, y0, x1, y1)`` bounding box of non-transparent pixels, or None."""
    cols = np.where(alpha.any(axis=0))[0]
    rows = np.where(alpha.any(axis=1))[0]
    if cols.size == 0 or rows.size == 0:
        return None
    return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1


def decode_frame(ff_image, key, shader="default", trim=True):
    """Decode one :class:`extract_ff.FFImage` into a :class:`Frame`."""
    im = ff_image.open()
    rgba, _ntrans = shaders.colorkey(im, kind=shader)
    src_h, src_w = rgba.shape[0], rgba.shape[1]
    trim_x = trim_y = 0
    if trim:
        bbox = _trim_bbox(rgba[..., 3] != 0)
        if bbox is None:
            # fully transparent -> keep a 1x1 stub so it still has a frame
            rgba = rgba[:1, :1]
        else:
            x0, y0, x1, y1 = bbox
            trim_x, trim_y = x0, y0
            rgba = rgba[y0:y1, x0:x1]
    return Frame(key, np.ascontiguousarray(rgba), src_w, src_h, trim_x, trim_y, shader)
