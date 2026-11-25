"""build_mod: build one MOD data set into the content-addressed asset store.

A mod is one game installation's data (Globals tables, scripts, sprites) converted for the
editor. Several mods live side by side in one store and share every byte-identical file:

    <store>/mods/index.json          the installed mods
    <store>/mods/<mod-id>/mod.json   one mod: identity + logical file name -> blob
    <store>/blobs/<xx>/<sha256>.<ext>

    python tools/asset-pipeline/build_mod.py \
        --game "C:/Games/SomeMod" --mod-id some-mod --name "Some Mod" \
        --family some --family-order 1 --store public/assets \
        [--graphics]

``--game`` is the directory that holds ``Globals`` / ``Imgs`` / ``Scripts`` (for an original
install that is ``<root>/Game``).

What is built here (the DATA of a mod):
  * the catalogs the editor already uses (units, items, spells, lords, modifiers, object
    data) and the icon sets, by the existing builders, unchanged;
  * ``ids.json``           every id the Globals tables define  -> mod detection
  * ``profile.json``       races / guardians / leaders / lords -> blank maps, new players
  * ``dictionaries.json``  the L*.dbf lookup tables            -> pickers of the mod editor
  * ``scenVariables.json`` scenario variables the mod reads    -> map restrictions
  * ``settings.json``      scalar values of Scripts/settings.lua
  * ``dbfSchema.json``     columns of every Globals table, and which expected ones are absent
  * ``modscripts/**``      the Lua sources of scripted modifiers

``--graphics`` also builds the mod's sprites (build_sheets: one small palette sheet per
source image record, AssetManifest 0.2) and the decoration catalog, which needs them.
``--ingest-atlases`` instead takes in the atlas pages an earlier ``pipeline.py`` run produced
(AssetManifest 0.1). Without either the mod is registered as ``data-only``.

Everything is written through fflib.blobstore, so a file two mods share is stored once.
The contract of the JSON files is packages/mod-catalog (Contract D).
"""
import argparse
import hashlib
import importlib
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from fflib import dbf  # noqa: E402
from fflib.blobstore import BlobStore, sha256_file  # noqa: E402
import manifest as manifest_mod  # noqa: E402

PIPELINE_VERSION = "2.1.0"
SCHEMA_VERSION = 1
MOD_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
NULL_ID = "G000000000"

#: Catalog / icon builders, in dependency order (icons read the catalogs).
DATA_BUILDERS = [
    "extract_gamedata",
    "build_unit_catalog",
    "build_item_catalog",
    "build_spell_catalog",
    "build_lord_catalog",
    "build_modifier_catalog",
    "build_item_icons",
    "build_spell_icons",
    "build_lord_icons",
    "build_unit_icons",
]
#: Builders that read the sprite sheets from --out; run only when graphics are present.
GRAPHICS_BUILDERS = ["build_decor_catalog"]

#: Table code inside a global id -> (table file, id column). Mirrors ID_TABLES of Contract D.
ID_TABLES = [
    ("UU", "Gunits.dbf", "UNIT_ID"),
    ("IG", "GItem.dbf", "ITEM_ID"),
    ("SS", "GSpells.dbf", "SPELL_ID"),
    ("MG", "GLmark.dbf", "LMARK_ID"),
    ("UM", "Gmodif.dbf", "MODIF_ID"),
    ("LR", "Glord.dbf", "LORD_ID"),
    ("RR", "Grace.dbf", "RACE_ID"),
    ("BB", "Gbuild.dbf", "BUILD_ID"),
]

#: Imgs archives the pipeline converts — the part of Imgs that belongs to a mod's identity.
FINGERPRINT_ARCHIVES = [
    "IsoTerrn.ff", "IsoStill.ff", "IsoCmon.ff", "City.ff", "Capital.ff", "IsoAnim.ff",
    "IsoUnit.ff", "Ground.ff", "GrBorder.ff", "IconItem.ff", "IconSpel.ff", "Lords.ff",
    "Faces.ff",
]

