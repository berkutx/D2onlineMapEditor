/**
 * Placement helpers (mountains, landmarks, locations, chests, villages, stacks). They
 * build the EditOps for one placement, allocating the object's id HERE so the byte writer
 * can reuse it (ids must agree between the in-memory model and the exported .sg).
 *
 * - Mountains: addObject + a 37 ("mountain ground") setCell stamp over the footprint
 *   (the editor stamps covered cells to 37; allowed on water — the stamp replaces it).
 * - Landmarks: addObject only (footprint comes from GLmark at render/validate time).
 * - Chests/villages/stacks: addObject whose object EXACTLY matches the reader's output
 *   for the appended block (the semantic round-trip compares them key-for-key).
 */

import type { MapDocument, MapObject } from "@d2/map-schema";
import type { EditOp } from "./ops.js";

/** Mountain-ground cell value (terrain 5 | ground 4), as the editor stamps. */
export const MOUNTAIN_CELL = 37;

/** Cell value a removed mountain's footprint reverts to (terrain 5 | ground 0) — the reference's
 *  mountain-removal restore value (MapStateHolder), i.e. bare mountain terrain, now passable. */
export const MOUNTAIN_RESTORE = 5;

const hex4 = (n: number): string => (n >>> 0).toString(16).padStart(4, "0");

/**
 * Collab id-namespacing (M4). A minted hex4 object id is partitioned by SLOT: a client draws
 * ids from `[slot*ID_BAND, (slot+1)*ID_BAND)`, a band DISJOINT from every other slot's. So two
 * clients minting the same object type CONCURRENTLY (both seeing the same doc, both computing the
 * same max) still get different ids — collision-free BY CONSTRUCTION, with no server round-trip,
 * no temp-id and no reconcile (the model that made M4 v1 net-negative). The server hands each
 * socket in a room a distinct slot on join; solo / offline / tests use slot 0.
 *
 * 16 slots × 4096 ids/band = 65536 = the whole 4-hex space. A band holds a full maze generation
 * (~2500 landmarks). Slot 0's band is the LOW range [0,4096), so for any map with <4096 objects
 * of one type the mint is identical to the old `max+1` — behaviour-preserving for solo edits.
 *
 * Bands apply only to the 7 hex4 type codes (FT/KC/RU/SI/MM/BG/LO). Mountains (ML) carry a
 * POSITIONAL `#index` and are NOT namespaced — concurrent mountain placement stays a known rare
 * limit (a drop+warn, as before M4).
 */
export const ID_BAND_BITS = 12;
export const ID_BAND = 1 << ID_BAND_BITS; // 4096 ids per slot per type
export const ID_SLOTS = 0x10000 >> ID_BAND_BITS; // 16 slots fill the 0x0000..0xFFFF space

/**
 * Mint the next free hex4 id of `typeCode` in `slot`'s band. Scans EVERY object whose id carries
 * the 2-char code (matching on the id, not `o.type` — FT is shared by village/fort/capital, SI by
 * the four site kinds), takes the max index inside the slot's band and returns band-max + 1.
 *
 * If the band is full (>4096 of one type in one slot — e.g. repeated landmark-heavy generation),
 * it falls back to the LOWEST GLOBALLY-FREE index, NOT `globalMax + 1`. This matters: `globalMax+1`
 * is by definition a NEIGHBOUR band's next-mint value, so it collides with that neighbour the next
 * time they place — resurrecting the very silent-drop bug M4 kills. The lowest-free index instead
 * prefers an INTERIOR GAP (a hole below some band's max, e.g. left by a deletion), which no active
 * band-minter will pick — they always mint ABOVE their own band max. It NEVER collides with a
 * committed id. Residual (accepted): with a fully CONTIGUOUS fill (no interior gaps), the lowest
 * free index is the lowest non-full band's own next-mint, so a solo overflow is safe (borrows an
 * empty band) but a concurrent peer minting the same type in that band could still clash — rare,
 * and preferable to aborting a whole generation with a throw. Throws only when all 65536 ids of
 * the type are truly taken. (True zero-collision at overflow would need server id arbitration.)
 */
