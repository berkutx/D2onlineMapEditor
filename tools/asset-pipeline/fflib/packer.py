"""Shelf / row bin-packer (no rectpack dependency).

Packs trimmed sprite rectangles into one or more atlas pages, each capped at
``max_size`` x ``max_size`` (2048 default). Sprites are sorted tallest-first and
laid out left-to-right on horizontal shelves; a new shelf opens when the current
row is full, a new page opens when the page is full. Each finished page is sized
up to the next power of two for GPU friendliness.
"""

DEFAULT_MAX = 2048
PADDING = 1  # 1px gutter to avoid bilinear bleed between neighbours


class Placement(object):
    __slots__ = ("key", "page", "x", "y", "w", "h")

    def __init__(self, key, page, x, y, w, h):
        self.key = key
        self.page = page
        self.x = x
        self.y = y
        self.w = w
        self.h = h

    def __repr__(self):
        return "Placement(%r, page=%d, x=%d, y=%d, w=%d, h=%d)" % (
            self.key, self.page, self.x, self.y, self.w, self.h)


def _next_pow2(n):
    p = 1
    while p < n:
        p <<= 1
    return p


class _Page(object):
    """A page being filled with shelves."""

    def __init__(self, max_size, padding):
        self.max_size = max_size
        self.padding = padding
        self.shelf_x = 0
        self.shelf_y = 0
        self.shelf_h = 0
        self.used_w = 0
        self.used_h = 0

    def try_place(self, w, h):
        """Try to place a ``w x h`` rect. Returns ``(x, y)`` or ``None``."""
        pw = w + self.padding
        ph = h + self.padding
        if pw > self.max_size or ph > self.max_size:
            return None
        # open a new shelf if the row would overflow
        if self.shelf_x + pw > self.max_size:
            self.shelf_y += self.shelf_h
            self.shelf_x = 0
            self.shelf_h = 0
        # page full vertically?
        if self.shelf_y + ph > self.max_size:
            return None
        x, y = self.shelf_x, self.shelf_y
        self.shelf_x += pw
        if ph > self.shelf_h:
            self.shelf_h = ph
        if self.shelf_x > self.used_w:
            self.used_w = self.shelf_x
        if self.shelf_y + self.shelf_h > self.used_h:
            self.used_h = self.shelf_y + self.shelf_h
        return x, y

    def size(self):
        if not self.used_w or not self.used_h:
            return 1, 1
        return _next_pow2(self.used_w), _next_pow2(self.used_h)


def pack(rects, max_size=DEFAULT_MAX, padding=PADDING, groups=None):
    """Pack ``rects`` (list of ``(key, w, h)``) into atlas pages.

    Returns ``(placements, pages)`` where ``placements`` is a list of
    :class:`Placement` and ``pages`` is a list of ``(width, height)`` per page
    (power-of-two). Any single sprite larger than ``max_size`` gets its own
    oversized page (clamped, never dropped).

    ``groups`` (optional ``{key: group_id}``) keeps same-group sprites adjacent in
    pack order so an animation's frames land on the same page (best-effort: a group
    may still straddle a page boundary if it is very large). Ungrouped keys are
    packed after the groups, tallest-first.
    """
    if groups:
        # Order groups by their tallest member; within a group keep input order
        # (so numbered animation frames stay sequential and contiguous).
        by_group = {}
        for r in rects:
            by_group.setdefault(groups.get(r[0]), []).append(r)
        ordered_groups = sorted(
            by_group.items(),
            key=lambda kv: (kv[0] is None, -max(r[2] for r in kv[1])))
        order = []
        for _gid, members in ordered_groups:
            order.extend(members)
    else:
        order = sorted(rects, key=lambda r: (-r[2], -r[1], r[0]))

    placements = []
    pages = [_Page(max_size, padding)]

    for key, w, h in order:
        # oversized -> dedicated page sized to fit it
        if w + padding > max_size or h + padding > max_size:
            idx = len(pages)
            placements.append(Placement(key, idx, 0, 0, w, h))
            big = _Page(max(max_size, w + padding), padding)
            big.try_place(w, h)
            pages.append(big)
            pages.append(_Page(max_size, padding))  # fresh page to continue on
            continue

        placed = False
        # try the current (last non-oversized) page first, else open a new one
        idx = len(pages) - 1
        spot = pages[idx].try_place(w, h)
        if spot is None:
            pages.append(_Page(max_size, padding))
            idx = len(pages) - 1
            spot = pages[idx].try_place(w, h)
        placements.append(Placement(key, idx, spot[0], spot[1], w, h))
        placed = True
        assert placed

    sizes = [p.size() for p in pages]
    return placements, sizes
