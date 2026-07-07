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
| **MidStack / MidVillage / MidRuin** | ❌ blocked | garrison = sibling `MidUnit` **instance** blocks; the model RESOLVES them (unit+level+hp) and `assemble.ts` deletes the raw ids/ordering. Byte-exact rebuild needs the raw instance graph preserved — a deep model change that conflicts with the resolved model the editor UI depends on. |
| **MidBag (treasure)** | ❌ blocked | `items` = `MidItem` **instance** refs (same instance-ref/ordering gap). Empty bags are 0-diff; non-empty diverge. |
| **MidMountains** | ⚠ deferred | ONE block holds ALL mountains (`byId.get(block-id)` fails — children are `${blockId}#n`); needs a dispatcher special-case + `ID_MOUNT` per-entry id. Not an instance-ref gap, just a different shape. |

**The honest limit:** compound objects (stack/village/ruin/treasure) can't rebuild byte-exact
without the model preserving the raw `MidUnit`/`MidItem` instance graph + ordering. That's a
separate sub-project (it fights the *resolved* garrison/inventory model the whole UI relies on),
reported rather than forced.

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

## Status

`REBUILD_TYPES` = **MidLocation, MidLandmark, MidCrystal, MidSiteMerchant, MidSiteMage,
MidSiteTrainer, MidSiteMercs** — all **byte-perfect** (`rebuildBytes(x, parse(x)) === x`) on ALL 80
pristine originals, largest included. Gates: `sgBlocks.test.ts` (STEP-3 per-type 0-diff on Riders;
STEP-4 full-rebuild byte-identity over the biggest-first pristine corpus). Full suite green:
sg-parser 71, map-edit 139, server 96, map-schema 5. The DESC_TXT + merchant-flag + landmark-
presence fixes also harden the production patch/reader paths (real round-trip bugs). Not pushed —
local branch only.

Next: MidMountains dispatcher special-case (one-block-holds-all + `ID_MOUNT`); then the
instance-graph sub-project for the compound types (stack/village/ruin/treasure); then the
non-object blocks + STEP 5 ScenEdit gold-check on a fully model-rebuilt map.
