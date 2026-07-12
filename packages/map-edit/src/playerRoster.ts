/**
 * Player-roster synthesis — add / remove a playable faction (race + capital + hero + subrace +
 * per-player satellites) as ONE undoable cluster. Verbatim faction data (guardian/leader/lord/
 * raceType) comes from the reference port @d2/sg-parser `RACES` (D2MapEditor::addRace); here it is
 * a MODEL mutation the from-model export serializes: MidPlayer + MidSubRace + fog/spells/buildings +
 * Capital + hero MidStack (guardian/hero MidUnit + 3 MidItem ride the objects' garrison key+slot /
 * itemKeys). The FILE-HEADER `_playersData` blob is re-stamped by serializeMapFromModel; ScenarioInfo
 * PLAYER_n + diplomacy are carried in the model here.
 *
 * Gold-checked in native ScenEdit: add-player loads on a blank map + 6 corpus maps (incl. the
 * 6-player max). CONSTRAINT — one player per race: the game keys players by race (adding a race the
 * map already has → ScenEdit rejects at StreamRaces/FindRace), so an add refuses a duplicate race.
 * The race-terrain 5×5 stamp addRace does is COSMETIC (gold-checked to load without it) → omitted, so
 * the cluster touches only cleanly-removable entities and undo is exact.
 */
import type { MapDocument, MapObject, GarrisonUnit } from "@d2/map-schema";
import { RACES, RACE_KEYS } from "@d2/sg-parser";
import { ID_BAND, ID_SLOTS } from "./place.js";

export type RaceKey = keyof typeof RACES;
export { RACES, RACE_KEYS };

const VER_DEFAULT = "S143";
const NIL = "G000000000";
const CAPITAL_ITEM = "G000IG0006";
const SLOT_COUNT = 13;
const hex4 = (n: number): string => (n >>> 0).toString(16).padStart(4, "0");

/** RACE_ID → RACE_TYPE (the header/diplomacy/PLAYER_n value — NOT the Grace index). Neutral=4. */
const RACEID_TO_TYPE = new Map<string, number>([
  ["G000RR0004", 4],
  ...RACE_KEYS.map((k) => [RACES[k].raceId, RACES[k].raceType] as [string, number]),
]);
function raceTypeOf(raceId: string | undefined): number | undefined {
  return RACEID_TO_TYPE.get(raceId ?? "");
}

/** Every compound id referenced anywhere in the doc — to mint collision-free ids per family. */
function allIds(doc: MapDocument): Set<string> {
  const s = new Set<string>();
  const add = (id: unknown): void => { if (typeof id === "string" && id) s.add(id); };
  for (const p of doc.players ?? []) add(p.id);
  for (const sr of doc.subraces ?? []) add(sr.id);
  for (const r of doc.roads ?? []) add(r.id);
  for (const e of doc.events ?? []) add(e.id);
  for (const t of doc.templates ?? []) add(t.id);
  const sat = doc.satellites as Record<string, { id: string }[]> | undefined;
  if (sat) for (const k of Object.keys(sat)) for (const x of sat[k] ?? []) add(x.id);
  for (const it of doc.strayInstances?.items ?? []) add(it.id);
  for (const u of doc.strayInstances?.units ?? []) add(u.id);
  for (const o of doc.objects ?? []) {
    add(o.id);
    for (const c of (o as { garrison?: (GarrisonUnit | null)[] }).garrison ?? []) if (c?.key) add(c.key);
    for (const k of (o as { itemKeys?: string[] }).itemKeys ?? []) add(k);
    for (const k of (o as { inventoryKeys?: string[] }).inventoryKeys ?? []) add(k);
  }
  return s;
}
/** Next free hex4 index of family `pre` inside `slot`'s disjoint band — the SAME collab id-
 *  namespacing place.ts's nextTypedId uses (M4), so two clients adding a player concurrently mint
 *  non-overlapping PL/SR/FG/…/UN/IM ids. Band full → lowest globally-free (an interior gap). */
function nextSecond(ids: Set<string>, pre: string, slot = 0): number {
  const s = Number.isInteger(slot) && slot >= 0 && slot < ID_SLOTS ? slot : 0;
  const bandStart = s * ID_BAND;
  const bandEnd = bandStart + ID_BAND;
  let bandMax = bandStart - 1;
  const used = new Set<number>();
  for (const id of ids) {
    if (id.startsWith(pre) && id.length === pre.length + 4) {
      const idx = parseInt(id.slice(pre.length), 16);
      used.add(idx);
      if (idx >= bandStart && idx < bandEnd && idx > bandMax) bandMax = idx;
    }
  }
  let next = bandMax + 1;
  if (next >= bandEnd) {
    next = -1;
    for (let i = 0; i <= 0xffff; i++) if (!used.has(i)) { next = i; break; }
    if (next < 0) throw new Error(`${pre}: id space exhausted (65536)`);
  }
  return next;
}

