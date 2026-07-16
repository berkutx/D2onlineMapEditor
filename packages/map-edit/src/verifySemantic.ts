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
/** Render-DERIVED fields the reader computes at parse (race from the owner player's Grace race,
 *  bannerIndex from the subrace, image/footprint/z/looter from catalogs) — never persisted, never
 *  carried by an EditOp, so the byte writer omits them (its own DERIVED set). A freshly PLACED
 *  object whose op omits them still reparses WITH them (derived from its owner/subrace), so the
 *  semantic round-trip must ignore them. Stripping is a no-op for original objects (both sides
 *  derive identically). */
const DERIVED_FIELDS = ["race", "bannerIndex", "imageName", "footprint", "z", "looted", "leaderImage"] as const;

function stripEntityIdentity(objs: readonly MapObject[]): MapObject[] {
  return objs.map((o) => {
    const clone: Record<string, unknown> = { ...o };
    delete clone.itemKeys;
    delete clone.inventoryKeys;
    delete clone.idMount;
    for (const f of DERIVED_FIELDS) delete clone[f];
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
  return firstDiff(a, b) === null;
}

/** The FIRST structural difference between two JSON values, as a dotted/indexed path plus both
 *  sides (`a` = expected/model, `b` = got/after-export). `null` ⇒ deeply equal. Key-order-
 *  insensitive, mirroring `deepEqual`. This is what turns a useless "objects differ" into an
 *  actionable "object X at garrison[3].unit: expected … got …". */
export function firstDiff(a: unknown, b: unknown, path = "", depth = 0): { path: string; a: unknown; b: unknown } | null {
  if (a === b) return null;
  // Depth backstop: MapDocument trees nest <~20 levels; a value this deep can only be a pathological
  // cycle (never produced by parseScenario/applyOps). Bail as "differs here" rather than overflow the
  // stack and crash the validator with no report.
  if (depth > 256) return { path, a, b };
  if (typeof a !== typeof b) return { path, a, b };
  if (a === null || b === null) return { path, a, b };
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return { path, a, b };
    if (a.length !== b.length) return { path: `${path}.length`, a: a.length, b: b.length };
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`, depth + 1);
      if (d) return d;
    }
    return null;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    // union of keys so a key PRESENT on one side and ABSENT on the other is reported (not skipped)
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      const kp = path ? `${path}.${k}` : k;
      const inA = Object.prototype.hasOwnProperty.call(ao, k);
      const inB = Object.prototype.hasOwnProperty.call(bo, k);
      if (inA !== inB) return { path: kp, a: inA ? ao[k] : undefined, b: inB ? bo[k] : undefined };
      const d = firstDiff(ao[k], bo[k], kp, depth + 1);
      if (d) return d;
    }
    return null;
  }
  return { path, a, b };
}

/** Compact one-line rendering of a JSON value for a diff message (never floods the reason). */
function briefVal(v: unknown): string {
  if (v === undefined) return "(нет поля)";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v.length > 48 ? `${v.slice(0, 48)}…` : v);
  if (typeof v === "object") {
    // Never let a message-formatting edge (a BigInt leaf or cycle the schema might one day admit)
    // throw out of the validator — the reason string is diagnostic, not load-bearing.
    let s: string;
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      return "[объект]";
    }
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  }
  return String(v);
}

/** Precise reason for two id-keyed collections (objects / events / templates). `a` = expected
 *  (model), `b` = got (re-parsed export). Names the first offending id + field path + values,
 *  or (on a count mismatch) which id was dropped/added. `null` ⇒ equal. */
function diffById<T extends { id: string }>(a: readonly T[], b: readonly T[], noun: string): string | null {
  if (a.length !== b.length) {
    const aIds = new Set(a.map((o) => o.id));
    const bIds = new Set(b.map((o) => o.id));
    const dropped = a.find((o) => !bIds.has(o.id)); // in model, missing after export
    const added = b.find((o) => !aIds.has(o.id)); // appeared after export, not in model
    const tail = dropped
      ? `, пропал ${dropped.id}`
      : added
        ? `, лишний ${added.id}`
        : "";
    return `${noun}: в модели ${a.length}, после экспорта ${b.length}${tail}`;
  }
  const byId = new Map(b.map((o) => [o.id, o]));
  for (const o of a) {
    const m = byId.get(o.id);
    if (!m) return `${noun} ${o.id} пропал после экспорта`;
    const d = firstDiff(o, m);
    if (d) return `${noun} ${o.id}: ${d.path || "(корень)"} — ожидалось ${briefVal(d.a)}, получено ${briefVal(d.b)}`;
  }
  return null;
}

/** Precise reason for a plain (positional) JSON value. `a` = expected (model), `b` = got. */
function diffScalar(a: unknown, b: unknown, noun: string): string | null {
  const d = firstDiff(a, b);
  if (!d) return null;
  return `${noun}: ${d.path || "(корень)"} — ожидалось ${briefVal(d.a)}, получено ${briefVal(d.b)}`;
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
  const expected = applyOps(origDoc, ops); // the model = source of truth ("expected")
  const reparsed = parseScenario(writtenBytes); // what the exported bytes decode to ("got")

  const terrain = diffScalar(expected.terrain, reparsed.terrain, "рельеф");
  if (terrain) return { ok: false, reason: terrain };
  // Objects compared by id, ORDER-INSENSITIVELY: re-emitted blocks (e.g. an
  // appended landmark, or a rebuilt single MidMountains block) can land at a
  // different array index than applyOp's in-memory order, but the set must match.
  const objects = diffById(stripEntityIdentity(expected.objects), stripEntityIdentity(reparsed.objects), "объект");
  if (objects) return { ok: false, reason: objects };
  // Events compared by id, order-insensitively (an appended/re-emitted MidEvent can land at a
  // different index than applyOp's order). A re-emitted event that carried an unknown/custom
  // condition/effect category the reader dropped would surface here as a mismatch.
  const events = diffById(expected.events ?? [], reparsed.events ?? [], "событие");
  if (events) return { ok: false, reason: events };
  const variables = diffScalar(expected.variables ?? [], reparsed.variables ?? [], "переменные");
  if (variables) return { ok: false, reason: variables };
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
  const templates = diffById(
    stripTmplLayout(expected.templates ?? []),
    stripTmplLayout(reparsed.templates ?? []),
    "шаблон",
  );
  if (templates) return { ok: false, reason: templates };
  const diplomacy = diffScalar(expected.diplomacy ?? [], reparsed.diplomacy ?? [], "дипломатия");
  if (diplomacy) return { ok: false, reason: diplomacy };
  const players = diffScalar(expected.players, reparsed.players, "игроки");
  if (players) return { ok: false, reason: players };
  const header = diffScalar(expected.header, reparsed.header, "заголовок");
  if (header) return { ok: false, reason: header };
  return { ok: true };
}
