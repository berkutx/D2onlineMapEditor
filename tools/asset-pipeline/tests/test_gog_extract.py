"""gog_extract: the Inno block reader and the file table, on bytes made here (no installer).

    py -3.7 -W ignore -m unittest tests.test_gog_extract        (from tools/asset-pipeline)
"""
import lzma
import os
import struct
import sys
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import gog_extract  # noqa: E402


def block(payload, compress):
    """An Inno block: crc'd header (stored size, compressed flag), then crc'd 4096-byte chunks."""
    if compress:
        lc, lp, pb, dict_size = 3, 0, 2, 1 << 16
        raw = lzma.compress(payload, format=lzma.FORMAT_RAW, filters=[
            {"id": lzma.FILTER_LZMA1, "lc": lc, "lp": lp, "pb": pb, "dict_size": dict_size}])
        payload = bytes([(pb * 5 + lp) * 9 + lc]) + struct.pack("<I", dict_size) + raw
    chunks = b""
    for i in range(0, len(payload), 4096):
        piece = payload[i:i + 4096]
        chunks += struct.pack("<I", zlib.crc32(piece) & 0xFFFFFFFF) + piece
    head = struct.pack("<IB", len(chunks), 1 if compress else 0)
    return struct.pack("<I", zlib.crc32(head) & 0xFFFFFFFF) + head + chunks


def string(s):
    b = s.encode("utf-16-le")
    return struct.pack("<I", len(b)) + b


def file_entry(dest, cond, after, before, location):
    """The ten strings of a file entry and the fields after them, as far as gog_extract reads.
    GOG's entries have an empty source: the destination comes right after its length."""
    strs = ["", dest, "", "", "", "", "", cond, after, before]
    return b"".join(string(s) for s in strs) + b"\0" * 20 + struct.pack("<I", location) + b"\0" * 8


class TestBlocks(unittest.TestCase):
    def test_reads_a_stored_and_a_compressed_block(self):
        payload = bytes(range(256)) * 40  # spans three chunks
        for compress in (False, True):
            buf = b"junk" + block(payload, compress) + b"next"
            got, end = gog_extract.read_block(buf, 4)
            self.assertEqual(got, payload, "compressed" if compress else "stored")
            self.assertEqual(buf[end:], b"next")

    def test_a_damaged_chunk_is_refused(self):
        buf = bytearray(block(b"x" * 5000, False))
        buf[20] ^= 1
        with self.assertRaisesRegex(gog_extract.ExtractError, "chunk crc"):
            gog_extract.read_block(bytes(buf), 0)

    def test_finds_the_header_that_a_block_follows(self):
        entries = gog_extract.DATA_ENTRY.pack(0, 0, 0, 0, 1, 1, b"\0" * 20, 0, 0, 0, 0)
        tail = block(b"the header", True) + block(entries, False)
        # the setup program's own copy of the text comes first, with no block after it
        exe = b"MZ" + gog_extract.SETUP_ID + b"\0" * 80 + gog_extract.SETUP_ID.ljust(64, b"\0") + tail
        header, data = gog_extract.read_setup(exe)
        self.assertEqual(header, b"the header")
        self.assertEqual(len(data), 1)


class TestFileTable(unittest.TestCase):
    MD5 = "0" * 32

    def header(self):
        e = file_entry
        return b"".join([
            # a file in two parts (data entries 0 and 1); the second part has no before_install
            e("{tmp}/aa/bb\\x", "check_if_install('en-US#', 1)", "after_install('%s', 10, 20)" % self.MD5,
              "before_install('%s', 'Imgs\\Big.ff', 2)" % self.MD5, 0),
            e("{tmp}/aa/bc\\y", "check_if_install('en-US#', 1)", "after_install('%s', 5, 7)" % self.MD5, "", 1),
            # one file for English and Polish, one for Polish only
            e("{tmp}/ab/cd\\z", "check_if_install('en-US#pl-PL#', 1)", "after_install('%s', 3, 3)" % self.MD5,
              "before_install('%s', 'Globals\\Tglobal.dbf', 1)" % self.MD5, 2),
            e("{tmp}/ab/ce\\w", "check_if_install('pl-PL#', 1)", "after_install('%s', 3, 4)" % self.MD5,
              "before_install('%s', 'Globals\\Tglobal.dbf', 1)" % self.MD5, 3),
        ])

    def test_groups_the_parts_and_keeps_one_language(self):
        files, conditions = gog_extract.file_table(self.header(), 4, "en-US")
        self.assertEqual(sorted(files), ["Globals/Tglobal.dbf", "Imgs/Big.ff"])
        self.assertEqual(files["Imgs/Big.ff"][1], [(1, 0, 10, 20), (2, 1, 5, 7)])
        self.assertEqual(files["Globals/Tglobal.dbf"][1], [(1, 2, 3, 3)])
        self.assertEqual(conditions, {"en-US#": 1, "en-US#pl-PL#": 1, "pl-PL#": 1})

    def test_two_entries_for_one_language_are_refused(self):
        # for Polish both Tglobal entries apply: refused rather than one picked
        with self.assertRaisesRegex(gog_extract.ExtractError, "two entries for pl-PL"):
            gog_extract.file_table(self.header(), 4, "pl-PL")

    def test_an_entry_past_the_data_entries_is_refused(self):
        with self.assertRaisesRegex(gog_extract.ExtractError, "data entry 4 of 4"):
            gog_extract.file_table(self.header() + file_entry(
                "{tmp}/zz/zz\\q", "", "", "before_install('%s', 'a', 1)" % self.MD5, 4), 4, "en-US")

    def test_a_part_without_sizes_is_refused(self):
        header = file_entry("{tmp}/aa/bb\\x", "", "", "before_install('%s', 'Imgs\\A.ff', 1)" % self.MD5, 0)
        with self.assertRaisesRegex(gog_extract.ExtractError, "Imgs/A.ff: part 1 .data entry 0. has no sizes"):
            gog_extract.file_table(header, 1, "en-US")


if __name__ == "__main__":
    unittest.main()
