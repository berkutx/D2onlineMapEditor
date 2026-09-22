import type { MapDocument } from "@d2/map-schema";
import type { EditOp } from "@d2/map-edit";

/** State read/written by a roster operation. A faction is a cluster, not just a
 * PlayerInfo row: insertCluster/removeCluster also change global slots and the
 * collections below. Deliberately conservative for these infrequent operations:
 * any peer edit in this aggregate invalidates roster redo; terrain/events do not.
 * Keep in sync with packages/map-edit/src/playerRoster.ts. */
function rosterState(doc: MapDocument): unknown {
  return {
    players: doc.players, subraces: doc.subraces ?? [], objects: doc.objects,
    fogs: doc.satellites?.fogs ?? [],
    spells: doc.satellites?.playerSpells ?? [],
    buildings: doc.satellites?.playerBuildings ?? [],
    plan: doc.plan ?? null, diplomacy: doc.diplomacy ?? [],
    slots: doc.header.playerSlots ?? [],
  };
}

/** Exhaustive over the operation union, rather than parsing opaque opKeys back
 * into coordinates. Adding an EditOp now requires defining its redo guard. */
export function captureRedoState(doc: MapDocument, ops: readonly EditOp[]): Record<string, string> {
  const state: Record<string, string> = {};
  const capture = (key: string, value: unknown): void => { state[key] = JSON.stringify(value ?? null); };
  for (const op of ops) {
    switch (op.kind) {
      case "setCell": {
        const cell = doc.terrain.cells[op.y * doc.size + op.x];
        capture(`${op.x},${op.y}`, cell ? [cell.value, cell.roadType, cell.roadVar] : null);
        break;
      }
      case "addObject": capture(`O:${op.object.id}`, doc.objects.find(o => o.id === op.object.id)); break;
      case "moveObject":
      case "patchObject":
      case "deleteObject": capture(`O:${op.id}`, doc.objects.find(o => o.id === op.id)); break;
      case "patchPlayer": capture(`P:${op.id}`, doc.players.find(p => p.id === op.id)); break;
      case "addPlayer":
      case "removePlayer": capture("ROSTER", rosterState(doc)); break;
      case "upsertEvent": capture(`E:${op.event.id}`, doc.events?.find(e => e.id === op.event.id)); break;
      case "deleteEvent": capture(`E:${op.id}`, doc.events?.find(e => e.id === op.id)); break;
      case "upsertTemplate": capture(`T:${op.template.id}`, doc.templates?.find(t => t.id === op.template.id)); break;
      case "deleteTemplate": capture(`T:${op.id}`, doc.templates?.find(t => t.id === op.id)); break;
      case "setVariables": capture("VARS", doc.variables ?? []); break;
      case "setDiplomacy": capture("DIPLOMACY", doc.diplomacy ?? []); break;
      case "setScenarioInfo": capture("SCENARIO", doc.header); break;
      default: {
        const unsupported: never = op;
        throw new Error(`Unsupported redo operation: ${JSON.stringify(unsupported)}`);
      }
    }
  }
  return state;
}
