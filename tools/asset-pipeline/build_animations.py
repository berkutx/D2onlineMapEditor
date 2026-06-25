"""build_animations: group animation frames into named sequences.

IsoAnim frame names follow ``<group><index>`` where ``<index>`` is a trailing
digit run (e.g. ``BEACONA1``+``1..5``, ``1X1RUNEMOUNT``+``1..6``). We group by the
stripped prefix, order by the numeric index, and keep groups with >= 2 frames.
Each sequence runs at the uniform 42ms D2 clock (fps ~= 23.81).
"""
from build_atlases import FPS, TICK_MS
from fflib import naming


def group_animations(frame_keys):
    """Group ``frame_keys`` (extension-stripped, upper) into ``{group: [keys...]}``.

    Returns only multi-frame groups, frames ordered by numeric index.
    """
    buckets = {}
    for key in frame_keys:
        group, idx = naming.split_anim(key)
        if idx is None:
            continue
        buckets.setdefault(group, []).append((idx, key))

    anims = {}
    for group, items in buckets.items():
        if len(items) < 2:
            continue
        items.sort(key=lambda t: t[0])
        anims[group.rstrip("_") or group] = [k for _i, k in items]
    return anims


def animation_defs(anims, atlas_id):
    """Build Contract-B ``AnimationDef`` dicts for a ``{group: [keys]}`` mapping."""
    out = []
    for aid, keys in sorted(anims.items()):
        out.append({
            "id": aid,
            "atlas": atlas_id,
            "frames": list(keys),
            "frameDurationMs": TICK_MS,
            "fps": FPS,
            "loop": True,
        })
    return out


def fps_map_for(anims):
    """``{group: FPS}`` for the spritesheet ``meta.d2.fps`` field."""
    return {aid: FPS for aid in anims}
