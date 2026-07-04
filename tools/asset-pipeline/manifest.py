"""manifest: assemble + validate the top-level Contract-B AssetManifest.

Collects every emitted spritesheet, the frame index, animations, terrain index and
object-naming templates into one ``manifest.json`` and (optionally, if ``jsonschema``
is importable) validates it against ``asset-manifest.schema.json``.
"""
import datetime
import json
import os

MANIFEST_VERSION = "0.1.0"
TICK_MS = 42

# printf-style name builders mirrored from toolsqt (documented for the renderer).
OBJECT_NAMING = {
    "ground": "%s_%02d",          # <race/code>_<variant>
    "waterBorder": "WA_%02d_%02d",  # WA_<mask>_<variant>
    "landBorder": "%s_%02d_%02d",   # <race>_<mask>_<variant>
    "city": "%s%s%d",             # <race><state><level>
    "capital": "BG_%s",           # BG_<race>
}


class ManifestBuilder(object):
    def __init__(self, source_game_version=None, palette_mode="baked"):
        self.spritesheets = []
        self.index = {}
        self.animations = []
        self.terrain = None
        self.source_game_version = source_game_version
        self.palette_mode = palette_mode

    def add_spritesheet(self, sid, image, meta, ff=None):
        ref = {"id": sid, "image": image, "meta": meta}
        if ff:
            ref["ff"] = ff
        self.spritesheets.append(ref)

    def add_index(self, frame_key, sheet_id, frame=None):
        self.index[frame_key] = {"sheet": sheet_id, "frame": frame or frame_key}

    def add_animations(self, defs):
        self.animations.extend(defs)

    def set_terrain(self, terrain):
        self.terrain = terrain

    def to_dict(self):
        m = {
            "manifestVersion": MANIFEST_VERSION,
            "generatedAt": datetime.datetime.utcnow().isoformat() + "Z",
            "tickMs": TICK_MS,
            "paletteMode": self.palette_mode,
            "spritesheets": self.spritesheets,
            "index": self.index,
            "animations": self.animations,
            "objectNaming": OBJECT_NAMING,
        }
        if self.source_game_version:
            m["sourceGameVersion"] = self.source_game_version
        if self.terrain is not None:
            m["terrain"] = self.terrain
        return m

    def write(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # Inject per-sheet download sizes (atlas PNG + meta JSON). Done here, not in
        # add_spritesheet: only write() knows out_dir, and both files already exist on
        # disk by now. Graceful: a missing file simply leaves the field absent (the HUD
        # then shows an em-dash instead of a wrong number).
        out_dir = os.path.dirname(path)
        for ref in self.spritesheets:
            try:
                ref["bytes"] = (os.path.getsize(os.path.join(out_dir, ref["image"]))
                                + os.path.getsize(os.path.join(out_dir, ref["meta"])))
            except OSError:
                pass
        data = self.to_dict()
        with open(path, "w") as fp:
            json.dump(data, fp, indent=1)
        return data


def load_schema():
    """Load the Contract-B JSON Schema, or return ``None`` if absent."""
    here = os.path.dirname(os.path.abspath(__file__))
    schema_path = os.path.normpath(os.path.join(
        here, "..", "..", "packages", "asset-manifest", "gen",
        "asset-manifest.schema.json"))
    if not os.path.isfile(schema_path):
        return None
    with open(schema_path) as fp:
        return json.load(fp)


def validate(manifest_dict):
    """Validate against the JSON Schema if ``jsonschema`` is available.

    Returns ``(ok, message)``. When ``jsonschema`` is missing, performs a
    structural sanity check instead so the pipeline still fails loudly on
    obviously-malformed output.
    """
    schema = load_schema()
    try:
        import jsonschema  # type: ignore
    except ImportError:
        return _schema_check(manifest_dict)
    if schema is None:
        return _structural_check(manifest_dict)
    try:
        jsonschema.validate(manifest_dict, schema)
    except jsonschema.ValidationError as e:  # pragma: no cover - exercised in tests
        return False, "schema validation failed: %s" % e.message
    return True, "validated against asset-manifest.schema.json (jsonschema)"


def _schema_check(m):
    """Validate against the real JSON Schema with a minimal draft-07 walker.

    Used when ``jsonschema`` is not installed. Covers type / required /
    additionalProperties / enum - enough to catch a malformed manifest, including
    the strict ``additionalProperties: false`` constraints.
    """
    schema = load_schema()
    if schema is None:
        return _structural_check(m)
    root = schema.get("definitions", {}).get("AssetManifest", schema)
    errs = []
    validate_against_schema(m, root, "manifest", errs)
    if errs:
        return False, "schema check failed: " + "; ".join(errs[:5])
    return True, "validated against asset-manifest.schema.json (builtin walker)"


def validate_against_schema(node, sch, path, errs):
    """Minimal recursive type/required/additionalProperties/enum validator."""
    t = sch.get("type")
    if t == "object":
        if not isinstance(node, dict):
            errs.append("%s: expected object" % path)
            return
        props = sch.get("properties", {})
        for req in sch.get("required", []):
            if req not in node:
                errs.append("%s: missing required '%s'" % (path, req))
        ap = sch.get("additionalProperties", True)
        for k, v in node.items():
            if k in props:
                validate_against_schema(v, props[k], path + "." + k, errs)
            elif isinstance(ap, dict):
                validate_against_schema(v, ap, path + "." + k, errs)
            elif ap is False:
                errs.append("%s: additional property '%s' not allowed" % (path, k))
    elif t == "array":
        if not isinstance(node, list):
            errs.append("%s: expected array" % path)
            return
        items = sch.get("items")
        if items:
            for i, e in enumerate(node):
                validate_against_schema(e, items, "%s[%d]" % (path, i), errs)
    elif t == "string":
        if not isinstance(node, str):
            errs.append("%s: expected string" % path)
        elif "enum" in sch and node not in sch["enum"]:
            errs.append("%s: %r not in enum %r" % (path, node, sch["enum"]))
    elif t == "number":
        if not isinstance(node, (int, float)) or isinstance(node, bool):
            errs.append("%s: expected number" % path)
    elif t == "boolean":
        if not isinstance(node, bool):
            errs.append("%s: expected boolean" % path)


def _structural_check(m):
    if m.get("manifestVersion") != MANIFEST_VERSION:
        return False, "manifestVersion mismatch"
    for key in ("spritesheets", "animations"):
        if not isinstance(m.get(key), list):
            return False, "%s must be a list" % key
    if not isinstance(m.get("index"), dict):
        return False, "index must be a dict"
    for sh in m["spritesheets"]:
        if not all(k in sh for k in ("id", "image", "meta")):
            return False, "spritesheet missing required keys"
    for an in m["animations"]:
        if not all(k in an for k in ("id", "atlas", "frames")):
            return False, "animation missing required keys"
    return True, "structural check passed (jsonschema not installed)"
