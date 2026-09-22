import type { MapObject } from "@d2/map-schema";

type SiteObject = Extract<MapObject, { type: "merchant" | "mage" | "trainer" | "mercenary" }>;
type DefenseObject = Extract<MapObject, { type: "capital" | "village" | "ruin" }>;

export function isSiteObject(object: MapObject): object is SiteObject {
  return object.type === "merchant" || object.type === "mage" ||
    object.type === "trainer" || object.type === "mercenary";
}

export function isDefenseObject(object: MapObject): object is DefenseObject {
  return object.type === "capital" || object.type === "village" || object.type === "ruin";
}

export function selectDefenseObject(object: MapObject | null): DefenseObject | null {
  return object && isDefenseObject(object) ? object : null;
}

export function selectStackObject(object: MapObject | null): Extract<MapObject, { type: "stack" }> | null {
  return object?.type === "stack" ? object : null;
}

export function selectLocationObject(object: MapObject | null): Extract<MapObject, { type: "location" }> | null {
  return object?.type === "location" ? object : null;
}

/** The capital's visitor is chosen in-game, so only a village's visiting army is editable. */
export function selectEditableVisitorStack(object: MapObject | null, objects: readonly MapObject[]) {
  if (object?.type !== "village" || !object.stackRef) return null;
  return selectStackObject(objects.find((candidate) => candidate.id === object.stackRef) ?? null);
}

/** An obsolete picker must never write into a newly selected object. Resolve the live
 * object on invocation, retaining other participants' edits instead of a rendered snapshot. */
export function bindSelectionAction<T extends { id: string }, Args extends unknown[]>(
  selected: () => T | null,
  readOnly: () => boolean,
  action: (object: T, ...args: Args) => void,
): (...args: Args) => void {
  const renderedId = selected()?.id;
  return (...args) => {
    const object = selected();
    if (readOnly() || !object || object.id !== renderedId) return;
    action(object, ...args);
  };
}
