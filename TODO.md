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

## M4 deleteObject — LANDMARKS DONE (62eaac1); remaining types below
Landed: `deleteBlocks` (frame splice + OB0000 decrement + referential guard + MidgardPlan
entry purge), MidgardPlan parser stub (stable pos), eraser deletes decor, delete+undo
round-trips. REMAINING (per-type unlocks):
- **stacks**: cascade delete of dependent MidUnit (UNIT_0..5/LEADER_ID) + MidItem (inventory)
  instance blocks derived from RAW bytes; clear a linked city's STACK ref (or refuse for
  garrisoned visitors); undo needs the addObject path to also emit garrison/inventory
  (today stackFrame adds an EMPTY stack — re-add would lose the army -> semantic fail).
- **mountains**: N-per-block — deleting entry #n renumbers later `${blockId}#${i}` ids, which
  breaks the BY-ID semantic compare; needs either doc-side renumber ops or an order-stable id.
- **add-path plan entries (latent, pre-existing)**: added objects never get MidgardPlan
  entries (and a delete+re-add loses the original's) — semantically invisible (plan is a
  generic stub) but the GAME uses the plan for passability; emit entries in appendBlocks-time.

## (superseded by the above) M4 deleteObject in the byte writer (researched 2026-07-02, ready to implement)
The reference CAN'T be copied directly — it never patches: save = FULL re-serialization from
the block list (`D2MapModel::save`, D2MapModel.cpp:155-167), the OB0000 count is just
`m_blocks.count()` at save time (DataBlock.h:395-397), deletion = drop the block from the list
(`D2MapModel::remove`, D2MapModel.h:77-85) and simply not re-export orphans. For OUR
patch-in-place writer the equivalent is a **block-range splice**, and we already have every
mechanism: parseScenarioRaw's per-object byte ranges (framing), spliceVariableFields
(highest-offset-first mid-stream splices), the OB0000 count bump (appendBlocks — need the
decrement twin). Plan:
- `deleteBlocksSplice(ids)`: remove `[WHAT..ENDOBJECT]` ranges of the object + its DEPENDENT
  instance blocks (garrison/eq MidUnit + inventory MidItem — same id lists the readers use),
  decrement the OB0000 count by the number of removed blocks. Header `offset` is unaffected
  (all object blocks sit after it).
- Cascades (ported from the reference): item that is a talisman → drop its entry from
  D2TalismanCharges (D2MapEditor.cpp:234-246); deleting a visiting stack → clear the city's
  STACK ref to G000000000 (we have the growable string splice); deleting mountains → the
  delete op must come WITH setCell ops restoring terrain (MapStateHolder.cpp:62-81 restores
  value 5) — our place/erase flows already pair the stamp, undo pairs the inverse setCells.
- Referential guard: before deleting, scan other blocks for `0B 00 00 00 + <id>` refs; clear
  known ones, REJECT loudly on unknown (no-guess).
- Undo of a base-object delete = addObject of a parsed object — only allowed for types our
  frames can rebuild (stack/landmark/mountains/road/unit/item); gate the delete UI to those
  first.

## Anchors / scenario-window follow-ups (deferred 2026-07-02)
- **Road follows anchored building** — when a building anchored to a road moves, re-route the road
  from the nearest bend (or the second bend) to the building's new entrance. Design: the road is a
  cell chain (selectRoadSegment gives the strand); find the bend nearest the OLD building cell,
  erase `bend..end`, re-run `roadBrush` along a straight/L path `bend → new entrance cell`,
  re-tiling handles the joints. Ship as an OPT-IN per-anchor flag (anchor value could become
  `{parent, mode: "move"|"reroute-road"}` — today it's a plain child→parent string map in
  `EditorProject.anchors`).
- **E5 auto-generated (hidden) variables** — the scenario window could hide raw variables entirely:
  the user draws chains/state-machines (graph edges «событие A ➜ включает ➜ B», counters on events),
  and a compiler emits the MidScenVariables ids + varInRange/compareVar/modifyVariable plumbing at
  export. Groundwork already in place: per-variable usage map (VariablesEditor), star graph
  (EventGraph), panelTab jumps. Needs: a stable var-id allocator keyed by the drawn edge (so
  re-export doesn't renumber), and an importer that folds EXISTING var plumbing back into visual
  chains (else round-tripping someone else's map explodes the graph).
- **Graph polish** — edge hover highlight, drag-to-pan/zoom in the SVG, click a condition/effect
  node to scroll the editor column to that card.

## Collaboration & editor follow-ups (deferred 2026-06-30)
- **Events editor** — the one remaining big object type not yet editable (triggers/effects). Research the
  `.sg` event block layout on bitbucket before touching the writer.
- **Collab: history-revert action** — the shared History panel is read-only. To add "откатить отсюда"
  (single + chain), each history entry must carry its INVERSE captured at apply time (today only my own
  ops capture inverses, in `editStore.myUndo`; peer ops via `applyIncoming` don't). Store the inverse per
  entry in `collabStore`, then revert = `editStore.commit(inverse)` (broadcasts as a forward op).
- **Collab: share a pre-join local draft** — on `join`, the client's existing local journal stays on top
  locally but is NOT pushed to the server, so a peer won't see drafts made before joining. Decide: push
  `activeOps` on join (risk: double-apply on reconnect) vs. discard vs. prompt.
- **Locations: on-canvas drag-resize handles** — radius field already resizes "relative to center"; canvas
  handles are polish.

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
