# Full-rebuild: model gaps, compromises & the road to a fully-parsed graph

Status audit of the `experiment/full-rebuild` branch. Records every place we **guessed a constant**,
**dropped a field**, **kept raw bytes**, or **left a block un-modeled** — so nothing is silently
assumed, and so the eventual "parse everything, hold it live, rebuild the relations on export"
refactor has a checklist.

**Reading this doc:** "byte-exact" below always means *on the 80 pristine originals in
`Game/Exports - Copy`*. It does NOT mean the model understands every field — only that the bytes we
emit match. The two are different, and the gaps below are exactly where they diverge.

---

## 0. The direction (what this is debt against)

Today the model is **half-resolved**: object scalars are modeled, but the *instance graph*
(`MidUnit`/`MidItem` inside stacks/forts/chests) is (a) resolved to a lossy editor view AND (b)
shadowed by a **load-only `raw` snapshot** of the original ids that the rebuild replays verbatim.
That snapshot + the `doc.instances` carrier are a deliberate shortcut, and they have a real cost
(below). **The target** the raw snapshot is debt against:

> Parse EVERY block into a live, fully-typed model. Units/items are first-class entities with
> stable local handles. Relations (stack→units, city→garrison, city→visiting-stack, bag→items,
> object→plan-footprint, stack→source-template, city→subrace-banner) are explicit references, not
> id strings. On export, allocate the on-disk id space deterministically and **rebuild every ref +
> the MidgardPlan from the graph** — no snapshot, no "resolve on load / re-mint on save" dance.

**DECISION (user, 2026-07-10): the model stores NO raw bytes, period.** Byte-exactness is achieved
by *exactly replicating the format* — every field known and typed. Measurement (§1b) proves this is
sufficient: even the non-derivable "historical" residue is just a handful of orderings and entity
keys, all expressible as ordinary typed attributes (`unit.slot`, list positions, an ordered
block-reference list). Raw passthrough survives ONLY as migration scaffolding for blocks whose
fields aren't fully reverse-engineered yet (§1b class 4), with a per-type exit criterion: all
fields modeled → serializer proven byte-exact → raw path deleted for that type.

Everything in §1–§4 is a step away from that target; §5 is the target's own checklist.

---

## 1. The `raw` snapshot & `idMount` — the compromise you want gone

> **RESOLVED 2026-07-10 (§8 step 5).** The snapshot is gone: garrison members are full entities
> with `key`+`slot`, item lists carry `itemKeys`, templates carry typed `slots`+`slotOfCell`,
> unreferenced blocks live in `doc.strayInstances`, and `idMount` remains as the mountains
> entry's own identity attribute. The section below is kept as the historical rationale.

**What it is.** `StackObject`/`VillageObject`/`RuinObject`/`TreasureObject` carry an optional
`raw: InstanceRawSnapshot` = the **minted-id graph** exactly as read: `UNIT_0..5` (slot instance
ids), `POS_0..5` (formation-cell→slot map), `LEADER_ID`, and the `ITEM_ID` list. `MidMountains`
entries carry `idMount` the same way. The rebuild replays these verbatim → byte-exact.

**Why it exists.** `MidUnit`/`MidItem` **instance ids are minted at export**, not authored. A placed
stack has no ids until `applyBytes` mints them, so the editor model can't carry stable ids for
*placed* objects — only for *loaded* ones. The resolved garrison (`{unit,level,hp}`) is what the UI
edits; `raw` is the byte-faithful shadow for unedited round-trips.

**Why it's debt (the costs):**

| cost | detail |
|---|---|
| **Goes stale on edit** | Edit a garrison/inventory → the resolved model changes but `raw` does NOT. A rebuild export of an EDITED compound would replay the stale snapshot (wrong). Mitigated only by: rebuild isn't the default export (patch/`applyBytes` re-mints correctly), and the byte-gate uses a fresh parse. **This is the sharpest edge.** |
| **Not semantic** | `verifySemantic` must STRIP `raw` (+ mountains `idMount`) before comparing, because a placed object mints fresh ids. So the round-trip test can't actually verify the instance graph — it verifies the resolved view + trusts the byte-gate for `raw`. |
| **Two sources of truth** | The same units live twice: resolved (`garrison`) AND raw (`raw.unitSlots` + `doc.instances`). They can drift; nothing enforces consistency. |
| **`doc.instances` bloat** | Full `MidUnit`/`MidItem` records ride on every doc (Relentless: ~1548 units + 577 items). The client ignores them; the server rebuild re-parses stored bytes anyway. Safe to strip from the client-facing response — not yet done. |

