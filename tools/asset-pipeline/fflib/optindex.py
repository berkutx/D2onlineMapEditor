"""id <-> name resolution from the MQDB name table (record id == 2).

The table is the record with ``id == 2`` and this layout (toolsqt NamesListData, the same one
``gameresource.GameResource`` reads):

    int32 count
    --- then one 260-byte entry per record, starting at offset 4: ---
        char  name[256]        (latin1, NUL-terminated)
        int32 id               (the MQRC record id that carries this name)

The first entries name the archive's own tables (``-INDEX.OPT``, ``-IMAGES.OPT``, …).

An earlier version read each entry as ``id`` then ``name`` from offset 260. Both strides are
260 bytes, so that reading still produced a tidy table — with every record carrying the name
of the NEXT entry. Nothing looked broken: coverage stayed at ~99%, and the pictures of an
archive whose records come in id order were merely each other's neighbours.

Mind what a record name is good for. In an archive WITH an index (``-INDEX.OPT``) a picture
is found by its index name, and a record holds that picture's parts packed side by side; the
record's file name is only where the art was imported from. Ask ``GameResource.picture``.
"""
import struct

from .mqdb import record_by_id

ENTRY_SIZE = 260
NAME_FIELD = 256
TABLE_START = 4  # past the entry count


def parse_name_table(payload):
    """Parse an id==2 payload into an ``{id: name}`` dict (latin1, all entries)."""
    out = {}
    off = TABLE_START
    n = len(payload)
    while off + ENTRY_SIZE <= n:
        raw = payload[off : off + NAME_FIELD].split(b"\x00", 1)[0]
        rid = struct.unpack_from("<i", payload, off + NAME_FIELD)[0]
        if raw:
            out[rid] = raw.decode("latin1")
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
