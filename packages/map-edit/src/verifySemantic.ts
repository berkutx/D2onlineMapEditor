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
 * A compound object's load-only `raw` snapshot (minted UNIT_/POS_/LEADER_ID/ITEM_ID refs) is an
 * EXPORT artifact, not semantic content: a PLACED/edited stack/village/ruin/bag mints fresh
 * instance ids at export, so its reparse can never match the pre-export op. Drop it before the
 * id-keyed comparison — the resolved garrison/leader/inventory/scalars still compare exactly.
 */
function stripStackRaw(objs: readonly MapObject[]): MapObject[] {
  return objs.map((o) => {
    // `idMount` on a mountains entry is the same kind of export artifact (a placed entry is
    // numbered at export), so drop it alongside `raw`.
    if (!("raw" in o) && !(o.type === "mountains" && "idMount" in o)) return o;
    const clone: Record<string, unknown> = { ...o };
    delete clone.raw;
    delete clone.idMount;
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
  if (!equalById(stripStackRaw(reparsed.objects), stripStackRaw(expected.objects))) {
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
  // templates: strip the load-only verbatim slot layout (an edited template re-packs canonically,
  // so its reparse can't match the pre-edit raw — same artifact class as a stack's `raw`).
  const stripTmplRaw = <T extends { raw?: unknown }>(a: readonly T[]): T[] =>
    a.map((t) => {
      if (!("raw" in t)) return t;
      const clone = { ...t } as Record<string, unknown>;
      delete clone.raw;
      return clone as unknown as T;
    });
  if (!equalById(stripTmplRaw(reparsed.templates ?? []), stripTmplRaw(expected.templates ?? []))) {
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