/** The minted on-disk id cluster for a new player (one id per block the addRace port emits). */
export interface PlayerIds {
  pl: string; sr: string; fg: string; ks: string; pb: string;
  ft: string; kc: string; guard: string; hero: string; items: [string, string, string];
}

/** Mint a full collision-free id cluster for a new player (call at op-build time; baked into the op
 *  so every collab peer applies the identical ids — no re-minting drift). `slot` = the client's collab
 *  id band (M4); solo/offline = 0. UN needs 2 consecutive ids, IM needs 3 — both fit a 4096 band. */
export function mintPlayerIds(doc: MapDocument, slot = 0): PlayerIds {
  const ver = doc.header.version || VER_DEFAULT;
  const ids = allIds(doc);
  const id = (short: string, n: number): string => ver + short + hex4(n);
  const un = nextSecond(ids, ver + "UN", slot);
  const im = nextSecond(ids, ver + "IM", slot);
  return {
    pl: id("PL", nextSecond(ids, ver + "PL", slot)),
    sr: id("SR", nextSecond(ids, ver + "SR", slot)),
    fg: id("FG", nextSecond(ids, ver + "FG", slot)),
    ks: id("KS", nextSecond(ids, ver + "KS", slot)),
    pb: id("PB", nextSecond(ids, ver + "PB", slot)),
    ft: id("FT", nextSecond(ids, ver + "FT", slot)),
    kc: id("KC", nextSecond(ids, ver + "KC", slot)),
    guard: id("UN", un),
    hero: id("UN", un + 1),
    items: [id("IM", im), id("IM", im + 1), id("IM", im + 2)],
  };
}

/** Spec for a fresh add-player (all faction data derived from RACES[race]). */
export interface AddPlayerSpec {
  race: RaceKey;
  x: number; y: number;
  lordId?: string;
  name?: string;
  ids: PlayerIds;
}

/** Is this race already on the map? (one player per race — hard game constraint.) */
export function raceAlreadyPresent(doc: MapDocument, race: RaceKey): boolean {
  return (doc.players ?? []).some((p) => p.raceId === RACES[race].raceId);
}

/** RACE_ID (e.g. "G000RR0001") → the RaceKey whose RACES entry carries it (for a UI that presents
 *  races by their game name/id and dispatches addPlayer by key). */
export function raceKeyOfId(raceId: string): RaceKey | undefined {
  return RACE_KEYS.find((k) => RACES[k].raceId === raceId);
}

/** Find a free 5×5 land spot for a new capital (no water/mountain, no MidgardPlan occupancy). The
 *  add-player op needs a valid land anchor; the user can drag the capital afterward. Null = the map
 *  has no open 5×5 land block (a full map). */
export function findFreeCapitalSpot(doc: MapDocument): { x: number; y: number } | null {
  const n = doc.size;
  const occ = new Set<number>();
  for (const e of doc.plan?.entries ?? []) occ.add(e.y * n + e.x);
  const land = (x: number, y: number): boolean => {
    for (let dx = 0; dx < 5; dx++) for (let dy = 0; dy < 5; dy++) {
      const cx = x + dx, cy = y + dy;
      if (cx >= n || cy >= n || occ.has(cy * n + cx)) return false;
      const g = ((doc.terrain.cells[cy * n + cx]?.value ?? 0) >> 3) & 7;
      if (g === 3 || g === 4) return false; // water / mountain
    }
    return true;
  };
  // spiral-ish scan from the centre outward so a new capital lands away from the edges when possible
  for (let y = 2; y < n - 6; y++) for (let x = 2; x < n - 6; x++) if (land(x, y)) return { x, y };
  return null;
}

/** A captured player cluster — enough to re-insert verbatim (undo of a remove, redo of an add). */
export interface PlayerCluster {
  player: Record<string, unknown>;
  subraces: Record<string, unknown>[];
  objects: MapObject[];
  fogs: unknown[];
  spells: unknown[];
  buildings: unknown[];
  planEntries: unknown[];
  diplomacy: unknown[];
  /** The exact doc.header.playerSlots array insert should restore (13 ints, 99 = unused). */
  slots: number[];
}

function normSlots(slots: readonly number[] | undefined): number[] {
  const out = (slots ?? []).slice(0, SLOT_COUNT);
  while (out.length < SLOT_COUNT) out.push(99);
  return out;
}

type Sats = NonNullable<MapDocument["satellites"]>;
const emptySats = (): Sats => ({
  fogs: [], playerSpells: [], playerBuildings: [], talismanCharges: [], stackDestroyed: [],
  questLogs: [], spellCasts: [], spellEffects: [], turnSummaries: [],
});

/** Build a fresh player cluster (deterministic given doc + spec.ids). Mirrors addRace, minus the
 *  cosmetic terrain stamp. */
