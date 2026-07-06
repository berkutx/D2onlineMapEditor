/**
 * RoomManager — holds presence per room. A room is `map:<id>`; each member is a
 * `UserPresence` keyed by socket id. Stage 1 only tracks presence (cursor /
 * viewport / selection); edit history lands in Stage 4.
 */

import type { UserPresence } from "@d2/socket-contract";
import { ID_SLOTS } from "@d2/map-edit";

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

/**
 * Composite room key (v0.2 privacy): visitors of the same map share a room ONLY when they
 * share a channel — the client's own persistent channel by default (private), or the value
 * from a share link. No channel (legacy client) -> the old global per-map key. RoomManager
 * and EditLog treat the key as an opaque string, so nothing else changes.
 */
export function roomKey(mapId: string, channel?: string): string {
  return channel ? `${mapId}#${channel}` : mapId;
}

interface Room {
  members: Map<string, UserPresence>; // socketId -> presence
  colorCursor: number;
  /** Collab id slot (M4) per member: each socket in a room draws object ids from a DISJOINT
   *  band, so concurrent placements never collide. The smallest free slot is handed out on
   *  join and freed on leave (so it can be reused). */
  slots: Map<string, number>; // socketId -> slot ∈ [0, ID_SLOTS)
}

export class RoomManager {
  private rooms = new Map<string, Room>();

  private room(mapId: string): Room {
    const key = roomId(mapId);
    let r = this.rooms.get(key);
    if (!r) {
      r = { members: new Map(), colorCursor: 0, slots: new Map() };
      this.rooms.set(key, r);
    }
    return r;
  }

  /** The smallest slot ∈ [0, ID_SLOTS) not currently held by a room member. Returns 0 when the
   *  room is full (>ID_SLOTS concurrent editors — unrealistic for this tool); at that point the
   *  band scheme degrades to the pre-M4 collision risk for the extra editors, not a crash. */
  private freeSlot(r: Room): number {
    const taken = new Set(r.slots.values());
    for (let s = 0; s < ID_SLOTS; s++) if (!taken.has(s)) return s;
    // >ID_SLOTS concurrent editors in ONE room (unrealistic for this tool): the 17th shares
    // band 0 with the first, reviving the pre-M4 same-band collision risk for those two. Warn
    // so it is observable rather than a silent mystery; a real cap would need a read-only-join.
    console.warn(`[room] all ${ID_SLOTS} id slots taken — new editor shares slot 0 (collision risk)`);
    return 0;
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
    // assign a distinct id slot (reuse the existing one on a re-join by the same socket)
    if (!r.slots.has(socketId)) r.slots.set(socketId, this.freeSlot(r));
    return presence;
  }

  /** The id slot assigned to a member (0 if unknown). */
  slotOf(mapId: string, socketId: string): number {
    return this.rooms.get(roomId(mapId))?.slots.get(socketId) ?? 0;
  }

  /** Remove a member; cleans up the room when it empties. */
  leave(mapId: string, socketId: string): UserPresence | undefined {
    const key = roomId(mapId);
    const r = this.rooms.get(key);
    if (!r) return undefined;
    const presence = r.members.get(socketId);
    r.members.delete(socketId);
    r.slots.delete(socketId); // free the id slot for the next joiner
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