#: Lrace code (TEXT without "L_", first two letters) -> the editor's race key.
RACE_KEYS = {"HU": "empire", "DW": "clans", "HE": "legions", "UN": "undead", "EL": "elves", "NE": "neutral"}
#: The item a new capital starts with (toolsqt D2MapEditor::addRace), when the mod has it.
CAPITAL_ITEM = "G000IG0006"
#: The round 1x1 stone tower ("Башня") the game's own maze maps place at wall junctions.
MAZE_TOWER = "G000MG0149"
#: What the editor's own code still assumes about races, whatever the mod (its reference
#: RACES table, packages/sg-parser createBlankMap.ts): race key -> (RACE_ID, RACE_TYPE,
#: guardian, first leader, category-0 lord, capital terrain). Hit points come from the
#: profile; these ids do not, so a mod that changes them is reported at build time.
REFERENCE_RACES = {
    "empire": ("G000RR0000", 0, "G000UU3001", "G000UU0019", "G000LR0003", 1),
    "clans": ("G000RR0001", 3, "G000UU3002", "G000UU0044", "G000LR0006", 2),
    "legions": ("G000RR0002", 2, "G000UU3003", "G000UU0070", "G000LR0009", 3),
    "undead": ("G000RR0003", 1, "G000UU3004", "G000UU0096", "G000LR0012", 4),
    "elves": ("G000RR0005", 5, "G000UU8040", "G000UU8009", "G000LR0018", 6),
}


def race_table_differences(profile):
    """Where a mod's races depart from REFERENCE_RACES (ids and types, not hit points)."""
    by_key = {r["key"]: r for r in profile["races"]}
    out = []
    for key, ref in sorted(REFERENCE_RACES.items()):
        r = by_key.get(key)
        if not r:
            out.append("%s: absent" % key)
            continue
        got = (r["raceId"], r["raceType"], r.get("guardian"), r.get("leader"), r.get("lord"), r.get("terrain"))
        if got != ref:
            out.append("%s: %s (editor assumes %s)" % (key, got, ref))
    return out


class BuildError(Exception):
    pass


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def dump_json(obj):
    """Deterministic JSON bytes: same data -> same bytes -> same blob."""
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def find_dir(parent, name):
    """A sub-directory by case-insensitive name, or None."""
    direct = os.path.join(parent, name)
    if os.path.isdir(direct):
        return direct
    try:
        for entry in os.listdir(parent):
            if entry.lower() == name.lower() and os.path.isdir(os.path.join(parent, entry)):
                return os.path.join(parent, entry)
    except OSError:
        pass
    return None


def find_file(parent, name):
    try:
        for entry in os.listdir(parent):
            if entry.lower() == name.lower() and os.path.isfile(os.path.join(parent, entry)):
                return os.path.join(parent, entry)
    except OSError:
        pass
    return None


# ---- identity ------------------------------------------------------------------------

def _fingerprint(entries):
    """sha256 over the sorted ``path\\0size\\0sha256`` lines (the engine content pack's scheme)."""
    lines = sorted("%s\0%d\0%s" % e for e in entries)
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def fingerprint(game):
    """(contentFingerprint, source hashes) of the install files this pipeline reads."""
    groups = {"globals": [], "scripts": [], "imgs": []}
    g = find_dir(game, "Globals")
    if g:
        for name in sorted(os.listdir(g)):
            if name.lower().endswith(".dbf"):
                p = os.path.join(g, name)
                groups["globals"].append(("globals/" + name.lower(), os.path.getsize(p), sha256_file(p)))
    s = find_dir(game, "Scripts")
    if s:
        for root, _dirs, names in os.walk(s):
            for name in names:
                if name.lower().endswith(".lua"):
                    p = os.path.join(root, name)
                    rel = os.path.relpath(p, s).replace("\\", "/").lower()
                    groups["scripts"].append(("scripts/" + rel, os.path.getsize(p), sha256_file(p)))
    i = find_dir(game, "Imgs")
    if i:
        for arch in FINGERPRINT_ARCHIVES:
            p = find_file(i, arch)
            if p:
                groups["imgs"].append(("imgs/" + arch.lower(), os.path.getsize(p), sha256_file(p)))
    source = {}
    for key in ("globals", "scripts"):
        if groups[key]:
            source[key] = _fingerprint(groups[key])
    for key, name in (("exe", "Discipl2.exe"), ("mss32", "mss32.dll")):
        p = find_file(game, name)
        if p:
            source[key] = sha256_file(p)
    return _fingerprint(groups["globals"] + groups["scripts"] + groups["imgs"]), source


