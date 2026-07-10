/**
 * revertGuard — the pure core of the cherry-pick revert guard shared by client and server.
 * Covers the review's failure classes: tie/interleave ordering (laterTouching is pure array
 * order — no seq involved), batch targets with interleaved entries, empty-inverse batches
 * (keys from ALL ops via keysOfOps), typed dangling refs incl. templateId/eventId + nested
 * changeFog entries (and NO player false-blocks), and baseline-subtracted structure issues.
 */

import { describe, it, expect } from "vitest";
import type { MapDocument } from "@d2/map-schema";
import {
  keysOfOps, laterTouching, danglingRefs, newStructuralIssues, applyOps, opKeys, type EditOp,
} from "@d2/map-edit";

const setCell = (x: number, y: number, value = 1): EditOp => ({ kind: "setCell", x, y, value });
const patch = (id: string): EditOp => ({ kind: "patchObject", id, fields: { name: "n" } });

function blankDoc(n = 6): MapDocument {
  const cells = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      cells.push({ x, y, value: 0, terrain: 0, ground: 0, forest: 0, roadType: -1, roadVar: -1 });
  return {
    name: "t", size: n, players: 0, version: "S143",
    terrain: { size: n, cells }, objects: [], events: [], templates: [],
  } as unknown as MapDocument;
}

describe("keysOfOps", () => {
  it("unions keys over every op — an empty-inverse batch is still fully covered", () => {
    const keys = keysOfOps([setCell(1, 1), setCell(2, 2), patch("KC000001")]);
    expect(keys).toEqual(new Set(["1,1", "2,2", "O:KC000001"]));
  });
});

describe("laterTouching", () => {
  const keysOf = (ops: EditOp[][]): string[][] => ops.map((o) => o.flatMap(opKeys));

  it("flags a later same-key item and ignores earlier/disjoint ones", () => {
    const items = keysOf([[setCell(0, 0)], [setCell(1, 1)], [setCell(0, 0)], [setCell(2, 2)]]);
    expect(laterTouching(items, new Set([0]))).toEqual([2]); // only the later (0,0)
    expect(laterTouching(items, new Set([2]))).toEqual([]); // nothing after touches (0,0)
  });

  it("ADJACENT items count — pure array order, no seq tie-break to hide behind", () => {
    // the review's provisional-seq case: two in-flight strokes on the same cell — the second
    // must block a revert of the first no matter what seq either row carries
    const items = keysOf([[setCell(5, 5)], [setCell(5, 5)]]);
    expect(laterTouching(items, new Set([0]))).toEqual([1]);
  });

  it("a batch target counts entries interleaved INTO it (after its FIRST index)", () => {
    // target = items 0 and 2 (one batch); item 1 sits between them and shares a key
    const items = keysOf([[setCell(0, 0)], [setCell(0, 0)], [setCell(3, 3)]]);
    expect(laterTouching(items, new Set([0, 2]))).toEqual([1]);
  });

  it("target items never report themselves; empty target → empty result", () => {
    const items = keysOf([[setCell(0, 0)], [setCell(0, 0)]]);
    expect(laterTouching(items, new Set([0, 1]))).toEqual([]);
    expect(laterTouching(items, new Set())).toEqual([]);
  });
});

describe("danglingRefs", () => {
  it("flags an event effect at a missing template (templateId) and a missing event (eventId)", () => {
    const doc = blankDoc();
    (doc.events as unknown[]).push({
      id: "EV0001", name: "e", conditions: [],
      effects: [{ kind: "createStack", templateId: "TMPL0001" }, { kind: "enableEvent", eventId: "EV9999" }],
    });
    const refs = danglingRefs(doc);
    expect(refs.some((r) => r.includes("TMPL0001"))).toBe(true);
    expect(refs.some((r) => r.includes("EV9999"))).toBe(true);
  });

  it("sees NESTED changeFog entries[].eventId (an array value the flat probe cannot)", () => {
    const doc = blankDoc();
    (doc.events as unknown[]).push({
      id: "EV0001", name: "e", conditions: [],
      effects: [{ kind: "changeFog", entries: [{ eventId: "EV4242", player: "P1" }] }],
    });
    expect(danglingRefs(doc).some((r) => r.includes("EV4242"))).toBe(true);
  });

  it("does NOT false-block on player refs (players are not op-deletable) or free text", () => {
    const doc = blankDoc();
    (doc.events as unknown[]).push({
      id: "EV0001", name: "e", conditions: [],
      effects: [{ kind: "winLose", win: true, player: "P0000001", text: "KC000001 упоминается в тексте" }],
    });
    expect(danglingRefs(doc)).toEqual([]);
  });

  it("resolves refs that DO exist (object / template / event / null sentinel)", () => {
    const doc = blankDoc();
    (doc.objects as unknown[]).push({ id: "KC000001", type: "stack", pos: { x: 0, y: 0 } });
    (doc.templates as unknown[]).push({ id: "TMPL0001", units: [], leader: "" });
    (doc.events as unknown[]).push({
      id: "EV0001", name: "e",
      conditions: [{ kind: "visitLocation", stackId: "KC000001" }],
      effects: [
        { kind: "createStack", templateId: "TMPL0001" },
        { kind: "enableEvent", eventId: "EV0001" },
        { kind: "captureCity", cityId: "G000000000" },
      ],
    });
    expect(danglingRefs(doc)).toEqual([]);
  });
});

describe("newStructuralIssues", () => {
  it("empty when nothing changed", () => {
    const doc = blankDoc();
    expect(newStructuralIssues(doc, doc)).toEqual([]);
  });

  it("reports a NEW dangling ref the revert would introduce", () => {
    // head: template + event referencing it; target (revert of the template's creation): no template
    const head = blankDoc();
    (head.templates as unknown[]).push({ id: "TMPL0001", units: [], leader: "" });
    (head.events as unknown[]).push({
      id: "EV0001", name: "e", conditions: [], effects: [{ kind: "createStack", templateId: "TMPL0001" }],
    });
    const target = applyOps(head, [{ kind: "deleteTemplate", id: "TMPL0001" } as EditOp]);
    const issues = newStructuralIssues(head, target);
    expect(issues.some((m) => m.includes("TMPL0001"))).toBe(true);
  });

  it("baseline-subtracted: a PRE-EXISTING issue never blocks", () => {
    // both head and target carry the same dangling ref — the revert makes nothing worse
    const head = blankDoc();
    (head.events as unknown[]).push({
      id: "EV0001", name: "e", conditions: [], effects: [{ kind: "enableEvent", eventId: "EV9999" }],
    });
    const target = applyOps(head, [setCell(1, 1, 3)]);
    expect(newStructuralIssues(head, target)).toEqual([]);
  });
});
