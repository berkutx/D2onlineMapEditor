/**
 * Semantic round-trip (validator tier 2): the bytes we exported, re-parsed, must
 * describe exactly the document our in-memory model produced from the same ops.
 * Proves the byte-writer and the logical model never drift.
 */

import { parseScenario } from "@d2/sg-parser";
import type { MapDocument, MapObject } from "@d2/map-schema";
import { applyOps } from "./ops.js";
import type { EditOp } from "./ops.js";

/**
 * Strip the entities' PERSISTENT IDENTITY attributes before comparing: key/slot on garrison
 * members, itemKeys/inventoryKeys on item lists, idMount on a mountains entry. These are minted
 * at export (like DB auto-keys) — a PLACED/edited object's reparse carries fresh ones the
 * pre-export op can't know. Everything semantic (units/levels/hp/xp/names/items/scalars) still
 * compares exactly.
 */
function stripEntityIdentity(objs: readonly MapObject[]): MapObject[] {
  return objs.map((o) => {
    const clone: Record<string, unknown> = { ...o };
    delete clone.itemKeys;
    delete clone.inventoryKeys;
    delete clone.idMount;
    const g = clone.garrison as ({ key?: string; slot?: number } | null)[] | undefined;
    if (Array.isArray(g)) {
      clone.garrison = g.map((m) => {
        if (!m) return m;
        const mc = { ...m };
        delete mc.key;
        delete mc.slot;
        return mc;
      });
    }
    return clone as unknown as MapObject;
  });
}

/** Key-order-insensitive structural equality (documents are plain JSON values). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}

/** Order-insensitive comparison keyed by id (every MapObject / MapEvent has an id). */
function equalById<T extends { id: string }>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((o) => [o.id, o]));
  for (const o of a) {
    const m = byId.get(o.id);
    if (!m || !deepEqual(o, m)) return false;
  }
  return true;
}

export interface SemanticResult {
  ok: boolean;
  reason?: string;
}

/**
 * Re-parse `writtenBytes` and compare against `applyOps(origDoc, ops)`. Ignores
 * the parser/schema version stamps (metadata, not map content).
 */
export function roundTripSemantic(
  origDoc: MapDocument,
  writtenBytes: Uint8Array,
  ops: readonly EditOp[],
): SemanticResult {
  const expected = applyOps(origDoc, ops);
  const reparsed = parseScenario(writtenBytes);

  if (!deepEqual(reparsed.terrain, expected.terrain)) {
    return { ok: false, reason: "terrain differs after round-trip" };
  }
  // Objects compared by id, ORDER-INSENSITIVELY: re-emitted blocks (e.g. an
  // appended landmark, or a rebuilt single MidMountains block) can land at a
  // different array index than applyOp's in-memory order, but the set must match.
  if (!equalById(stripEntityIdentity(reparsed.objects), stripEntityIdentity(expected.objects))) {
    return { ok: false, reason: "objects differ after round-trip" };
  }
  // Events compared by id, order-insensitively (an appended/re-emitted MidEvent can land at a
  // different index than applyOp's order). A re-emitted event that carried an unknown/custom
  // condition/effect category the reader dropped would surface here as a mismatch.
  if (!equalById(reparsed.events ?? [], expected.events ?? [])) {
    return { ok: false, reason: "events differ after round-trip" };
  }
  if (!deepEqual(reparsed.variables ?? [], expected.variables ?? [])) {
    return { ok: false, reason: "variables differ after round-trip" };
  }
  // templates: strip the on-disk slot layout (slots + slotOfCell) — an edited template re-packs
  // canonically, so its reparse can't match the pre-edit layout (the same identity-attribute
  // class as a garrison member's key/slot).
  const stripTmplLayout = <T extends { slots?: unknown; slotOfCell?: unknown }>(a: readonly T[]): T[] =>
    a.map((t) => {
      if (!("slots" in t) && !("slotOfCell" in t)) return t;
      const clone = { ...t } as Record<string, unknown>;
      delete clone.slots;
      delete clone.slotOfCell;
      return clone as unknown as T;
    });
  if (!equalById(stripTmplLayout(reparsed.templates ?? []), stripTmplLayout(expected.templates ?? []))) {
    return { ok: false, reason: "templates differ after round-trip" };
  }
  if (!deepEqual(reparsed.diplomacy ?? [], expected.diplomacy ?? [])) {
    return { ok: false, reason: "diplomacy differs after round-trip" };
  }
  if (!deepEqual(reparsed.players, expected.players)) {
    return { ok: false, reason: "players differ after round-trip" };
  }
  if (!deepEqual(reparsed.header, expected.header)) {
    return { ok: false, reason: "header differs after round-trip" };
  }
  return { ok: true };
}
