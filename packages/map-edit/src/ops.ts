/**
 * In-memory application of an EditOp (Contract C) to a MapDocument, returning a
 * NEW document plus the INVERSE op (for undo). Pure: inputs are never mutated.
 *
 * This is the editor's logical model. The matching byte-level write lives in
 * applyBytes.ts; the two are kept consistent by the semantic round-trip check.
 */

import type { MapDocument, MapObject, MapCell } from "@d2/map-schema";
import { MapEvent } from "@d2/map-schema";
import { EditOp } from "@d2/socket-contract";
import { makeCell } from "./bits.js";

export { EditOp };

export interface AppliedOp {
  doc: MapDocument;
  /** The op that, applied to `doc`, restores the input document. */
  inverse: EditOp;
}

function replaceCell(doc: MapDocument, idx: number, cell: MapCell): MapDocument {
  const cells = doc.terrain.cells.slice();
  cells[idx] = cell;
  return { ...doc, terrain: { ...doc.terrain, cells } };
}

function replaceObjects(doc: MapDocument, objects: MapObject[]): MapDocument {
  return { ...doc, objects };
}

/** Apply one op; throw (fail loud) on anything malformed rather than guessing. */
export function applyOp(doc: MapDocument, op: EditOp): AppliedOp {
  switch (op.kind) {
    case "setCell": {
      const { x, y } = op;
      if (x < 0 || y < 0 || x >= doc.size || y >= doc.size) {
        throw new Error(`applyOp setCell: (${x},${y}) out of bounds for size ${doc.size}`);
      }
      const idx = y * doc.size + x;
      const prev = doc.terrain.cells[idx];
      if (!prev) throw new Error(`applyOp setCell: no cell at (${x},${y})`);
      const roadType = op.roadType ?? prev.roadType;
      const roadVar = op.roadVar ?? prev.roadVar;
      const next = makeCell(x, y, op.value, roadType, roadVar);
      const inverse: EditOp = {
        kind: "setCell",
        x,
        y,
        value: prev.value,
        roadType: prev.roadType,
        roadVar: prev.roadVar,
      };
      return { doc: replaceCell(doc, idx, next), inverse };
    }

    case "moveObject": {
      const objects = doc.objects.slice();
      const i = objects.findIndex((o) => o.id === op.id);
      if (i < 0) throw new Error(`applyOp moveObject: unknown object ${op.id}`);
      const obj = objects[i]!;
      const inverse: EditOp = { kind: "moveObject", id: op.id, x: obj.pos.x, y: obj.pos.y };
      objects[i] = { ...obj, pos: { x: op.x, y: op.y } };
      return { doc: replaceObjects(doc, objects), inverse };
    }

    case "patchObject": {
      const objects = doc.objects.slice();
      const i = objects.findIndex((o) => o.id === op.id);
      if (i < 0) throw new Error(`applyOp patchObject: unknown object ${op.id}`);
      const obj = objects[i]! as Record<string, unknown>;
      const prevFields: Record<string, unknown> = {};
      for (const k of Object.keys(op.fields)) prevFields[k] = obj[k];
      objects[i] = { ...(obj as object), ...op.fields } as MapObject;
      const inverse: EditOp = { kind: "patchObject", id: op.id, fields: prevFields };
      return { doc: replaceObjects(doc, objects), inverse };
    }

    case "addObject": {
      if (doc.objects.some((o) => o.id === op.object.id)) {
        throw new Error(`applyOp addObject: id ${op.object.id} already exists`);
      }
      const objects = doc.objects.concat(op.object);
      const inverse: EditOp = { kind: "deleteObject", id: op.object.id };
      return { doc: replaceObjects(doc, objects), inverse };
    }

    case "deleteObject": {
      const i = doc.objects.findIndex((o) => o.id === op.id);
      if (i < 0) throw new Error(`applyOp deleteObject: unknown object ${op.id}`);
      const removed = doc.objects[i]!;
      const objects = doc.objects.slice();
      objects.splice(i, 1);
      const inverse: EditOp = { kind: "addObject", object: removed };
      return { doc: replaceObjects(doc, objects), inverse };
    }

    case "upsertEvent": {
      const events = (doc.events ?? []).slice();
      const i = events.findIndex((e) => e.id === op.event.id);
      const inverse: EditOp =
        i < 0
          ? { kind: "deleteEvent", id: op.event.id }
          : { kind: "upsertEvent", event: events[i]! };
      // Normalize through Contract A: fields absent in the op (older journals / peers on an
      // older spec) get their schema defaults — matching what the byte codec writes for an
      // absent tag, so the semantic round-trip compares like with like.
      const ev = MapEvent.parse(op.event);
      if (i < 0) events.push(ev);
      else events[i] = ev;
      return { doc: { ...doc, events }, inverse };
    }

    case "deleteEvent": {
      const events = (doc.events ?? []).slice();
      const i = events.findIndex((e) => e.id === op.id);
      if (i < 0) throw new Error(`applyOp deleteEvent: unknown event ${op.id}`);
      const removed = events[i]!;
      events.splice(i, 1);
      const inverse: EditOp = { kind: "upsertEvent", event: removed };
      return { doc: { ...doc, events }, inverse };
    }

    case "setVariables": {
      const inverse: EditOp = { kind: "setVariables", variables: doc.variables ?? [] };
      return { doc: { ...doc, variables: op.variables.slice() }, inverse };
    }

    case "upsertTemplate": {
      const templates = (doc.templates ?? []).slice();
      const i = templates.findIndex((t) => t.id === op.template.id);
      const inverse: EditOp =
        i < 0
          ? { kind: "deleteTemplate", id: op.template.id }
          : { kind: "upsertTemplate", template: templates[i]! };
      if (i < 0) templates.push(op.template);
      else templates[i] = op.template;
      return { doc: { ...doc, templates }, inverse };
    }

    case "deleteTemplate": {
      const templates = (doc.templates ?? []).slice();
      const i = templates.findIndex((t) => t.id === op.id);
      if (i < 0) throw new Error(`applyOp deleteTemplate: unknown template ${op.id}`);
      const removed = templates[i]!;
      templates.splice(i, 1);
      const inverse: EditOp = { kind: "upsertTemplate", template: removed };
      return { doc: { ...doc, templates }, inverse };
    }

    case "setScenarioInfo": {
      const header = doc.header as unknown as Record<string, unknown>;
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(op.fields)) {
        // JSON drops undefined on journal serialization, which would turn the inverse into a
        // no-op for that key — materialize the reader's defaults instead (texts are "").
        const v = header[k];
        prev[k] = v !== undefined ? v
          : ["name", "description", "author", "objective", "story", "winText", "loseText"].includes(k) ? ""
          : v;
      }
      const inverse: EditOp = { kind: "setScenarioInfo", fields: prev as typeof op.fields };
      return { doc: { ...doc, header: { ...doc.header, ...op.fields } }, inverse };
    }

    case "setDiplomacy": {
      const inverse: EditOp = { kind: "setDiplomacy", diplomacy: doc.diplomacy ?? [] };
      return { doc: { ...doc, diplomacy: op.diplomacy.slice() }, inverse };
    }
  }
}

