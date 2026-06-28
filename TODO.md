# d2-web-editor — deferred TODO

Things intentionally postponed (decided 2026-06-26). Order is rough priority.

## Editing engine — milestone status (plan: ~/.claude/plans/partitioned-shimmying-umbrella.md)
- **M1 DONE (2026-06-27): round-trip writer + 3-tier validator + project format.**
  `@d2/sg-parser/writer` (`parseScenarioRaw`, `SgWriter`, `roundTripIdentity`/`verifyCellOffsets`/
  `validateMap`); `@d2/map-edit` (`applyOp`+inverse, `applyEditsToBytes`, `roundTripSemantic`,
  `EditorProject` diff/undo, relations/cascade stubs); server `/raw` `/validate` `/export` (fail-closed
  422); web Editor menu + Validate button + `editStore`. Proven: every campaign map round-trips
  byte-exact; a setCell perturbs ≤4 bytes, a move ≤8; export gated on validation.
- **M2 DONE (2026-06-28):** terrain/water/erase brushes (`@d2/map-edit` `terrainBrush`+`bits.ts`),
  stroke-grouped journal (`pushCommit`, undo reverts a whole stroke), `editStore.liveDoc` (base+commits)
  with live preview, `Scene.updateTerrain` (terrain-only re-tile, rAF-debounced) + `setPanEnabled`
  (paint tool owns the drag), `EditToolsBar` (tool/size 1·3·5/terrain/undo·redo). Export/validate use the
  same project. **TODO in M2 polish:** forest brush (needs valid forest tile ids); roads (M3, auto-tile
  bitmask); incremental dirty-cell `updateCells` (currently full terrain re-tile per stroke).
- **Forest brush DONE (2026-06-28):** `brush.ts` forest = ground 1 + per-cell tree id (0..19, valid for all
  terrains); fixed-width export (forest lives in the cell value).
- **M3 roads DONE (2026-06-28):** `roadBrush` ports `MapEditTool::updateRoad` (4-neighbour bitmask -> 16-case
  INDEX, recompute cell + 4 neighbours, clear cell to bare terrain). Export grows the file: `sgRebuild.ts`
  `appendBlocks`+`roadFrame` append MidRoad blocks (code 15/RA: ROAD_ID/INDEX/VAR/POS_X/POS_Y) + bump OB0000
  count; existing roads retuned via `SgWriter.setRoad`; per-cell dedup. Verified via map-edit round-trip +
  server validate.
- **M3 mountains TODO:** place tool + `Scene.updateObjects` (sprite shows live; updateTerrain only does the
  37 ground-stamp) + MidMountains growable export (entries are block-internal, not top-level blocks).
- **updateCells optimization TODO:** chunked tilemaps (CompositeTilemap is append-only); do after mountains.
- **M4:** buildings/ruins (needs the growable
  writer: object insert/delete + framing/count fixups + cp1251 string emit). **M5:** relations +
  cascade move (drag-with-bindings, Alt to detach). **M6:** region-regen agent scaffold.
- **New Map (blank from scratch): DONE (2026-06-28).** `createBlankMap({size, fill:'default'|'water'|'snow',
  name, mountains})` in `packages/sg-parser/src/writer/createBlankMap.ts` ports toolsqt `createMap`+`commitGrid`
  +`MapHeaderBlock::data`+ every block `data()` (verbatim, cross-checked vs Riders.sg). Header `offset` =
  firstObjectByte−30 (verified invariant). Samples in `fixtures/blank/blank-72-*.sg`. Proven: reader
  round-trip + validateMap green + byte-exact offset index. **Pending: manual game-editor load (gold check).**
  Residual risks if game rejects: empty `_playersData` header blob; player FOG_ID references a fog block we
  don't emit — both are toolsqt's own createMap behavior; first fixes to try are populating those.
- **Generator (future M6) — research captured:** real generator = `RandomStackGenerator.dll` (VB.NET) behind
  the C# `D2MapGenerator`; template-driven (`GenSettings` global + per-`LocationGenSetting`). Knobs: WaterAmount,
  ForestAmount, RoadsAmount, per-location DecorationsAmount(=mountains), maxGoldMines/ManaSources/Cities/Vendors/
  Mercenaries/Mages/Trainers/Ruins. Algorithm: place loc centers (repulsion/symmetry) → borders/labyrinth →
  water → roads/forest → scale per-loc counts by area → place objects + guards → write `.sg`.
- **Overlap object selection (for editor click):** no z-order/priority/cycling. Per-cell lists (objects +
  locations), each object appended to every footprint cell in load order; pick = locations[cell][0] if the
  locations layer is shown, else objects[cell][0] (earliest-added).
- **`apps/web` has no vitest tests** -> `pnpm -r run test` exits non-zero on web ("no test files").
  Pre-existing; consider `vitest run --passWithNoTests` for the web test script.

## Animation (by need, with a size optimization to consider first)
- Sprite animation is off by default (`viewStore.animate`). Turning it on must drive
  stack walk/idle, animated forts/crystals/landmarks, the cursor highlight, etc. at the
  42 ms clock (`animationSpeed = fps/60`, fps ≈ 23.81).
- **Animated water** rides with this (currently a single static 128px region).
- **Optimization to weigh:** if a viewer does NOT need animation, ship only frame 0 of
  each sprite — drop the extra animation frames from the atlases. That shrinks atlas
  size and speeds load. Possibly a build flag: `--no-anim` produces single-frame atlases;
  full atlases only when animation is wanted. Decide before committing to full frames.

## Shaders (very last)
- Live render shaders the editor uses as preprocessing:
  - **Shadows** (SSTO / boat BOAT shadow / fort SHLV shield use a shadow preprocess) —
    needed for visually correct stack/boat/fort **shadows**. Until then, shadows are not drawn.
  - TransparentBlack live treatment (crystals/rods already get their black keyed out at
    decode time in `decode_resource.py`, so this is only if we move it to the renderer).

## Minimap
- Port `MinimapHelper.cpp`: offscreen ~4px/cell image, terrain by `colorForRace`/water,
  plus per-type markers (capital shield + ellipse, village square + ellipse, mountains,
  landmark, stack, ruin).
