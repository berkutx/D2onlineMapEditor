"""store_upload: what of the asset store goes to a server, as one .tgz.

    py -3.7 tools/asset-pipeline/store_upload.py --store public/assets --tar - | ssh <host> \\
      'docker run --rm -i -v d2editor_assets:/dst alpine sh -c "cd /dst && tar xzf -"'

The archive holds, for the chosen mods, ``mods/<id>/mod.json``, every blob those manifests
name (the sheets their ``manifest.json`` names too) and a ``mods/index.json`` that lists
exactly them. By default the chosen mods are every mod of the store's index that is not
DERIVED (derive_mod.py): a derived mod is local work and goes up only when named with
``--mods`` and ``--include-derived``. Blobs no chosen mod names (old atlas pages, earlier
builds) stay behind.

``--list`` prints the archive's member paths instead (one per line), e.g. to check a server
copy with ``sha256sum``.
"""
import argparse
import io
import json
import os
import sys
import tarfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import build_mod  # noqa: E402


class UploadError(Exception):
    pass


def manifest_blobs(store_root, mod):
    """Blobs a mod's manifest.json names (its sprite sheets)."""
    rel = mod.get("files", {}).get("manifest.json")
    if not rel:
        return set()
    with open(os.path.join(store_root, *rel.split("/")), encoding="utf-8") as fp:
        man = json.load(fp)
    out = set()
    for sheet in man.get("spritesheets", []):
        for key in ("image", "meta"):
            v = sheet.get(key) if isinstance(sheet, dict) else None
            if isinstance(v, str) and v.startswith("blobs/"):
                out.add(v)
    return out


def select(store_root, wanted=None, include_derived=False):
    """(index to upload, [(mod id, mod.json)], sorted blob paths)."""
    index = build_mod.load_index(store_root)
    rows = {m["id"]: m for m in index.get("mods", [])}
    ids = list(wanted) if wanted else sorted(rows)
    mods = []
    for mod_id in ids:
        if mod_id not in rows:
            raise UploadError("the store's index has no mod %s" % mod_id)
        mod = build_mod.load_mod(store_root, mod_id)
        if mod is None:
            raise UploadError("mods/%s/mod.json is missing" % mod_id)
        if mod.get("parent"):
            if not wanted:
                continue  # derived: local unless named
            if not include_derived:
                raise UploadError("%s is a derived mod (of %s); add --include-derived to upload it" % (mod_id, mod["parent"]["modId"]))
        mods.append((mod_id, mod))
    if not mods:
        raise UploadError("no mod to upload")
    chosen = {m for m, _ in mods}
    out_index = dict(index)
    out_index["mods"] = [rows[m] for m in sorted(chosen, key=lambda i: (rows[i]["family"], rows[i]["familyOrder"], i))]
    if out_index.get("defaultModId") not in chosen:
        raise UploadError("the default mod %s is not among the mods uploaded (%s)" % (index.get("defaultModId"), ", ".join(sorted(chosen))))
    blobs = set()
    for _mod_id, mod in mods:
        blobs.update(mod.get("files", {}).values())
        blobs.update(manifest_blobs(store_root, mod))
    missing = [b for b in sorted(blobs) if not os.path.isfile(os.path.join(store_root, *b.split("/")))]
    if missing:
        raise UploadError("%d blob(s) are missing from the store, e.g. %s" % (len(missing), missing[0]))
    return out_index, mods, sorted(blobs)


def write_tar(fileobj, store_root, index, mods, blobs):
    # "w:gz" writes forward only (GzipFile never seeks when writing), so a pipe works; the
    # stream mode "w|gz" takes no compresslevel before Python 3.12
    with tarfile.open(fileobj=fileobj, mode="w:gz", compresslevel=1, format=tarfile.USTAR_FORMAT) as tar:
        for rel in blobs:
            tar.add(os.path.join(store_root, *rel.split("/")), arcname=rel, recursive=False)
        for mod_id, _mod in mods:
            rel = "mods/%s/mod.json" % mod_id
            tar.add(os.path.join(store_root, "mods", mod_id, "mod.json"), arcname=rel, recursive=False)
        # the index last: a reader on the server sees the new mods only once their files are there
        data = build_mod.dump_json(index)
        info = tarfile.TarInfo("mods/index.json")
        info.size = len(data)
        info.mode = 0o644
        # the server sees a new index by its time: an unset one (1970) would never change
        info.mtime = int(time.time())
        tar.addfile(info, io.BytesIO(data))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Pack the store's mods for a server, without derived mods")
    ap.add_argument("--store", required=True, help="asset store root (e.g. public/assets)")
    ap.add_argument("--mods", default=None, help="comma-separated mod ids (default: every mod that is not derived)")
    ap.add_argument("--include-derived", action="store_true", help="allow derived mods named in --mods")
    out = ap.add_mutually_exclusive_group(required=True)
    out.add_argument("--tar", metavar="FILE", help="write the .tgz here ('-' for stdout)")
    out.add_argument("--list", action="store_true", help="print the member paths instead")
    args = ap.parse_args(argv)

    store_root = os.path.abspath(args.store)
    wanted = [m.strip() for m in args.mods.split(",") if m.strip()] if args.mods else None
    index, mods, blobs = select(store_root, wanted, args.include_derived)
    size = sum(os.path.getsize(os.path.join(store_root, *b.split("/"))) for b in blobs)
    sys.stderr.write("mods %s: %d blobs, %.1f MB\n" % (", ".join(m for m, _ in mods), len(blobs), size / 1048576.0))
    if args.list:
        for rel in blobs + ["mods/%s/mod.json" % m for m, _ in mods] + ["mods/index.json"]:
            print(rel)
        return 0
    if args.tar == "-":
        write_tar(sys.stdout.buffer, store_root, index, mods, blobs)
        sys.stdout.buffer.flush()
    else:
        with open(args.tar, "xb") as fp:
            write_tar(fp, store_root, index, mods, blobs)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except UploadError as e:
        sys.stderr.write("store_upload: %s\n" % e)
        sys.exit(1)
