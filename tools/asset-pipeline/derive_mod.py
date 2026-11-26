"""derive_mod: build a DERIVED mod into the asset store from its edit file and its parent's install.

A derived mod is a mod of the store (the parent) plus a journal of edits to the parent's tables
and archives: an edit file of packages/mod-edit (``kind: d2-mod-edits``), started with its
command (``node packages/mod-edit/dist/node/cli.js init …``, or ``diff`` from a hand-edited
copy of the tables) and kept, by default, in ``var/mod-edits/<mod-id>/edits.json`` (git
ignores ``var/``). This tool

  1. checks the edit file, the parent's store entry (it must not be derived itself) and the
     parent's install, which must be the one the store's parent was built from (the same
     contentFingerprint);
  2. makes a work folder next to the repo (``var/mod-work/<mod-id>``, on the install's volume):
     the parent's Globals, Scripts, Imgs, Interf and root .exe/.dll as HARD LINKS, and the
     tables and archives the edits change written as new files (packages/mod-edit
     ``materialize``; nothing is ever written through a link into the install);
  3. runs build_mod over it, with ``--parent``, the parent's family and its familyOrder - 1
     (so the parent wins a tie in detection) unless the edit file sets one, and ``--graphics``
     (``--with-capital``) when the parent has its sprite sheets (with Capital.ff);
  4. removes the work folder (``--keep-work`` leaves it).

    py -3.7 tools/asset-pipeline/derive_mod.py --edits var/mod-edits/semga-x/edits.json \\
        --store public/assets [--parent-game DIR] [--dry-run]

Everything the edits do not change is byte-identical to the parent's output and so the
parent's blob: a derived mod costs the store only what its edits change.

Derived mods stay on this machine: store_upload.py, which deploy/README.md uploads with,
leaves them out unless named. A parent listed in ``closedMods`` of mods.local.json (a closed
beta) is refused unless ``--allow-closed-parent``.
"""
import argparse
import json
import os
import shutil
import stat
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)

import build_mod  # noqa: E402

EDITS_KIND = "d2-mod-edits"
EDITS_VERSION = 1
CLI = os.path.join(REPO, "packages", "mod-edit", "dist", "node", "cli.js")
#: Room left free beyond the edited files: the stage folder of catalogs and icons, new blobs.
SPACE_MARGIN = 256 * 1048576


class DeriveError(Exception):
    pass


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def load_edits(path):
    """The edit file's head; the node side checks the journal itself."""
    try:
        with open(path, encoding="utf-8") as fp:
            e = json.load(fp)
    except (OSError, ValueError) as err:
        raise DeriveError("cannot read the edit file %s: %s" % (path, err))
    if not isinstance(e, dict) or e.get("kind") != EDITS_KIND or e.get("version") != EDITS_VERSION:
        raise DeriveError("%s is not a %s v%d file" % (path, EDITS_KIND, EDITS_VERSION))
    mod_id = e.get("modId")
    parent = (e.get("parent") or {}).get("modId")
    if not isinstance(mod_id, str) or not build_mod.MOD_ID_RE.match(mod_id):
        raise DeriveError("%s: modId %r is not a mod id" % (path, mod_id))
    if not isinstance(parent, str) or not build_mod.MOD_ID_RE.match(parent):
        raise DeriveError("%s: parent.modId %r is not a mod id" % (path, parent))
    if parent == mod_id:
        raise DeriveError("%s: the mod is its own parent" % path)
    return e


def local_config(path=None):
    """mods.local.json at the repo root (gitignored), or {}."""
    path = path or os.path.join(REPO, "mods.local.json")
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as fp:
        return json.load(fp)


def family_order(edits, parent):
    order = edits.get("familyOrder")
    return order if isinstance(order, int) else int(parent.get("familyOrder", 0)) - 1


def check_install_matches(game, parent):
    """The install must be the one the store's parent was built from."""
    got, _source = build_mod.fingerprint(game)
    want = parent.get("contentFingerprint")
    if got != want:
        raise DeriveError("the install at %s is not the store's %s: its fingerprint is %s, the store's %s "
                          "(rebuild the parent first, or give the right --parent-game)" % (game, parent["id"], got, want))
    return got


