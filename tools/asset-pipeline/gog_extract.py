"""Take chosen files out of a GOG offline installer of Disciples II without installing it.

GOG's installer (Inno Setup 5.6.2, Unicode) is an .exe and a .bin next to it:

- the .exe holds the setup header, LZMA-compressed. Each file entry installs into
  `{tmp}/xx/yy\\<md5>`; its real path is in the entry's `before_install('<md5 of the file>',
  '<Real\\Path>', <number of parts>)`, the language it is for in `check_if_install('en-US#', ...)`,
  and the part's sizes in `after_install('<md5 of the part>', <stored size>, <real size>)`.
- the .bin holds the data: a file of up to 10 MB is one zlib stream, a larger one is several
  10 MB parts in consecutive data entries, each its own zlib stream inside an Inno chunk that
  Inno stored as it is.

Every part is checked (sha1 of the stored bytes, real size, end of the zlib stream) and the
whole file against its md5. Files for another language than `--lang` are left out.

    py -3.7 gog_extract.py <setup.exe> <out dir> [--bin <setup.bin>] [--list] [--lang en-US] [regex ...]

The regexes pick files by their path in the game folder (`Globals/`, `Imgs/IsoUnit.ff`); none
picks every file. `--list` prints what would be extracted. Writes `<out>/<path>`; nothing
else is touched. The README's "The unmodded game" section has the command for the editor.
"""
import argparse
import hashlib
import lzma
import os
import re
import struct
import sys
import zlib

SETUP_ID = b"Inno Setup Setup Data (5.6.2) (u)"
SLICE_ID = b"idska32\x1a"
CHUNK_ID = b"zlb\x1a"
# first_slice, last_slice, chunk_offset, file_offset, file_size, chunk_size, sha1, filetime,
# version ms/ls, flags
DATA_ENTRY = struct.Struct("<IIIQQQ20sQIIH")
FLAG_CHUNK_COMPRESSED = 0x80


class ExtractError(Exception):
    pass


