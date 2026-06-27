# d2-web-editor — deferred TODO

Things intentionally postponed (decided 2026-06-26). Order is rough priority.

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
