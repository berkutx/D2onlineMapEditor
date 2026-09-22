import { describe, expect, it } from "vitest";
import { MapDocument } from "@d2/map-schema";
import { applyOp } from "../src/ops";
import { makeCell } from "../src/bits";
import type { EditOp } from "@d2/map-edit";
import { PlayerRosterConflictError, RACES } from "../src/playerRoster";

const races = [RACES.empire, RACES.clans, RACES.legions, RACES.undead];

function fixture(): MapDocument {
  return MapDocument.parse({
    schemaVersion: "0.3",
    size: 8,
    header: { size: 8, version: "S143", playerSlots: [...races.map((r) => r.raceType), ...Array<number>(9).fill(99)] },
    terrain: {
      size: 8,
      cells: Array.from({ length: 64 }, (_, i) => makeCell(i % 8, Math.floor(i / 8), 0)),
    },
    players: races.map((race, i) => ({
      id: `S143PL000${i + 1}`, playerNo: i + 1, race: i, raceId: race.raceId, name: `Player ${i}`,
    })),
    objects: [],
  });
}

describe("player roster preserves block-order slots across undo and redo", () => {
  it.each([0, 1, 2, 3])("restores the original player position when removing index %i", (index) => {
    const base = fixture();
    const player = base.players[index];
    if (!player) throw new Error("Missing fixture player");
    const remove: EditOp = { kind: "removePlayer", id: player.id };
    const removed = applyOp(base, remove);
    const restored = applyOp(removed.doc, removed.inverse).doc;

    expect(restored.players).toEqual(base.players);
    expect(restored.header.playerSlots).toEqual(base.header.playerSlots);

    const removedAgain = applyOp(restored, remove).doc;
    expect(removedAgain.players).toEqual(removed.doc.players);
    expect(removedAgain.header.playerSlots).toEqual(removed.doc.header.playerSlots);
  });

  it("preserves multiple nested removals and inverse restores", () => {
    const base = fixture();
    const first = applyOp(base, { kind: "removePlayer", id: "S143PL0002" });
    const second = applyOp(first.doc, { kind: "removePlayer", id: "S143PL0003" });
    const restoredSecond = applyOp(second.doc, second.inverse).doc;
    const restoredFirst = applyOp(restoredSecond, first.inverse).doc;

    expect(restoredSecond.players).toEqual(first.doc.players);
    expect(restoredSecond.header.playerSlots).toEqual(first.doc.header.playerSlots);
    expect(restoredFirst.players).toEqual(base.players);
    expect(restoredFirst.header.playerSlots).toEqual(base.header.playerSlots);
  });

  it.each(["S143PL0001", "S143PL0004"])("reports a typed conflict restoring %s after a peer removes another player", (playerId) => {
    const base = fixture();
    const removed = applyOp(base, { kind: "removePlayer", id: playerId });
    const peerRemoval = applyOp(removed.doc, { kind: "removePlayer", id: "S143PL0002" });
    const unchanged = structuredClone(peerRemoval.doc);

    expect(() => applyOp(peerRemoval.doc, removed.inverse)).toThrow(PlayerRosterConflictError);
    expect(peerRemoval.doc).toEqual(unchanged);
  });

  it("does not mistake an equal-race replacement player for the original remaining roster", () => {
    const removed = applyOp(fixture(), { kind: "removePlayer", id: "S143PL0001" });
    const current = structuredClone(removed.doc);
    const replaced = current.players[0];
    if (!replaced) throw new Error("Missing fixture player");
    replaced.id = "S143PL0009";

    expect(() => applyOp(current, removed.inverse)).toThrow(/roster changed since snapshot/i);
  });

  it("preserves a peer's independent remaining-player edits when restoring", () => {
    const base = fixture();
    const removed = applyOp(base, { kind: "removePlayer", id: "S143PL0001" });
    const peerEdit = applyOp(removed.doc, { kind: "patchPlayer", id: "S143PL0002", fields: { name: "Peer name" } });
    const restored = applyOp(peerEdit.doc, removed.inverse).doc;

    expect(restored.players.map((p) => p.id)).toEqual(base.players.map((p) => p.id));
    expect(restored.players[1]?.name).toBe("Peer name");
    expect(restored.header.playerSlots).toEqual(base.header.playerSlots);
  });

  it.each([0, 1, 2, 3])("restores legacy snapshots without position metadata at index %i", (index) => {
    const base = fixture();
    const removed = applyOp(base, { kind: "removePlayer", id: `S143PL000${index + 1}` });
    if (removed.inverse.kind !== "addPlayer" || !removed.inverse.snapshot) throw new Error("Missing snapshot");
    const legacySnapshot = { ...removed.inverse.snapshot };
    delete legacySnapshot.playerIndex;
    delete legacySnapshot.remainingPlayerIds;
    const restored = applyOp(removed.doc, { kind: "addPlayer", snapshot: legacySnapshot }).doc;

    expect(restored.players).toEqual(base.players);
    expect(restored.header.playerSlots).toEqual(base.header.playerSlots);
  });

  it("restores a legacy neutral player at its uniquely proven slot", () => {
    const base = fixture();
    base.players.splice(2, 0, { id: "S143PL0000", playerNo: 0, race: 4, raceId: "G000RR0004", isHuman: false });
    base.header.playerSlots = [0, 3, 4, 2, 1, ...Array<number>(8).fill(99)];
    const removed = applyOp(base, { kind: "removePlayer", id: "S143PL0000" });
    if (removed.inverse.kind !== "addPlayer" || !removed.inverse.snapshot) throw new Error("Missing snapshot");
    const legacySnapshot = { ...removed.inverse.snapshot };
    delete legacySnapshot.playerIndex;
    delete legacySnapshot.remainingPlayerIds;
    const restored = applyOp(removed.doc, { kind: "addPlayer", snapshot: legacySnapshot }).doc;

    expect(restored.players).toEqual(base.players);
    expect(restored.header.playerSlots).toEqual(base.header.playerSlots);
  });

  it("refuses a legacy snapshot whose race-slot position cannot be proven", () => {
    const base = fixture();
    const removed = applyOp(base, { kind: "removePlayer", id: "S143PL0002" });
    if (removed.inverse.kind !== "addPlayer" || !removed.inverse.snapshot) throw new Error("Missing snapshot");
    const legacySnapshot: Record<string, unknown> = { ...removed.inverse.snapshot, slots: [0, 2, 1, ...Array<number>(10).fill(99)] };
    delete legacySnapshot.playerIndex;
    delete legacySnapshot.remainingPlayerIds;

    expect(() => applyOp(removed.doc, { kind: "addPlayer", snapshot: legacySnapshot })).toThrow(/legacy.*snapshot/i);
  });

  it("refuses ambiguous legacy race slots instead of guessing by id", () => {
    const base = fixture();
    const repeated = base.players[1];
    if (!repeated) throw new Error("Missing fixture player");
    base.players[1] = { ...repeated, race: 0, raceId: "G000RR0000" };
    base.header.playerSlots = [0, 0, 2, 1, ...Array<number>(9).fill(99)];
    const removed = applyOp(base, { kind: "removePlayer", id: "S143PL0001" });
    if (removed.inverse.kind !== "addPlayer" || !removed.inverse.snapshot) throw new Error("Missing snapshot");
    const legacySnapshot = { ...removed.inverse.snapshot };
    delete legacySnapshot.playerIndex;
    delete legacySnapshot.remainingPlayerIds;

    expect(() => applyOp(removed.doc, { kind: "addPlayer", snapshot: legacySnapshot })).toThrow(/legacy.*snapshot/i);
  });

  it.each([-1, 1.5, 4, Number.NaN])("rejects invalid recorded position %s before changing the model", (playerIndex) => {
    const base = fixture();
    const removed = applyOp(base, { kind: "removePlayer", id: "S143PL0002" });
    if (removed.inverse.kind !== "addPlayer" || !removed.inverse.snapshot) throw new Error("Missing snapshot");
    const unchanged = structuredClone(removed.doc);

    expect(() => applyOp(removed.doc, {
      kind: "addPlayer", snapshot: { ...removed.inverse.snapshot, playerIndex },
    })).toThrow(/player.*index/i);
    expect(removed.doc).toEqual(unchanged);
  });
});
