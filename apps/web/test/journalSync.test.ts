import { describe, expect, it } from "vitest";
import { emptyProject, ensureOpUids, pushCommit, undo } from "@d2/map-edit";
import type { EditOp } from "@d2/socket-contract";
import { pendingJournalEntries } from "../src/services/journalSync";

const cell = (x: number): EditOp => ({ kind: "setCell", x, y: 0, value: 1 });

describe("pending journal synchronization", () => {
  it("filters acknowledged operations without shifting their identities", () => {
    let project = pushCommit(emptyProject("map1"), [cell(1), cell(2)], ["u1", "u2"]);
    project = pushCommit(project, [cell(3), cell(4)], ["u3", "u4"]);
    const known = new Set(["u1", "u3"]);
    const pending = pendingJournalEntries(project, known);
    expect(pending).toEqual([{ op: cell(2), uid: "u2" }, { op: cell(4), uid: "u4" }]);
    // Reopening/retrying before the ack retains the persisted clientOpIds.
    expect(pendingJournalEntries(project, known)).toEqual(pending);
    for (const entry of pending) known.add(entry.uid);
    expect(pendingJournalEntries(project, known)).toEqual([]);
  });

  it("does not send the redo tail and keeps subsequent replacement identities aligned", () => {
    let project = pushCommit(emptyProject("map1"), [cell(1)], ["u1"]);
    project = pushCommit(project, [cell(2)], ["u2"]);
    project = undo(project);
    expect(pendingJournalEntries(project, new Set())).toEqual([{ op: cell(1), uid: "u1" }]);
    project = pushCommit(project, [cell(3)], ["u3"]);
    expect(pendingJournalEntries(project, new Set(["u1"]))).toEqual([{ op: cell(3), uid: "u3" }]);
  });

  it("requires legacy IDs to be persisted once rather than minting new IDs on every retry", () => {
    const legacy = pushCommit(emptyProject("map1"), [cell(1), cell(2)]);
    expect(() => pendingJournalEntries(legacy, new Set())).toThrow("no persisted UID");
    let next = 0;
    const project = ensureOpUids(legacy, () => `legacy-${++next}`);
    const first = pendingJournalEntries(project, new Set());
    expect(first.map((entry) => entry.uid)).toEqual(["legacy-1", "legacy-2"]);
    expect(ensureOpUids(project, () => `unexpected-${++next}`)).toBe(project);
    expect(pendingJournalEntries(project, new Set())).toEqual(first);
    expect(next).toBe(2);
  });
});
