"""build_terrain: assemble the Contract-B TerrainIndex from decoded frame keys.

Mirrors the toolsqt ``MapTileHelper`` terrain logic enough for the renderer to pick
frames from a MapCell deterministically (without re-deriving naming):

  - base tiles  : Ground.ff ``<CODE>_nn`` keyed by ground/race code (HU/UN/HE/DW/EL/
                  NE land races, BL = blend/neutral, WA = water). The variation seed
                  ``(x*y + x + y) % n`` selects among the ``n`` variants.
  - borders     : GrBorder.ff blend tiles. Water borders ``WA_<mask>_<var>`` keyed by
                  ``"WA"``; land borders ``<RACE>_<mask>_<var>`` keyed by race.
  - roads/forest: IsoTerrn named decorations (``M_DW_*`` mountains, ``*TREE`` forest).
"""
from fflib import naming

TILE_W = 192  # verified isometric base-tile width


def build_terrain_index(ground_keys, border_keys, terrn_keys):
    """Return a Contract-B ``TerrainIndex`` dict.

    Inputs are extension-stripped, upper-cased frame keys per source archive.
    """
    base = {}
    for key in ground_keys:
        info = naming.classify_ground(key)
        if info:
            base.setdefault(info["code"], []).append((info["variant"], key))
    base = {code: [k for _v, k in sorted(items)] for code, items in base.items()}

    borders = {}
    for key in border_keys:
        info = naming.classify_border(key)
        if not info:
            continue
        bucket = "WA" if info["kind"] == "water" else info["race"]
        borders.setdefault(bucket, []).append(
            (info["mask"], info["variant"], key))
    borders = {b: [k for _m, _v, k in sorted(items)] for b, items in borders.items()}

    # forest overlay: IsoTerrn race trees (one frame each) keyed by a short label
    forest = {}
    roads = {}
    for key in terrn_keys:
        s = key.upper()
        if s.endswith("TREE"):
            forest[s.replace("TREE", "").lower() or s.lower()] = key
        elif s.startswith("M_"):
            # mountain road/decoration tiles M_<RACE>_<a>_<b>
            roads.setdefault("mountain", []).append(key)

    for k in roads:
        roads[k] = sorted(roads[k])

    return {
        "tileW": TILE_W,
        "base": base,
        "borders": borders,
        "roads": roads,
        "forest": forest,
        "seedFormula": "(x*y + x + y) % n",
    }
