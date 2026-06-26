"""compose_terrain: faithful port of the editor's terrain compositing.

Ports d2mapeditorqt Engine/MapView/{MapTileHelper,LandscapeObject}.cpp +
MapRegionExtractor exactly: TILE_SIZE=32 (64x32 iso diamonds), a seamless region
cut from race textures tiled at 192px, and neighbour-config border blending with
masks (NE_) and water foam borders (WA_), using the exact priority rules.

Produces one composited terrain PNG + a meta JSON (so the renderer shows it as a
single sprite and aligns objects). Run:

    python tools/asset-pipeline/compose_terrain.py --map-id <id> \
        --game "C:/GOG Games/last_version/Game" --out public/assets/terrain
"""
import argparse
import json
import os
import struct
import sys
import urllib.request

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fflib.diamond_data import DIAMOND_ROWS  # noqa: E402  exact editor diamond mask
from fflib.gameresource import (  # noqa: E402
    GameResource, SH_DEFAULT, SH_TRANSP_BLACK, SH_BORDER,
)

TILE = 32                 # TILE_SIZE
DW, DH = TILE * 2, TILE   # diamond 64x32
EXTRA = TILE * 2          # EXTRA_OFFSET
GROUND_TILE = 192         # source ground tile size (MapRegionExtractor m_tileSize)

def read_lterrain(globals_dir):
    """{terrain id -> 2-letter code}, exactly as MapTileHelper::init reads it from
    Lterrain.dbf: code = terr->text.replace("L_", "") (e.g. "L_HU" -> "HU")."""
    path = None
    for nm in ("Lterrain.dbf", "Lterrain.DBF"):
        p = os.path.join(globals_dir, nm)
        if os.path.exists(p):
            path = p
            break
    if path is None:
        raise FileNotFoundError("Lterrain.dbf not found in %s" % globals_dir)
    d = open(path, "rb").read()
    nrec = struct.unpack_from("<I", d, 4)[0]
    hlen = struct.unpack_from("<H", d, 8)[0]
    rlen = struct.unpack_from("<H", d, 10)[0]
    fields = []
    i = 32
    while d[i] != 0x0D:
        fields.append((d[i:i + 11].split(b"\x00")[0].decode("latin1"), d[i + 16]))
        i += 32
    out = {}
    for r in range(nrec):
        off = hlen + r * rlen
        if off + rlen > len(d):
            break
        pos = off + 1
        row = {}
        for (name, flen) in fields:
            row[name] = d[pos:pos + flen].decode("latin1").strip()
            pos += flen
        out[int(row["ID"])] = row["TEXT"].replace("L_", "")
    return out


# ---------- .ff image loading ----------
def _scaled(rgba, w, h):
    return np.array(Image.fromarray(rgba, "RGBA").resize((w, h), Image.NEAREST))


