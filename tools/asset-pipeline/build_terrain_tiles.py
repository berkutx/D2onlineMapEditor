"""build_terrain_tiles: the SHARED CLIENT terrain tile atlas.

Instead of baking one big PNG per map (compose_terrain.py), we emit the FINITE set
of 64x32 diamond base tiles, and the renderer assembles each map at runtime with
@pixi/tilemap. This is map-independent (one atlas for every map) and editable.

Why finite: a cell's base tile is the 64x32 diamond cut from a race texture (tiled
at ts=192 land / 128 water) at iso offset (nx,ny). The cut depends only on
(rx,ry) = (nx % ts, ny % ts). Because TILE=32 divides ts, only a small lattice of
(rx,ry) ever occurs:
  land  ts=192: rx in {0,32,64,96,128,160} (6),  ry in {0,16,..,176} (12)
  water ts=128: rx in {0,32,64,96} (4),          ry in {0,16,..,112} (8)
The variant blend inside each cut is positional + seed-fixed (seed=0), i.e. baked
into the cut. So a base tile is fully determined by (terrain-id | water, rx, ry).

Tile keys (renderer recomputes them per cell from value + map size, see
TerrainTilemapLayer):
  land  : "T<terrainId>_<rx>_<ry>"   (terrainId = value & 7)
  water : "TW_<rx>_<ry>"
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402

from compose_terrain import Tiles, RegionExtractor, DW, DH, GROUND_TILE  # noqa: E402
from decode_images import Frame  # noqa: E402
import build_atlases  # noqa: E402

WATER_TILE = 128  # water source tile size (one 128px variant in this install)

# the 8 direction mask codes the editor uses (LandscapeObject border pass):
# orthogonal W/N/E/S = 1/2/4/8, diagonal NW/NE/SE/SW = 17/18/20/24.
BORDER_MASK_TYPES = [1, 2, 4, 8, 17, 18, 20, 24]


def _diamond_tile(region, diamond):
    """64x32 RGBA = the region clipped to the iso diamond (transparent corners),
    matching TerrainComposer._draw_cell's base layer (dia>0 & src alpha>0)."""
    tile = np.zeros((DH, DW, 4), np.uint8)
    cond = (diamond > 0) & (region[..., 3] > 0)
    tile[cond] = region[cond]
    return tile


def _offsets(ts):
    """The (rx,ry) lattice for a tile size ts: rx multiples of 32 < ts, ry of 16 < ts."""
    return ([rx for rx in range(0, ts, 32)], [ry for ry in range(0, ts, 16)])


def base_frames(tiles):
    """Every distinct base tile as a decode_images.Frame (untrimmed 64x32)."""
    frames = []
    dia = tiles.diamond
    rxs, rys = _offsets(GROUND_TILE)
    for tid, variants in sorted(tiles.base.items()):
        ex = RegionExtractor(variants, 0)  # ts = 192
        for rx in rxs:
            for ry in rys:
                tile = _diamond_tile(ex.extract(rx, ry), dia)
                frames.append(Frame("T%d_%d_%d" % (tid, rx, ry), tile, DW, DH, 0, 0, "default"))
    if tiles.water:
        wex = RegionExtractor(tiles.water, 0)  # ts = 128
        wrxs, wrys = _offsets(WATER_TILE)
        for rx in wrxs:
            for ry in wrys:
                tile = _diamond_tile(wex.extract(rx, ry), dia)
                frames.append(Frame("TW_%d_%d" % (rx, ry), tile, DW, DH, 0, 0, "default"))
    return frames


def border_frames(tiles):
    """Pre-baked border-blend tiles: each is a NEIGHBOUR land region clipped to
    (diamond AND NE_ alpha mask), keyed "E_<ntid>_<nrx>_<nry>_<masktype>_<var>".
    Mirrors TerrainComposer._layers exactly. The renderer computes (ntid, nrx, nry)
    from the neighbour cell, the direction masktype, and var=(x*y+x+y)%count."""
    frames = []
    dia = tiles.diamond
    rxs, rys = _offsets(GROUND_TILE)
    for tid, variants in sorted(tiles.base.items()):
        ex = RegionExtractor(variants, 0)  # ts = 192 (neighbour is always land)
        for rx in rxs:
            for ry in rys:
                region = ex.extract(rx, ry)
                for mt in BORDER_MASK_TYPES:
                    masks = tiles.masks.get(mt)
                    if not masks:
                        continue
                    for var, mask in enumerate(masks):
                        tile = np.zeros((DH, DW, 4), np.uint8)
                        cond = (dia > 0) & (region[..., 3] > 0) & (mask[..., 3] > 0)
                        if not cond.any():
                            continue
                        tile[cond] = region[cond]
                        frames.append(
                            Frame("E_%d_%d_%d_%d_%d" % (tid, rx, ry, mt, var),
                                  tile, DW, DH, 0, 0, "default"))
    return frames


def foam_frames(tiles):
    """Water foam border tiles "WF_<type>_<var>" = the WA_ image clipped to the
    diamond (TerrainComposer water_border layers). type = the accumulated orth
    bitmask, or extra-diag bitmask + 16."""
    frames = []
    dia = tiles.diamond
    for t, variants in sorted(tiles.wborders.items()):
        for var, wb in enumerate(variants):
            tile = np.zeros((DH, DW, 4), np.uint8)
            cond = (dia > 0) & (wb[..., 3] > 0)
            if not cond.any():
                continue
            tile[cond] = wb[cond]
            frames.append(Frame("WF_%d_%d" % (t, var), tile, DW, DH, 0, 0, "default"))
    return frames


def _register(builder, stats, bundle_id, frames, out_dir, ff):
    written = build_atlases.build_atlas(
        bundle_id, frames, out_dir, ff=ff, shader="default", tile_w=DW)
    for page_idx, (img_name, meta_name) in enumerate(written):
        sheet_id = bundle_id if len(written) == 1 else "%s-%d" % (bundle_id, page_idx)
        builder.add_spritesheet(sheet_id, img_name, meta_name, ff=ff)
    for f in frames:
        builder.add_index(f.key, bundle_id, frame=f.key)
    stats["archives"] += 1
    stats["frames"] += len(frames)
    stats["sheets"] += len(written)
    return len(written)


def add_terrain_base(game_dir, out_dir, builder, stats):
    """Build the shared terrain tile atlases (base ground + pre-blended borders +
    water foam) + register them on a ManifestBuilder. Returns the tile count."""
    tiles = Tiles(game_dir)
    base = base_frames(tiles)
    border = border_frames(tiles)
    foam = foam_frames(tiles)
    bp = _register(builder, stats, "terrain-base", base, out_dir, "Ground.ff")
    ep = _register(builder, stats, "terrain-border", border + foam, out_dir, "GrBorder.ff")
    sys.stderr.write(
        "  terrain-base: %d base (%d races + water) on %d page(s); "
        "terrain-border: %d border + %d foam on %d page(s)\n"
        % (len(base), len(tiles.base), bp, len(border), len(foam), ep))
    return len(base) + len(border) + len(foam)
