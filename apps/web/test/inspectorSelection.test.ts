import { describe, expect, it, vi } from "vitest";
import { MapObject } from "@d2/map-schema";
import {
  bindSelectionAction, selectDefenseObject, selectEditableVisitorStack,
  selectLocationObject, selectStackObject,
} from "../src/services/inspectorSelection";

describe("rendered inspector actions", () => {
  const city = () => ({ id: "city-a", garrison: [{ unit: "guard", hp: 20 }] });

  it("ignores a delayed action after the selected object was deleted", () => {
    let selected: ReturnType<typeof city> | null = city();
    const commit = vi.fn();
    const onStat = bindSelectionAction(() => selected, () => false, commit);
    selected = null;
    expect(() => onStat()).not.toThrow();
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not apply an old panel's event to a newly selected object", () => {
    let selected = city();
    const commit = vi.fn();
    const oldPanelAction = bindSelectionAction(() => selected, () => false, commit);
    selected = { ...city(), id: "city-b" };
    oldPanelAction();
    expect(commit).not.toHaveBeenCalled();
  });

  it("uses the current object so a collaborator's new garrison member is preserved", () => {
    let selected = city();
    const committed: ReturnType<typeof city>[] = [];
    const onStat = bindSelectionAction(() => selected, () => false, (object, hp: number) => {
      committed.push({ ...object, garrison: object.garrison.map((unit, index) =>
        index === 0 ? { ...unit, hp } : unit) });
    });
    selected = { ...selected, garrison: [...selected.garrison, { unit: "archer", hp: 15 }] };
    onStat(10);
    expect(committed).toEqual([{ id: "city-a", garrison: [
      { unit: "guard", hp: 10 }, { unit: "archer", hp: 15 },
    ] }]);
  });

  it("rechecks read-only mode when an outstanding picker reports its result", () => {
    const selected = city();
    let readOnly = false;
    const commit = vi.fn();
    const onPick = bindSelectionAction(() => selected, () => readOnly, commit);
    readOnly = true;
    onPick();
    expect(commit).not.toHaveBeenCalled();
  });
});

const stackA = MapObject.parse({ type: "stack", id: "stack-a", pos: { x: 0, y: 0 } });
const stackB = MapObject.parse({ type: "stack", id: "stack-b", pos: { x: 1, y: 1 } });
const cityA = MapObject.parse({ type: "village", id: "city-a", stackRef: stackA.id, pos: { x: 0, y: 0 } });
const cityB = MapObject.parse({ type: "village", id: "city-b", stackRef: stackB.id, pos: { x: 1, y: 1 } });

const adapters: {
  name: string;
  first: MapObject;
  next: MapObject;
  select: (object: MapObject | null) => { id: string } | null;
}[] = [
  { name: "city defense", first: cityA, next: cityB, select: selectDefenseObject },
  {
    name: "ruin guards",
    first: MapObject.parse({ type: "ruin", id: "ruin-a", pos: { x: 0, y: 0 } }),
    next: MapObject.parse({ type: "ruin", id: "ruin-b", pos: { x: 1, y: 1 } }),
    select: selectDefenseObject,
  },
  { name: "map stack", first: stackA, next: stackB, select: selectStackObject },
  {
    name: "visiting stack", first: cityA, next: cityB,
    select: (object) => selectEditableVisitorStack(object, [stackA, stackB]),
  },
  {
    name: "location caption",
    first: MapObject.parse({ type: "location", id: "loc-a", pos: { x: 0, y: 0 } }),
    next: MapObject.parse({ type: "location", id: "loc-b", pos: { x: 1, y: 1 } }),
    select: selectLocationObject,
  },
];

describe.each(adapters)("$name selection adapter", ({ first, next, select }) => {
  it("rejects a stale event and accepts the newly rendered handler", () => {
    let selected: MapObject | null = first;
    const commit = vi.fn();
    const previousHandler = bindSelectionAction(() => select(selected), () => false, commit);
    selected = next;
    previousHandler();
    expect(commit).not.toHaveBeenCalled();
    const currentHandler = bindSelectionAction(() => select(selected), () => false, commit);
    currentHandler();
    expect(commit).toHaveBeenCalledWith(select(next));
  });

  it("rejects an event after deletion or deselection", () => {
    let selected: MapObject | null = first;
    const commit = vi.fn();
    const handler = bindSelectionAction(() => select(selected), () => false, commit);
    selected = null;
    handler();
    expect(commit).not.toHaveBeenCalled();
  });
});

it("never edits a capital visitor or an invalid/missing stack reference", () => {
  const capital = MapObject.parse({ type: "capital", id: "capital", stackRef: stackA.id, pos: { x: 0, y: 0 } });
  expect(selectEditableVisitorStack(capital, [stackA])).toBeNull();
  expect(selectEditableVisitorStack(cityA, [])).toBeNull();
  expect(selectEditableVisitorStack(cityA, [{ ...cityB, id: stackA.id }])).toBeNull();
});
