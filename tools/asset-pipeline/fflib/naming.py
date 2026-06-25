"""Name classification + normalization for D2 assets.

Handles the ``.PNG.PNG`` double-extension quirk (some recolored variants in
IsoTerrn/Capital/IsoAnim carry it), produces clean frame keys, and classifies
names into the categories the terrain/object/animation builders need.
"""
import re

# Race two-letter codes used by Ground.ff base tiles and GrBorder.ff land borders.
RACE_CODES = ("HU", "UN", "HE", "DW", "EL", "NE")
# Ground.ff also has generic / water base codes.
GROUND_CODES = RACE_CODES + ("BL", "WA")


def strip_ext(name):
    """Strip a trailing ``.png`` (case-insensitive), collapsing the ``.PNG.PNG``
    double-extension quirk to a bare stem."""
    s = name
    while True:
        low = s.lower()
        if low.endswith(".png"):
            s = s[:-4]
        else:
            break
    return s


def frame_key(name):
    """Canonical, stable frame key for a sprite (extension-stripped, upper-cased)."""
    return strip_ext(name).upper()


# -- terrain classification --------------------------------------------------

# Water border:  WA_xx_yy   (xx = neighbour mask, yy = variant)
_WATER_BORDER = re.compile(r"^WA_(\d+)_(\d+)$", re.I)
# Land border:   <RACE>_xx_yy  (e.g. NE_01_00)
_LAND_BORDER = re.compile(r"^([A-Z]{2})_(\d+)_(\d+)$", re.I)
# Ground base tile: <CODE>_nn   (e.g. HU_00, BL_03, WA_01)
_GROUND_BASE = re.compile(r"^([A-Z]{2})_(\d+)$", re.I)


def classify_border(stem):
    """Classify a GrBorder stem. Returns a dict or ``None``.

    ``{"kind": "water", "mask": int, "variant": int}`` or
    ``{"kind": "land", "race": str, "mask": int, "variant": int}``.
    """
    m = _WATER_BORDER.match(stem)
    if m:
        return {"kind": "water", "mask": int(m.group(1)), "variant": int(m.group(2))}
    m = _LAND_BORDER.match(stem)
    if m and m.group(1).upper() in RACE_CODES:
        return {
            "kind": "land",
            "race": m.group(1).upper(),
            "mask": int(m.group(2)),
            "variant": int(m.group(3)),
        }
    return None


def classify_ground(stem):
    """Classify a Ground base tile stem -> ``{"code": str, "variant": int}`` or None."""
    m = _GROUND_BASE.match(stem)
    if m and m.group(1).upper() in GROUND_CODES:
        return {"code": m.group(1).upper(), "variant": int(m.group(2))}
    return None


# -- animation grouping ------------------------------------------------------

# An animation frame name = <group><index> where <index> is a trailing run of
# digits.  e.g. BEACONA1 + "1".."5", 1X1RUNEMOUNT + "1".."6", G000MG00 + "04"..
_TRAILING_NUM = re.compile(r"^(.*?)(\d+)$")


def split_anim(stem):
    """Split an extension-stripped name into ``(group, frame_index)``.

    Returns ``(group, int)`` if the name ends in a digit run, else ``(stem, None)``.
    The group key keeps trailing non-numeric suffixes intact (e.g. ``..._1`` recolor
    markers are preserved as part of the digits only when purely numeric).
    """
    m = _TRAILING_NUM.match(stem)
    if not m:
        return stem, None
    group, num = m.group(1), m.group(2)
    if not group:
        return stem, None
    return group, int(num)


def is_terrain_object(stem):
    """Heuristic: IsoTerrn named trees / fog / mountains (static decoration)."""
    s = stem.upper()
    return s.startswith("MOM") or s.endswith("TREE") or s.startswith("FOG") or s.startswith("M_")