export function nextTypedId(
  doc: MapDocument,
  version: string,
  typeCode: string,
  slot = 0,
): string {
  const s = Number.isInteger(slot) && slot >= 0 && slot < ID_SLOTS ? slot : 0;
  const bandStart = s * ID_BAND;
  const bandEnd = bandStart + ID_BAND;
  const re = new RegExp(`${typeCode}([0-9a-fA-F]{4})$`);
  let bandMax = bandStart - 1;
  const used = new Set<number>();
  for (const o of doc.objects) {
    const m = re.exec(o.id);
    if (!m) continue;
    const idx = parseInt(m[1]!, 16);
    used.add(idx);
    if (idx >= bandStart && idx < bandEnd && idx > bandMax) bandMax = idx;
  }
  let next = bandMax + 1;
  if (next >= bandEnd) {
    // band exhausted → lowest globally-free index (a gap no active minter will pick)
    next = -1;
    for (let i = 0; i <= 0xffff; i++) if (!used.has(i)) { next = i; break; }
    if (next < 0) throw new Error(`${version}${typeCode}: id space exhausted (65536 objects)`);
  }
  return `${version}${typeCode}${hex4(next)}`;
}

/** True iff a w×h footprint anchored at (cx,cy) fits on the map (no overlap check yet). */
export function canPlaceAt(doc: MapDocument, cx: number, cy: number, w: number, h: number): boolean {
  return cx >= 0 && cy >= 0 && cx + w <= doc.size && cy + h <= doc.size;
}

/** Ops to place a mountain: addObject + 37-stamp its footprint. id matches readMountains. */
export function placeMountainOps(
  doc: MapDocument,
  cx: number,
  cy: number,
  w: number,
  h: number,
  image: number,
  race = 0,
): EditOp[] {
  const version = doc.header.version || "S143";
  const count = doc.objects.filter((o) => o.type === "mountains").length;
  // readMountains ids entries as `${blockId}#${index}`; the single block is ML0000.
  const id = `${version}ML0000#${count}`;
  const ops: EditOp[] = [
    { kind: "addObject", object: { type: "mountains", id, pos: { x: cx, y: cy }, w, h, image, race } },
  ];
  const n = doc.size;
  for (let i = 0; i < w; i++) {
    for (let k = 0; k < h; k++) {
      const x = cx + i;
      const y = cy + k;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const cell = doc.terrain.cells[y * n + x];
      if (cell && cell.value !== MOUNTAIN_CELL) {
        ops.push({ kind: "setCell", x, y, value: MOUNTAIN_CELL });
      }
    }
  }
  return ops;
}

/**
 * Ops to DELETE a mountain (one entry of the single MidMountains block). Mountains carry
 * POSITIONAL ids (`<blockId>#<index>`), so removing entry n renumbers every later entry on the
 * byte-side block rebuild. To keep the in-memory doc aligned with that reparse, we delete the
 * target AND every mountain after it, then RE-ADD the tail shifted down one index — the objects
 * are fungible (nothing references a mountain id), so this is a safe reindex. The target's
 * footprint is reverted to the bare mountain-terrain value (5); cells shared with a surviving
 * mountain keep their 37 stamp. Emit order: restore setCells, deletes, then the re-adds.
 */