# ---- new per-mod files ---------------------------------------------------------------

def build_ids(globals_dir):
    tables = {}
    for code, table, column in ID_TABLES:
        try:
            rows = dbf.read_dbf(dbf.find_table(globals_dir, table))
        except FileNotFoundError:
            continue
        tables[code] = [i for i in dbf.id_column(rows, column) if i != NULL_ID]
    return {"schemaVersion": SCHEMA_VERSION, "tables": tables}


def _texts(globals_dir):
    out = {}
    for r in dbf.read_dbf(dbf.find_table(globals_dir, "Tglobal.dbf")):
        key = dbf.ascii_(r["TXT_ID"]).lower()
        if key:
            out[key] = re.sub(r"^\\f\w+;", "", dbf.cp866_(r["TEXT"])).strip()
    return out


def _code_table(globals_dir, name):
    """An L*.dbf enum as {id: 2-letter code} ("L_HUMAN" -> "HU")."""
    out = {}
    for r in dbf.read_dbf(dbf.find_table(globals_dir, name)):
        try:
            out[int(dbf.ascii_(r["ID"]))] = dbf.ascii_(r["TEXT"]).replace("L_", "")[:2].upper()
        except ValueError:
            continue
    return out


def build_profile(globals_dir):
    """Races as the editor's "add race" needs them (port of toolsqt D2MapEditor::addRace):
    the Grace row, its guardian and first leader with their base hit points, the race's
    category-0 lord, and the terrain stamped under a new capital."""
    texts = _texts(globals_dir)
    lrace = _code_table(globals_dir, "Lrace.dbf")
    terrain_by_code = {code: tid for tid, code in _code_table(globals_dir, "Lterrain.dbf").items()}
    units = {}
    unit_count = 0
    for r in dbf.read_dbf(dbf.find_table(globals_dir, "Gunits.dbf")):
        uid = dbf.ascii_(r["UNIT_ID"]).upper()
        if uid and uid != NULL_ID:
            unit_count += 1
            units[uid] = dbf.int_(r["HIT_POINT"])
    lord_of = {}
    for r in dbf.read_dbf(dbf.find_table(globals_dir, "Glord.dbf")):
        if dbf.int_(r["CATEGORY"], -1) == 0:
            lord_of.setdefault(dbf.ascii_(r["RACE_ID"]).upper(), dbf.ascii_(r["LORD_ID"]).upper())
    items = set(dbf.id_column(dbf.read_dbf(dbf.find_table(globals_dir, "GItem.dbf")), "ITEM_ID"))

    races = []
    for r in dbf.read_dbf(dbf.find_table(globals_dir, "Grace.dbf")):
        race_id = dbf.ascii_(r["RACE_ID"]).upper()
        if not race_id:
            continue
        race_type = dbf.int_(r["RACE_TYPE"])
        code = lrace.get(race_type, "")
        playable_flag = dbf.ascii_(r["PLAYABLE"]).upper()
        race = {
            "key": RACE_KEYS.get(code, code.lower() or race_id.lower()),
            "raceId": race_id,
            "raceType": race_type,
            "name": texts.get(dbf.ascii_(r["NAME_TXT"]).lower(), ""),
            "playable": (playable_flag == "T") if playable_flag else code != "NE",
        }
        for field, column in (("guardian", "GUARDIAN"), ("leader", "LEADER_1")):
            uid = dbf.ascii_(r[column]).upper()
            if uid and uid != NULL_ID:
                race[field] = uid
                if uid in units:
                    race[field + "Hp"] = units[uid]
        if race_id in lord_of:
            race["lord"] = lord_of[race_id]
        if code in terrain_by_code:
            race["terrain"] = terrain_by_code[code]
        races.append(race)
    races.sort(key=lambda x: x["raceId"])
    profile = {"schemaVersion": SCHEMA_VERSION, "races": races, "unitCount": unit_count}
    if CAPITAL_ITEM in items:
        profile["capitalItem"] = CAPITAL_ITEM
    # the 1x1 stone tower the game's own maze maps put at wall junctions, if this mod has it
    for r in dbf.read_dbf(dbf.find_table(globals_dir, "GLmark.dbf")):
        if (dbf.ascii_(r["LMARK_ID"]).upper() == MAZE_TOWER
                and dbf.int_(r["CX"], 1) == 1 and dbf.int_(r["CY"], 1) == 1):
            profile["mazeTower"] = MAZE_TOWER
    return profile