class Tiles:
    """Loads every terrain source image via GameResource — the SAME path the editor
    uses (getFramesById / getImagesData) with the editor's shaders. (The previous
    custom PNG name-table loader mis-decoded some Ground tiles, e.g. DW_00 -> all
    black; GameResource reads it correctly as the light-grey dwarf rock.)"""

    def __init__(self, game_dir):
        imgs = os.path.join(game_dir, "Imgs")
        self.gr_ground = GameResource(os.path.join(imgs, "Ground.ff"))
        self.gr_border = GameResource(os.path.join(imgs, "GrBorder.ff"))
        self.gr_terrn = GameResource(os.path.join(imgs, "IsoTerrn.ff"))
        # race code per terrain id, from Lterrain.dbf (faithful, not hard-coded)
        self.race_code = read_lterrain(os.path.join(game_dir, "Globals"))
        # base race ground variants (k=0,1,2) per terrain id that has textures
        self.base = {}
        for tid, code in self.race_code.items():
            vs = self._ground(code)
            if vs:
                self.base[tid] = vs
        # water ground (L_WATER -> "WA"; one 128px variant in this install)
        self.water = self._ground("WA")
        # border masks NE_<t>_<k> (TransparentBlack) + water foam WA_<t>_<k> (Border)
        self.masks = {}     # type -> [64x32 mask rgba], reversed to Qt values() order
        self.wborders = {}  # type -> [64x32 rgba]
        for t in range(1, 32):
            mk = self._border("NE", t, SH_TRANSP_BLACK)
            if mk:
                self.masks[t] = mk
            wb = self._border("WA", t, SH_BORDER)
            if wb:
                self.wborders[t] = wb
        self.diamond = make_diamond()

        # roads + forest from IsoTerrn (LandscapeObject::drawRoads / drawTrees).
        # roadImage(i) = "ROAD"+i(2)+"00" (i=0..16); forestByValue = race + "F" + forest(4).
        self.roads = {}  # roadType -> rgba
        for i in range(17):
            fr = self.gr_terrn.get_frames("ROAD%s00" % str(i).rjust(2, "0"), SH_DEFAULT)
            if fr:
                self.roads[i] = fr[0]
            else:
                # Editor (MapTileHelper::init): a missing ROADxx00 inserts a solid
                # opaque-red 40x40 placeholder (QImage(40,40).fill(Qt::red)).
                ph = np.zeros((40, 40, 4), np.uint8)
                ph[..., 0] = 255  # R
                ph[..., 3] = 255  # opaque
                self.roads[i] = ph
        self._forest_cache = {}

    def forest(self, value):
        """forestByValue: raceMap[terrain] + "F" + forest(4) from IsoTerrn."""
        forest = (value >> 26) & 0x3F
        # Editor: key = raceMap[terrain] + "F" + forest(4); raceMap is a QMap whose
        # operator[] yields "" for a missing terrain id (NOT a substituted race).
        code = self.race_code.get(value & 7, "")
        key = "%sF%s" % (code, str(forest).rjust(4, "0"))
        if key in self._forest_cache:
            return self._forest_cache[key]
        fr = self.gr_terrn.get_frames(key, SH_DEFAULT)
        img = fr[0] if fr else None
        self._forest_cache[key] = img
        return img

    def _ground(self, code):
        """Ground variants k=0,1,2 for a 2-letter code (getFramesById("Ground", ...))."""
        out = []
        for k in range(3):
            fr = self.gr_ground.get_frames("%s_%02d" % (code, k), SH_DEFAULT)
            if fr:
                out.append(fr[0])
        return out

    def _border(self, prefix, t, shader):
        # getBlendMask/waterBorder index m_border*.values(type); Qt QMultiHash::values
        # yields most-recently-inserted first, so reverse the k=0,1,2 insertion order.
        out = []
        for k in range(3):
            fr = self.gr_border.get_frames("%s_%02d_%02d" % (prefix, t, k), shader)
            if fr:
                out.append(_scaled(fr[0], DW, DH))
        out.reverse()
        return out


# ---------- geometry (exact ports) ----------
def make_diamond():
    """64x32 alpha mask = the editor's exact createDiamond (tileIndices==0 interior),
    so diamonds tessellate without gaps (my earlier |x|/cx+|y|/cy<=1 formula left
    1px seams). DIAMOND_ROWS is parsed verbatim from MapTileHelper.cpp."""
    a = np.zeros((DH, DW), np.uint8)
    for y in range(DH):
        row = DIAMOND_ROWS[y]
        for x in range(DW):
            if (row >> x) & 1:
                a[y, x] = 255
    return a


class _Mt19937:
    """std::mt19937 (the generator the editor's MapRegionExtractor uses)."""

    def __init__(self, seed):
        self.mt = [0] * 624
        self.idx = 624
        self.mt[0] = seed & 0xFFFFFFFF
        for i in range(1, 624):
            self.mt[i] = (1812433253 * (self.mt[i - 1] ^ (self.mt[i - 1] >> 30)) + i) & 0xFFFFFFFF

    def _regen(self):
        for i in range(624):
            y = (self.mt[i] & 0x80000000) + (self.mt[(i + 1) % 624] & 0x7FFFFFFF)
            self.mt[i] = self.mt[(i + 397) % 624] ^ (y >> 1)
            if y & 1:
                self.mt[i] ^= 0x9908B0DF
        self.idx = 0

    def next(self):
        if self.idx >= 624:
            self._regen()
        y = self.mt[self.idx]
        self.idx += 1
        y ^= y >> 11
        y ^= (y << 7) & 0x9D2C5680
        y ^= (y << 15) & 0xEFC60000
        y ^= y >> 18
        return y & 0xFFFFFFFF


