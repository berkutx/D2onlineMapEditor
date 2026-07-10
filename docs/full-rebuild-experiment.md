# Experiment: full `.sg` rebuild from model state (branch `experiment/full-rebuild`)

**Goal (user):** export a LOADED map by rebuilding the whole byte stream from the model
("паритет с эталоном"), not by patching the original bytes in place. Local-only experiment,
NOT deployed to master.

## Why the current export is byte-identical (context)

Today's writer (`sgRaw`/`applyBytes`) is **patch-in-place**: it splices edits into the ORIGINAL
bytes at captured offsets. Zero edits ⇒ byte-identical output. It is deliberately NOT a rebuild —
the `.sg` has ~35 block types and we model a subset; re-serialising from the model would drop the
unmodeled blocks. `sgRaw.ts`'s own header says this, calling it "mirroring the editor's
TagDataBlock pass-through".

## What the reference (toolsqt `D2MapModel`) actually does

Not a full model of everything either. From `D2MapModel.cpp`:

```cpp
bool D2MapModel::save(const QString &path) {
    file.write(header.data(m_blocks.count()));          // header, parameterised by block count
    foreach (block, m_blocks) file.write(block->data(header)); // each block serialises itself
}
```

`IDataBlock` is polymorphic: **typed** blocks serialise from their fields; **`TagDataBlock`**
keeps the raw payload bytes (`m_data`) between markers and re-emits them verbatim. So the
reference's "full rebuild" = `header(count) + Σ block.serialize()`, where unmodeled blocks are
raw pass-through. That is exactly what makes it lossless and tractable — and it maps 1:1 onto our
frame-writers (typed) + a raw block carrier (Tag).

## Plan (incremental, each step gold-checked before the next)

- **STEP 1 — block-list spine ✅ (this commit).** `splitScenario(bytes) → {header, blocks[], trailer}`
  + `joinScenario(...)`. Every block kept RAW. Invariant proven on ALL real campaign maps:
  `join(split(x)) === x` byte-for-byte (`sgBlocks.test.ts`). This is our `m_blocks` model.
- **STEP 2 — header/count separation.** Split the leading header off cleanly and re-emit it with a
  block-count field (mirror `header.data(count)`), so inserting/removing blocks stays valid.
