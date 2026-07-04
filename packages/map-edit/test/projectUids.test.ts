/**
 * Per-op uid tracking in the EditorProject journal — the dedup base for collab room-log
 * replays (fresh join / second tab / reconnect). Regression for the prod crash
 * «applyOp addObject: id … already exists»: ops sent to the room AND held in the local
 * journal must be recognizable (by uid) so the client skips re-applying them.
 */

import { describe, it, expect } from "vitest";
import type { EditOp } from "@d2/socket-contract";
import {
  emptyProject,
  pushCommit,
  undo,
  allOpUids,
  activeOpUids,
  activeOps,
  ensureOpUids,
  deserializeProject,
  serializeProject,
} from "../src/project.js";

const cellOp = (x: number): EditOp => ({ kind: "setCell", x, y: 0, value: 1 });

describe("journal op uids", () => {
  it("pushCommit stores uids parallel to ops; allOpUids/activeOpUids expose them", () => {
    let p = emptyProject("map1");
    p = pushCommit(p, [cellOp(1), cellOp(2)], ["u1", "u2"]);
    p = pushCommit(p, [cellOp(3)], ["u3"]);
    expect([...allOpUids(p)].sort()).toEqual(["u1", "u2", "u3"]);
    expect(activeOpUids(p)).toEqual(["u1", "u2", "u3"]);
    expect(activeOps(p)).toHaveLength(3);
  });

  it("dropping the redo tail drops its uids too (journal и opUids не расходятся)", () => {
    let p = emptyProject("map1");
    p = pushCommit(p, [cellOp(1)], ["u1"]);
    p = pushCommit(p, [cellOp(2)], ["u2"]);
    p = undo(p);
    p = pushCommit(p, [cellOp(3)], ["u3"]); // replaces the undone commit
    expect(p.journal).toHaveLength(2);
    expect(p.opUids).toHaveLength(2);
    expect([...allOpUids(p)].sort()).toEqual(["u1", "u3"]);
  });

  it("undone-but-known uids stay in allOpUids (sent ops must dedup even past the cursor)", () => {
    let p = emptyProject("map1");
    p = pushCommit(p, [cellOp(1)], ["u1"]);
    p = undo(p);
    expect(activeOpUids(p)).toEqual([]); // not active…
    expect(allOpUids(p).has("u1")).toBe(true); // …but still known
  });

  it("ensureOpUids backfills legacy commits and leaves complete ones untouched", () => {
    let p = emptyProject("map1");
    p = pushCommit(p, [cellOp(1), cellOp(2)]); // legacy: no uids
    p = pushCommit(p, [cellOp(3)], ["u3"]);
    let n = 0;
    const filled = ensureOpUids(p, () => `gen${++n}`);
    expect(filled).not.toBe(p); // changed → new object
    expect(activeOpUids(filled)).toEqual(["gen1", "gen2", "u3"]);
    // already complete → same object back
    expect(ensureOpUids(filled, () => "nope")).toBe(filled);
  });

  it("a legacy serialized project (no opUids key) still parses; uids default empty", () => {
    let p = emptyProject("map1");
    p = pushCommit(p, [cellOp(1)], ["u1"]);
    const json = JSON.parse(serializeProject(p)) as Record<string, unknown>;
    delete json.opUids; // simulate a project saved by a pre-uid build
    const revived = deserializeProject(JSON.stringify(json));
    expect(revived.journal).toHaveLength(1);
    expect(allOpUids(revived).size).toBe(0);
    expect(activeOpUids(revived)).toEqual([""]); // gap, parallel to the op
  });
});
