"""Faithful port of toolsqt ResourceModel/GameResource.cpp + ResourceDescription.h.

Resolves a logical resource id (e.g. "MOMNE0102", "G000SI0000MERH") to its frame(s)
the SAME way the editor does, instead of guessing/standalone-PNG shortcuts:

  no -INDEX.OPT  -> getSimpleImageByName: the standalone PNG named `id`.
  with -INDEX.OPT -> GetIndexDescByName(id) -> {uid, relatedOffset, relatedSize}:
     uid != -1 : ImagesContainer.getImageData(images_opt + relatedOffset) -> the
                 ImageRestoreData whose name == id -> processParts() assembles the
                 frame from the source PNG (ResDescByUid(uid)) via ImagePart rects.
     uid == -1 : AnimationsContainer at anim_opt + relatedOffset -> frameNames[];
                 each frame resolved like the simple-image case.

Shaders: Default = magenta colour-key (r>247&&b>247&&g<8); TransparentBlack = black
(r<5&&g<5&&b<5); Border per isTransparentBorderColor2. Ported from GameResource.cpp.
"""
import io
import re
import struct

import numpy as np
from PIL import Image

# PreprocessingShaderType flags (subset we need)
SH_DEFAULT = 1
SH_SHADOWS = 2
SH_TRANSP_BLACK = 4
SH_BORDER = 8


def _ri(b, i):
    return struct.unpack_from("<i", b, i)[0]


def _term(b, i):
    j = b.index(b"\x00", i)
    return b[i:j].decode("latin1"), j + 1


class ResourceDesc:
    __slots__ = ("uid", "offset", "packed", "name")

    def __init__(self, uid, offset, packed):
        self.uid = uid
        self.offset = offset
        self.packed = packed
        self.name = ""


