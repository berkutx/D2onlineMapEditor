"""id <-> name resolution from the MQDB name table (record id == 2).

Promoted and hardened from ``spikes/probe_ff.py::try_name_table``. The spike used a
fuzzy "does this look like a 260-byte table" heuristic that also matched RGB pixel
records and produced garbage names. Empirically (see spike notes) the *authoritative*
table is always the record with ``id == 2``, with this exact layout:

    int32 nameAreaLen          (length of a leading descriptor string, e.g. "-IMAGES.OPT")
    char  nameArea[...]        (padded to fill the rest of the first 260-byte block)
    --- then one 260-byte entry per asset, starting at offset 260: ---
        int32 id               (matches the MQRC record id of the PNG)
        char  name[256]        (latin1, NUL-terminated)

The first 260-byte block (offset 0) is the table's own descriptor (its id field is
not a real asset id), so entries begin at offset 260. This yields ~99% PNG coverage
on every Stage-1 archive (IsoTerrn/City/IsoAnim/IsoStill/Capital/GrBorder/Ground).
"""
import struct

from .mqdb import record_by_id

ENTRY_SIZE = 260
NAME_FIELD = 256


def parse_name_table(payload):
    """Parse an id==2 payload into an ``{id: name}`` dict (latin1, all entries)."""
    out = {}
    off = ENTRY_SIZE  # skip the leading descriptor block
    n = len(payload)
    while off + ENTRY_SIZE <= n:
        rid = struct.unpack_from("<i", payload, off)[0]
        raw = payload[off + 4 : off + 4 + NAME_FIELD].split(b"\x00", 1)[0]
        if raw:
            try:
                name = raw.decode("latin1")
            except Exception:
                name = ""
            if name:
                out[rid] = name
        off += ENTRY_SIZE
    return out


def build_index(recs):
    """Return ``{record_id: name}`` for an archive's parsed records.

    Uses the id==2 table. Returns ``{}`` if the archive has no name table
    (so callers can fall back to a synthetic ``id_<n>`` naming convention).
    """
    rec2 = record_by_id(recs, 2)
    if rec2 is None:
        return {}
    return parse_name_table(rec2.payload)


def png_name_index(recs):
    """Return ``{record_id: name}`` restricted to PNG image records.

    Non-image table entries (``-INDEX.OPT``, ``-IMAGES.OPT``) and any name that
    is not a ``.png`` asset are dropped. Falls back to ``id_<n>`` for any PNG
    record missing from the table.
    """
    names = build_index(recs)
    out = {}
    for r in recs:
        if not r.is_png:
            continue
        nm = names.get(r.id)
        if nm and ".png" in nm.lower():
            out[r.id] = nm
        else:
            # distinct synthetic name; the leading '@' keeps it from matching the
            # <CODE>_nn terrain conventions in naming.py.
            out[r.id] = "@unnamed_%d.PNG" % r.id
    return out