def build_dictionaries(globals_dir):
    """Every L*.dbf lookup table, decoded: {"LATTR": [{"ID": 1, "TEXT": "L_ALL", ...}, ...]}."""
    out = {}
    for name in sorted(os.listdir(globals_dir)):
        if not (name.lower().startswith("l") and name.lower().endswith(".dbf")):
            continue
        path = os.path.join(globals_dir, name)
        with open(path, "rb") as fp:
            schema = dbf.read_schema(fp.read())
        rows = []
        for r in dbf.read_dbf(path):
            row = {}
            for (col, ftype, _len, dec) in schema:
                raw = dbf.ascii_(r[col])
                if ftype == "N" and dec == 0:
                    try:
                        row[col] = int(raw) if raw else None
                    except ValueError:
                        row[col] = raw
                elif ftype == "L":
                    row[col] = raw.upper() == "T"
                else:
                    row[col] = raw
            rows.append(row)
        out[dbf.table_name(path)] = rows
    return {"schemaVersion": SCHEMA_VERSION, "tables": out}


def build_dbf_schema(globals_dir, report):
    tables = {}
    for name in sorted(os.listdir(globals_dir)):
        if name.lower().endswith(".dbf"):
            path = os.path.join(globals_dir, name)
            with open(path, "rb") as fp:
                head = fp.read(32 + 32 * 256 + 1)
            tables[dbf.table_name(path)] = [list(f) for f in dbf.read_schema(head)]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "tables": tables,
        # columns the builders asked for and this mod's tables do not have
        "missingColumns": report.missing_columns(),
        "absentTables": sorted(report.absent),
    }


_GET_VARIABLE = re.compile(r"""getVariable\(\s*(['"])([A-Za-z0-9_]+)\1\s*(\.\.)?""")


def scan_lua_variables(scripts_dir):
    """Scenario variable names the mod's Lua reads: {name: (is_prefix, first file)}.

    ``getVariable('NAME')`` is an exact name; ``getVariable('NAME_' .. x)`` builds the name at
    run time, so only its leading part is known (a prefix)."""
    found = {}
    if not scripts_dir:
        return found
    for root, _dirs, names in os.walk(scripts_dir):
        for name in sorted(names):
            if not name.lower().endswith(".lua"):
                continue
            path = os.path.join(root, name)
            with open(path, "rb") as fp:
                text = fp.read().decode("latin1")
            rel = os.path.relpath(path, scripts_dir).replace("\\", "/")
            for m in _GET_VARIABLE.finditer(text):
                key = (m.group(2), bool(m.group(3)))
                if key not in found or rel < found[key]:
                    found[key] = rel
    return found