export function synthesizeCluster(doc: MapDocument, spec: AddPlayerSpec): PlayerCluster {
  const race = RACES[spec.race];
  const { ids } = spec;
  const raceType = race.raceType;
  const graceIdx = parseInt(race.raceId.slice(6), 16);
  const playerIndex = (doc.players ?? []).length; // block-order slot (PLAYER_n / _playersData position)
  // The reader DERIVES playerNo from the PLAYER id's hex4 (parseCompoundId), NOT the array position —
  // on a map with gappy player ids these differ, so match the id or the semantic round-trip fails.
  const playerNo = parseInt(ids.pl.slice(-4), 16);

  const player: Record<string, unknown> = {
    id: ids.pl, playerNo, race: graceIdx, name: spec.name || race.name, isHuman: false,
    desc: "", lordId: spec.lordId || race.lord, raceId: race.raceId,
    fogId: ids.fg, knownId: ids.ks, buildsId: ids.pb, face: 0, qtyBreaks: 0,
    bank: "G0100:R0000:Y0000:E0000:W0000:B0000", spellBank: "G0000:R0000:Y0000:E0000:W0000:B0000",
    attitude: 1, researchT: 0, constructT: 0,
    spy1: NIL, spy2: NIL, spy3: NIL, capturedBy: NIL, alwaysAi: false,
    exMapId1: NIL, exMapTurn1: 0, exMapId2: NIL, exMapTurn2: 0, exMapId3: NIL, exMapTurn3: 0,
  };
  const subrace = { id: ids.sr, subrace: raceType + 1, playerId: ids.pl, number: 0, name: "", banner: raceType };
  const rowBytes = doc.size / 8;
  const fog = { id: ids.fg, rows: Array.from({ length: doc.size }, (_, y) => ({ y, mask: new Array(rowBytes).fill(0) })) };
  const spells = { id: ids.ks, spells: [] as string[] };
  const buildings = { id: ids.pb, buildings: [] as string[] };

  // NB: field shapes MUST match what the reader produces on reparse (the semantic round-trip gate
  // compares them) — empty NAME_TXT omitted (no `name:""`), a garrisoned stack always reads back
  // garrisoned:true + equip:{} + inventory:[], and LEADR_ALIV=true is the default the reader omits.
  const guard: GarrisonUnit = { unit: race.guardian, level: 1, hp: race.guardianHp, key: ids.guard, slot: 0 };
  const hero: GarrisonUnit = { unit: race.leader, level: 1, hp: race.leaderHp, name: "Герой", key: ids.hero, slot: 0 };
  const cell2 = (m: GarrisonUnit): (GarrisonUnit | null)[] => [null, null, m, null, null, null];

  const capital = {
    type: "capital" as const, id: ids.ft, pos: { x: spec.x, y: spec.y },
    owner: ids.pl, subRace: ids.sr, race: graceIdx, name: `Столица (${race.name})`, desc: "",
    priority: 0, stackRef: ids.kc, garrison: cell2(guard),
    items: [CAPITAL_ITEM, CAPITAL_ITEM, CAPITAL_ITEM], itemKeys: [...ids.items],
  } as unknown as MapObject;
  const stack = {
    type: "stack" as const, id: ids.kc, pos: { x: spec.x, y: spec.y },
    owner: ids.pl, subRace: ids.sr, inside: ids.ft, garrisoned: true, leaderCell: 2, garrison: cell2(hero),
    order: 1, move: 35, aiOrder: 1, priority: 3, creatLvl: 1, facing: 0, morale: 0,
    equip: {}, inventory: [],
  } as unknown as MapObject;

  const planEntries: { x: number; y: number; element: string }[] = [];
  for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) planEntries.push({ x: spec.x + dx, y: spec.y + dy, element: ids.ft });
  planEntries.push({ x: spec.x, y: spec.y, element: ids.kc });

  // diplomacy: pair the new race with every existing player whose raceType resolves (relation 0)
  const diplomacy: { race1: number; race2: number; relation: number }[] = [];
  for (const p of doc.players ?? []) {
    const rt = raceTypeOf(p.raceId);
    if (rt !== undefined && rt !== raceType) diplomacy.push({ race1: rt, race2: raceType, relation: 0 });
  }

  const slots = normSlots(doc.header.playerSlots);
  slots[playerIndex] = raceType;

  return { player, subraces: [subrace], objects: [capital, stack], fogs: [fog], spells: [spells], buildings: [buildings], planEntries, diplomacy, slots };
}

/** Insert a cluster into a doc → new doc (pure). Used by addPlayer (synthesized) and the undo of a
 *  removePlayer (verbatim snapshot restore). */
