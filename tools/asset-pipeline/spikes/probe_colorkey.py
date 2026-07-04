"""Confirm magenta color-key produces real transparency for BOTH palette('P') and
'RGB' tiles, using the numpy method the real pipeline will use."""
import io, os, re, struct
import numpy as np
from PIL import Image

GAME_IMGS = os.path.join(os.environ.get("D2_GAME_DIR", "."), "Game", "Imgs")
OUT = os.path.join(os.path.dirname(__file__), "out")


def first_pngs(path, n=3):
    d = open(path, "rb").read()
    recs = []
    for o in (m.start() for m in re.finditer(b"MQRC", d)):
        rid, sizeA = struct.unpack_from("<ii", d, o + 8)
        payload = d[o + 28 : o + 28 + sizeA]
        if payload[:4] == b"\x89PNG":
            recs.append((rid, payload))
        if len(recs) >= n:
            break
    return recs


def colorkey(im):
    """Return RGBA np array with magenta keyed to alpha=0. Handles P and RGB."""
    if im.mode == "P":
        idx = np.array(im)                       # H x W palette indices
        pal = np.array(im.getpalette(), dtype=np.uint8).reshape(-1, 3)
        rgb = pal[idx]                           # H x W x 3
    else:
        rgb = np.array(im.convert("RGB"))
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    magenta = (r > 247) & (b > 247) & (g < 8)
    a = np.where(magenta, 0, 255).astype(np.uint8)
    return np.dstack([rgb, a]), int(magenta.sum())


for arc in ["City.ff", "IsoTerrn.ff", "GrBorder.ff", "Ground.ff"]:
    print("\n", arc)
    for rid, png in first_pngs(os.path.join(GAME_IMGS, arc), 3):
        im = Image.open(io.BytesIO(png))
        rgba, ntrans = colorkey(im)
        total = im.size[0] * im.size[1]
        Image.fromarray(rgba, "RGBA").save(os.path.join(OUT, "ck_%s_%d.png" % (arc, rid)))
        print("  id=%-5d mode=%-3s %sx%s  magenta_px=%d (%.1f%%)" % (
            rid, im.mode, im.size[0], im.size[1], ntrans, 100.0 * ntrans / total))