export function deleteMountainOps(doc: MapDocument, id: string): EditOp[] {
  const hash = id.indexOf("#");
  if (hash < 0) throw new Error(`deleteMountainOps: ${id} is not a mountain entry id`);
  const blockPrefix = id.slice(0, hash); // e.g. "S143ML0000" — every entry shares it (one block)
  // mountains in positional-index order (readMountains emits #0,#1,… — sort to be safe)
  const mountains = doc.objects
    .filter((o): o is Extract<MapObject, { type: "mountains" }> => o.type === "mountains")
    .map((o) => ({ o, idx: parseInt(o.id.slice(o.id.indexOf("#") + 1), 10) }))
    .sort((a, b) => a.idx - b.idx);
  const n = mountains.findIndex((m) => m.o.id === id);
  if (n < 0) throw new Error(`deleteMountainOps: mountain ${id} not in document`);
  const target = mountains[n]!.o;

  // cells covered by any SURVIVING mountain — keep their 37 stamp when restoring the target
  const survivorCells = new Set<string>();
  for (let i = 0; i < mountains.length; i++) {
    if (i === n) continue;
    const m = mountains[i]!.o;
    const mw = m.w ?? 1, mh = m.h ?? 1;
    for (let dx = 0; dx < mw; dx++) for (let dy = 0; dy < mh; dy++)
      survivorCells.add(`${m.pos.x + dx},${m.pos.y + dy}`);
  }

  const ops: EditOp[] = [];
  const size = doc.size;
  const tw = target.w ?? 1, th = target.h ?? 1;
  for (let dx = 0; dx < tw; dx++) {
    for (let dy = 0; dy < th; dy++) {
      const x = target.pos.x + dx, y = target.pos.y + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      if (survivorCells.has(`${x},${y}`)) continue;
      const cell = doc.terrain.cells[y * size + x];
      if (cell && cell.value !== MOUNTAIN_RESTORE) {
        ops.push({ kind: "setCell", x, y, value: MOUNTAIN_RESTORE });
      }
    }
  }
  // delete the target + tail, then re-add the tail (old i -> new id #(i-1))
  for (let i = n; i < mountains.length; i++) ops.push({ kind: "deleteObject", id: mountains[i]!.o.id });
  for (let i = n + 1; i < mountains.length; i++) {
    ops.push({ kind: "addObject", object: { ...mountains[i]!.o, id: `${blockPrefix}#${i - 1}` } });
  }
  return ops;
}

/**
 * Ops to add a VISITING hero stack to a city/capital: a fresh empty MidStack (KC id) linked via
 * INSIDE → city, plus city.STACK → the new stack. The stack starts empty (no units/leader/items)
 * and is then filled via the normal garrison/equip/inventory ops. The op.object is built to EXACTLY
 * match what parse() will produce for the written MidStack (so the 3-tier validator's semantic
 * round-trip passes): SUBRACE is left empty (no derived bannerIndex), stacks skip the race pass.
 */
export function placeVisitorOps(
  doc: MapDocument,
  city: { id: string; pos: { x: number; y: number }; owner?: string },
  slot = 0,
): EditOp[] {
  const version = doc.header.version || "S143";
  const id = nextTypedId(doc, version, "KC", slot);
  const visitor = {
    type: "stack" as const,
    id,
    pos: { x: city.pos.x, y: city.pos.y },
    garrisoned: true as const,
    inside: city.id,
    facing: 0,
    order: 1, // Normal
    morale: 0,
    move: 20,
    priority: 3,
    creatLvl: 1,
    equip: {},
    inventory: [] as string[],
    garrison: [null, null, null, null, null, null] as (null)[],
    ...(city.owner ? { owner: city.owner } : {}),
  };
  return [
    { kind: "addObject", object: visitor as unknown as MapObject },
    { kind: "patchObject", id: city.id, fields: { stackRef: id } },
  ];
}

/** Ops to place a landmark: one addObject. id = a fresh S143MM#### (matches the block). */
export function placeLandmarkOps(doc: MapDocument, cx: number, cy: number, lmarkKey: string, slot = 0): EditOp[] {
  const version = doc.header.version || "S143";
  const id = nextTypedId(doc, version, "MM", slot);
  // desc: "" mirrors the reference editor (which writes an empty DESC_TXT on every landmark it
  // saves) and matches what readLandmark reports back after export (present-empty), so the
  // semantic round-trip stays exact. Omitting it would reparse as undefined and mismatch.
  return [{ kind: "addObject", object: { type: "landmark", id, pos: { x: cx, y: cy }, baseType: lmarkKey, desc: "" } }];
}