def x_offset(x, y, total_w):
    return total_w // 2 + x - y - TILE


def y_offset(x, y):
    return (x + y) // 2


def variant_index(seed, tx, ty, n):
    # MapRegionExtractor::calculateTileIndex: std::mt19937(seed + tx*73856093 +
    # ty*19349663), then std::uniform_int_distribution<int>(0, n-1). The editor is
    # built with MSVC (D2MapEditor.pro: win32 QMAKE_CXXFLAGS += /bigobj), whose
    # _Rng_from_urng for mt19937 has _Bits=32 / _Bmask=0xFFFFFFFF: the bit-gathering
    # loop runs ONCE (one full 32-bit engine output), then returns ret % n, rejecting
    # only the single partial top bucket. Net effect: engine_output % n (NOT the
    # libstdc++ low-bits scheme, which picks a different variant for non-power-of-2 n).
    if n <= 1:
        return 0
    rng = _Mt19937((seed + tx * 73856093 + ty * 19349663) & 0xFFFFFFFF)
    mask = 0xFFFFFFFF  # _Bmask; _Bits == 32 so the gather loop runs once
    while True:
        ret = rng.next()  # _Ret = one full 32-bit _Get_bits()
        if ret // n < mask // n or mask % n == n - 1:
            return ret % n


class RegionExtractor:
    """Port of MapRegionExtractor: a 64x32 region cut from variants tiled at the
    variant's OWN pixel size (m_tileSize = im.width() — 192 for races, 128 water)."""

    def __init__(self, variants, seed=0):
        self.variants = variants
        self.seed = seed
        self.ts = variants[0].shape[1] if variants else GROUND_TILE
        self.cache = {}

    def extract(self, x, y):
        ts = self.ts
        rx, ry = x % ts, y % ts
        key = (rx, ry)
        if key in self.cache:
            return self.cache[key]
        plane = np.zeros((ts * 2, ts * 2, 4), np.uint8)
        for tx in (0, 1):
            for ty in (0, 1):
                vi = variant_index(self.seed, tx, ty, len(self.variants))
                plane[ty * ts:(ty + 1) * ts, tx * ts:(tx + 1) * ts] = self.variants[vi]
        region = plane[ry:ry + DH, rx:rx + DW].copy()
        self.cache[key] = region
        return region


def tile_terrain(v):
    return v & 7


def tile_ground(v):
    return (v >> 3) & 7


def is_water(v):
    return tile_ground(v) == 3


def test(v1, v2):
    """Blend priority (LandscapeObject::test): does v1 bleed over v2's edge?"""
    if is_water(v2):
        return False
    if is_water(v1):
        return True
    t1, t2 = tile_terrain(v1), tile_terrain(v2)
    if t1 == 2 and t2 == 1:
        return False
    if t1 == 1 and t2 == 2:
        return True
    return t1 > t2


