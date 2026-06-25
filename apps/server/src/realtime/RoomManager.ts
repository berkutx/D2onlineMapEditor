/**
 * RoomManager — holds presence per room. A room is `map:<id>`; each member is a
 * `UserPresence` keyed by socket id. Stage 1 only tracks presence (cursor /
 * viewport / selection); edit history lands in Stage 4.
 */

import type { UserPresence } from "@d2/socket-contract";

/** Distinct, readable cursor colors handed out round-robin per room. */
const PALETTE = [
  "#e6194b",
  "#3cb44b",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#46f0f0",
  "#f032e6",
  "#bcf60c",
  "#fabebe",
  "#008080",
];

export function roomId(mapId: string): string {
  return `map:${mapId}`;
}

interface Room {
  members: Map<string, UserPresence>; // socketId -> presence
  colorCursor: number;
}

export class RoomManager {
  private rooms = new Map<string, Room>();

  private room(mapId: string): Room {
    const key = roomId(mapId);
    let r = this.rooms.get(key);
    if (!r) {
      r = { members: new Map(), colorCursor: 0 };
      this.rooms.set(key, r);
    }
    return r;
  }

  /** Add a member to a room and return their assigned presence. */
  join(
    mapId: string,
    socketId: string,
    userId: string,
    name: string,
    color?: string,
  ): UserPresence {
    const r = this.room(mapId);
    const assignedColor =
      color ?? PALETTE[r.colorCursor++ % PALETTE.length] ?? "#ffffff";
    const presence: UserPresence = {
      socketId,
      userId,
      name,
      color: assignedColor,
    };
    r.members.set(socketId, presence);
    return presence;
  }

  /** Remove a member; cleans up the room when it empties. */
  leave(mapId: string, socketId: string): UserPresence | undefined {
    const key = roomId(mapId);
    const r = this.rooms.get(key);
    if (!r) return undefined;
    const presence = r.members.get(socketId);
    r.members.delete(socketId);
    if (r.members.size === 0) this.rooms.delete(key);
    return presence;
  }

  /** Current peers in a room, optionally excluding one socket. */
  peers(mapId: string, exceptSocketId?: string): UserPresence[] {
    const r = this.rooms.get(roomId(mapId));
    if (!r) return [];
    const out: UserPresence[] = [];
    for (const p of r.members.values()) {
      if (p.socketId !== exceptSocketId) out.push(p);
    }
    return out;
  }

  get(mapId: string, socketId: string): UserPresence | undefined {
    return this.rooms.get(roomId(mapId))?.members.get(socketId);
  }

  /** Mutate a member's presence in place; returns the updated presence. */
  update(
    mapId: string,
    socketId: string,
    patch: Partial<Pick<UserPresence, "cursor" | "viewport" | "selection">>,
  ): UserPresence | undefined {
    const p = this.get(mapId, socketId);
    if (!p) return undefined;
    if (patch.cursor !== undefined) p.cursor = patch.cursor;
    if (patch.viewport !== undefined) p.viewport = patch.viewport;
    if (patch.selection !== undefined) p.selection = patch.selection;
    return p;
  }

  /** All rooms a socket currently belongs to (for disconnect cleanup). */
  roomsForSocket(socketId: string): string[] {
    const out: string[] = [];
    for (const [key, r] of this.rooms) {
      if (r.members.has(socketId)) out.push(key.replace(/^map:/, ""));
    }
    return out;
  }
}
