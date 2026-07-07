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

## Measured findings (Riders, STEP 3)

Rebuild every block of ONE type from the model (rest raw), then count byte diffs vs the original:

| type | blocks | byte diffs | Δlen | per block | verdict |
|---|---|---|---|---|---|
| **MidLocation** | 418 | **0** | 0 | 0 | **byte-perfect** — model + `locationFrame` fully capture the block (LOC_ID/POS/NAME_TXT/RADIUS). |
| **MidLandmark** | 673 | 1,125,825 | −6680 | **−9.9** | semantically valid (reparses, all survive, `validateMap` ok) but **~10 bytes/block SHORT**. |

**What the landmark gap is:** `readLandmark` keeps only `{id, pos, baseType}` — it does NOT read
`DESC_TXT`, and `LandmarkObject` has no field for it. `landmarkFrame` then writes `DESC_TXT("")`.
The real blocks carry ~10 more bytes/landmark (a non-empty description and/or a real `TYPE` where
the model dropped a nil `baseType`). So the model is LOSSY for landmarks by ~10 bytes each — the
exact "unmodeled field" failure the reference avoids by keeping such blocks as `TagDataBlock` raw.

**Takeaway:** the full-rebuild MECHANISM works (location proves byte-perfect reproduction is
possible). Parity is now a per-type job of closing model gaps — for landmark: add `DESC_TXT` to the
schema + reader + frame, or (cheaper, reference-style) keep landmark blocks RAW until the model is
proven complete. Every type gets this treatment, gold-checked, before it's switched from raw to
model-serialized.

## Status

STEP 1 (spine) + STEP 2 (OB0000 count) + STEP 3 (typed serialize: location byte-perfect, landmark
gap measured) done + tested (`sgBlocks.test.ts`, 7 tests). Not pushed — local branch only.

Next: STEP 3 increments per type (close model gaps, keep unproven types raw), then STEP 4
(`rebuildScenario` export path + patch-vs-rebuild toggle) with a ScenEdit gold-check.