/** Ops to place a treasure chest (MidBag): one addObject. id = a fresh S143BG####.
 *  The object mirrors readTreasure's output EXACTLY (IMAGE + AIPRIORITY are always
 *  written by bagFrame, items always present) so the semantic round-trip passes.
 *  `items` are global GItem TEMPLATE ids — MidItem instances are minted on export. */
export function placeChestOps(
  doc: MapDocument,
  cx: number,
  cy: number,
  image = 0,
  items: readonly string[] = [],
  slot = 0,
): EditOp[] {
  const version = doc.header.version || "S143";
  const id = nextTypedId(doc, version, "BG", slot);
  return [{
    kind: "addObject",
    object: { type: "treasure", id, pos: { x: cx, y: cy }, image, priority: 0, items: items.slice() },
  }];
}

/** Ops to place a race-neutral EMPTY village (MidVillage): one addObject. The FT id prefix
 *  is SHARED by Village/Fort/Capital (byte-verified: Riders villages AND capitals are all
 *  S143FT####), so the fresh id scans EVERY object carrying the prefix, not just villages.
 *  The object mirrors readVillage + the assemble post-pass exactly: neutral owner (OWNER =
 *  the nil sentinel -> key omitted, no race), empty 6-cell garrison, desc "" and the always-
 *  written scalars at their frame defaults. The inspector edits everything after placement. */
/** The NEUTRAL player + one of its subraces. Every valid fort/village needs a REAL owner (a
 *  MidPlayer ref) AND a subrace (a MidSubRace ref — the banner); the game's fort isValid rejects a
 *  fort with nil owner/subrace (proven in the ScenEdit gold-check). Mirrors the reference
 *  FortObject, whose `owner`/`subrace` MapLinks are always assigned at placement. The neutral player
 *  is race 4 ("Нейтральные", always scenario slot 0) and owns the neutral subrace variants — we take
 *  its first. */
function neutralOwner(doc: MapDocument): { owner?: string; subRace?: string } {
  const neutral =
    doc.players.find((p) => p.race === 4) ??
    doc.players.find((p) => p.playerNo === 0) ??
    doc.players[0];
  if (!neutral) return {};
  const sr = (doc.subraces ?? []).find((s) => s.playerId === neutral.id);
  return { owner: neutral.id, subRace: sr?.id };
}

export function placeVillageOps(
  doc: MapDocument,
  cx: number,
  cy: number,
  name: string,
  tier = 1,
  slot = 0,
): EditOp[] {
  const version = doc.header.version || "S143";
  const id = nextTypedId(doc, version, "FT", slot);
  const village = {
    type: "village" as const,
    id,
    pos: { x: cx, y: cy },
    name,
    desc: "",
    tier,
    priority: 0,
    morale: 0,
    regen: 0,
    growth: 0,
    // a neutral fort needs a valid owner + subrace or the game rejects it (gold-checked).
    ...neutralOwner(doc),
    garrison: [null, null, null, null, null, null] as null[],
    items: [] as string[], // captured loot — the reader always emits the (possibly empty) list
  };
  return [{ kind: "addObject", object: village as unknown as MapObject }];
}

/** Ops to place a REAL army stack (MidStack WITH units): one addObject. `units` = up to 6
 *  formation cells (index = FORMATION CELL; {unit: global Gunit id, level, hp} | null);
 *  `leaderCell` names the hero's cell (exported as LEADER_ID via that cell's minted MidUnit
 *  instance). The object mirrors readStack + the assemble post-pass exactly (leaderCell +
 *  leaderImage resolved from LEADER_ID; scalar defaults = stackFrame's frame defaults). */
