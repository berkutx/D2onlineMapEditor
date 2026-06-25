"""MQDB (.ff) container reader.

Promoted from ``spikes/probe_ff.py::parse_ff``. A ``.ff`` archive is a ``MQDB``
container: a 28-byte file header followed by a flat list of 28-byte ``MQRC``
record headers, each followed by ``payload[sizeA]`` bytes. We locate records by
scanning for the ``MQRC`` marker (verified robust in the spike).

Record header layout (little-endian, relative to the ``MQRC`` marker):
    +0  'MQRC' (4 bytes)
    +4  reserved   int32
    +8  id         int32   (== logical record id; PNG records map to names via the
                            id==2 name table, see optindex.py)
    +12 sizeA      int32   (payload length)
    +16 sizeB      int32   (uncompressed length; == sizeA here, archives are stored)
    +20 flag       int32
    +24 reserved   int32

Images are embedded standalone PNG files (payload starts with the PNG signature).
"""
import re
import struct

PNG_SIG = b"\x89PNG\r\n\x1a\n"
MQDB_MAGIC = b"MQDB"
MQRC_MARKER = b"MQRC"


class Record(object):
    """A single MQRC record."""

    __slots__ = ("off", "id", "size_a", "size_b", "flag", "payload")

    def __init__(self, off, rid, size_a, size_b, flag, payload):
        self.off = off
        self.id = rid
        self.size_a = size_a
        self.size_b = size_b
        self.flag = flag
        self.payload = payload

    @property
    def is_png(self):
        return self.payload[:4] == b"\x89PNG"

    def __repr__(self):
        return "Record(id=%d, size=%d, png=%s)" % (self.id, self.size_a, self.is_png)


def parse_ff_bytes(data):
    """Parse raw ``.ff`` bytes -> list of :class:`Record`. Raises on bad magic."""
    if data[:4] != MQDB_MAGIC:
        raise ValueError("not an MQDB archive: bad magic %r" % data[:4])
    recs = []
    for m in re.finditer(MQRC_MARKER, data):
        o = m.start()
        # 'MQRC'(4) reserved(4) id(4) sizeA(4) sizeB(4) flag(4) reserved(4)
        _res0, rid, size_a, size_b, flag, _res1 = struct.unpack_from("<6i", data, o + 4)
        payload = data[o + 28 : o + 28 + size_a]
        recs.append(Record(o, rid, size_a, size_b, flag, payload))
    return recs


def parse_ff(path):
    """Read and parse a ``.ff`` archive at ``path``."""
    with open(path, "rb") as f:
        data = f.read()
    return parse_ff_bytes(data)


def png_records(recs):
    """Filter to the embedded-PNG records (the actual image assets)."""
    return [r for r in recs if r.is_png]


def record_by_id(recs, rid):
    """Return the first record whose id == ``rid``, or ``None``."""
    for r in recs:
        if r.id == rid:
            return r
    return None