def active_ops(edits):
    cursor = edits.get("cursor", 0)
    return [op for commit in edits.get("journal", [])[:cursor] for op in commit.get("ops", [])]


def edited_files(edits, game):
    """Paths in the parent's install of the tables and archives the edits change."""
    out = set()
    globals_dir = build_mod.find_dir(game, "Globals")
    interf = build_mod.find_dir(game, "Interf")
    imgs = build_mod.find_dir(game, "Imgs")
    for op in active_ops(edits):
        if "table" in op:
            dirs, name = (globals_dir, interf), op["table"] + ".dbf"
        elif "archive" in op:
            dirs, name = (imgs, interf), op["archive"]
        else:
            continue
        for d in dirs:
            p = d and build_mod.find_file(d, name)
            if p:
                out.add(p)
                break
    return sorted(out)


def check_space(where, need):
    free = shutil.disk_usage(where).free
    if free < need:
        raise DeriveError("%.0f MB free on the volume of %s, %.0f MB needed" % (free / 1048576.0, where, need / 1048576.0))
    return free


def remove_work(work, game):
    """Remove the work folder. Its hard links are names of the parent's files: unlinking one
    leaves the file. A read-only file has to be made writable to unlink it, and as the
    attribute belongs to the file, not the name, it is put back on the parent's copy after."""
    if not os.path.isdir(work):
        return
    for root, dirs, names in os.walk(work, topdown=False):
        for name in names:
            p = os.path.join(root, name)
            try:
                os.unlink(p)
            except PermissionError:
                mode = os.stat(p).st_mode
                os.chmod(p, mode | stat.S_IWRITE)
                os.unlink(p)
                original = os.path.join(game, os.path.relpath(p, work))
                if os.path.exists(original):
                    os.chmod(original, mode)
        for name in dirs:
            os.rmdir(os.path.join(root, name))
    os.rmdir(work)


def run_materialize(node, game, edits_path, work, payloads):
    if not os.path.isfile(CLI):
        raise DeriveError("%s is missing: build the TypeScript first (corepack pnpm run build:tsc)" % CLI)
    cmd = [node, CLI, "materialize", "--parent-game", game, "--edits", edits_path, "--out", work, "--json"]
    if payloads:
        cmd += ["--payloads", payloads]
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out = r.stdout.decode("utf-8", "replace")
    err = r.stderr.decode("utf-8", "replace").strip()
    try:
        report = json.loads(out) if out.strip() else None
    except ValueError:
        report = None
    if r.returncode != 0:
        if report and report.get("conflicts"):
            for c in report["conflicts"][:20]:
                log("  CONFLICT %s %s: %s" % (c.get("file"), c.get("reason"), c.get("detail")))
            if len(report["conflicts"]) > 20:
                log("  … %d more" % (len(report["conflicts"]) - 20))
            raise DeriveError("the edits do not apply to %s: %d conflict(s)" % (game, len(report["conflicts"])))
        raise DeriveError("mod-edit materialize failed (%d): %s" % (r.returncode, err or out[:500]))
    if report is None:
        raise DeriveError("mod-edit materialize printed no report")
    return report


