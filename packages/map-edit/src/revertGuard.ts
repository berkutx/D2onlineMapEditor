/**
 * revertGuard — the PURE core of the conflict-aware cherry-pick revert («только это»),
 * shared by the client (history rows) and the server (authoritative room-log check).
 *
 * Two independent layers, both required:
 *
 *  1. `laterTouching` — the DEPENDENTS guard. Ripping an entry out of the middle of the
 *     timeline is only safe when NOTHING later touches the same cells/objects; otherwise
 *     applying the old inverse silently clobbers the newer edits (a patch/move clobber
 *     yields a perfectly VALID document, so no validator can catch it — only ordering can).
 *     Items must be given in APPLICATION order — the order their effects entered the doc.
 *
 *  2. `newStructuralIssues` — the STRUCTURE guard. Key-disjoint entries can still break the
 *     map when reverted: reverting an addObject re-frees a cell a later building landed on,
 *     reverting a delete re-adds an object a later event started referencing, etc. Simulate
 *     the revert and report only NEW problems (baseline-subtracted, so pre-existing warnings
 *     on a shipped map never block).
 */

import type { MapDocument } from "@d2/map-schema";
import type { EditOp } from "@d2/socket-contract";
import { opKeys } from "./diff.js";
import { occupancyErrors, validateMechanics } from "./mechanics.js";

/** Union of `opKeys` over a list of ops (a batch's full conflict-key set). */
export function keysOfOps(ops: readonly EditOp[]): Set<string> {
  const out = new Set<string>();
  for (const op of ops) for (const k of opKeys(op)) out.add(k);
  return out;
}

/**
 * Indices of the items that BLOCK a cherry-pick revert of `targetIdxs`: every non-target
 * item positioned after the FIRST target index that shares a conflict key with the target's
 * union key set. Counting from the first (not last) target index also covers entries
 * interleaved INTO a multi-item target (a batch). Items are `{keys}` in application order.
 */
export function laterTouching(
  itemKeys: readonly (readonly string[])[],
  targetIdxs: ReadonlySet<number>,
): number[] {
  let first = -1;
  const targetKeys = new Set<string>();
  for (const i of targetIdxs) {
    if (first === -1 || i < first) first = i;
    for (const k of itemKeys[i] ?? []) targetKeys.add(k);
  }
  if (first === -1) return [];
  const out: number[] = [];
  for (let j = first + 1; j < itemKeys.length; j++) {
    if (targetIdxs.has(j)) continue;
    for (const k of itemKeys[j] ?? []) {
      if (targetKeys.has(k)) {
        out.push(j);
        break;
      }
    }
  }
  return out;
}

/** Ref fields an event condition/effect may carry — the TYPED probe set for dangling refs.
 *  (A substring scan would false-block on free text that happens to equal an id.) Includes
 *  `templateId` (spawn effect) and `eventId` (enable/disable effect) — reverting a template's
 *  or an event's CREATION is exactly the case that leaves these dangling. Player refs are NOT
 *  probed: players live in doc.players, no EditOp can remove one, so a player ref can never
 *  dangle because of a revert — probing them only false-blocked safe reverts. */
const EVENT_REF_FIELDS = [
  "locId", "cityId", "stackId", "siteId", "ruinId", "lmarkId",
  "orderTarget", "stackTmpId", "templateId", "eventId",
] as const;

const NULL_ID = "G000000000";

/**
 * Dangling references in a doc: an event condition/effect or a city's visitor stack pointing
 * at an object/template/event that no longer exists. Pure and typed — used by the structure
 * guard on both sides (and by nothing else: the byte-level tier-3 validator has its own).
 */
export function danglingRefs(doc: MapDocument): string[] {
  const ids = new Set(doc.objects.map((o) => o.id));
  const tmplIds = new Set((doc.templates ?? []).map((t) => t.id));
  const evtIds = new Set((doc.events ?? []).map((e) => e.id));
  const known = (v: string): boolean => ids.has(v) || tmplIds.has(v) || evtIds.has(v);
  const out: string[] = [];
  for (const o of doc.objects) {
    const ref = (o as { stackRef?: string }).stackRef;
    if (ref && ref !== NULL_ID && !ids.has(ref)) {
      out.push(`висячая ссылка: гость города ${o.id} → нет ${ref}`);
    }
  }
  for (const ev of doc.events ?? []) {
    for (const part of [...ev.conditions, ...ev.effects] as Record<string, unknown>[]) {
      for (const k of EVENT_REF_FIELDS) {
        const v = part[k];
        if (typeof v === "string" && v && v !== NULL_ID && !known(v)) {
          out.push(`висячая ссылка: событие ${ev.id} → нет ${v}`);
        }
      }
      // changeFog carries NESTED refs: entries[] = {eventId, player} — the flat probe above
      // cannot see them (the value is an array, not a string).
      const nested = part.entries;
      if (Array.isArray(nested)) {
        for (const en of nested as { eventId?: unknown }[]) {
          const v = en?.eventId;
          if (typeof v === "string" && v && v !== NULL_ID && !known(v)) {
            out.push(`висячая ссылка: событие ${ev.id} → нет ${v}`);
          }
        }
      }
    }
  }
  return out;
}

/** Every structural complaint about a doc (occupancy + mechanics + dangling refs). */
function structuralIssues(doc: MapDocument): string[] {
  return [...occupancyErrors(doc), ...validateMechanics(doc), ...danglingRefs(doc)];
}

/**
 * Structural problems `after` has that `before` does not — the baseline-subtracted verdict
 * of a simulated revert. Empty = the reverted state is no worse than the current one
 * (pre-existing issues on a shipped map never block a revert).
 */
export function newStructuralIssues(before: MapDocument, after: MapDocument): string[] {
  const baseline = new Set(structuralIssues(before));
  return structuralIssues(after).filter((m) => !baseline.has(m));
}