export function placeStackOps(
  doc: MapDocument,
  cx: number,
  cy: number,
  o: {
    owner?: string;
    units: readonly ({ unit: string; level?: number; hp?: number } | null)[];
    leaderCell: number;
  },
  slot = 0,
): EditOp[] {
  const version = doc.header.version || "S143";
  const id = nextTypedId(doc, version, "KC", slot);
  const garrison = Array.from({ length: 6 }, (_, i) => {
    const gu = o.units[i];
    return gu ? { unit: gu.unit, level: gu.level ?? 1, hp: gu.hp ?? 0 } : null;
  });
  if (!garrison[o.leaderCell]) {
    throw new Error(`placeStackOps: leaderCell ${o.leaderCell} names an empty formation cell`);
  }
  const stack = {
    type: "stack" as const,
    id,
    pos: { x: cx, y: cy },
    ...(o.owner ? { owner: o.owner } : {}),
    leaderCell: o.leaderCell,
    leaderImage: garrison[o.leaderCell]!.unit,
    facing: 0,
    order: 1, // Normal
    morale: 0,
    move: 20,
    priority: 3,
    creatLvl: 1,
    equip: {},
    inventory: [] as string[],
    garrison,
  };
  return [{ kind: "addObject", object: stack as unknown as MapObject }];
}

/** Ops to place an EMPTY ruin (MidRuin): one addObject. The object mirrors readRuin +
 *  the assemble post-pass for a fresh ruinFrame exactly: TITLE "", IMAGE always written,
 *  LOOTER = the nil ref kept as the raw string (looted=false), CASH ""/ITEM nil → omitted,
 *  empty 6-cell guardian formation. The inspector edits everything after placement. */
export function placeRuinOps(doc: MapDocument, cx: number, cy: number, image = 0, slot = 0): EditOp[] {
  const version = doc.header.version || "S143";
  const id = nextTypedId(doc, version, "RU", slot);
  const ruin = {
    type: "ruin" as const,
    id,
    pos: { x: cx, y: cy },
    name: "",
    image,
    looted: false,
    looter: "G000000000",
    priority: 0,
    garrison: [null, null, null, null, null, null] as null[],
  };
  return [{ kind: "addObject", object: ruin as unknown as MapObject }];
}

export type PlaceSiteKind = "merchant" | "mage" | "trainer" | "mercenary";

/** Ops to place an EMPTY site (MidSite*): one addObject. The SI id prefix is shared by all
 *  four site kinds, so the fresh id scans every site. The object mirrors readSite for a
 *  fresh siteFrame exactly: TXT_TITLE "", IMG_ISO always written, desc "" → omitted, and
 *  the kind's stock list empty (merchant items / mage spells / mercenary units; trainer none).
 *  AIPRIORITY is written by the frame but not read back — no priority field. */
export function placeSiteOps(
  doc: MapDocument,
  cx: number,
  cy: number,
  kind: PlaceSiteKind,
  image = 0,
  slot = 0,
): EditOp[] {
  const version = doc.header.version || "S143";
  const id = nextTypedId(doc, version, "SI", slot);
  const stock =
    kind === "merchant" ? { items: [] as { id: string; count: number }[] } :
    kind === "mage" ? { spells: [] as string[] } :
    kind === "mercenary" ? { units: [] as { id: string; level: number; unique: boolean }[] } :
    {};
  const site = { type: kind, id, pos: { x: cx, y: cy }, name: "", image, ...stock };
  return [{ kind: "addObject", object: site as unknown as MapObject }];
}

/** Ops to place a location (named region): one addObject. id = a fresh S143LO####
 *  (max existing + 1, allocated HERE so model and export agree). */
export function placeLocationOps(
  doc: MapDocument,
  cx: number,
  cy: number,
  radius: number,
  name: string,
  slot = 0,
): EditOp[] {
  const version = doc.header.version || "S143";
  const id = nextTypedId(doc, version, "LO", slot);
  return [{ kind: "addObject", object: { type: "location", id, pos: { x: cx, y: cy }, name, radius } }];
}