- **STEP 3 — typed serialisation, ONE type at a time.** For a modeled block type (start with the
  simplest — landmark/MM), serialise the frame from the model via the existing frame-writers
  instead of the raw bytes. Acceptance test is NOT byte-identity (the reference isn't byte-identical
  either) but the **gold-check**: ScenEdit / the game LOADS the rebuilt map (see the from-scratch
  gold-check harness, task #26). Expand type-by-type; unmodeled types stay raw (Tag pass-through).
- **STEP 4 — a `rebuildScenario(doc, blocks)` export path** in `@d2/map-edit`, and a toggle
  (export route flag / UI) to choose patch-in-place (default, byte-exact) vs full-rebuild.
- **STEP 5 — validation:** the 3-tier validator + a rebuild-specific gold-check across the campaign
  corpus.

## Key caveat

Model-serialised blocks are game-VALID, not byte-identical to the original (field order/padding may
differ). So the full-rebuild export will NOT be byte-equal to a loaded map — that is expected and
fine (the game re-reads it). The byte-exact property belongs to patch-in-place, which stays the
default. Full-rebuild is the opt-in path toward reference parity.

## Measured findings (Riders, STEP 3) + the close-the-gap loop

Rebuild every block of ONE type from the model (rest raw), then count byte diffs vs the original:

| type | blocks | byte diffs | verdict |
|---|---|---|---|
| **MidLocation** | 418 | **0** | byte-perfect — model + `locationFrame` fully capture the block. |
| **MidLandmark** (before) | 673 | 1,125,825 (−9.9 B/block) | valid but SHORT — model dropped a field. |
| **MidLandmark** (after fix) | 673 | **0** | byte-perfect — the gap is closed. |

**The landmark gap, diagnosed from the bytes:** the −9.9 B/block lived entirely in `DESC_TXT`.
HEX decode of real landmark descriptions: `d2 ee ef fc 00` = **"Топь"** (marsh), `Фонтан`
(fountain), `Яма` (pit) — CP1251. `DESC_TXT` is the **author's name/label for the decoration**.
`readLandmark` never read it and `LandmarkObject` had no field, so the model dropped it (a real
data-loss bug — even a re-added/undone landmark lost its name through the patch-in-place writer).
The reference DOES model it: its factory registers `D2LandMark` (typed), not `TagDataBlock`.

**The fix (the close-the-gap loop in miniature):** add `desc` (optional, CP1251) to
`LandmarkObject` → read `DESC_TXT` in `readLandmark` (omit when empty) → thread it through BOTH
writers (`applyBytes` landmark append + the experiment `serializeTypedBlock`). Re-measured:
**landmark 0 diffs**. No disassembly needed — the bytes + the reference source were enough.

**Takeaway:** the mechanism works AND the per-type gap-closing is cheap & mechanical: diff → HEX-
decode the delta → find the dropped field → add to schema+reader+writer → 0 diffs. Two types
(location, landmark) are now byte-perfect from the model.

## Round 2 — the remaining object types (stack/village/ruin/site/crystal/treasure/mountains)

A 7-agent analysis + per-type byte measurement split the requested types into **achievable now**
vs **blocked by the instance-ref gap**:

| type | verdict | why |
|---|---|---|
| **MidCrystal** | ✅ byte-perfect | one dropped scalar (`AIPRIORITY`) — added like `DESC_TXT`. Self-ref id, no instances. |
| **MidSiteMage / Trainer / Mercs** | ✅ byte-perfect | stock lists are GLOBAL template ids (order == file order), no instance graph. |
| **MidSiteMerchant** | ✅ byte-perfect | same, after capturing `BUY_*` (8 bools) + `MISSION` (value-carrying bools, omit-when-default). |
| **MidStack / MidVillage / MidRuin** | ✅ raw / ❌ model-serialize | ALREADY byte-exact via **raw passthrough** (not in REBUILD_TYPES → TagDataBlock, like the reference). Only MODEL-serializing them from the resolved model is blocked: garrison = sibling `MidUnit` instance blocks that `assemble.ts` resolves (unit+level+hp) and whose raw ids/ordering it drops. |
| **MidBag (treasure)** | ✅ raw / ❌ model-serialize | same: `items` = `MidItem` instance refs, resolved to global templates. Raw passthrough is byte-exact; model-serialize isn't. |
| **MidMountains** | ⚠ deferred | ONE block holds ALL mountains (`byId.get(block-id)` fails — children are `${blockId}#n`); needs a dispatcher special-case + `ID_MOUNT` per-entry id. Not an instance-ref gap, just a different shape. |

**The honest limit (corrected):** compound objects (stack/village/ruin/treasure) DO rebuild
byte-exact today — as **raw passthrough** (proven: Relentless.sg, 370 stacks / 1548 MidUnit /
577 MidItem, is in the 80/80 byte-identical sweep). What's blocked is only *model-serializing an
EDITED compound object byte-exactly* from the flat/resolved model. That is (a) not needed for the
export-unedited goal, (b) impossible by definition (edited ≠ byte-identical), and (c) already done
by `applyBytes` (patch-in-place) for the production edit path. Preserving the raw `MidUnit`/`MidItem`
instance graph as an object sidecar would only matter if the REBUILD path (vs patch) had to carry
compound edits too — modest payoff, so deferred rather than forced.

### Two residual gaps, closed against the PRISTINE corpus

A per-type sweep over **80 pristine originals** (`Game/Exports - Copy`, incl. the 2.4 MB giants —
NOT the `Game/Campaign` copies, which carry playthrough state) surfaced two deviations Riders never
exercised:

1. **Merchant `MISSION` / `BUY_*`** — a handful of merchants set `MISSION=1` or toggle a `BUY_*`
   category off. `readDefaultBool` is presence-only (wrong for value-carrying bools); added
   `readBoolValue` + `readMerchantFlags` (omit-when-default) → `siteFrame` writes them.
2. **Landmark `DESC_TXT` presence** — RMG-generated maps (`Random scenario.sg`) omit `DESC_TXT`
   entirely; editor-authored maps always write it. The model collapsed "absent" and "present-empty"
   into `undefined`. Fix: `readLandmark` preserves the distinction (`desc !== null`), `landmarkFrame`
   OMITS the field when `desc === undefined`, `placeLandmarkOps` sets `desc: ""` (эталон parity),
   and `applyBytes` passes `o.desc` through — so **the model's `desc` presence IS the DESC_TXT
   presence**, consistently across patch AND rebuild.

Also surfaced (campaign-only, not modeled): a **site VISITER visited-players list** (`SITE_ID`+
player-ref records) appended after the stock — dynamic playthrough state that pristine exports never
carry. Intentionally left raw; it's why the corpus is `Exports - Copy`, not `Campaign`.

## Round 3 — the instance graph modeled (MidStack / MidUnit / MidItem)

The "instance-ref gap" is now CLOSED (user chose the full model-serialize over leaving it raw). The
graph that lives inside stacks/forts/chests is fully parsed and re-emitted from the model:

- **`doc.instances`** (additive, optional, editor-transparent) carries the full `MidUnit` +
  `MidItem` records (impl/level/hp/xp/creation/name/`MODIF_ID` list; item = ITEM_TYPE). `assemble`
  populates it; `rebuildFromModel` serializes `MidItem`/`MidUnit` blocks from it (looked up by block
  id — they're not `MapObject`s).
- **`MidUnit`** full-parse: verified encoding `LEVEL · <own-id>count · MODIF_ID×n · CREATION ·
  NAME_TXT · TRANSF · DYNLEVEL · HP · XP`. `MODIF_ID` list on **14%** of 34k units, `NAME_TXT` on
  **27%** — both reproduced. `TRANSF=true` (a polymorph's 5-field nested block) is 0/34k; such a
  unit is flagged `transformed` and kept RAW as a safety net.
- **`MidStack`** full-parse: all 32 fields. The minted-id graph (`UNIT_0..5`/`POS_0..5`/`LEADER_ID`/
  `ITEM_ID`) is captured as a **load-only `raw` snapshot** on the stack object; scalars
  (`AIORDER`≠2 on **99.8%** of 9k stacks, `SRCTMPL_ID`, `INVISIBLE`, `AI_IGNORE`, `UPGCOUNT`, …) as
  omit-when-default fields. `roundTripSemantic` STRIPS `raw` before comparing (a PLACED stack mints
  fresh ids, so it can't match the pre-export op — the resolved garrison/leader/scalars still do).

Reference parity confirmed: toolsqt `D2Stack`/`D2Unit`/`D2Item` `read()`/`data()` field order
matches the byte dumps 1:1.

**Known limitation (rebuild of an EDITED compound):** the `raw` snapshot is captured at LOAD and goes
stale if a garrison/inventory is edited (the ids are minted at export). The rebuild path is not the
default export; the production edit path is `applyBytes` (patch-in-place), which re-mints correctly.
A rebuild export of an edited map would need snapshot invalidation + re-mint — deferred.
**Perf note:** `doc.instances` adds the instance records to every doc (big maps: ~1.5k units); the
client ignores them and the server rebuild re-parses stored bytes, so stripping them from the
client-facing response is a safe future optimization.

## Round 4 — Village / Ruin / Bag + Mountains (the mechanism generalized)

The `raw`-snapshot + `doc.instances` pattern now covers the rest of the compound objects, and the
one-block-holds-all mountains shape:

- **`InstanceRawSnapshot`** extracted to a shared schema; **MidVillage** (garrison slots +
  captured-loot `ITEM_ID`, 71% of villages carry loot), **MidRuin** (guardian garrison, 87%), and
  **MidBag** (`ITEM_ID` contents, 98%) each get a load-only `raw`. `verifySemantic` strips `raw`
  from ANY compound. Latent scalars (`RIOT_T`/`PROTECT_B`/`P_O_*`, ruin visiter-count) are invariant
  on shipped maps — hardcoded.
- **MidMountains** — the ONE-block-holds-all case: `rebuildFromModel` special-cases it, GATHERING
  every `${blockId}#n` child back into a single block via `mountainsFrame`. `ID_MOUNT` is a per-entry
  id (**83/93 blocks non-sequential**, e.g. 4151,4157,…), now captured on the object + preserved by
  BOTH paths (`sgRaw` for patch, the model for rebuild); it's an export artifact for placed entries,
  so `verifySemantic` strips it like `raw`.

## Status

`REBUILD_TYPES` = **14 types**: MidLocation, MidLandmark, MidCrystal, MidSite{Merchant,Mage,Trainer,
Mercs}, MidItem, MidUnit, MidStack, MidVillage, MidRuin, MidBag, MidMountains — i.e. **every object
block type**. All **byte-perfect** (`rebuildBytes(x, parse(x)) === x`) on ALL 80 pristine originals,
largest (2.4 MB) included. Gates: `sgBlocks.test.ts` (STEP-3 per-type 0-diff + STEP-4 pristine
sweep). Full suite green: sg-parser 76, map-edit 139, server 96, map-schema 5. The DESC_TXT +
merchant-flag + landmark-presence + full-stack + mountains-`ID_MOUNT` fixes also harden the
production patch/reader paths. Not pushed — local branch only.

Next: the NON-object blocks (ScenarioInfo, MidgardMapBlock terrain, MidRoad, MidPlayer, MidSubRace,
MidgardPlan, events/variables/templates/diplomacy) — many already round-trip raw byte-exact; a full
model rebuild would fold them into the model too. Then STEP 5: a ScenEdit gold-check that a fully
model-rebuilt map LOADS in the game editor.
