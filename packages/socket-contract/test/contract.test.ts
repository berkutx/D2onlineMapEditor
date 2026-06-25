import { describe, it, expect } from "vitest";
import { EditOp, OpAck, UserPresence, REST, EVENTS, SOCKET_CONTRACT_VERSION } from "../src/index";

describe("@d2/socket-contract", () => {
  it("has a version + REST routes", () => {
    expect(SOCKET_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(REST.map("abc")).toBe("/api/maps/abc");
    expect(EVENTS.roomJoin).toBe("room:join");
  });

  it("validates a setCell op", () => {
    const op = EditOp.parse({ kind: "setCell", x: 1, y: 2, value: 42 });
    expect(op.kind).toBe("setCell");
  });

  it("validates an addObject op reusing the map-schema MapObject", () => {
    const op = EditOp.parse({
      kind: "addObject",
      object: { type: "crystal", id: "CR0001", pos: { x: 3, y: 4 }, resource: 5 },
    });
    expect(op.kind).toBe("addObject");
  });

  it("rejects an unknown op kind", () => {
    expect(() => EditOp.parse({ kind: "nope" })).toThrow();
  });

  it("validates an OpAck and presence", () => {
    expect(OpAck.parse({ ok: false, reason: "read-only" }).ok).toBe(false);
    const p = UserPresence.parse({ socketId: "s", userId: "u", name: "n", color: "#fff", cursor: { x: 1, y: 2 } });
    expect(p.cursor?.x).toBe(1);
  });
});
