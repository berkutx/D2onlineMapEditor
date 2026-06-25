/**
 * objectSprite — PURE resolver from a {@link MapObject} to candidate sprite /
 * animation names (D2 resource ids), in priority order. The renderer tries each
 * candidate against the {@link AssetStore}: first an animation, then a static frame.
 *
 * Names follow the editor's iso-resource conventions, cross-checked against the
 * generated atlases (IsoCmon/IsoStill/IsoAnim/City/Capital):
 *   landmark   -> baseType verbatim (e.g. "G000MG8057")
 *   capital    -> "G000FT0000<race>C0"
 *   village    -> "G000FT0000NE<tier>" / "ALN<tier>"
 *   site       -> "G000SI0000<TYPE><nn>"  (MERH/MAGE/TRAI/MERC)
 *   ruin       -> "G000RU0000<nnn>"
 *   mountains  -> "M_<race>_<size>_<img>"
 *   crystal    -> "G000CR0000<color>"
 *   stack      -> leader unit sprite (needs IsoUnit; absent in Stage 1 -> no render)
 */
import type { MapObject } from "@d2/map-schema";

/** raceId -> 2-letter code (verified against Riders.sg terrain mapping). */
export const RACE_CODE = ["HU", "UN", "HE", "DW", "NE", "EL"] as const;

/** crystal resource id -> colour code (best-effort; unmatched falls through to all). */
const CRYSTAL_COLORS = ["BG", "GR", "RD", "WH", "RG", "YG"] as const;

const pad = (n: number, w: number): string => String(n).padStart(w, "0");
const code = (race: number | undefined): string =>
  RACE_CODE[(race ?? 4) % RACE_CODE.length] ?? "NE";

export interface ObjectResolveCtx {
  /** owner player uid -> raceId (for forts/capitals themed by owner). */
  raceOf: (ownerId: string | undefined) => number | undefined;
}

/** Ordered candidate sprite/animation names for an object. Empty = not renderable. */
export function objectSpriteCandidates(
  obj: MapObject,
  ctx: ObjectResolveCtx,
): string[] {
  switch (obj.type) {
    case "landmark":
      return obj.baseType ? [obj.baseType] : [];

    case "crystal": {
      const c = CRYSTAL_COLORS[(obj.resource ?? 0) % CRYSTAL_COLORS.length]!;
      return [`G000CR0000${c}`, ...CRYSTAL_COLORS.map((x) => `G000CR0000${x}`)];
    }

    case "capital": {
      const c = code(ctx.raceOf(obj.owner) ?? obj.race);
      return [`G000FT0000${c}C0`, `G000FT0000${c}C0_1`, "G000FT0000NEC0"];
    }

    case "fort": {
      const c = code(ctx.raceOf(obj.owner) ?? obj.race);
      return [`G000FT0000${c}0`, "G000FT0000NE0"];
    }

    case "village": {
      const t = obj.tier ?? 1;
      return [`G000FT0000NE${t}`, `ALN${t}`, `G000FT0000NE${t}HU`, "G000FT0000NE1"];
    }

    case "ruin": {
      const i = obj.image ?? 0;
      return [
        `G000RU0000${pad(i, 3)}`,
        `G000RU0000${pad(i, 3)}0`,
        `G000RU0000${pad(i, 2)}0`,
      ];
    }

    case "merchant":
      return ["G000SI0000MERH00", "G000SI0000MERH"];
    case "mage": {
      const i = obj.image ?? 4;
      return [`G000SI0000MAGE${pad(i, 2)}`, "G000SI0000MAGE04"];
    }
    case "trainer":
      return ["G000SI0000TRAI04", "G000SI0000TRAI00"];
    case "mercenary":
      return ["G000SI0000MERC05", "G000SI0000MERC00"];

    case "mountains": {
      const c = code(obj.race);
      const img = obj.image ?? 0;
      // size is not in the .sg cell; try the sizes the catalog ships (2,3,5,4,1).
      return [2, 3, 5, 4, 1].map((s) => `M_${c}_${s}_${img}`);
    }

    case "stack":
      return obj.leaderImage ? [obj.leaderImage] : [];

    default:
      return obj.imageName ? [obj.imageName] : [];
  }
}
