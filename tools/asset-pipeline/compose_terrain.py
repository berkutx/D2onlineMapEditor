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
from fflib.mqdb import parse_ff  # noqa: E402

TILE = 32                 # TILE_SIZE
DW, DH = TILE * 2, TILE   # diamond 64x32
EXTRA = TILE * 2          # EXTRA_OFFSET
GROUND_TILE = 192         # source ground tile size (MapRegionExtractor m_tileSize)

# terrain index (value & 7) -> 2-letter code, AUTHORITATIVE from Lterrain.dbf:
#   0 L_GO  1 L_HU  2 L_DW  3 L_HE  4 L_UN  5 L_NE  6 L_EL
RACE_CODE = {0: "NE", 1: "HU", 2: "DW", 3: "HE", 4: "UN", 5: "NE", 6: "EL"}


# ---------- .ff image loading ----------
def _names_and_pngs(path):
    """Return (name->png bytes) for an archive via the id==2 name table."""
    d = open(path, "rb").read()
    import re
    recs = []
    for o in (m.start() for m in re.finditer(b"MQRC", d)):
        rid, sizeA = struct.unpack_from("<ii", d, o + 8)
        recs.append((rid, d[o + 28 : o + 28 + sizeA]))
    id2png = {rid: p for rid, p in recs if p[:4] == b"\x89PNG"}
    names = {}
    for rid, p in recs:
        if rid == 2:
            for base in _table_starts(p):
                off = base
                while off + 260 <= len(p):
                    eid = struct.unpack_from("<i", p, off)[0]
                    raw = p[off + 4 : off + 260].split(b"\x00")[0]
                    try:
                        nm = raw.decode("latin1")
                    except Exception:
                        nm = ""
                    if nm.upper().endswith(".PNG") and eid in id2png:
                        names[nm.upper()[:-4]] = id2png[eid]
                    off += 260
                if names:
                    break
    return names


def _table_starts(payload):
    starts = {0}
    if len(payload) >= 4:
        na = struct.unpack_from("<i", payload, 0)[0]
        if 0 < na < len(payload):
            starts.add(4 + na)
    return sorted(starts)


def _decode(png_bytes, key="magenta"):
    """PNG bytes -> HxWx4 uint8 RGBA with the given colour key removed."""
    import io
    im = Image.open(io.BytesIO(png_bytes))
    if im.mode == "P":
        idx = np.array(im)
        pal = np.array(im.getpalette() or [], dtype=np.uint8).reshape(-1, 3)
        rgb = pal[idx]
    else:
        rgb = np.array(im.convert("RGB"))
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    if key == "black":  # TransparentBlack: black -> transparent (blend masks)
        transparent = (r < 5) & (g < 5) & (b < 5)
    else:  # magenta colour-key (default / border)
        transparent = (r > 247) & (b > 247) & (g < 8)
    a = np.where(transparent, 0, 255).astype(np.uint8)
    return np.dstack([rgb, a])


def _scaled(rgba, w, h):
    return np.array(Image.fromarray(rgba, "RGBA").resize((w, h), Image.NEAREST))


class Tiles:
    """Loads every terrain source image the compositor needs."""

    def __init__(self, game_dir):
        imgs = os.path.join(game_dir, "Imgs")
        self.ground = _names_and_pngs(os.path.join(imgs, "Ground.ff"))
        self.border = _names_and_pngs(os.path.join(imgs, "GrBorder.ff"))
        self.terrn = _names_and_pngs(os.path.join(imgs, "IsoTerrn.ff"))
        # base race variants (192x192) per terrain index, + water variants
        self.base = {}
        for tv, code in RACE_CODE.items():
            self.base[tv] = self._variants(self.ground, code)
        self.water = self._variants(self.ground, "WA")
        # border masks (NE_<type>_<var>) and water foam borders (WA_<type>_<var>)
        self.masks = {}     # type -> [64x32 alpha-mask rgba]
        self.wborders = {}  # type -> [64x32 rgba]
        for t in range(1, 32):
            mk = self._border(self.border, "NE", t, "black")
            if mk:
                self.masks[t] = mk
            wb = self._border(self.border, "WA", t, "magenta")
            if wb:
                self.wborders[t] = wb
        self.diamond = make_diamond()

    def _variants(self, src, code):
        out = []
        for k in range(4):
            nm = "%s_%02d" % (code, k)
            if nm in src:
                t = _decode(src[nm])
                # skip degenerate all-black placeholder tiles (e.g. DW_00)
                if int(t[..., :3].max()) < 5:
                    continue
                out.append(t)
        return out or [np.zeros((GROUND_TILE, GROUND_TILE, 4), np.uint8)]

    def _border(self, src, prefix, t, key):
        out = []
        for k in range(3):
            nm = "%s_%02d_%02d" % (prefix, t, k)
            if nm in src:
                out.append(_scaled(_decode(src[nm], key), DW, DH))
        return out


# ---------- geometry (exact ports) ----------
def make_diamond():
    """64x32 alpha mask; interior (tileIndices==0) opaque. Generated to match the
    editor's diamond: |x'| / TILE + |y'| / (TILE/2) <= 1 in centered coords."""
    a = np.zeros((DH, DW), np.uint8)
    cx, cy = DW / 2.0, DH / 2.0
    for y in range(DH):
        for x in range(DW):
            if abs((x + 0.5) - cx) / cx + abs((y + 0.5) - cy) / cy <= 1.0:
                a[y, x] = 255
    return a


def x_offset(x, y, total_w):
    return total_w // 2 + x - y - TILE


def y_offset(x, y):
    return (x + y) // 2


def variant_index(seed, tx, ty, n):
    if n <= 1:
        return 0
    h = (seed + tx * 73856093 + ty * 19349663) & 0xFFFFFFFF
    h = (h * 2654435761) & 0xFFFFFFFF
    return h % n


class RegionExtractor:
    """Port of MapRegionExtractor: 64x32 region cut from a 192-tiled variant plane."""

    def __init__(self, variants, seed=0):
        self.variants = variants
        self.seed = seed
        self.cache = {}

    def extract(self, x, y):
        rx, ry = x % GROUND_TILE, y % GROUND_TILE
        key = (rx, ry)
        if key in self.cache:
            return self.cache[key]
        plane = np.zeros((GROUND_TILE * 2, GROUND_TILE * 2, 4), np.uint8)
        for tx in (0, 1):
            for ty in (0, 1):
                vi = variant_index(self.seed, tx, ty, len(self.variants))
                plane[ty * GROUND_TILE:(ty + 1) * GROUND_TILE,
                      tx * GROUND_TILE:(tx + 1) * GROUND_TILE] = self.variants[vi]
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
        ex = self.race_ex.get(tile_terrain(value)) or self.race_ex[5]
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

    def compose(self):
        for x in range(self.n):
            for y in range(self.n):
                self._draw_cell(x, y)
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