def parent_graphics(store_root, parent):
    """(has sheets, with Capital.ff) of the parent's build."""
    rel = parent.get("files", {}).get("manifest.json")
    if not rel:
        return False, False
    with open(os.path.join(store_root, *rel.split("/")), encoding="utf-8") as fp:
        man = json.load(fp)
    sheets = man.get("spritesheets", [])
    return True, any(str(s.get("ff", "")).lower() == "capital.ff" for s in sheets if isinstance(s, dict))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build a derived mod (a parent mod + an edit file) into the asset store")
    ap.add_argument("--edits", required=True, help="the edit file (kind d2-mod-edits)")
    ap.add_argument("--store", required=True, help="asset store root (e.g. public/assets)")
    ap.add_argument("--parent-game", default=None, metavar="DIR",
                    help="the parent's game folder (default: gameRoots[<parent>] of mods.local.json)")
    ap.add_argument("--payloads", default=None, metavar="DIR",
                    help="payload files of ff.putRecord ops (default: <edit file's folder>/payloads)")
    ap.add_argument("--work", default=None, metavar="DIR",
                    help="the work folder to make, on the install's volume (default: var/mod-work/<mod-id>)")
    ap.add_argument("--keep-work", action="store_true", help="leave the work folder for a look")
    ap.add_argument("--allow-closed-parent", action="store_true",
                    help="derive from a mod in closedMods of mods.local.json")
    ap.add_argument("--node", default=None, help="the node executable (default: node on PATH)")
    ap.add_argument("--dry-run", action="store_true", help="build and report, but leave the store untouched")
    args = ap.parse_args(argv)

    edits_path = os.path.abspath(args.edits)
    edits = load_edits(edits_path)
    mod_id, parent_id = edits["modId"], edits["parent"]["modId"]
    store_root = os.path.abspath(args.store)
    config = local_config()
    if parent_id in (config.get("closedMods") or []) and not args.allow_closed_parent:
        raise DeriveError("%s is a closed mod (closedMods in mods.local.json): a mod derived from it would "
                          "carry its data; give --allow-closed-parent to derive from it anyway" % parent_id)
    try:
        parent = build_mod.load_parent(store_root, parent_id)
    except build_mod.BuildError as e:
        raise DeriveError(str(e))
    existing = build_mod.load_mod(store_root, mod_id)
    if existing and not existing.get("parent"):
        raise DeriveError("the store's %s is not a derived mod; pick another modId" % mod_id)

    game = args.parent_game or (config.get("gameRoots") or {}).get(parent_id)
    if not game:
        raise DeriveError("no install for %s: give --parent-game, or gameRoots.%s in mods.local.json" % (parent_id, parent_id))
    game = os.path.abspath(game)
    if not build_mod.find_dir(game, "Globals"):
        raise DeriveError("no Globals under %s" % game)
    started = edits["parent"].get("contentFingerprint")
    log("[%s] checking the install of %s ..." % (mod_id, parent_id))
    check_install_matches(game, parent)
    if started and started != parent["contentFingerprint"]:
        log("[%s] note: %s was rebuilt since the edits began; an edited cell that changed under them is a conflict" % (mod_id, parent_id))

    work = os.path.abspath(args.work or os.path.join(REPO, "var", "mod-work", mod_id))
    if os.path.exists(work):
        raise DeriveError("%s exists (a run left it?): remove it first" % work)
    if build_mod.is_inside(work, game) or build_mod.is_inside(work, store_root):
        raise DeriveError("the work folder %s may not be inside the install or the store" % work)
    if not build_mod.same_volume(work, game):
        raise DeriveError("the work folder %s must be on the volume of %s (hard links)" % (work, game))
    edited = edited_files(edits, game)
    need = sum(os.path.getsize(p) for p in edited) + SPACE_MARGIN
    os.makedirs(os.path.dirname(work), exist_ok=True)
    check_space(os.path.dirname(work), need)

    node = args.node or shutil.which("node")
    if not node:
        raise DeriveError("node is not on PATH; give --node")
    payloads = args.payloads or os.path.join(os.path.dirname(edits_path), "payloads")
    graphics, capital = parent_graphics(store_root, parent)
    try:
        log("[%s] work folder %s ..." % (mod_id, work))
        report = run_materialize(node, game, edits_path, work, payloads if os.path.isdir(payloads) else None)
        log("[%s] %d files linked, %d written%s" % (
            mod_id, report.get("linked", 0), len(report.get("written", [])),
            "".join(", %s %d op(s) carried" % (c["archive"], c["ops"]) for c in report.get("carried", []))))
        argv2 = ["--game", work, "--mod-id", mod_id, "--name", edits.get("name") or mod_id,
                 "--family", parent.get("family") or parent_id, "--family-order", str(family_order(edits, parent)),
                 "--store", store_root, "--parent", parent_id]
        if graphics:
            argv2.append("--graphics")
        if capital:
            argv2.append("--with-capital")
        if args.dry_run:
            argv2.append("--dry-run")
        try:
            rc = build_mod.main(argv2)
        except build_mod.BuildError as e:
            raise DeriveError(str(e))
        if rc:
            raise DeriveError("build_mod failed (%s)" % rc)
    finally:
        if args.keep_work:
            log("[%s] the work folder stays: %s" % (mod_id, work))
        else:
            remove_work(work, game)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except DeriveError as e:
        log("derive_mod: " + str(e))
        sys.exit(1)
