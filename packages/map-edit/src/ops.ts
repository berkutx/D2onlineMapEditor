/**
 * In-memory application of an EditOp (Contract C) to a MapDocument, returning a
 * NEW document plus the INVERSE op (for undo). Pure: inputs are never mutated.
 *
 * This is the editor's logical model. The matching byte-level write lives in
 * applyBytes.ts; the two are kept consistent by the semantic round-trip check.
 */

import type { MapDocument, MapObject, MapCell } from "@d2/map-schema";
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