def build_scen_variables(game, scripts_dir):
    with open(os.path.join(HERE, "data", "scen_variables.json"), encoding="utf-8") as fp:
        curated = json.load(fp)
    mss32 = find_file(game, "mss32.dll")
    dll = b""
    if mss32:
        with open(mss32, "rb") as fp:
            dll = fp.read()
    lua = scan_lua_variables(scripts_dir)

    variables = []
    # Rules the curated list knows but THIS mod does not read (another toolset build, another
    # mod's script): a map that sets one expects an effect it will not get here.
    unsupported = []
    described = set()
    for c in expand_curated(curated["variables"]):
        # 'probe' is for this function only: what to look for in the dll when the toolset
        # builds the name from a format string ("TIER_{:d}_CITY_INCOME")
        entry = {k: v for k, v in c.items() if k != "probe"}
        key = (c["name"], bool(c.get("prefix", False)))
        if c["source"] == "mss32":
            # the toolset build of THIS mod has to know the name; the format string of the
            # per-race form ("{:s}NAME") contains it too, so one search covers both
            if c.get("probe", c["name"]).encode("ascii") not in dll:
                unsupported.append(entry)
                continue
        else:
            if key not in lua:
                unsupported.append(entry)
                continue
            entry["origin"] = lua[key]
        described.add(key)
        variables.append(entry)
    for (name, is_prefix) in sorted(lua):
        if (name, is_prefix) in described:
            continue
        entry = {"name": name, "source": "lua", "origin": lua[(name, is_prefix)]}
        if is_prefix:
            entry["prefix"] = True
        variables.append(entry)
    used_groups = set(v["group"] for v in variables if v.get("group"))
    # an unsupported entry only has to be recognised, not edited: name, how it is spelled
    # per race, and what to call it
    unsupported = [dict((k, e[k]) for k in ("name", "prefix", "scope", "source", "title") if k in e)
                   for e in unsupported]
    per_race = any(v.get("scope") == "perRace" for v in variables + unsupported)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "racePrefixes": curated["racePrefixes"] if per_race else {},
        "groups": [g for g in curated.get("groups", []) if g["id"] in used_groups],
        "variables": variables,
        "unsupported": unsupported,
    }


def expand_curated(entries):
    """Curated entries with every 'each' series written out.

    ``{"name": "TIER_{n}_CITY_INCOME", "each": [{"n": "0", "title": "Столица"}, ...]}`` stands
    for one entry per item: ``{n}`` in the name is replaced and the item's title is taken."""
    out = []
    for c in entries:
        series = c.get("each")
        if not series:
            out.append(c)
            continue
        for item in series:
            entry = {k: v for k, v in c.items() if k != "each"}
            entry["name"] = c["name"].replace("{n}", item["n"])
            if item.get("title"):
                entry["title"] = item["title"]
            out.append(entry)
    return out


_LUA_ASSIGN = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*,?\s*$")
_LUA_NUMBER = re.compile(r"^-?\d+(\.\d+)?$")


def build_settings(scripts_dir):
    """Numbers and flags of Scripts/settings.lua as a flat {"a.b.c": value} map.

    A line-based reader for the file's plain shape (``key = value,`` lines and nested
    ``key = {`` tables); anything else — strings, functions, lists, expressions — is skipped."""
    values = {}
    path = find_file(scripts_dir, "settings.lua") if scripts_dir else None
    if path:
        with open(path, "rb") as fp:
            text = fp.read().decode("latin1")
        stack = []
        for raw in text.splitlines():
            line = raw.split("--", 1)[0].strip()
            if not line:
                continue
            m = _LUA_ASSIGN.match(line)
            if m and m.group(2) == "{":
                stack.append(m.group(1))
                continue
            if m and m.group(2) and "{" not in m.group(2) and "}" not in m.group(2):
                rhs = m.group(2)
                key = ".".join(stack[1:] + [m.group(1)]) if stack else m.group(1)
                # numbers and flags only: string settings are paths and server addresses,
                # which the editor has no use for and a public data set should not carry
                if rhs in ("true", "false"):
                    values[key] = rhs == "true"
                elif _LUA_NUMBER.match(rhs):
                    values[key] = float(rhs) if "." in rhs else int(rhs)
                continue
            opens, closes = line.count("{"), line.count("}")
            if opens > closes:
                stack.extend(["?"] * (opens - closes))
            elif closes > opens:
                del stack[max(0, len(stack) - (closes - opens)):]
    return {"schemaVersion": SCHEMA_VERSION, "values": values}


# ---- running the existing builders ---------------------------------------------------

def run_builder(name, game, out_dir):
    """Run a builder's main() in this process, so every table read lands in one SchemaReport."""
    module = importlib.import_module(name)
    saved = sys.argv
    sys.argv = [name + ".py", "--game", game, "--out", out_dir]
    try:
        rc = module.main()
    except SystemExit as e:
        rc = e.code
    finally:
        sys.argv = saved
    if rc not in (None, 0):
        raise BuildError("%s failed: %s" % (name, rc))


def pillow_version():
    import PIL
    return getattr(PIL, "__version__", None) or getattr(PIL, "PILLOW_VERSION", "?")


