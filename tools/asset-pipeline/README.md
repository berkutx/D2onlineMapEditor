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
    --game "C:/GOG Games/last_version/Game" \
    --out public/assets \
    --stage 1
```

This processes the Stage-1 archives and writes:

- `public/assets/<bundle>[-N].png`  — atlas pages (2048² cap, split as needed)
- `public/assets/<bundle>[-N].json` — Pixi "JSON Hash" spritesheet per page
- `public/assets/manifest.json`     — the top-level `AssetManifest`

`public/assets/` is gitignored; the committed artifact is the **code** here.

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