class GameResource:
    """One .ff archive."""

    def __init__(self, path):
        self.path = path
        self._d = open(path, "rb").read()
        self.resources = []  # list[ResourceDesc]
        self._by_uid = {}
        self._by_name = {}  # upper, .PNG stripped -> ResourceDesc
        self.names_desc = None
        self.indexes_opt = None  # ResourceDesc of -INDEX.OPT
        self.images_opt = None
        self.anim_opt = None
        self._index = {}  # name(lower) -> (uid, relatedOffset, relatedSize)
        self._read()

    # ---- container parse ----
    def _payload(self, desc):
        return self._d[desc.offset + 28 : desc.offset + 28 + desc.packed]

    def _read(self):
        d = self._d
        for o in (m.start() for m in re.finditer(b"MQRC", d)):
            # 'MQRC'(4) magic(4) uid(4) realSize(4) packedSize(4) m3(4) m4(4)
            uid, _real, packed = struct.unpack_from("<iii", d, o + 8)
            desc = ResourceDesc(uid, o, packed)
            self.resources.append(desc)
            self._by_uid[uid] = desc
            if uid == 2:
                self.names_desc = desc
        self._restore_names()
        # identify the OPT records by name and parse the index
        self.indexes_opt = self._by_name.get("-INDEX.OPT")
        self.images_opt = self._by_name.get("-IMAGES.OPT")
        self.anim_opt = self._by_name.get("-ANIMS.OPT")
        if self.indexes_opt is not None:
            self._parse_index(self._payload(self.indexes_opt))

    def _restore_names(self):
        # NamesListData: name(256) + id(4), stride 260, from offset 4
        if self.names_desc is None:
            return
        p = self._payload(self.names_desc)
        k = 4
        while k + 260 <= len(p):
            name = p[k : k + 256].split(b"\x00")[0].decode("latin1")
            rid = _ri(p, k + 256)
            k += 260
            if not name:
                continue
            desc = self._by_uid.get(rid)
            if desc is not None:
                desc.name = name
                self._by_name[name.upper().replace(".PNG", "")] = desc

    def _parse_index(self, b):
        # IndexesData: count, then [uid(4), name(term), relatedOffset(4), relatedSize(4)]
        i = 0
        count = _ri(b, i)
        i += 4
        for _ in range(count):
            uid = _ri(b, i)
            i += 4
            name, i = _term(b, i)
            ro = _ri(b, i)
            i += 4
            rs = _ri(b, i)
            i += 4
            self._index[name.lower()] = (uid, ro, rs)

    # ---- ImagesContainer / AnimationsContainer (read on demand) ----
    def _image_data(self, related_offset, related_size):
        """ImagesContainer.getImageData: returns (palette_or_none, [ImageRestoreData])."""
        base = self.images_opt.offset + 28 + related_offset
        b = self._d[base : base + related_size]
        i = 0
        header_size = 11 + 1024
        i += header_size  # 11 + 1024-byte palette (unused here; source PNG carries its own)
        if i > len(b):
            return []
        images = []
        n = _ri(b, i)
        i += 4
        for _ in range(n):
            name, i = _term(b, i)
            pcount = _ri(b, i); i += 4
            w = _ri(b, i); i += 4
            h = _ri(b, i); i += 4
            parts = []
            for _p in range(pcount):
                sx, sy, tx, ty, pw, ph = struct.unpack_from("<6i", b, i)
                i += 24
                parts.append((sx, sy, tx, ty, pw, ph))
            images.append((name, w, h, parts))
        return images

    def _anim_frames(self, related_offset, related_size):
        base = self.anim_opt.offset + 28 + related_offset
        b = self._d[base : base + related_size]
        i = 0
        count = _ri(b, i); i += 4
        names = []
        for _ in range(count):
            nm, i = _term(b, i)
            names.append(nm)
        return names

    # ---- public ----
    def has(self, name):
        if self.indexes_opt is None:
            return name.upper().replace(".PNG", "") in self._by_name
        return name.lower() in self._index

    def get_frames(self, name, shader=SH_DEFAULT):
        """Return list[np.ndarray HxWx4] for a logical id, ported from getFramesById."""
        if self.indexes_opt is None:
            d = self._by_name.get(name.upper().replace(".PNG", ""))
            if d is None:
                return []
            img = self._load_png(self._payload(d))
            return [_shade(img, shader)] if img is not None else []

        desc = self._index.get(name.lower())
        if desc is None:
            return []
        uid, ro, rs = desc
        if uid != -1:  # simple image
            images = self._image_data(ro, rs)
            src_desc = self._by_uid.get(uid)
            if src_desc is None:
                return []
            out = []
            for (iname, w, h, parts) in images:
                if iname != name:
                    continue
                frame = self._process_parts(src_desc, w, h, parts, shader)
                if frame is not None:
                    out.append(frame)
            return out
        # animation
        out = []
        for fn in self._anim_frames(ro, rs):
            sdesc = self._index.get(fn.lower())
            if sdesc is None:
                continue
            suid, sro, srs = sdesc
            images = self._image_data(sro, srs)
            src_desc = self._by_uid.get(suid)
            if src_desc is None:
                continue
            for (iname, w, h, parts) in images:
                if iname != fn:
                    continue
                frame = self._process_parts(src_desc, w, h, parts, shader)
                if frame is not None:
                    out.append(frame)
        return out

    # ---- internals ----
    @staticmethod
    def _load_png(data):
        if data[:4] != b"\x89PNG":
            return None
        return Image.open(io.BytesIO(data))

    def _process_parts(self, src_desc, w, h, parts, shader):
        """fill/fill_indexed: frame[sx,sy] <- source[tx,ty] for each part, then shader."""
        src = self._load_png(self._payload(src_desc))
        if src is None or not parts:
            return None
        is_indexed = src.mode == "P"
        if is_indexed:
            sidx = np.array(src)  # H x W palette indices
            pal = np.array(src.getpalette() or [], dtype=np.uint8).reshape(-1, 3)
            fidx = np.zeros((h, w), np.uint8)  # palette index 0 default
            for (sx, sy, tx, ty, pw, ph) in parts:
                fidx[sy : sy + ph, sx : sx + pw] = sidx[ty : ty + ph, tx : tx + pw]
            rgb = pal[fidx]
            # transparency by palette: index 0 forced magenta; key magenta (+black if asked)
            r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
            transp = (r > 247) & (b > 247) & (g < 8)
            if shader & SH_TRANSP_BLACK:
                transp |= (r < 5) & (g < 5) & (b < 5)
            a = np.where(transp, 0, 255).astype(np.uint8)
            return np.dstack([rgb, a])
        # RGB source
        srgb = np.array(src.convert("RGB"))
        frame = np.zeros((h, w, 4), np.uint8)
        for (sx, sy, tx, ty, pw, ph) in parts:
            frame[sy : sy + ph, sx : sx + pw, :3] = srgb[ty : ty + ph, tx : tx + pw]
            frame[sy : sy + ph, sx : sx + pw, 3] = 255
        return _shade(frame if isinstance(frame, np.ndarray) else np.array(frame), shader)


def _shade(img, shader):
    """Apply colour-key shaders to a PIL image or HxWx4 array -> HxWx4 array."""
    if isinstance(img, Image.Image):
        if img.mode == "P":
            idx = np.array(img)
            pal = np.array(img.getpalette() or [], dtype=np.uint8).reshape(-1, 3)
            rgb = pal[idx]
        else:
            rgb = np.array(img.convert("RGB"))
        arr = np.dstack([rgb, np.full(rgb.shape[:2], 255, np.uint8)])
    else:
        arr = img.copy()
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    if shader & SH_DEFAULT:
        arr[(r > 247) & (b > 247) & (g < 8), 3] = 0
    if shader & SH_TRANSP_BLACK:
        arr[(r < 5) & (g < 5) & (b < 5), 3] = 0
    if shader & SH_BORDER:
        m = ((r > 250) & (b > 250) & (g < 5)) | ((r > 250) & (b > 250) & (g > 250))
        arr[m, 3] = 0
    return arr
