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

## Status

STEP 1 (spine) + STEP 2 (OB0000 count) + STEP 3 (typed serialize; **location + landmark both
byte-perfect from the model** after closing the DESC_TXT gap) done + tested (`sgBlocks.test.ts`,
7 tests, asserting 0 diffs). Landmark `desc` fix also lands in the main writer/reader (a real
bug fix). Not pushed — local branch only.

Next: repeat the loop for the remaining object types (stack/village/ruin/site/…), then the
non-object blocks, then STEP 4 (`rebuildScenario` export path + patch-vs-rebuild toggle) with a
ScenEdit gold-check on the fully model-rebuilt map.
