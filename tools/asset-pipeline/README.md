# D2 asset pipeline

Offline Python pipeline that decodes Disciples 2 `.ff` (MQDB) archives into
**PixiJS-v8 spritesheet atlases (PNG + JSON)** plus a top-level **`AssetManifest`**
(Contract B) under `public/assets/`. This is the asset half of the d2-web-editor
browser port.

## Environment

Use the **3.7 interpreter** — it is the one with Pillow + numpy on this machine:

```
python --version    # 3.7.3
# Pillow 6.2.0, numpy 1.21.5  (do NOT pip-install; assume offline)
```

`jsonschema` and `pytest` are **not** installed. The pipeline and tests both
degrade gracefully:

- manifest validation falls back to a builtin draft-07 schema walker that checks
  the emitted JSON against `packages/asset-manifest/gen/asset-manifest.schema.json`
  (types, `required`, `additionalProperties: false`, enums);
- tests are written as `unittest.TestCase` classes, so they run under **either**
  `pytest` (if ever installed) or `python -m unittest`.

## Run

```
python tools/asset-pipeline/pipeline.py \
    --game "<D2_GAME_DIR>/Game" \
    --out public/assets \
    --stage 1
```

This processes the Stage-1 archives and writes:

- `public/assets/<bundle>[-N].png`  — atlas pages (2048² cap, split as needed)
- `public/assets/<bundle>[-N].json` — Pixi "JSON Hash" spritesheet per page
- `public/assets/manifest.json`     — the top-level `AssetManifest`

`public/assets/` is gitignored; the committed artifact is the **code** here.

## Mod data sets (`build_mod.py`)

The editor can serve several mods side by side. `build_mod.py` builds the data of ONE mod
(one game installation) into a content-addressed store that all mods share:

```
<store>/mods/index.json            the installed mods (+ the default one)
<store>/mods/<mod-id>/mod.json     one mod: identity + logical file name -> blob
<store>/blobs/<xx>/<sha256>.<ext>  immutable files; identical bytes are stored once
```

```
python tools/asset-pipeline/build_mod.py \
    --game "C:/Games/SomeMod" --mod-id some-mod --name "Some Mod" \
    --family some --family-order 1 --store public/assets \
    [--graphics | --ingest-atlases <dir of an existing pipeline.py output>] [--default] [--dry-run]
    [--engine-pack <dir of the engine's content pack>] [--source-url <url>]
```

- `--game` is the directory holding `Globals` / `Imgs` / `Scripts` (for an original install
  that is `<root>/Game`; many mods keep them in the install root).
- `--family` / `--family-order`: mods of one family are versions of the same line; a map
  that fits several versions opens on the highest order.
- `--ingest-atlases` takes in the atlases of an earlier `pipeline.py` run (the files its
  `manifest.json` names) and builds the decoration catalog, which needs them. Atlases that
  already live in the store's own folder come in as hard links (no extra disk); atlases from
  another folder are copied, because a hard link would share bytes with a file somebody
  else may rewrite. Without graphics the mod is registered as `data-only`.
- `--graphics` builds the sprites from the game's own archives (see below) — the normal way.
- `--dry-run` builds everything, prints sizes and how much is already in the store, and
  leaves the store untouched.