export function insertCluster(doc: MapDocument, c: PlayerCluster): MapDocument {
  const sat: Sats = doc.satellites ?? emptySats();
  const satOut: Sats = {
    ...sat,
    fogs: [...sat.fogs, ...(c.fogs as Sats["fogs"])],
    playerSpells: [...sat.playerSpells, ...(c.spells as Sats["playerSpells"])],
    playerBuildings: [...sat.playerBuildings, ...(c.buildings as Sats["playerBuildings"])],
  };
  const plan = doc.plan
    ? { ...doc.plan, entries: [...doc.plan.entries, ...(c.planEntries as typeof doc.plan.entries)] }
    : doc.plan;
  return {
    ...doc,
    players: [...doc.players, c.player as unknown as (typeof doc.players)[number]],
    subraces: [...(doc.subraces ?? []), ...(c.subraces as unknown as NonNullable<typeof doc.subraces>)],
    objects: [...doc.objects, ...c.objects],
    satellites: satOut,
    plan,
    diplomacy: [...(doc.diplomacy ?? []), ...(c.diplomacy as typeof doc.diplomacy)],
    header: { ...doc.header, playerSlots: c.slots.slice() },
  };
}

/** Capture the full cluster owned by `playerId` (player + its subraces + every owned object + its
 *  satellites + plan entries + diplomacy rows), plus the CURRENT slot array (so undo restores it). */
export function extractCluster(doc: MapDocument, playerId: string): PlayerCluster {
  const player = doc.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`extractCluster: unknown player ${playerId}`);
  const raceType = raceTypeOf(player.raceId);
  const subraces = (doc.subraces ?? []).filter((s) => s.playerId === playerId);
  const objects = doc.objects.filter((o) => (o as { owner?: string }).owner === playerId);
  const objIds = new Set(objects.map((o) => o.id));
  const satIds = new Set([player.fogId, player.knownId, player.buildsId].filter(Boolean) as string[]);
  const sat: Sats = doc.satellites ?? emptySats();
  const fogs = sat.fogs.filter((f) => satIds.has(f.id));
  const spells = sat.playerSpells.filter((k) => satIds.has(k.id));
  const buildings = sat.playerBuildings.filter((b) => satIds.has(b.id));
  const planEntries = (doc.plan?.entries ?? []).filter((e) => objIds.has((e as { element: string }).element));
  const diplomacy = raceType === undefined ? [] : (doc.diplomacy ?? []).filter((d) => d.race1 === raceType || d.race2 === raceType);
  return {
    player: player as Record<string, unknown>,
    subraces: subraces as unknown as Record<string, unknown>[],
    objects, fogs, spells, buildings, planEntries, diplomacy,
    slots: normSlots(doc.header.playerSlots),
  };
}

/** Remove a player + everything the capture would restore → new doc (pure). Recomputes the slot
 *  array (splice out the player's block index). Refuses to remove the last non-neutral player. */
export function removeCluster(doc: MapDocument, playerId: string): MapDocument {
  const idx = doc.players.findIndex((p) => p.id === playerId);
  if (idx < 0) throw new Error(`removeCluster: unknown player ${playerId}`);
  const player = doc.players[idx]!;
  const raceType = raceTypeOf(player.raceId);
  const nonNeutral = doc.players.filter((p) => raceTypeOf(p.raceId) !== 4).length;
  if (raceTypeOf(player.raceId) !== 4 && nonNeutral <= 1) throw new Error("removeCluster: cannot remove the last faction (a map needs ≥1 player)");
  const objIds = new Set(doc.objects.filter((o) => (o as { owner?: string }).owner === playerId).map((o) => o.id));
  const satIds = new Set([player.fogId, player.knownId, player.buildsId].filter(Boolean) as string[]);
  const sat: Sats = doc.satellites ?? emptySats();
  const satOut: Sats = {
    ...sat,
    fogs: sat.fogs.filter((f) => !satIds.has(f.id)),
    playerSpells: sat.playerSpells.filter((k) => !satIds.has(k.id)),
    playerBuildings: sat.playerBuildings.filter((b) => !satIds.has(b.id)),
  };
  const plan = doc.plan
    ? { ...doc.plan, entries: doc.plan.entries.filter((e) => !objIds.has((e as { element: string }).element)) }
    : doc.plan;
  const slots = normSlots(doc.header.playerSlots);
  slots.splice(idx, 1);
  slots.push(99);
  return {
    ...doc,
    players: doc.players.filter((p) => p.id !== playerId),
    subraces: (doc.subraces ?? []).filter((s) => s.playerId !== playerId),
    objects: doc.objects.filter((o) => !objIds.has(o.id)),
    satellites: satOut,
    plan,
    diplomacy: raceType === undefined ? doc.diplomacy : (doc.diplomacy ?? []).filter((d) => d.race1 !== raceType && d.race2 !== raceType),
    header: { ...doc.header, playerSlots: slots.slice(0, SLOT_COUNT) },
  };
}
