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

## Status

STEP 1 done + tested. Not pushed. Continue on this branch.