- `--engine-pack <dir>` ties the mod to the online engine's content pack of the same install
  (the folder with the pack's `manifest.json`). The engine has already catalogued the whole
  installation — sound and video included — and its manifest lists every file with size
  and sha256, so **nothing is recomputed**: the pack's `contentFingerprint` is recorded as
  `engineContentFingerprint`, after every table and script the pack lists is compared with
  this install. One difference and the build stops: the pack is of another install or
  another version of it. It is what an engine profile of this installation is found by
  when a map is handed over for a play test. Rebuild with it again whenever the install —
  and so the engine's pack — changes; a stale pack is refused, not recorded.
- `--engine-fingerprint <sha256>` gives the same value by hand, unchecked (no pack at hand).
- `--source-url` records where the data set can be downloaded from (`sourceUrl`, also in
  `mods/index.json`) — the slot a catalog of ready builds fills in.

Per mod it writes the catalogs and icon sets the editor already used (same builders, same
output) plus:

| file | from | used for |
|------|------|----------|
| `ids.json` | id columns of GUnits, GItem, GSpells, GLmark, Gmodif, GLord, Grace, Gbuild | detecting the mod of a map; "this map references ids the mod lacks" |
| `profile.json` | Grace, GLord, GUnits, Lrace, Lterrain | blank maps and new players (guardian, leader, lord, hit points) |
| `dictionaries.json` | every `L*.dbf` | pickers and groups of the mod editor |
| `scenVariables.json` | names found in `mss32.dll` and read by the mod's Lua, described in `data/scen_variables.json`; plus `unsupported` — the described rules this mod does NOT read | the map-restrictions panel, and its warning about variables that expect an effect this mod will not give |
| `settings.json` | numbers and flags of `Scripts/settings.lua` | value limits |
| `dbfSchema.json` | header of every Globals table | which columns this mod has |
| `modscripts/**` | `Scripts/modifiers/**.lua` | the modifier inspector |

The JSON shapes are **Contract D** (`packages/mod-catalog`); `build_mod.py` checks its
output against the JSON Schemas in `packages/mod-catalog/gen/`.

### Graphics: one sheet per source image record (`build_sheets.py`)

`build_mod.py --graphics` builds the mod's sprites itself (no `pipeline.py` run needed):

- **One sheet per source image record** of `IsoTerrn / IsoStill / IsoCmon / City / IsoAnim`
  (a record already holds what belongs together: one landmark, one animation, one forest
  set), one per FACING of a unit for the idle frames of `IsoUnit`, and the shared terrain
  tile atlases.
- Frames are assembled from the record's parts exactly as `GameResource` does, but **stay in
  palette indices**: a sheet is a palette PNG whose colour-key entries are transparent
  (`tRNS`). Frames from several records share a sheet only when their colours fit one
  palette (`merge_palettes`, lossless); otherwise the sheet is RGBA. A unit's eight facings
  never fit (8 records, 256–1900 colours together), which is why each facing is a sheet of
  its own — and a stack faces one way, so a map fetches one small sheet per stack.
- A sheet depends on nothing but its record and the shader, so **the same record in two mods
  gives the same bytes** — one blob in the store, one cached copy in a browser.
- Frame rectangles are in the manifest's own `frames` table (**AssetManifest 0.2**); a sheet
  says itself whether it loads up front or on demand. An animation lists existing frame
  keys instead of getting a copy of the pixels.
- Frame names are unique only inside one archive (`A`, `0H`, …). The plain key belongs to
  the first archive that defines it; a later one is kept as `<archive>:<KEY>`, and each
  archive's animations are resolved through its own keys.

For the reference install this is 3 828 sheets / 33 MB instead of 239 MB of atlas pages
(animations: 9 MB instead of 82 MB).
`tests/test_sheets.py` rebuilds every frame from the sheets and compares it, pixel for pixel,
with `GameResource.get_frames` (needs a game install; skipped without one). The unit sheets
are compared on a spread-out sample by default — the old decoder re-reads a whole animation
per frame — and in full with `D2_FULL=1`.

The decoration catalog built with the graphics also writes **`decorThumbs.png`**, one
contact sheet with a thumbnail (at most 64 px) of every catalog entry: the palette shows
hundreds of decorations at once, and this is one image instead of one request each. An
entry keeps both places — `thumb` (its cell on the contact sheet) and `sprite` (the full
picture on its own sheet, for the zoomed preview).

`--ingest-atlases <dir>` is the older way: it takes in the atlas pages of an existing
`pipeline.py` output (AssetManifest 0.1), which the editor still reads.

`data/scen_variables.json` is the one hand-written input: what each scenario variable the
toolset or a mod's Lua reads MEANS (title, description, ready-made choices, what the game
assumes when the variable is absent, whether a race-prefixed variable replaces the common one
or is added to it). Each entry was written from the reading code, whose file is named in
`origin` — add an entry the same way, not from a guess. A mod's catalog keeps an mss32 entry
only when that mod's `mss32.dll` contains the name (or the entry's `probe`, for names the
toolset builds from a format string), so one curated file serves every toolset version.

