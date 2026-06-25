"""decode_resource: extract an archive's frames the faithful way, via GameResource.

For every resolvable logical id (index names for indexed archives like IsoTerrn/
IsoCmon/IsoAnim/City/Capital, PNG names otherwise) it calls GameResource.get_frames
-- the exact editor restoration (IndexesData -> ImagesContainer -> ImageParts) --
trims each assembled frame, and emits decode_images.Frame objects keyed by the
UPPERCASE logical id. Multi-frame ids become animations (id -> [id#0, id#1, ...]).
"""
import numpy as np

from decode_images import Frame, _trim_bbox
from fflib.gameresource import GameResource, SH_DEFAULT


def _to_frame(key, rgba):
    """Trim an assembled HxWx4 array into a Frame (preserving the iso anchor)."""
    src_h, src_w = int(rgba.shape[0]), int(rgba.shape[1])
    bbox = _trim_bbox(rgba[..., 3] != 0)
    if bbox is None:
        return Frame(key, np.ascontiguousarray(rgba[:1, :1]), src_w, src_h, 0, 0, "default")
    x0, y0, x1, y1 = bbox
    return Frame(key, np.ascontiguousarray(rgba[y0:y1, x0:x1]), src_w, src_h, x0, y0, "default")


def decode_bundle(path, shader=SH_DEFAULT):
    """Return (frames, animations) for an archive, resolved through GameResource."""
    gr = GameResource(path)
    frames = []
    animations = {}
    for name in gr.all_names():
        try:
            fr = gr.get_frames(name, shader)
        except Exception:
            fr = []
        if not fr:
            continue
        key = name.upper()
        if len(fr) == 1:
            frames.append(_to_frame(key, fr[0]))
        else:
            anim_keys = []
            for i, f in enumerate(fr):
                fk = "%s#%d" % (key, i)
                frames.append(_to_frame(fk, f))
                anim_keys.append(fk)
            animations[key] = anim_keys
    # dedupe by key (first wins), keep insertion order
    seen = set()
    deduped = []
    for f in frames:
        if f.key in seen:
            continue
        seen.add(f.key)
        deduped.append(f)
    return deduped, animations