**The fix (per the no-raw-bytes decision, §0):** dissolve the snapshot INTO the entities — a
garrison member is an entity with `key` (its on-disk id; null for new, allocated at export) and
`slot: int` (§1b class 3); a bag holds an ordered list of item entities. Byte-exactness then falls
out of the typed model with nothing stored "on the side". `raw`, `idMount`-as-artifact,
`doc.instances`-as-carrier, the `verifySemantic` strip, and the resolve/re-mint split all disappear.

---

## 1b. Recoverability classification — what regenerates 100% from a pure model (MEASURED)

The question behind the no-raw-bytes decision: *which parts of the file are a pure function of the
map's meaning, and which carry a non-derivable "editing-history trace"?* Nothing is random — the
original editor's output is `f(edit history)`, ours is `g(final state)`; both deterministic, but
`f ≠ g` and the history is gone. Measured across the 80-map pristine corpus:

**Class 1 — pure function of the model TODAY (proven 0-diff, no trace of any kind):**
`MidLocation`, `MidLandmark`, `MidCrystal`, 4×`MidSite` (stock-list order is semantic — the editor
edits the list as-is); terrain `MidgardMapBlock` (cells fully modeled, chunk grid AND chunk block
ids derivable — uid.second encodes the origin `(by<<8)|bx`); `MidDiplomacy` (pure table);
events/variables/templates bodies.