# ---------- compositor ----------
class TerrainComposer:
    def __init__(self, tiles, grid, n):
        self.t = tiles
        self.grid = grid   # grid[x][y] = {"value","roadType","roadVar"}
        self.n = n
        self.water_ex = RegionExtractor(tiles.water, 0)
        self.race_ex = {tv: RegionExtractor(v, 0) for tv, v in tiles.base.items()}
        self.total_w = n * DW
        self.W = self.total_w + EXTRA * 2
        self.H = n * TILE + EXTRA * 2
        self.img = np.zeros((self.H, self.W, 4), np.uint8)

    def main_image(self, value, x, y):
        nx = x_offset(x * TILE, y * TILE, self.total_w)
        ny = y_offset(x * TILE, y * TILE)
        if tile_ground(value) == 3:
            return self.water_ex.extract(nx, ny)
        ex = self.race_ex.get(tile_terrain(value))
        if ex is None:
            # Editor: extractors[id] is a default-constructed MapRegionExtractor with
            # an empty tile list -> empty region. No race substitution (no fallbacks).
            return np.zeros((DH, DW, 4), np.uint8)
        return ex.extract(nx, ny)

    def blend_mask(self, x, y, t):
        v = self.t.masks.get(t)
        if not v:
            return None
        return v[(x * y + x + y) % len(v)]

    def water_border(self, x, y, t):
        v = self.t.wborders.get(t)
        if not v:
            return None
        return v[(x * y + x + y) % len(v)]

    def _eval_border(self, x, y):
        g, n = self.grid, self.n
        b = 0
        v = g[x][y]["value"]
        if x > 0 and v != g[x - 1][y]["value"]:
            b |= 1
        if y > 0 and v != g[x][y - 1]["value"]:
            b |= 2
        if x < n - 1 and v != g[x + 1][y]["value"]:
            b |= 4
        if y < n - 1 and v != g[x][y + 1]["value"]:
            b |= 8
        return b

    def _eval_extra(self, x, y, b):
        g, n = self.grid, self.n
        v = g[x][y]["value"]
        e = 0
        if x > 0 and y > 0 and v != g[x - 1][y - 1]["value"] and (b & 0b11) == 0:
            e |= 1
        if x < n - 1 and y > 0 and v != g[x + 1][y - 1]["value"] and (b & 0b110) == 0:
            e |= 2
        if x < n - 1 and y < n - 1 and v != g[x + 1][y + 1]["value"] and (b & 0b1100) == 0:
            e |= 4
        if x > 0 and y < n - 1 and v != g[x - 1][y + 1]["value"] and (b & 0b1001) == 0:
            e |= 8
        return e

    def _layers(self, x, y):
        g, n = self.grid, self.n
        cell = g[x][y]["value"]
        layers = [(self.main_image(cell, x, y), None)]  # base (mask None = opaque)
        border = self._eval_border(x, y)
        extra = self._eval_extra(x, y, border)
        wtr = is_water(cell)

        if border:
            if wtr:
                wb = self.water_border(x, y, border)
                if wb is not None:
                    layers.append((wb, wb[..., 3]))
            for (cond, nx, ny, mt) in (
                (x > 0, x - 1, y, 1),
                (y > 0, x, y - 1, 2),
                (x < n - 1, x + 1, y, 4),
                (y < n - 1, x, y + 1, 8),
            ):
                if cond and test(cell, g[nx][ny]["value"]):
                    m = self.blend_mask(x, y, mt)
                    if m is not None:
                        layers.append((self.main_image(g[nx][ny]["value"], nx, ny), m[..., 3]))
        if extra:
            if wtr:
                wb = self.water_border(x, y, extra + 16)
                if wb is not None:
                    layers.append((wb, wb[..., 3]))
            for (cond, nx, ny, mt) in (
                (x > 0 and y > 0, x - 1, y - 1, 17),
                (x < n - 1 and y > 0, x + 1, y - 1, 18),
                (x < n - 1 and y < n - 1, x + 1, y + 1, 20),
                (x > 0 and y < n - 1, x - 1, y + 1, 24),
            ):
                if cond and test(cell, g[nx][ny]["value"]):
                    m = self.blend_mask(x, y, mt)
                    if m is not None:
                        layers.append((self.main_image(g[nx][ny]["value"], nx, ny), m[..., 3]))
        return layers

    def _draw_cell(self, x, y):
        layers = self._layers(x, y)
        tile = np.zeros((DH, DW, 4), np.uint8)
        dia = self.t.diamond
        for img, mask in layers:
            cond = (dia > 0) & (img[..., 3] > 0)
            if mask is not None:
                cond = cond & (mask > 0)
            tile[cond] = img[cond]
        nx = x_offset(x * TILE, y * TILE, self.total_w) + EXTRA
        ny = y_offset(x * TILE, y * TILE) + EXTRA
        dst = self.img[ny:ny + DH, nx:nx + DW]
        c = tile[..., 3] > 0
        dst[c] = tile[c]

    def _blit(self, src, cx, cy):
        """drawImage: copy src centered at (cx, cy) where src alpha>0 (no mask)."""
        if src is None:
            return
        h, w = src.shape[0], src.shape[1]
        x0, y0 = cx - w // 2, cy - h // 2
        ix0, iy0 = max(0, x0), max(0, y0)
        ix1, iy1 = min(self.W, x0 + w), min(self.H, y0 + h)
        if ix1 <= ix0 or iy1 <= iy0:
            return
        sub = src[iy0 - y0 : iy1 - y0, ix0 - x0 : ix1 - x0]
        dst = self.img[iy0:iy1, ix0:ix1]
        m = sub[..., 3] > 0
        dst[m] = sub[m]

    def _draw_road(self, x, y):
        rt = self.grid[x][y]["roadType"]
        if rt == -1:
            return
        cx, cy = self.cell_center(x, y)
        self._blit(self.t.roads.get(rt), cx, cy)

    def _draw_tree(self, x, y):
        v = self.grid[x][y]["value"]
        if tile_ground(v) != 1:  # ground==1 => forest cell
            return
        cx, cy = self.cell_center(x, y)
        self._blit(self.t.forest(v), cx, cy)

    def compose(self):
        # exact LandscapeObject::reloadGrid order: all cells, then roads, then trees.
        for x in range(self.n):
            for y in range(self.n):
                self._draw_cell(x, y)
        for x in range(self.n):
            for y in range(self.n):
                self._draw_road(x, y)
        for x in range(self.n):
            for y in range(self.n):
                self._draw_tree(x, y)
        return self.img

    # cell (x,y) screen-space center within the output image (for object alignment)
    def cell_center(self, x, y):
        nx = x_offset(x * TILE, y * TILE, self.total_w) + EXTRA
        ny = y_offset(x * TILE, y * TILE) + EXTRA
        return (nx + TILE, ny + TILE // 2)


def fetch_map(server, map_id):
    if not map_id:
        scen = json.load(urllib.request.urlopen(server + "/api/scenarios"))
        riders = next((s for s in scen if "Rider" in s["name"]), scen[0])
        map_id = riders["id"]
    doc = json.load(urllib.request.urlopen(server + "/api/maps/" + map_id))
    return map_id, doc


def build_grid(doc):
    n = doc["size"]
    cells = doc["terrain"]["cells"]
    grid = [[{"value": 0, "roadType": -1, "roadVar": -1} for _ in range(n)] for _ in range(n)]
    for c in cells:
        grid[c["x"]][c["y"]] = {"value": c["value"], "roadType": c["roadType"], "roadVar": c["roadVar"]}
    return grid, n


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--server", default="http://localhost:3000")
    ap.add_argument("--map-id", default="")
    args = ap.parse_args(argv)

    print("loading terrain tiles from", args.game)
    tiles = Tiles(args.game)
    print("  base races:", {k: len(v) for k, v in tiles.base.items()},
          "water:", len(tiles.water), "masks:", len(tiles.masks), "wborders:", len(tiles.wborders))

    map_id, doc = fetch_map(args.server, args.map_id)
    grid, n = build_grid(doc)
    print("map", map_id, "size", n)

    comp = TerrainComposer(tiles, grid, n)
    print("composing %dx%d cells -> %dx%d image ..." % (n, n, comp.W, comp.H))
    img = comp.compose()

    os.makedirs(args.out, exist_ok=True)
    png_path = os.path.join(args.out, map_id + ".png")
    Image.fromarray(img, "RGBA").save(png_path)
    c0 = comp.cell_center(0, 0)
    meta = {
        "mapId": map_id, "size": n, "tile": TILE, "diamondW": DW, "diamondH": DH,
        "extra": EXTRA, "width": comp.W, "height": comp.H,
        # cell (x,y) center on the image = (cx0 + (x-y)*TILE, cy0 + (x+y)*TILE/2)
        "cell0Center": {"x": c0[0], "y": c0[1]},
        "stepX": TILE, "stepY": TILE // 2,
        "image": map_id + ".png",
    }
    json.dump(meta, open(os.path.join(args.out, map_id + ".json"), "w"), indent=2)
    print("wrote", png_path, "and meta")
    return 0


if __name__ == "__main__":
    sys.exit(main())