All table reads go through `fflib/dbf.py`. The mods do not have the same columns (a field
is wider, added or missing), so a row answers a missing column with an empty value and the
miss is listed in the build summary and in `dbfSchema.json` instead of failing the build.

## Test

```
cd tools/asset-pipeline
python -m unittest discover -s tests -p "test_*.py"
# (or: python -m pytest tools/asset-pipeline   — once pytest is available)
```

Tests covering color-key / MQDB parse / manifest validation **need the real game
assets** and skip gracefully if the `Game` directory is missing. Override its
location with `D2_GAME_DIR`.

## Layout

```
fflib/
  mqdb.py        MQDB/MQRC container walk (marker scan) -> Record list
  optindex.py    id<->name from the record id==2 table (260-byte entries)
  naming.py      name classify/normalize; strips the .PNG.PNG double-extension
  shaders.py     numpy magenta color-key (P + RGB) + shader variants
  packer.py      shelf/row bin-packer, 2048² cap, multi-page split
  dbf.py         the one Globals table reader (deleted rows skipped, missing columns tolerated + reported)
  blobstore.py   content-addressed store: blobs/<xx>/<sha256>.<ext>, hard link / copy / move
build_mod.py     one mod -> the store (catalogs, icons, ids, profile, dictionaries, variables)
data/            curated descriptions (scenario variables)
extract_ff.py    .ff -> named FFImage list
decode_images.py color-key + trim -> Frame (keeps spriteSourceSize/sourceSize)
build_atlases.py Frames -> spritesheet PNG + Pixi JSON (frames/animations/meta)
build_animations.py group <prefix><index> frames into 42ms sequences
build_terrain.py terrain index (base/borders/roads/forest, seed formula)
manifest.py      assemble + validate the AssetManifest
pipeline.py      Stage-1 orchestrator + CLI
tests/           unittest/pytest suite
spikes/          original de-risk spikes (probe_ff.py, probe_colorkey.py)
```

## Format facts (see repo `CLAUDE.md` for the authoritative list)

- `.ff` = **MQDB** container; 28-byte `MQRC` records, image payloads are embedded
  standalone PNGs (mode `P` or `RGB`).
- **Names** come from the record with **`id == 2`**: a leading 260-byte descriptor
  block, then one 260-byte `int32 id + char[256]` entry per asset. ~99% PNG
  coverage on every Stage-1 archive (incl. GrBorder / Ground).
- **Transparency** = magenta color-key `r>247 && b>247 && g<8` (palette index 0 is
  magenta; no `tRNS`). Applied per-pixel for RGB, via the palette for `P`.
- **Animation clock = 42 ms/frame** uniform → `fps ≈ 23.81`, `animationSpeed = fps/60`.

## Stage-1 coverage

| bundle      | archive      | role                                  |
|-------------|--------------|---------------------------------------|
| iso-terrn   | IsoTerrn.ff  | terrain decorations (trees/fog/mtns)  |
| ground      | Ground.ff    | base ground tiles per race/code       |
| gr-border   | GrBorder.ff  | terrain blend borders (WA_/race)      |
| iso-still   | IsoStill.ff  | static map objects                    |
| city        | City.ff      | cities/villages                       |
| capital     | Capital.ff   | capital backgrounds                   |
| iso-anim    | IsoAnim.ff   | animated objects (water, beacons, …)  |
```