/** Apply a sequence of ops, returning the final document. */
export function applyOps(doc: MapDocument, ops: readonly EditOp[]): MapDocument {
  let d = doc;
  for (const op of ops) d = applyOp(d, op).doc;
  return d;
}

/**
 * Build the FORWARD ops that undo `ops` when applied to `doc` — i.e. each op's inverse,
 * in reverse order. Used by collaboration: an undo / history-revert is sent to peers as a
 * normal forward edit (append-inverse model), never as a history rewind. `doc` must be the
 * state the ops were last applied to (their inverses are computed against the walk).
 */
export function invertOps(doc: MapDocument, ops: readonly EditOp[]): EditOp[] {
  let d = doc;
  const inverses: EditOp[] = [];
  for (const op of ops) {
    const applied = applyOp(d, op);
    inverses.push(applied.inverse);
    d = applied.doc;
  }
  return inverses.reverse();
}

/**
 * Fold add→delete pairs out of an op sequence: when an object is ADDED by these ops and later
 * DELETED by them (the collab append-inverse undo of a placement emits exactly that), drop the
 * addObject, the deleteObject, and every op targeting that id in between. Semantics-preserving
 * for applyOps (the object ends up not existing either way) — and REQUIRED for the byte writer,
 * which cannot delete pre-existing blocks (M4 mid-stream splice) but trivially "deletes" a
 * never-appended one. deleteObject of a BASE object (no matching add) is left as-is so the
 * writer still fails loudly on the genuinely unsupported case.
 */
export function foldOps(ops: readonly EditOp[]): EditOp[] {
  const out: (EditOp | null)[] = ops.slice();
  const pendingAdd = new Map<string, number>(); // object id -> index of its addObject
  for (let i = 0; i < out.length; i++) {
    const op = out[i];
    if (!op) continue;
    if (op.kind === "addObject") {
      pendingAdd.set(op.object.id, i);
    } else if (op.kind === "deleteObject") {
      const ai = pendingAdd.get(op.id);
      if (ai !== undefined) {
        for (let j = ai; j <= i; j++) {
          const o = out[j];
          if (!o) continue;
          if (
            (o.kind === "addObject" && o.object.id === op.id) ||
            ((o.kind === "moveObject" || o.kind === "patchObject" || o.kind === "deleteObject") &&
              o.id === op.id)
          ) {
            out[j] = null;
          }
        }
        pendingAdd.delete(op.id);
      }
    }
  }
  return out.filter((o): o is EditOp => o !== null);
}
