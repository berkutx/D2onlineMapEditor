"""dbf: the one reader for the game's Globals tables (dBASE III .dbf).

The catalog builders each used to carry their own copy of this parser. They now share it,
because the same builders have to run against several mods whose tables do NOT have the same
columns: a mod widens a field (Gmodif.SCRIPT C40 vs C64), adds one (GUnits.ATCK_COUNT) or
lacks one another mod has (GmodifL.IMMUNITYC). The record layout is read from each file's own
header, so widths never matter; what does matter is a builder asking for a column the table
does not have. Rows therefore answer a missing column with an EMPTY value instead of raising,
and every such miss is recorded in a :class:`SchemaReport` so a build can show exactly which
expected columns a mod lacks.

Deleted records (marker ``*``) are skipped, as the game skips them: several tables carry
stale ghost rows (GItem 22, GLmark 6, Gunits 4, …).

    rows = read_dbf(path)        # values are raw bytes, padded as stored
    rows = read_dbf_text(path)   # values are latin1-decoded and stripped
"""
import os
import struct

DELETED = 0x2A  # '*'
HEADER_END = 0x0D


class SchemaReport(object):
    """What a build learned about the tables it read.

    ``tables``  : table name (upper, no extension) -> list of (name, type, length, decimals)
    ``missing`` : (table, column) -> how many row reads asked for a column the table lacks
    ``absent``  : table file names that were requested but do not exist in the mod
    """

    def __init__(self):
        self.tables = {}
        self.missing = {}
        self.absent = []

    def note_table(self, table, fields):
        self.tables[table] = [list(f) for f in fields]

    def note_missing(self, table, column):
        key = (table, column)
        self.missing[key] = self.missing.get(key, 0) + 1

    def note_absent(self, name):
        if name not in self.absent:
            self.absent.append(name)

    def missing_columns(self):
        """Sorted ``["TABLE.COLUMN", ...]`` of columns the builders asked for and did not get."""
        return sorted("%s.%s" % k for k in self.missing)

    def to_dict(self):
        return {
            "tables": {t: self.tables[t] for t in sorted(self.tables)},
            "missingColumns": self.missing_columns(),
            "absentTables": sorted(self.absent),
        }

    def reset(self):
        self.tables.clear()
        self.missing.clear()
        del self.absent[:]


#: The report every read in this process contributes to (one mod build = one process).
REPORT = SchemaReport()


class Row(dict):
    """A table row that tolerates a missing column: ``row["NOPE"]`` is the empty value
    (``b""`` or ``""``) and the miss is recorded, so the same builder runs on every mod."""

    __slots__ = ("_table", "_empty", "_report")

    def __init__(self, table, empty, report):
        dict.__init__(self)
        self._table = table
        self._empty = empty
        self._report = report

    def __missing__(self, key):
        self._report.note_missing(self._table, key)
        return self._empty

    def get(self, key, default=None):
        if key in self:
            return dict.__getitem__(self, key)
        self._report.note_missing(self._table, key)
        return default


def table_name(path):
    return os.path.splitext(os.path.basename(path))[0].upper()


def read_schema(data):
    """Field descriptors of a .dbf image: list of ``(name, type, length, decimals)``."""
    fields = []
    i = 32
    while i + 32 <= len(data) and data[i] != HEADER_END:
        name = data[i:i + 11].split(b"\x00")[0].decode("latin1")
        fields.append((name, chr(data[i + 11]), data[i + 16], data[i + 17]))
        i += 32
    return fields


def _read(path, decode, report):
    report = REPORT if report is None else report
    with open(path, "rb") as fp:
        d = fp.read()
    nrec = struct.unpack_from("<I", d, 4)[0]
    hlen = struct.unpack_from("<H", d, 8)[0]
    rlen = struct.unpack_from("<H", d, 10)[0]
    fields = read_schema(d)
    table = table_name(path)
    report.note_table(table, fields)
    empty = "" if decode else b""
    rows = []
    for r in range(nrec):
        off = hlen + r * rlen
        if off + rlen > len(d):
            break
        if d[off] == DELETED:
            continue
        pos = off + 1
        row = Row(table, empty, report)
        for (name, _type, flen, _dec) in fields:
            raw = d[pos:pos + flen]
            dict.__setitem__(row, name, raw.decode("latin1").strip() if decode else raw)
            pos += flen
        rows.append(row)
    return rows


def read_dbf(path, report=None):
    """Live rows of a table; each value is the field's raw bytes exactly as stored."""
    return _read(path, False, report)


def read_dbf_text(path, report=None):
    """Live rows of a table; each value is latin1-decoded and stripped."""
    return _read(path, True, report)


def find_table(globals_dir, name, report=None):
    """Path of a table file by name, matched case-insensitively (the installs differ in case).

    Raises FileNotFoundError when the mod has no such table; the miss is recorded first."""
    for nm in (name, name.upper(), name.lower()):
        p = os.path.join(globals_dir, nm)
        if os.path.exists(p):
            return p
    wanted = name.lower()
    try:
        for entry in os.listdir(globals_dir):
            if entry.lower() == wanted:
                return os.path.join(globals_dir, entry)
    except OSError:
        pass
    (REPORT if report is None else report).note_absent(name)
    raise FileNotFoundError(name + " in " + globals_dir)


def has_table(globals_dir, name):
    try:
        find_table(globals_dir, name, SchemaReport())
        return True
    except FileNotFoundError:
        return False


# ---- value helpers shared by the builders ------------------------------------------

def ascii_(b):
    """An ASCII field (ids, enum keys): up to the first NUL, stripped."""
    return b.decode("latin1").split("\x00")[0].strip()


def cp866_(b):
    """A text field. The Globals tables are CP866 (DOS Cyrillic), unlike the CP1251 .sg."""
    return b.decode("cp866", "replace").rstrip("\x00").strip()


def int_(b, default=0):
    try:
        return int(ascii_(b) or default)
    except ValueError:
        return default


def id_column(rows, column):
    """Sorted unique UPPERCASE ids of one column — the ids a table defines."""
    out = set()
    for r in rows:
        v = ascii_(r[column]).upper()
        if v:
            out.add(v)
    return sorted(out)
