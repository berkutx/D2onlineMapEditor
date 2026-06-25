"""Color-key / shader-variant pixel ops.

Promoted from ``spikes/probe_colorkey.py::colorkey``. Disciples 2 has no PNG alpha;
transparency is a magenta color-key ``r>247 && b>247 && g<8`` (palette index 0 is
magenta for ``P`` tiles). We apply it with numpy, per-pixel for RGB and via the
palette for ``P`` images (proven in the spike).

Shader "variants" mirror the toolsqt render kinds so the renderer can pick the
right blend without re-deriving it:
  - ``default``          : magenta -> alpha 0.
  - ``shadows``          : as default; the renderer composites it as a 50% black
                           shadow. We keep RGB but the kind is recorded in meta.
  - ``transparentBlack`` : in addition to magenta, near-black is keyed out (used by
                           glow / additive overlays in IsoAnim).
  - ``border``           : terrain blend tiles; magenta -> alpha 0 (same pixels,
                           tagged so the renderer feathers edges).
"""
import numpy as np

# Magenta key thresholds (VERIFIED in CLAUDE.md).
_R_HI = 247
_B_HI = 247
_G_LO = 8


def _to_rgb(im):
    """Return an ``HxWx3`` uint8 RGB array for a Pillow image (handles ``P``)."""
    if im.mode == "P":
        idx = np.asarray(im)  # H x W palette indices
        pal = np.frombuffer(bytes(im.getpalette() or b""), dtype=np.uint8)
        if pal.size < 768:
            pal = np.concatenate([pal, np.zeros(768 - pal.size, dtype=np.uint8)])
        pal = pal[:768].reshape(-1, 3)
        return pal[idx]
    return np.asarray(im.convert("RGB"))


def magenta_mask(rgb):
    """Boolean ``HxW`` mask of magenta-keyed (transparent) pixels."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return (r > _R_HI) & (b > _B_HI) & (g < _G_LO)


def colorkey(im, kind="default"):
    """Return ``(rgba_uint8_HxWx4, transparent_pixel_count)``.

    ``kind`` selects a shader variant (see module docstring).
    """
    rgb = _to_rgb(im)
    mask = magenta_mask(rgb)
    if kind == "transparentBlack":
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        mask = mask | ((r < _G_LO) & (g < _G_LO) & (b < _G_LO))
    a = np.where(mask, 0, 255).astype(np.uint8)
    rgba = np.dstack([rgb, a])
    return rgba, int(mask.sum())


def has_magenta(im):
    """True if the image contains any magenta-keyed pixel."""
    return bool(magenta_mask(_to_rgb(im)).any())
