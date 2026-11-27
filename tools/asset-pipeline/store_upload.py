"""store_upload: what of the asset store goes to a server, as one .tgz.

    py -3.7 tools/asset-pipeline/store_upload.py --store public/assets --tar - | ssh <host> \\
      'docker run --rm -i -v d2editor_assets:/dst alpine sh -c "cd /dst && tar xzf -"'

The archive holds, for the chosen mods, ``mods/<id>/mod.json``, every blob those manifests
name (the sheets their ``manifest.json`` names too) and a ``mods/index.json`` that lists
exactly them. By default the chosen mods are every mod of the store's index that is not
DERIVED (derive_mod.py): a derived mod is local work and goes up only when named with
``--mods`` and ``--include-derived``. Blobs no chosen mod names (old atlas pages, earlier
builds) stay behind.

CLOSED mods (``closedMods`` of the local config: ``--local-config``, by default
mods.local.json at the repo root; no such file means no closed mod) go up WITHOUT the
install's own files. Their ``mod.json`` in the archive lacks the ``tables/...`` and
``capital.dat`` entries (it is written from bytes; the local file keeps them), and a blob
that only those entries name is not sent. A blob another uploaded mod names still goes: it
is that mod's table. A mod derived from a closed mod counts as closed (it carries the
parent's tables). stderr names the closed mods and how many files were left out. So on the
server a closed mod's mod.json is not the local file, and its rev differs from the local one.

``--with-closed-tables`` sends the closed mods whole, tables included, for a server that
keeps them private: it must list them in HIDDEN_MODS, and then serves their tables only to a
request with a share key (MOD_SHARE_KEYS, the mod comparison's secret link; deploy/README).

``--list`` prints the archive's member paths instead (one per line), e.g. to check a server
copy with ``sha256sum``. It lists the same set the archive would hold.
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
import derive_mod  # noqa: E402  (reads mods.local.json)

#: The local config read when --local-config is not given.
DEFAULT_LOCAL_CONFIG = os.path.join(derive_mod.REPO, "mods.local.json")


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


def closed_mods(config):
    """The ids in closedMods of a local config."""
    return set(config.get("closedMods") or [])


def is_closed(mod_id, mod, closed):
    """A closed mod, or a mod derived from one (it carries that mod's tables)."""
    return mod_id in closed or (mod.get("parent") or {}).get("modId") in closed


def without_install_files(mod):
    """A copy of a mod.json without the install's own files (tables/..., capital.dat)."""
    out = dict(mod)
    out["files"] = {k: v for k, v in mod.get("files", {}).items() if not build_mod.is_install_file(k)}
    return out


def select(store_root, wanted=None, include_derived=False, closed=()):
    """(index to upload, [(mod id, mod.json to upload)], sorted blob paths).

    The mod.json of a closed mod is the local one without its install files; the blobs are
    the ones the uploaded mod.json files (and their sprite manifests) name."""
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
        if is_closed(mod_id, mod, closed):
            mod = without_install_files(mod)
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


def left_out(store_root, mods, blobs, closed):
    """[(mod id, logical names left out of its mod.json, blobs not sent)] of the closed mods."""
    sent = set(blobs)
    out = []
    for mod_id, mod in mods:
        if not is_closed(mod_id, mod, closed):
            continue
        local = build_mod.load_mod(store_root, mod_id).get("files", {})
        names = sorted(set(local) - set(mod.get("files", {})))
        out.append((mod_id, names, sorted(set(local[n] for n in names) - sent)))
    return out


def _add_bytes(tar, name, data):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = 0o644
    # the server sees a new index by its time: an unset one (1970) would never change
    info.mtime = int(time.time())
    tar.addfile(info, io.BytesIO(data))


def write_tar(fileobj, store_root, index, mods, blobs):
    # "w:gz" writes forward only (GzipFile never seeks when writing), so a pipe works; the
    # stream mode "w|gz" takes no compresslevel before Python 3.12
    with tarfile.open(fileobj=fileobj, mode="w:gz", compresslevel=1, format=tarfile.USTAR_FORMAT) as tar:
        for rel in blobs:
            tar.add(os.path.join(store_root, *rel.split("/")), arcname=rel, recursive=False)
        for mod_id, mod in mods:
            rel = "mods/%s/mod.json" % mod_id
            if mod == build_mod.load_mod(store_root, mod_id):
                # the local file as it is: the server's rev of the mod is the hash of these bytes
                tar.add(os.path.join(store_root, "mods", mod_id, "mod.json"), arcname=rel, recursive=False)
            else:
                # a closed mod without its install files; the local mod.json keeps them
                _add_bytes(tar, rel, build_mod.dump_json(mod))
        # the index last: a reader on the server sees the new mods only once their files are there
        _add_bytes(tar, "mods/index.json", build_mod.dump_json(index))


def load_closed(path=None):
    """closedMods of the local config. The default file may be absent (no closed mod); a
    file named with --local-config must exist."""
    if path and not os.path.isfile(path):
        raise UploadError("no local config at %s" % path)
    path = path or DEFAULT_LOCAL_CONFIG
    if not os.path.isfile(path):
        sys.stderr.write("no local config at %s: no mod is treated as closed\n" % path)
        return set()
    try:
        return closed_mods(derive_mod.local_config(path))
    except (OSError, ValueError) as e:
        raise UploadError("cannot read the local config %s: %s" % (path, e))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Pack the store's mods for a server, without derived mods")
    ap.add_argument("--store", required=True, help="asset store root (e.g. public/assets)")
    ap.add_argument("--mods", default=None, help="comma-separated mod ids (default: every mod that is not derived)")
    ap.add_argument("--include-derived", action="store_true", help="allow derived mods named in --mods")
    ap.add_argument("--local-config", default=None, metavar="PATH",
                    help="the config whose closedMods go up without their tables "
                         "(default: mods.local.json at the repo root; absent = no closed mod)")
    ap.add_argument("--with-closed-tables", action="store_true",
                    help="send the closed mods with their tables too, for a server that hides them "
                         "(HIDDEN_MODS) and serves their tables only with a share key")
    out = ap.add_mutually_exclusive_group(required=True)
    out.add_argument("--tar", metavar="FILE", help="write the .tgz here ('-' for stdout)")
    out.add_argument("--list", action="store_true", help="print the member paths instead")
    args = ap.parse_args(argv)

    store_root = os.path.abspath(args.store)
    wanted = [m.strip() for m in args.mods.split(",") if m.strip()] if args.mods else None
    closed = load_closed(os.path.abspath(args.local_config) if args.local_config else None)
    if args.with_closed_tables and closed:
        sys.stderr.write("closed mods %s go up WITH their tables: the server must list them in HIDDEN_MODS\n" % ", ".join(sorted(closed)))
        closed = set()
    index, mods, blobs = select(store_root, wanted, args.include_derived, closed)
    size = sum(os.path.getsize(os.path.join(store_root, *b.split("/"))) for b in blobs)
    sys.stderr.write("mods %s: %d blobs, %.1f MB\n" % (", ".join(m for m, _ in mods), len(blobs), size / 1048576.0))
    for mod_id, names, kept in left_out(store_root, mods, blobs, closed):
        sys.stderr.write("closed mod %s: %d files left out of its mod.json (tables, capital.dat), %d blobs not sent\n" % (
            mod_id, len(names), len(kept)))
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
