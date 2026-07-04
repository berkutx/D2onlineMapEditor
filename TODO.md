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
- **GAME-EDITOR GOLD CHECK (2026-07-02): PASSES ✅ — from-scratch race maps now LOAD + RENDER
  in ScenEdit.** A 2-race (Empire+Undead) 48×48 createBlankMap output opens in the game's own
  editor with its capital, terrain and object palette (task #26 done). The decisive move was
  letting ScenEdit CREATE a blank map itself (GTREF.sg) and byte-diffing against it — that
  ground truth pinpointed every gap with zero guessing. Fixed, in order of discovery:
  1. dangling neutral fog (below); 2. missing MidSubRace table (below); 3. **OB0000 header count
     undercounted the per-race MidSubRace blocks** (the game trusts OB0000 to know how many
     blocks to read — an off-by-race-count made it read short and refuse; added a fail-loud guard
     that asserts emitted-blocks == OB0000); 4. **empty MidDiplomacy** (the game writes ALL
     pairwise player-race relations, RELATION=0 — count + N×(RACE_1,RACE_2,RELATION); RACE_i =
     race_type); 5. **empty MidgardPlan** (the game writes one entry per occupied cell: each
     capital's 5×5 footprint → ELEMENT=capitalId, each hero stack's anchor → ELEMENT=stackId;
     units get none). All values extracted from GTREF byte-for-byte. Earlier findings kept:
  - **FIXED — dangling neutral fog:** the neutral MidPlayer references FOG_ID=FG0000 but
    createMap emitted NO fog block → dangling ref. Now every player (incl. neutral) gets its own
    MidgardMapFog, keyed by player index (Riders: player n → FGn). Race fogs renumbered to
    playerNo (were colliding with race-index).
  - **FIXED — missing MidSubRace table:** capitals reference SUBRACE=SR#### with no MidSubRace
    block emitted. Extracted the deterministic table from 28 real campaign maps: 1 neutral SR
    (SUBRACE 5, BANNER 4) + 1 per race player (SUBRACE = raceType+1 verified Empire0→1/Undead1→2/
    Clans2→3/Neutral4→5; BANNER = SUBRACE−1) + the fixed neutral-special tail SUBRACE 6..13
    (BANNER 5..12, identical across every map). Capital.SUBRACE = SR<playerNo> matches.
  - **RULED OUT — block order:** D2MapModel::save writes m_blocks in INSERTION order (QList,
    foreach, no sort — confirmed from source); the loader is two-pass, so forward refs / order
    don't matter.
  - **RULED OUT — header layout:** MapHeaderBlock::data() order confirmed from source; our header
    is byte-identical to Riders except the offset field (2720 vs 2800, both = (playerCount+67)*40).
    `_playersData` is positioned per source (after the padding-size i32, before S143OB0000).
  - **RESOLVED** by fixes 3–5 above (OB0000 count + diplomacy + plan). Guarded by a new
    createBlankMap test (OB0000==blocks, 3 diplomacy pairs, 52 plan entries) + the emit-time
    fail-loud count assertion. OPEN edge: a 0-race (neutral-only) map wasn't gold-checked — the
    New Map UI defaults to ≥1 race, so the typical path is validated; gate races≥1 if 0-race
    turns out unsupported. The ground-truth technique (let ScenEdit create a blank, byte-diff)
    is the go-to for any future from-scratch byte question.

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

## M4 deleteObject — LANDMARKS + STACKS + MOUNTAINS DONE; remaining types below
Landed: `deleteBlocks(ids, dependentIds)` (frame splice + OB0000 decrement + referential guard
+ MidgardPlan entry purge), MidgardPlan parser stub (stable pos), eraser deletes decor, ctx-menu
🗑 for landmark/stack/mountains (`deleteObjectSafely`), delete+undo round-trips.
- **stacks** (DONE): `stackDeleteCascade(raw, id)` enumerates dependent MidUnit (UNIT_0..5) +
  MidItem (inventory) instances from RAW bytes → `deleteBlocks` dependentIds (cascade-safe, skip
  the guard). Inverse addObject carries the FULL stack from the doc (garrison/leader/inventory),
  which the stack add-path re-emits → undo round-trips. A city's VISITING hero is REFUSED
  (fail-loud: the doc-side STACK-clear can't survive the JSON journal as an omitted-key edit —
  manage visitors via the city inspector; sanctioned by the reference).
- **mountains** (DONE): `deleteMountainOps(doc, id)` — mountains carry positional ids, so it
  deletes the target + tail and re-adds the tail shifted down one index (fungible objects; keeps
  the doc aligned with the byte-side block rebuild's renumber), and reverts the footprint to the
  bare mountain-terrain value 5 (MapStateHolder), skipping cells shared with a surviving mountain.
- **talisman charges** (DONE 2026-07-04, reference-verified): `MidTalismanCharges` (WHAT 0x1a, "TC",
  singleton) = `blockId + i32 count` + 34-byte entries `ID_TALIS ref(MidItem INSTANCE) · CHARGES i32`
  (layout byte-verified: toolsqt D2TalismanCharges.h == Riders hexdump, 14 entries, all charges=5).
  Delete side = `purgeTalismanCharges` inside deleteBlocks (the reference's D2MapEditor::removeItem);
  add side = `addTalismanCharges` per minted talisman MidItem (the reference's addItem; charges =
  GVars.talis_chrg default 5; talisman-ness via itemCatalog L_TALISMAN set, loaded lazily by the server
  and passed as `applyEditsToBytes(..., {talismanTemplates})`).
- **villages + chests** (DONE 2026-07-04): MidVillage delete cascades garrison MidUnit (refuses while a
  visiting hero is linked); MidBag delete cascades its MidItem instances (+ their charges entries).
  Capital delete REFUSED (race integrity). Reference cross-check: the live Qt editor does NO cascade at
  all (save = full re-export, orphans just aren't written; it even exports a DANGLING visiter stackId) —
  our cascade + fail-loud guard is the patch-in-place equivalent with stricter integrity.
- **review fixes (2026-07-04)**: delete+same-id-re-add (collab undo of a delete) now KEEPS one set of
  MidgardPlan/TC entries (purge skips survivors, add-path skips duplicates); deleteBlocks dedups ids
  (peer-race double delete); the referential guard now covers dependent ids too; the visitor-holder
  scan is fort-scoped + readRefField rejects suffix tag matches (event ID_STACK ≠ STACK).
- **ruins** (DONE 2026-07-04): `ruinFrame` byte-verified (reproduces a real Riders ruin frame
  bit-for-bit in the test); layout RUIN_ID·TITLE·DESC·IMAGE·POS·CASH·ITEM·LOOTER·AIPRIORITY·
  visiterCount(0)·GROUP_ID·UNIT_0..5·POS_0..5. Ruin ITEM = GLOBAL GItem template (byte-verified,
  reviewer's open question closed — the inspector's template edit path was right). Ruins carry
  GUARDIANS: readRuin now reads the garrison (schema += RuinObject.garrison, assemble resolves) so
  delete cascades the MidUnit guards AND undo restores them; plan footprint 3×3 (9 entries,
  byte-verified). Riders fact: some ruins are event/quest-referenced — their delete is refused by
  the referential guard (correct fail-closed).
- **sites** (REMAINING): no instance dependents (stocks are global ids) — only siteFrame ports
  (merchant/mage/trainer/mercs write layouts) are missing for the undo re-add path.
- **pre-flight delete check (idea, from review)**: a doc-side mirror of the referential guard so a
  delete refused at export (e.g. an event still targets the landmark) is rejected AT COMMIT with a
  named referencer, instead of poisoning the whole journal until undo.
- **plan entries for ADDED roads (latent)**: addPlanEntries covers landmark/location/stack/chest/
  village adds (byte-verified footprints); freshly appended MidRoad blocks get no plan entry yet —
  verify road membership in shipped plans first, then emit alongside roadFrame.

## UX v2 queue (researched 2026-07-04; multi-select + roads DONE)
- ~~Дороги: move/extend~~ — DONE: `translateRoadCells`/`extendRoadPath`/`lPath` в roadSelect.ts;
  roadsel: драг внутри выделения = перенос, за конец (≤1 соседа в выделении) = продление
  L-путём; live-превью через setRoadSelection, клик без движения = прежний level-bump.
  Рефактор-долг: overlay-хелпер (over/cur/updateRoad) скопирован 5-й раз — вынести.
- ~~Дорога→здание~~ — DONE: entrance = pos+(size,size) (byte-derived, memory
  building-entrance-rule); project.roadAnchors {fortId→{mode:'reroute'}}; ctx-меню города
  «🛣 Дорога следует за входом»; при переносе форта: обход графа дорог от старого входа до
  первого колена/развилки → erase хвоста → extendRoadPath(колено→новый вход), одним страйком
  с moveObject (тест на реальной деревне Riders@(25,1)). Fail-soft: без дороги у входа — no-op.
- **Зоны свободной формы — ЭТАП 1 DONE**: инструмент «Зона» (док, режимы ▭/🖌/╱/▢ =
  region-пайплайн), тайлер `zones.ts` (Chebyshev distance transform + жадное покрытие
  квадратами 5×5/3×3/1×1; тайлы строго ⊆ маски, перекрытие легально; 5 тестов: 10×10=4×r2,
  линия=1×1, кольцо, L-blob точное покрытие), live-оценка «Нарезать → N лок.» в панели
  опций, editStore.createZone = ОДИН commit (undo/collab бесплатно), project.zones
  {name,cells,locIds} (+regenId-путь удаляет прошлую генерацию), removeZone. Валидатор
  3-уровневый зелёный. **ЭТАП 2 (осталось)**: зоны-события — юзер пишет ОДНО событие с
  ZN-ссылкой → N клонов (условия только AND, byte-факт TAppEdit; >1 enterZone запрещён);
  сворачивание клонов в EventsPanel; occur-once через guard-переменную (autoVars); группа
  «Зоны» в ref-loc пикере; скрыть ⟐-генерённые локации из пикеров; UI перегенерации
  (redraw seeded зоны) + список зон.
- **Флайауты дока** (решение юзера: hover с задержкой ~350мс, тултип переезжает в шапку) —
  data-driven из tools.ts (flyout-фабрика, max 4 ряда): Рельеф=свотчи 6 земель+кисть;
  Декор=Природа/Постройки/Рельеф/🔍 (требует lift фильтров DecorPalette в стор — activeFamily/
  search/faction/tone сейчас component-local); Локации=фильтр ролей+2 тумблера; Вода/Лес/
  Ластик=кисть; Двигать=якоря. Обзор/Дорога/Дорога✂ — без флайаута.

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
  re-export doesn't renumber). **SCOPE DECISION (user, 2026-07-02): design for maps authored FROM
  SCRATCH in this editor — the compiler owns ALL variables on such maps, no reverse-importer.
  Uploaded/foreign maps get only the minimal path that already exists (raw variables list + the
  usage/readers-writers view); do NOT build a decompiler that folds foreign var plumbing back into
  visual chains.** Practical split: EditorProject carries the visual scenario model (chains,
  counters) as the source of truth; export compiles model→vars; a map is "editor-native" when its
  project has that model, otherwise the vars tab stays in raw mode.
- ~~Graph polish~~ — DONE (4837b85): edge hover highlight (наведение гасит несвязанное),
  drag-to-pan/zoom (были ранее), клик по условию/эффекту скроллит редактор к карточке + вспышка.

## Collaboration & editor follow-ups (deferred 2026-06-30)
- ~~Events editor~~ — DONE (E1+E2: full read/edit, все 746 событий Riders ре-сериализуются
  байт-в-байт; см. секции событий выше).
- ~~Collab: history-revert action~~ — DONE: каждая запись истории несёт свой INVERSE (мои — через
  outgoing(ops, inverses) с per-op выравниванием, чужие — из applyIncoming); в раскрытой строке
  кнопки «⎌ только это» / «⎌ отсюда (N)» (точные инверсы новые-первыми, confirm, обычный forward
  commit → в историю, отменяется Ctrl+Z; конфликт = fail loud, док не трогается).
- ~~Collab: share a pre-join local draft~~ — DONE: при входе в комнату С УЧАСТНИКАМИ и локальным
  черновиком — диалог «Отправить черновик в комнату?» (отправка = обычные ops через sendOps, журнал
  их сохраняет — он остаётся полным оп-логом для экспорта; отказ = черновик поверх только у меня;
  раз за сессию на комнату; на реконнектах не спрашивает — doJoin в обход join()).
- **Collab: reconnect resync double-apply (pre-existing gap)** — на реконнекте snapshot:request →
  setBaseDoc(серверный док С МОИМИ опами) + recompute поверх журнала (в котором те же опы) →
  повторное применение: setCell/patch идемпотентны, а addObject/deleteObject КИДАЮТ. Правильный
  фикс: реплей только пропущенных ops (seq>lastSeq) вместо полного снапшота — трогает Contract C.
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