# ---- graphics an earlier pipeline.py run produced ------------------------------------

def atlas_file_names(atlas_dir):
    """manifest.json + every atlas page and page meta it references."""
    with open(os.path.join(atlas_dir, "manifest.json"), encoding="utf-8") as fp:
        man = json.load(fp)
    names = {"manifest.json"}
    for sheet in man.get("spritesheets", []):
        for key in ("image", "meta"):
            if sheet.get(key):
                names.add(sheet[key])
    return sorted(names)


def same_volume(a, b):
    return os.path.splitdrive(os.path.abspath(a))[0].lower() == os.path.splitdrive(os.path.abspath(b))[0].lower()


def is_inside(path, parent):
    path, parent = os.path.abspath(path), os.path.abspath(parent)
    return os.path.commonpath([path, parent]) == parent


# ---- the store -----------------------------------------------------------------------

def load_index(store_root):
    path = os.path.join(store_root, "mods", "index.json")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fp:
            return json.load(fp)
    return {"schemaVersion": SCHEMA_VERSION, "mods": []}


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp%d" % os.getpid()
    with open(tmp, "wb") as fp:
        fp.write(data)
    os.replace(tmp, path)


def validate(obj, schema_file, type_name):
    """Check against Contract D's JSON Schema (packages/mod-catalog/gen), when present."""
    path = os.path.normpath(os.path.join(HERE, "..", "..", "packages", "mod-catalog", "gen", schema_file))
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as fp:
        schema = json.load(fp)
    errs = []
    manifest_mod.validate_against_schema(obj, schema.get("definitions", {}).get(type_name, schema), type_name, errs)
    if errs:
        raise BuildError("%s does not match %s: %s" % (type_name, schema_file, "; ".join(errs[:5])))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build one mod data set into the asset store")
    ap.add_argument("--game", required=True, help="directory holding Globals / Imgs / Scripts")
    ap.add_argument("--mod-id", required=True, help="lowercase slug, e.g. smns3")
    ap.add_argument("--name", default=None, help="display name (default: the mod id)")
    ap.add_argument("--family", default=None, help="version line the mod belongs to (default: the mod id)")
    ap.add_argument("--family-order", type=int, default=0, help="higher = newer version of the family")
    ap.add_argument("--store", required=True, help="asset store root (e.g. public/assets)")
    ap.add_argument("--graphics", action="store_true",
                    help="build the sprite sheets from the game's archives (build_sheets)")
    ap.add_argument("--with-capital", action="store_true",
                    help="with --graphics: also build Capital.ff (city screens; nothing draws them yet)")
    ap.add_argument("--ingest-atlases", default=None, metavar="DIR",
                    help="instead of --graphics: take in an existing pipeline.py output (manifest.json + pages)")
    ap.add_argument("--default", action="store_true", help="make this the store's default mod")
    ap.add_argument("--engine-fingerprint", default=None, metavar="SHA256",
                    help="contentFingerprint the online engine's content pipeline reports for this "
                         "install (recorded as engineContentFingerprint; it is not computed here)")
    ap.add_argument("--source-url", default=None, metavar="URL",
                    help="where this data set can be downloaded from (for a catalog of ready builds)")
    ap.add_argument("--dry-run", action="store_true",
                    help="build and report sizes, but leave the store untouched")
    args = ap.parse_args(argv)

    if not MOD_ID_RE.match(args.mod_id):
        ap.error("--mod-id must be a lowercase slug ([a-z0-9-], up to 40 chars)")
    if args.engine_fingerprint and not re.match(r"^[0-9a-f]{64}$", args.engine_fingerprint):
        ap.error("--engine-fingerprint must be 64 lowercase hex characters")
    if args.graphics and args.ingest_atlases:
        ap.error("--graphics and --ingest-atlases are two ways to the same thing; give one")
    game = os.path.abspath(args.game)
    globals_dir = find_dir(game, "Globals")
    if not globals_dir:
        ap.error("no Globals directory under --game %s" % game)
    scripts_dir = find_dir(game, "Scripts")
    store_root = os.path.abspath(args.store)
    store = BlobStore(store_root)
    stage = os.path.join(store_root, "mods", args.mod_id, ".stage")
    assert stage.endswith(".stage")
    if os.path.isdir(stage):
        shutil.rmtree(stage)
    os.makedirs(stage)
    dbf.REPORT.reset()

    files = {}
    try:
        log("[%s] fingerprint ..." % args.mod_id)
        content_fp, source = fingerprint(game)

        # 1. graphics from an earlier run: straight into the store, plus a link in the stage
        #    directory for the builders that read atlas pages (they never write them)
        atlas_names = []
        if args.ingest_atlases:
            atlas_dir = os.path.abspath(args.ingest_atlases)
            atlas_names = atlas_file_names(atlas_dir)
            # a hard link shares the file with its source: fine for the store's own old
            # layout, not for somebody else's folder that may be rewritten in place
            link = is_inside(atlas_dir, store_root) and same_volume(atlas_dir, store_root)
            log("[%s] atlases: %d files from %s (%s)" % (args.mod_id, len(atlas_names), atlas_dir, "hard links" if link else "copies"))
            for name in atlas_names:
                src = os.path.join(atlas_dir, name)
                if not os.path.isfile(src):
                    raise BuildError("atlas file missing: %s" % src)
                if args.dry_run:
                    files[name] = store.would_put(src)
                    blob_abs = src
                else:
                    files[name] = store.put_file(src, link=link)
                    blob_abs = store.abspath(files[name])
                try:
                    os.link(blob_abs, os.path.join(stage, name))
                except OSError:
                    shutil.copyfile(blob_abs, os.path.join(stage, name))

        # 1b. ... or graphics built here: sheets + manifest.json into the stage directory.
        #     A sheet's blob path is its hash, so the manifest can name it before step 5
        #     moves the file into the store.
        sheet_stats = None
        if args.graphics:
            import build_sheets
            log("[%s] sprite sheets ..." % args.mod_id)
            sheet_stats = build_sheets.build(
                game, stage, blob_rel=lambda path: store.rel(sha256_file(path), "png"),
                with_capital=args.with_capital, log=log)
            ok, msg = manifest_mod.validate(sheet_stats["manifest"])
            if not ok:
                raise BuildError("manifest.json: " + msg)

        # 2. the existing catalog / icon builders, unchanged, into the stage directory
        for name in DATA_BUILDERS + (GRAPHICS_BUILDERS if atlas_names or sheet_stats else []):
            log("[%s] %s ..." % (args.mod_id, name))
            run_builder(name, game, stage)

        # 3. the new per-mod files
        new_files = {
            "ids.json": build_ids(globals_dir),
            "profile.json": build_profile(globals_dir),
            "dictionaries.json": build_dictionaries(globals_dir),
            "scenVariables.json": build_scen_variables(game, scripts_dir),
            "settings.json": build_settings(scripts_dir),
        }
        new_files["dbfSchema.json"] = build_dbf_schema(globals_dir, dbf.REPORT)
        validate(new_files["ids.json"], "id-sets.schema.json", "IdSets")
        validate(new_files["profile.json"], "mod-profile.schema.json", "ModProfile")
        validate(new_files["scenVariables.json"], "scen-variables.schema.json", "ScenVariableCatalog")
        for name, obj in new_files.items():
            with open(os.path.join(stage, name), "wb") as fp:
                fp.write(dump_json(obj))

        # 4. Lua sources of scripted modifiers (the modifier inspector shows them)
        modifiers_dir = find_dir(scripts_dir, "modifiers") if scripts_dir else None
        script_count = 0
        if modifiers_dir:
            for root, _dirs, names in os.walk(modifiers_dir):
                for name in sorted(names):
                    if not name.lower().endswith(".lua"):
                        continue
                    src = os.path.join(root, name)
                    rel = "modscripts/" + os.path.relpath(src, modifiers_dir).replace("\\", "/")
                    dst = os.path.join(stage, *rel.split("/"))
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copyfile(src, dst)
                    script_count += 1

        # 5. everything the stage directory holds goes into the store
        staged_bytes = 0
        for root, _dirs, names in os.walk(stage):
            for name in sorted(names):
                path = os.path.join(root, name)
                rel = os.path.relpath(path, stage).replace("\\", "/")
                if rel in atlas_names:
                    continue  # already in the store (step 1)
                staged_bytes += os.path.getsize(path)
                if args.dry_run:
                    files[rel] = store.would_put(path)
                else:
                    files[rel] = store.put_file(path, move=True)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
        if args.dry_run:  # leave no empty directories behind in a store we promised not to touch
            for d in (os.path.dirname(stage), os.path.join(store_root, "mods")):
                try:
                    os.rmdir(d)
                except OSError:
                    pass

    status = "ready" if "manifest.json" in files else "data-only"
    mod = {
        "schemaVersion": SCHEMA_VERSION,
        "id": args.mod_id,
        "name": args.name or args.mod_id,
        "family": args.family or args.mod_id,
        "familyOrder": args.family_order,
        "status": status,
        "contentFingerprint": content_fp,
        # sheets are PNGs written by Pillow: its version is part of what "same bytes" means
        "pipelineVersion": PIPELINE_VERSION + (" (Pillow %s)" % pillow_version() if sheet_stats else ""),
        "source": source,
        "capabilities": [],
        "files": {k: files[k] for k in sorted(files)},
    }
    if args.engine_fingerprint:
        mod["engineContentFingerprint"] = args.engine_fingerprint
    if args.source_url:
        mod["sourceUrl"] = args.source_url
    validate(mod, "mod-manifest.schema.json", "ModManifest")

    report = dbf.REPORT
    ids = new_files["ids.json"]["tables"]
    print("mod %s (%s, family %s #%d): %s" % (mod["id"], mod["name"], mod["family"], mod["familyOrder"], status))
    print("  fingerprint  %s" % content_fp)
    print("  ids          %s" % ", ".join("%s %d" % (c, len(ids[c])) for c in sorted(ids)))
    print("  races        %s" % ", ".join("%s%s" % (r["key"], "" if r["playable"] else "(np)") for r in new_files["profile.json"]["races"]))
    print("  variables    %s" % (", ".join(v["name"] + ("*" if v.get("prefix") else "") for v in new_files["scenVariables.json"]["variables"]) or "-"))
    print("  files        %d logical (%d atlas, %d modifier scripts), built %.1f MB" % (
        len(files), len(atlas_names), script_count, staged_bytes / 1048576.0))
    if sheet_stats:
        print("  sheets       %d (%d palette, %d RGBA), %.1f MB; %d frames, %d animations" % (
            sheet_stats["sheets"], sheet_stats["palette"], sheet_stats["rgba"],
            sheet_stats["bytes"] / 1048576.0, sheet_stats["frames"], sheet_stats["animations"]))
        if sheet_stats["missing"]:
            print("  archives this mod lacks: %s" % ", ".join(sheet_stats["missing"]))
    print("  store        %s" % store.summary())
    for diff in race_table_differences(new_files["profile.json"]):
        print("  RACE TABLE DIFFERS from the editor's reference — %s" % diff)
    if report.missing_columns():
        print("  columns this mod lacks: %s" % ", ".join(report.missing_columns()))
    if report.absent:
        print("  tables this mod lacks : %s" % ", ".join(sorted(report.absent)))

    if args.dry_run:
        print("  dry run: the store was not changed")
        return 0

    write_atomic(os.path.join(store_root, "mods", args.mod_id, "mod.json"), dump_json(mod))
    index = load_index(store_root)
    row = {k: mod[k] for k in ("id", "name", "family", "familyOrder", "status", "contentFingerprint", "sourceUrl")
           if k in mod}
    index["mods"] = sorted([m for m in index.get("mods", []) if m.get("id") != mod["id"]] + [row],
                           key=lambda m: (m["family"], m["familyOrder"], m["id"]))
    if args.default or not index.get("defaultModId"):
        index["defaultModId"] = mod["id"]
    validate(index, "mod-index.schema.json", "ModIndex")
    write_atomic(os.path.join(store_root, "mods", "index.json"), dump_json(index))
    print("  wrote        mods/%s/mod.json, mods/index.json (default mod: %s)" % (mod["id"], index["defaultModId"]))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BuildError as e:
        log("build_mod: " + str(e))
        sys.exit(1)