**Class 2 — pure given ONE natural condition: the entity keeps its on-disk id as its key.** This is
ordinary persistence (a primary key), NOT raw bytes. `MidItem`/`MidUnit` bodies (proven);
`MidBag` (list order is semantic, item refs = entity keys); `MidRoad` (body = roadType/roadVar/pos;
but ids are creation-order — measured: only **4/87** maps have sequential road ids, 2-3 match any
scan order); `MidMountains` (`ID_MOUNT` **is** the entry's entity key — 83/93 blocks non-sequential);
all object block ids in general (MM/KC/FT/… — creation-order keys, already stored as `MapObject.id`,
and they're the relational glue events/OWNER/INSIDE/STACK point at).

**Class 3 — the GENUINE non-derivable residue (the complete list — it is short), each expressible
as a typed attribute, no bytes:**

| what | measurement | typed-model home |
|---|---|---|
| garrison slot packing (`UNIT_`/`POS_` order) | non-canonical on **79%** stacks / **41%** villages / **92%** ruins / **68%** capitals (9082/598/1238/215 groups) | `slot: int` on the garrison-member entity (~10 bits/compound) |
| `MidgardPlan` entry order | **93/93** maps: insertion order, sorted by nothing | keep entries as an ordered list (the SET is derivable from footprints; the ORDER is not) |
| file block order | **84 distinct type-run sequences** across 93 maps, types interleaved | the spine, degenerated: once every type model-serializes, the spine IS just an ordered list of entity references — no bytes left in it |

(Duplicate `POS_` values — e.g. `pos=[0,0,…]` — are big units occupying two cells with one slot;
that part is semantic and already modeled.)

**Class 4 — not entropy but INCOMPLETE KNOWLEDGE (fixable by finishing the reverse-engineering):**
unread `ScenarioInfo` fields, `MidPlayer` extras, `MidSubRace` table, `_playersData`, `MidFog` —
plus block types the scan surfaced that we don't model at all yet: **`MidStackDestroyed`,
`MidQuestLog`, `PlayerBuildings`, `MidSpellCast`** (raw/Generic today). These are the ONLY reason
raw passthrough still exists; each one exits the raw path the moment its fields are fully modeled.

**Bottom line:** by data volume, virtually the whole file is class 1–2. The irreducible trace is
three orderings + entity keys — a few bits per object, all typed. The no-raw-bytes target costs
almost nothing.

**Reference parity (verified in toolsqt sources):** the reference does EXACTLY this. `D2Stack`
keeps `int unit[6]; int pos[6]; int leaderId;` — typed fields stored as read, re-serialized
verbatim with no normalization (ids as plain ints; the `S143UN` prefix is reconstructed at write
time from version+type). Block order = the `m_blocks` list in read order (`save()` = `foreach`).
Raw bytes exist in exactly ONE place: `TagDataBlock { QByteArray m_data; }` — the passthrough for
block types toolsqt never modeled (their permanent class 4). Id allocation for new objects lives
in the editor layer (max+1 per type — already ported to `place.ts`). Our target = the reference's
scheme MINUS `TagDataBlock`: finish class 4 and delete the raw path entirely — the one step the
reference never took.

---

## 2. Hardcoded constants — fields we ASSUME invariant (from-scratch risk)

These are written as **literals** in the frame-writers (not model-driven). Verified invariant across
all 80 pristine maps, so byte-exact on them — but a from-scratch or hand-edited object that *should*
differ here has no way to express it, and we never learned the field's full semantics.

| block | field(s) | hardcoded to | what we DON'T know / risk |
|---|---|---|---|
| **MidSite\*** | `IMG_INTF` | `""` | interface image ref; empty on every shipped site. A site wanting a custom interface image can't set it. |
| **MidSite\*** | `VISITER` (single ref) | `G000000000` | "currently-visiting" ref; always nil at authoring. Safe default. |
| **MidVillage** | `PROTECT_B` | `G000000000` (nil) | a "protection building" ref? Never non-nil on shipped maps. Semantics unconfirmed; not settable. |
| **MidVillage** | `P_O_UN/P_O_HE/P_O_HU/P_O_DW/P_O_EL` | `false` ×5 | per-race "protection-owner" flags? All false on shipped. Not modeled/settable. |
| **MidVillage** | `RIOT_T` | `0` (via `o.riot ?? 0`, but `readVillage` never reads it) | riot timer. Modeled in the *frame* but NOT read back — effectively unsettable + we don't confirm its meaning. |
| **MidUnit** | `TRANSF` + nested block | `false`, nested OMITTED | a polymorphed unit carries a 5-field nested block (`ORIGTYPEID/KEEP_HP/ORIG_XP/HP_BEFORE/HP_BEF_MAX`). **0/34k on shipped maps.** A `transformed:true` unit is kept **fully RAW** (not model-serialized) as a safety net → can't be created or edited from the model. |
| **MidUnit** | `DYNLEVEL` | `false` | dynamic-level flag; always false on shipped (the format's conditional branch never taken). |
| **MidRuin** / **MidSite\*** | trailer visiter-count | `0` | see §3 (dropped visited-players list). |

**From-scratch takeaway:** the hardcodes are all *safe empty/default* values, so a freshly-authored
object matches shipped maps and the game accepts it (the from-scratch gold-check, task #26, confirms
a minimal map LOADS). The real limitation is **expressiveness**: `RIOT_T`, `PROTECT_B`, `P_O_*`, a
custom site `IMG_INTF`, and transformed units **cannot be authored** through the model — they're
frozen at the default. None are known to matter for normal authoring, but none are confirmed either.

---

## 3. Dropped fields — playthrough state we intentionally do NOT model

Dynamic per-playthrough state that pristine authored exports never carry. This is **why the test
corpus is `Game/Exports - Copy`, not `Game/Campaign`** (campaign copies are save-tainted).

| block | dropped | evidence |
|---|---|---|
| **MidSite\*** | **VISITER visited-players list** — after the stock: a count + N×(`SITE_ID` + player-ref) records of who already visited. | Found on campaign `Dragon_s teeth.sg` trainer (1 visitor); 0 on all pristine exports. Frame writes count `0`, never the records. |
| **MidRuin** | **visited-players records** (same shape, after the ruin's `<ownId>` count). | count hardcoded `0`. |

If we ever want to round-trip a *campaign save*, these lists must be modeled. For authoring they're
correctly absent.

---

## 4. Object types NOT yet model-serialized (still raw passthrough)

`REBUILD_TYPES` = 14: `MidLocation, MidLandmark, MidCrystal, MidSite{Merchant,Mage,Trainer,Mercs},
MidItem, MidUnit, MidStack, MidVillage, MidRuin, MidBag, MidMountains`. But `assemble`'s object
readers cover **16** decls — these three are parsed into `MapObject`s but **left RAW** in the rebuild
(byte-exact via passthrough, NOT model-driven):

| type | why it matters | effort to add |
|---|---|---|
| **Capital** | the player capital city — has a garrison (defense) + a visiting-hero stack link, exactly like `MidVillage`. A real gap: an edited capital wouldn't rebuild from the model. | LOW — clone the `MidVillage` path (`raw` garrison snapshot + `capitalFrame`); the frame already exists for from-scratch. |
| **MidRod** | border-influence rod (owner + race). | LOW — small scalar block. |
| **MidTomb** | constant-sprite decoration. | LOW — near-trivial. |

**Note:** the 80/80 byte-gate passes *with these raw*, so "byte-exact on the corpus" is true, but
"every object block is model-driven" is **not** — Capital/Rod/Tomb are the honest asterisk.

---

## 5. Non-object blocks — the remaining ~half of the file (all raw today)

Everything below is parsed into the model for the *editor* but the **rebuild keeps it raw** (not in
`REBUILD_TYPES`). Raw passthrough is byte-exact, so the full-rebuild is already byte-exact overall —
but a *fully model-driven* rebuild (the target) must fold these in too. This is the bulk of the
remaining work.

| block | current model status | what a model rebuild needs |
|---|---|---|
| **ScenarioInfo** | header fields modeled: name/desc/author/size/difficulty/`BRIEFING`/`BRIEFLONG1-5`/`DEBUNKW*`/`DEBUNKL`/`MAX_*`/`SUGG_LVL`/`MAP_SEED`. | The block is large; **unmodeled fields exist** (only the above are read). A model rebuild needs the complete field list (`_playersData` race blob, campaign flags, etc.). From-scratch copies a known-good body verbatim rather than modeling it. |
| **MidgardMap** | map size only. | trivial; any other fields unknown. |
| **MidgardMapBlock** (terrain) | fully unpacked into `terrain.cells` (terrain/ground/forest/road bits). | re-pack cells → 8×4 chunks byte-exact (the `createBlankMap` writer proves it's doable; just not wired into `rebuildFromModel`). |
| **MidRoad** | applied onto cells (`roadType`/`roadVar`). | re-emit one `MidRoad` per road cell (frame exists: `roadFrame`). |
| **MidPlayer** | `PlayerInfo` (id/no/race/name/isHuman/color). | likely more fields on disk (money, spells-known, fog, etc.) — only the above are read. |
| **MidSubRace** | only the `BANNER` number captured (keyed by index). | the full subrace table (`createBlankMap` emits it verbatim as a gold-checked port — not modeled). |
| **MidgardPlan** | **generic stub only** (`{type:"generic", raw:{}}`) — deliberately not parsed. | THE hard one: the plan is the placement/passability index (per-cell POS + ELEMENT ref). Today it's mutated by `applyBytes` (add/purge entries) but never modeled. A model rebuild must **regenerate the whole plan from object footprints** — this is the linchpin of the "rebuild relations on export" target. |
| **MidEvent / MidScenVariables / MidStackTemplate / MidDiplomacy** | fully modeled (events/vars/templates/diplomacy) for the editor. | wire their existing frames into `rebuildFromModel` (largely mechanical — the readers/writers exist from the events work). |
| **MidFog**, `_playersData`, unknown decls | raw / `GenericObject`. | enumerate + model, or keep as explicit raw with a reason. |

---

## 6. Semantics we preserve but don't understand (opaque passthrough)

Round-tripped byte-exact, but treated as opaque — a fully-modeled editor would want to decode these:

- **Ruin `CASH`** — reward string `"G####:R####:Y####:E####:W####:B####"` (gold/mana-by-school). Read
  as an opaque string; not parsed into per-resource amounts.
- **MidUnit `MODIF_ID` list** — level-up/equipment modifier refs (`Gmodif`). Preserved verbatim
  (order + duplicates), never validated or decoded — the editor can't add/remove a modifier meaningfully.
- **MidUnit `CREATION`** — an int (creation turn?), captured but semantics unconfirmed.
- **MidStack `SRCTMPL_ID`** — the `MidStackTemplate` this stack was spawned from; captured as a raw ref,
  the relation to the template block isn't modeled.
- **`AIORDER` / `ORDER` enums** — captured as ints; only partial enum meaning documented.

---

## 7. What would hurt when creating a map FROM SCRATCH

`createBlankMap` produces a **minimal playable map** (races → player + fog + subrace + capital +
guardian + hero + 3 items, plus ScenarioInfo/MidgardMap/MidgardPlan/MidDiplomacy). Everything richer
(villages, ruins, sites, crystals, bags, mountains, locations, landmarks) is added afterward via the
editor's place-ops → `applyBytes`, using the same frames. Concrete from-scratch exposure:

1. **Verbatim-port blocks, not modeled.** `ScenarioInfo` body, `MidSubRace` table, `_playersData`
   blob, and `MidgardPlan` are emitted as **byte-copied known-good patterns**, not built from a model.
   They're gold-checked for the shapes we reverse-engineered (≤5 races, tested corners). An untested
   configuration (6+ players, an unusual race mix) could hit an unmodeled field we've only ever copied.
2. **Un-authorable fields (§2).** `RIOT_T`, `PROTECT_B`, `P_O_*`, site `IMG_INTF`, transformed units —
   frozen at defaults. Fine for normal maps; a blocker if a design needs them.
3. **`MidgardPlan` correctness.** New objects must add correct plan entries (footprint cells +
   passability) or the game editor **refuses the map**. Today `applyBytes` adds entries per placement
   using per-baseType footprints; a mistake there = a map the game rejects. This is the most fragile
   from-scratch surface and the least modeled.
4. **Instance-id allocation.** From-scratch mints `MidUnit`/`MidItem` ids sequentially. No collision
   logic beyond "next index"; fine now, but a real relation-model export needs a deterministic
   allocator shared across all id bands.

---

## 8. Remaining work (ordered) + the gold-check

**STATUS 2026-07-10: steps 1-5 are DONE.** REBUILD_TYPES = 38 = every block type on the corpus;
`rebuildBytes(x, parse(x)) === x` on all 80 pristine originals AND 55/55 campaign saves with
**ZERO raw passthrough** (a census in the gate proves no block falls back to TagDataBlock-style
copying). Newly modeled along the way: MidSiteResourceMarket (mod-era 5th site kind: CUSTOM +
embedded Lua CODE + BANK + INF - the tail is read positionally because Lua text can contain
tag-like substrings).

**Step 5 (the entity refactor) is DONE:** `InstanceRawSnapshot`, `doc.instances`, `garrisonRaw`
and the template `raw` are all GONE. GarrisonUnit is the full MidUnit entity inlined on the
formation cell (unit/level/hp/xp/creation/name/modifiers + `key` = block id, `slot` = UNIT_ slot);
UNIT_/POS_/LEADER_ID are DERIVED from the members (measured safe: 0 orphan slots / 0 unreachable
leaders / 0 double refs on 13116 shipped garrisons). Item lists carry `itemKeys`/`inventoryKeys`
(index-aligned; 0 sentinels in 8127 lists); villages gained their loot list. Templates keep the
on-disk layout as typed `slots` + `slotOfCell` — REQUIRED, not an artifact: 919/2656 shipped
templates carry ORPHAN slots (a filled UNIT_s no POS_i references) that the cell view can't
express; the reference's D2StackTemplate stores exactly these slots. Blocks referenced by nothing
(62 MidUnit + 4 MidItem across the corpus — dangling editor leftovers) live in typed
`doc.strayInstances`. `verifySemantic` now strips only the identity attributes (key/slot,
itemKeys/inventoryKeys, idMount, template slots) — the DB-auto-key analogy, not a data blob.
Bonus fix: applyBytes garrison re-mint now carries xp/creation/name/modifiers into the fresh
MidUnit (before, editing a garrison silently reset a veteran's XP/name in the bytes).

**Step 6 (the ScenEdit gold-check) is DONE — the roadmap is COMPLETE.** Protocol: every corpus
map got a battery of MODEL edits (scenario/village/location/event/template rename + stack
facing), was exported via the FULL model rebuild (bytes genuinely diverge from the original),
and fed to the map's own mod editor (`last_version` ScenEdit, headless: null-render cnc-ddraw
as C4dll-R.dll + `ScenEditDatabase=0`, driven by `tools/scen-tester` posted messages under a
Win32 debugger). Result: **originals 80/80 PASS, model-rebuilt-with-edits 80/80 PASS** —
loaded AND re-saved by the game's own validator, zero rejections. (First attempt against the
slasher install produced a false signal — 29/30 originals rejected on ITS mod DB, `MidItem:
Invalid type G000IG7105` — always gold-check against the mod the maps were written for.)

Known non-goal (unchanged): `rebuildBytes` of an object whose garrison was EDITED in-session
returns the block raw-unchanged (members lose key/slot on edit; minting fresh ids is
applyBytes' job — the production export path).

1. **Close the object set:** add **Capital** (clone the village garrison path), then **Rod/Tomb**
   (trivial) → 100% of object blocks model-driven.
2. **Fold in the mechanical non-object blocks:** terrain (`MidgardMapBlock`), `MidRoad`, `MidPlayer`,
   events/variables/templates/diplomacy — their frames exist; wire into `rebuildFromModel`.
3. **Model `MidgardPlan` properly** (regenerate from object footprints) — unlocks a truly
   model-driven export AND removes the fragile hand-maintained plan in `applyBytes`.
4. **Complete `ScenarioInfo` + `MidSubRace` + `_playersData`** field models (retire the verbatim
   ports), and reverse the class-4 stragglers the scan surfaced: `MidStackDestroyed`, `MidQuestLog`,
   `PlayerBuildings`, `MidSpellCast`, `MidFog`.
5. **The relation-model refactor (§0 decision):** first-class entities carrying `key` + `slot`
   (§1b), explicit refs, deterministic id allocation for NEW entities on export, plan + spine as
   ordered lists → delete `raw`, `idMount`-as-artifact, `doc.instances`-as-carrier, and the
   `verifySemantic` strip. End state: **zero raw bytes anywhere in the model**; the byte-gate keeps
   passing because the typed model replicates the format exactly (§1b proves the residue is tiny).
6. **ScenEdit gold-check:** the byte-gate proves `rebuildBytes(x, parse(x)) === x`, but the ultimate
   test of a *fully model-rebuilt* map (esp. once terrain/plan/scenario are model-driven and diverge
   from the original bytes) is that **ScenEdit / the game editor LOADS it** — reuse the from-scratch
   gold-check harness (task #26) on a rebuilt-from-model campaign map.

---

## Appendix — where each thing lives

- `REBUILD_TYPES` + dispatch: `packages/sg-parser/src/writer/sgModelSerialize.ts`
- frames (hardcodes): `packages/sg-parser/src/writer/sgRebuild.ts`
- readers (what's captured/dropped): `packages/sg-parser/src/blocks/objects.ts`, `.../scenario.ts`
- entity schemas (GarrisonUnit key/slot, itemKeys, template slots): `packages/map-schema/src/objects.ts`; `doc.strayInstances`: `.../document.ts`
- identity-attribute strip (key/slot/itemKeys/idMount/template slots): `packages/map-edit/src/verifySemantic.ts`
- patch-path plan/instance minting: `packages/map-edit/src/applyBytes.ts`
- from-scratch: `packages/sg-parser/src/writer/createBlankMap.ts`
- test corpus + gates: `packages/sg-parser/test/sgBlocks.test.ts`