def read_block(buf, pos):
    """An Inno block at pos: crc'd header, 4096-byte crc'd chunks, LZMA1 when compressed.
    Returns (bytes, position after the block)."""
    crc, stored, compressed = struct.unpack_from("<IIB", buf, pos)
    if zlib.crc32(buf[pos + 4:pos + 9]) & 0xFFFFFFFF != crc:
        raise ExtractError("setup header: block header crc")
    pos += 9
    raw = bytearray()
    end = pos + stored
    while pos < end:
        n = min(4096, end - pos - 4)
        if zlib.crc32(buf[pos + 4:pos + 4 + n]) & 0xFFFFFFFF != struct.unpack_from("<I", buf, pos)[0]:
            raise ExtractError("setup header: chunk crc")
        raw += buf[pos + 4:pos + 4 + n]
        pos += 4 + n
    if not compressed:
        return bytes(raw), end
    props, dict_size = raw[0], struct.unpack_from("<I", raw, 1)[0]
    lc, rest = props % 9, props // 9
    dec = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[
        {"id": lzma.FILTER_LZMA1, "lc": lc, "lp": rest % 5, "pb": rest // 5, "dict_size": dict_size}])
    return dec.decompress(bytes(raw[5:])), end


def read_setup(exe):
    """The setup header and the data entries of the installer's .exe bytes."""
    # the setup program's own code has the same text: the header is the one a block follows
    for m in re.finditer(re.escape(SETUP_ID), exe):
        try:
            header, nxt = read_block(exe, m.start() + 64)
            break
        except (ExtractError, struct.error, lzma.LZMAError):
            continue
    else:
        raise ExtractError("not an Inno Setup 5.6.2 (u) installer (GOG's offline installer is)")
    entries, _ = read_block(exe, nxt)
    if len(entries) % DATA_ENTRY.size:
        raise ExtractError("data entries: %d bytes is not a whole number of entries" % len(entries))
    data = [DATA_ENTRY.unpack_from(entries, i * DATA_ENTRY.size) for i in range(len(entries) // DATA_ENTRY.size)]
    return header, data


def file_table(header, data_count, lang):
    """{path: [(part, data entry, stored size, real size)]}, and the language conditions seen."""

    def string_at(pos):
        n = struct.unpack_from("<I", header, pos)[0]
        if n > 20000 or n % 2:
            raise ValueError
        return header[pos + 4:pos + 4 + n].decode("utf-16-le"), pos + 4 + n

    parts_at = {}
    heads = []
    for m in re.finditer(re.escape("{tmp}/".encode("utf-16-le")), header):
        # an entry's ten strings begin with its source, 8 bytes before the destination
        pos = m.start() - 8
        strs = []
        try:
            for _ in range(10):
                v, pos = string_at(pos)
                strs.append(v)
        except ValueError:
            continue
        location = struct.unpack_from("<I", header, pos + 20)[0]
        if location >= data_count:
            raise ExtractError("a file entry names data entry %d of %d" % (location, data_count))
        sizes = re.match(r"after_install\('([0-9a-f]{32})', (\d+), (\d+)\)$", strs[8])
        if sizes:
            parts_at[location] = (int(sizes.group(2)), int(sizes.group(3)))
        named = re.match(r"before_install\('([0-9a-f]{32})', '([^']+)', (\d+)\)$", strs[9])
        if named:
            cond = re.match(r"check_if_install\('([^']*)'", strs[7])
            heads.append((named.group(2).replace("\\", "/"), location, int(named.group(3)), named.group(1),
                          cond.group(1) if cond else strs[7]))
    conditions = {}
    files = {}
    for name, location, count, file_md5, cond in heads:
        conditions[cond] = conditions.get(cond, 0) + 1
        # a file for other languages only is left out; two for this language would be a conflict
        if cond and cond != "#" and ("%s#" % lang) not in cond and not cond.startswith("#"):
            continue
        if name in files:
            raise ExtractError("%s: two entries for %s" % (name, lang))
        parts = []
        for i in range(count):
            if location + i not in parts_at:
                raise ExtractError("%s: part %d (data entry %d) has no sizes" % (name, i + 1, location + i))
            stored, real = parts_at[location + i]
            parts.append((i + 1, location + i, stored, real))
        files[name] = (file_md5, parts)
    return files, conditions


def extract(slice_file, data, name, md5, parts, out):
    """Write one file to out/<name> (through a .part file), checking every part."""
    dst = os.path.join(out, *name.split("/"))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    whole = hashlib.md5()
    written = 0
    problems = []
    with open(dst + ".part", "wb") as w:
        for part, loc, stored, real in parts:
            first, last, chunk_off, file_off, size, chunk_size, sha1, _, _, _, flags = data[loc]
            # one slice, the part alone in its chunk, stored as it is (Inno did not compress it)
            if first != 0 or last != 0 or file_off != 0 or size != chunk_size or size != stored or flags & FLAG_CHUNK_COMPRESSED:
                raise ExtractError("%s part %d: a layout this tool does not know %r" % (name, part, data[loc][:6] + (flags,)))
            slice_file.seek(chunk_off)
            if slice_file.read(4) != CHUNK_ID:
                raise ExtractError("%s part %d: no chunk at %d" % (name, part, chunk_off))
            sh = hashlib.sha1()
            dec = zlib.decompressobj()
            got = 0
            left = size
            while left > 0:
                raw = slice_file.read(min(1 << 20, left))
                if not raw:
                    break
                left -= len(raw)
                sh.update(raw)
                piece = dec.decompress(raw)
                w.write(piece)
                whole.update(piece)
                got += len(piece)
            piece = dec.flush()
            w.write(piece)
            whole.update(piece)
            got += len(piece)
            written += got
            if sh.digest() != sha1:
                problems.append("part %d: sha1 of the stored bytes" % part)
            if got != real:
                problems.append("part %d: size %d, expected %d" % (part, got, real))
            if not dec.eof:
                problems.append("part %d: zlib stream not finished" % part)
    if whole.hexdigest() != md5:
        problems.append("md5 of the file")
    if problems:
        os.remove(dst + ".part")
        raise ExtractError("%s: %s" % (name, "; ".join(problems)))
    os.replace(dst + ".part", dst)
    return written


def main(argv=None):
    ap = argparse.ArgumentParser(description="Take files out of a GOG Disciples II installer")
    ap.add_argument("exe", help="setup_....exe")
    ap.add_argument("out", help="folder to write the files into (paths as in the game folder)")
    ap.add_argument("patterns", nargs="*", help="regexes on the file path (case-insensitive); none = every file")
    ap.add_argument("--bin", default=None, help="setup_....bin (default: the .exe's name with .bin)")
    ap.add_argument("--lang", default="en-US", help="the installer language whose files to take (default en-US)")
    ap.add_argument("--list", action="store_true", help="print what would be extracted and stop")
    args = ap.parse_intermixed_args(argv)

    with open(args.exe, "rb") as fp:
        exe = fp.read()
    header, data = read_setup(exe)
    files, conditions = file_table(header, len(data), args.lang)
    print("language conditions: %s" % ", ".join("%s %d" % (c or "-", n) for c, n in sorted(conditions.items())))
    patterns = [re.compile(p, re.I) for p in args.patterns]
    wanted = sorted(n for n in files if not patterns or any(p.search(n) for p in patterns))
    total = sum(p[3] for n in wanted for p in files[n][1])
    print("%d files for %s, %d wanted, %.1f MB" % (len(files), args.lang, len(wanted), total / 1048576.0))
    if args.list:
        for n in wanted:
            print("  %-40s %11d  %d part(s)" % (n, sum(p[3] for p in files[n][1]), len(files[n][1])))
        return 0
    bin_path = args.bin or os.path.splitext(args.exe)[0] + ".bin"
    with open(bin_path, "rb") as slice_file:
        if slice_file.read(8) != SLICE_ID:
            raise ExtractError("%s is not an Inno Setup slice" % bin_path)
        for n in wanted:
            md5, parts = files[n]
            print("ok %-40s %11d  %d part(s)" % (n, extract(slice_file, data, n, md5, parts, args.out), len(parts)))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ExtractError as e:
        sys.exit("gog_extract: %s" % e)
