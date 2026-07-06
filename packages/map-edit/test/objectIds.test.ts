/**
 * assignObjectIds (M4) — server reassigns a colliding addObject to the next free id of the
 * same family, keeps non-colliding ids, and rewrites later same-batch refs to the new id.
 */
import { describe, it, expect } from "vitest";
import { assignObjectIds, nextFreeObjectId, type EditOp } from "@d2/map-edit";

const add = (id: string): EditOp => ({ kind: "addObject", object: { id, type: "ruin", pos: { x: 0, y: 0 } } as never });

describe("assignObjectIds", () => {
  it("leaves a non-colliding add untouched (no remap)", () => {
    const { ops, remap } = assignObjectIds(new Set(["S143RU0001"]), [add("S143RU0002")]);
    expect(remap).toEqual({});
    expect((ops[0] as { object: { id: string } }).object.id).toBe("S143RU0002");
  });

  it("reassigns a colliding add to the next free id of the SAME family", () => {
    const live = new Set(["S143RU0005", "S143RU0006"]);
    const { ops, remap } = assignObjectIds(live, [add("S143RU0005")]); // collides
    const newId = (ops[0] as { object: { id: string } }).object.id;
    expect(newId).toBe("S143RU0007"); // skips 0006 (also taken), lands on next free
    expect(remap).toEqual({ "S143RU0005": "S143RU0007" });
  });

  it("rewrites a later same-batch op that references the reassigned id", () => {
    const { ops, remap } = assignObjectIds(new Set(["S143FT0001"]), [
      add("S143FT0001"), // collides -> reassigned
      { kind: "moveObject", id: "S143FT0001", x: 3, y: 4 },
      { kind: "patchObject", id: "S143FT0001", fields: { name: "x" } },
    ]);
    const newId = (ops[0] as { object: { id: string } }).object.id;
    expect(newId).toBe("S143FT0002");
    expect(remap).toEqual({ "S143FT0001": "S143FT0002" });
    expect((ops[1] as { id: string }).id).toBe("S143FT0002"); // move follows the remap
    expect((ops[2] as { id: string }).id).toBe("S143FT0002"); // patch follows the remap
  });

  it("handles the mountains `#index` family", () => {
    expect(nextFreeObjectId(new Set(["S143ML0000#0", "S143ML0000#1"]), "S143ML0000#0")).toBe("S143ML0000#2");
  });

  it("two adds of the same NEW id in one batch each get a distinct id", () => {
    const { ops } = assignObjectIds(new Set(["S143RU0009"]), [add("S143RU0009"), add("S143RU0009")]);
    const a = (ops[0] as { object: { id: string } }).object.id;
    const b = (ops[1] as { object: { id: string } }).object.id;
    expect(a).not.toBe(b);
    expect(a).toBe("S143RU000a");
    expect(b).toBe("S143RU000b");
  });
});
