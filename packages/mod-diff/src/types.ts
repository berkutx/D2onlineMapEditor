/**
 * Inputs and outputs of the mod diff. Everything in the output is plain data (JSON-safe), so
 * a page can compute it once and keep it in a store. README.md documents every field.
 */
import type { DbfTable, SchemaDiff } from "@d2/dbf";
import type { CellValue, KeyDecl, RowKey } from "@d2/mod-edit";

// ---------------------------------------------------------------- inputs

/** Table name -> table. Names are matched ignoring case ("GUnits" = "Gunits"). */
export type ModTables = ReadonlyMap<string, DbfTable> | Readonly<Record<string, DbfTable>>;

/** A sheet of a sprite manifest (Contract B 0.2 `spritesheets[]`). */
export interface ManifestSheet {
  id: string;
  ff?: string;
  /** "blobs/<xx>/<sha256>.png" in the store (any other path is compared as text). */
  image: string;
  size?: readonly [number, number] | readonly number[];
}

/** An animation of a sprite manifest (`animations[]`). */
export interface ManifestAnimation {
  id: string;
  atlas?: string;
  frames: readonly string[];
}

/** The parts of a mod's sprite manifest (packages/asset-manifest, version 0.2) the diff reads. */
export interface SpriteManifest {
  spritesheets: readonly ManifestSheet[];
  /** frame name -> [sheetIndex, x, y, w, h, trimX, trimY, sourceW, sourceH] */
  frames?: Readonly<Record<string, readonly number[]>>;
  animations?: readonly ManifestAnimation[];
}

export interface ModData {
  id: string;
  name: string;
  /** Globals tables plus TApp/TAppEdit. */
  tables: ModTables;
  /** Text of Imgs/capital.dat. */
  capitalDat?: string;
  manifest?: SpriteManifest;
  /**
   * Logical file name -> sha256 (or the store path "blobs/<xx>/<sha256>.<ext>", read the
   * same way). Icons (uniticons/, itemicons/, spellicons/, lordicons/) and modscripts/.
   */
  files?: Readonly<Record<string, string>>;
}

export interface DiffOptions {
  /** A race whose redesign score reaches this is flagged `redesigned` (default 0.5). */
  redesignThreshold?: number;
  /**
   * Whether a text that both mods have but word differently is a change:
   * - "compare" (default): it is;
   * - "skip": it is not, only counted (`TableChange.translations`) — for a pair whose texts
   *   are in two languages, like the English GOG vanilla against a Russian mod;
   * - "auto": "skip" when the two mods' texts are in different scripts (`TextLanguages`).
   * Texts only one mod has are added or removed either way; but a list of texts keyed by
   * the whole row (Tleader, TAiMsg), where a reworded text is a delete and an add, is not
   * compared at all when skipped.
   */
  texts?: "compare" | "skip" | "auto";
}

/** The script most of a mod's Tglobal texts are written in. */
export type TextScript = "cyrillic" | "latin";

/** The scripts of the two mods' texts (null: a mod without texts), and what was done. */
export interface TextLanguages {
  a: TextScript | null;
  b: TextScript | null;
  /** True when text wording was not compared (DiffOptions.texts). */
  skipped: boolean;
}

// ---------------------------------------------------------------- output: shared shapes

export const SECTIONS = [
  "units",
  "attacks",
  "items",
  "spells",
  "buildings",
  "lords",
  "races",
  "modifiers",
  "landmarks",
  "leaderUpgrades",
  "dynamicUpgrades",
  "texts",
  "rules",
] as const;
export type SectionId = (typeof SECTIONS)[number];

export type EntityStatus = "added" | "removed" | "changed" | "art-only" | "via-shared";
export type Change = "added" | "removed" | "changed";
export type Side = "a" | "b" | "both";

/** A row as plain cells, field names in upper case. */
export type Row = Record<string, CellValue>;

/** Who an op or a picture was given to. `section: "terrain"` names a terrain code. */
export interface Owner {
  section: SectionId | "terrain";
  id: string;
}

export interface EntityRef {
  section: SectionId;
  id: string;
  /** Name in B, else in A; null when the entity has none. */
  name: string | null;
}

/** One cell that differs. `aText`/`bText` show a link: an entity's name, an L* TEXT, a text. */
export interface FieldChange {
  table: string;
  field: string;
  a: CellValue | null;
  b: CellValue | null;
  aText?: string;
  bText?: string;
  /** Not a table op: the value does not fit A's column, so diffTable could not carry it. */
  uncarried?: true;
}

/** An owned row of a column-keyed table (Gimmu, GbuiList, GcityInf, ...). */
export interface RowChange {
  table: string;
  key: RowKey;
  /** The key as text ("[\"G000UU0001\",3]"), for lookups and list keys. */
  keyText: string;
  change: Change;
  fields: FieldChange[];
  rowA?: Row;
  rowB?: Row;
  /** Indexes into this table's `ops`. */
  ops: number[];
}

/** An owner's list in a whole-row-keyed table (GmodifL, GUmodif, Tleader, TAiMsg). */
export interface ListChange {
  table: string;
  ownerColumn: string;
  owner: string;
  /** The owner's whole list on each side, in file order. */
  a: Row[];
  b: Row[];
  removed: Row[];
  added: Row[];
  ops: number[];
}

/** A text column of the entity (or of a row it owns) whose text differs under the same id. */
export interface TextChange {
  /** "Gunits.NAME_TXT" */
  via: string;
  id: string;
  a: string | null;
  b: string | null;
}

export interface PictureSide {
  /** Sheet image (frames), file path (icons). */
  image?: string;
  /** Blob hash when the path names one. */
  sha256?: string;
  sheet?: string;
  /** [x, y, w, h, trimX, trimY, sourceW, sourceH] on the sheet. */
  rect?: number[];
  sheetSize?: number[];
  /** Animation frame names. */
  frames?: string[];
  /** A capital.dat layer. */
  layer?: CapitalLayer;
}

export interface PictureChange {
  kind: "frame" | "animation" | "icon" | "capital-layer";
  /** Frame or animation name, logical file name, or "<SECTION>/LAYER_<z>". */
  name: string;
  /** "IsoUnit.ff", "uniticons", "capital.dat"; null when the sheet names no archive. */
  archive: string | null;
  change: Change;
  a?: PictureSide;
  b?: PictureSide;
}

export interface UsedBy {
  /** "Gunits.ATTACK_ID" */
  via: string;
  /** null: a row no entity covers (an L* table); `id` is then its key text. */
  section: SectionId | null;
  id: string;
  name: string | null;
  side: Side;
}

export interface LinkedChange {
  via: string;
  section: SectionId;
  id: string;
  name: string | null;
  status: EntityStatus;
}

export interface ScriptRef {
  path: string;
  change: Change;
}

export interface OpRef {
  table: string;
  index: number;
}

export interface EntityChange {
  /** Unique over the whole diff: "<section>:<table>:<id>". */
  uid: string;
  section: SectionId;
  /** The root table ("Gunits", "GAI_normal"). */
  table: string;
  /** Upper-case id ("G000UU0019"); "BELONGS_TO:MODIF_ID" for a leader upgrade, "GAI#3" for an AI row. */
  id: string;
  nameA: string | null;
  nameB: string | null;
  status: EntityStatus;
  /** Its root row is in neither mod (rows that name a missing owner). */
  orphan?: true;
  rowA?: Row;
  rowB?: Row;
  /** Display of the link columns of rowA/rowB. */
  rowTextA?: Record<string, string>;
  rowTextB?: Record<string, string>;
  fields: FieldChange[];
  /** Values of columns only one mod has (not table ops; they do not change the status). */
  newColumns: FieldChange[];
  owned: RowChange[];
  lists: ListChange[];
  texts: TextChange[];
  scripts: ScriptRef[];
  /** Entities it owns that changed (a lord's leader upgrades). */
  children: LinkedChange[];
  /** Shared rows it uses that changed (a unit's attacks, dynamic upgrades, modifiers). */
  shared: LinkedChange[];
  pictures: PictureChange[];
  usedBy: UsedBy[];
  group: Record<string, CellValue | string[]>;
  groupText: Record<string, string>;
  ops: OpRef[];
}

// ---------------------------------------------------------------- tables

/**
 * One op of diffTable, field names upper-cased. `values` of an add is B's whole row (columns
 * A lacks included); `was` of a delete is A's whole row. `owners`: who the op was given to
 * (empty for a table no entity covers).
 */
export type TableOp =
  | { op: "dbf.set"; key: RowKey; keyText: string; field: string; was: CellValue; value: CellValue; wasText?: string; valueText?: string; owners: Owner[] }
  | { op: "dbf.add"; key: RowKey; keyText: string; values: Row; owners: Owner[] }
  | { op: "dbf.delete"; key: RowKey; keyText: string; was: Row; owners: Owner[] };

export interface TableChange {
  /** As A names it (B's name for a table only B has). */
  name: string;
  presence: "both" | "onlyA" | "onlyB";
  /** "entities": its ops are given to entities; "table": no entity covers it (L*, Gunits_2, ...). */
  coverage: "entities" | "table";
  rowsA: number | null;
  rowsB: number | null;
  key: KeyDecl | null;
  keyColumns: string[];
  counts: { set: number; add: number; delete: number };
  schema: SchemaDiff;
  ops: TableOp[];
  /** Values diffTable could not carry (they do not fit A's column, or a key cell's case). */
  skipped: { key: RowKey; keyText: string; field: string; reason: string; a?: CellValue; b?: CellValue }[];
  /** A whole-row table whose columns differ is compared over the columns both have. */
  projected?: string[];
  /** diffTable refused the table; it has no ops. */
  error?: string;
  /** Ops of an "entities" table no entity took (must be 0). */
  unassigned: number;
  /**
   * Cells that differ only in how they write "no id" (empty in one mod, G000000000 in the
   * other; see sameEmptyId). They are not ops: a set is dropped, and so is a deleted row with
   * an added one that reads the same but for such cells (a whole-row key).
   */
  noIdSpellings: number;
  /** Text cells both mods have, worded differently, not compared (DiffOptions.texts "skip"). */
  translations: number;
  note?: string;
}

// ---------------------------------------------------------------- capital.dat

export interface CapitalLayer {
  /** The number after LAYER_ as written ("160"). */
  z: string;
  build: string | null;
  picture: string;
  /** Every value of the line after the picture. */
  values: string[];
  /** The last four numbers: x0, y0, x1, y1 (-1 = none). */
  rect: number[] | null;
}

export interface CapitalSection {
  name: string;
  /** LAYERINFO_nn lines. */
  infos: { n: string; flag: string; build: string | null }[];
  layers: CapitalLayer[];
  /** Other KEY=VALUE lines (LayerInfoCount, LayerCount, ...). */
  other: Record<string, string>;
}

export interface CapitalLayerChange {
  /** "<build>|<PICTURE>" (a second layer of the same pair gets "#2"). */
  key: string;
  build: string | null;
  picture: string;
  change: Change;
  a?: CapitalLayer;
  b?: CapitalLayer;
}

export interface CapitalSectionChange {
  name: string;
  presence: "both" | "onlyA" | "onlyB";
  layersA: number;
  layersB: number;
  layers: CapitalLayerChange[];
  /** Layer changes by building (layers with no building are under build ""). */
  buildings: { build: string; nameA: string | null; nameB: string | null; added: number; removed: number; changed: number; layers: CapitalLayerChange[] }[];
  /** Buildings LAYERINFO lists only in B / only in A. */
  infoAdded: string[];
  infoRemoved: string[];
}

// ---------------------------------------------------------------- races

export interface SlotChange {
  /** GUARDIAN, NOBLE, LEADER_1..4, SOLDIER_1..10, SCOUT, REGEN_H, INCOME, PROTECTION */
  slot: string;
  a: CellValue | null;
  b: CellValue | null;
  aText?: string;
  bText?: string;
  changed: boolean;
}

export interface RaceMembers {
  countA: number;
  countB: number;
  added: EntityRef[];
  removed: EntityRef[];
  /** Members on both sides whose entity changed (any status). */
  changed: (EntityRef & { status: EntityStatus })[];
  /**
   * Members of `added` that are not new content: their picture (for units, the
   * `uniticons/<id>.png` file) has the same bytes as the picture of `of`, a unit of A. A mod
   * that renumbers units keeps their pictures; such a unit is not counted as new.
   */
  copies: (EntityRef & { of: EntityRef })[];
}

export interface RaceChange {
  /** Grace RACE_ID */
  id: string;
  nameA: string | null;
  nameB: string | null;
  presence: "both" | "onlyA" | "onlyB";
  /** The race's entity status in sections.races, or null when its own rows did not change. */
  status: EntityStatus | null;
  raceType: number | null;
  /** Lrace TEXT ("L_DWARF"), the capital.dat section ("DWARF") and the 2-letter code ("DW"). */
  lrace: string | null;
  capitalSection: string | null;
  code: string | null;
  slots: SlotChange[];
  units: RaceMembers;
  buildings: RaceMembers;
  lords: RaceMembers;
  owned: RowChange[];
  lists: ListChange[];
  capital: CapitalSectionChange | null;
  pictures: PictureChange[];
  /**
   * How much of the race in B is new, 0..1. `parts.units` / `parts.buildings`: the share of
   * B's members that A does not have (copies left out); `parts.capital`: the share of B's
   * capital layers that are added or changed; `parts.slots`: the share of Grace slots that
   * differ. `score` weighs them 0.35 / 0.35 / 0.2 / 0.1. What B cut is not new content and
   * does not count; it is in `removed`.
   */
  redesign: { score: number; redesigned: boolean; parts: { units: number; buildings: number; capital: number; slots: number } };
}

// ---------------------------------------------------------------- terrain, pictures, scripts

export interface TerrainChange {
  /** HU, DW, HE, UN, NE, EL, WA */
  code: string;
  /** Lterrain ID (null for water). */
  id: number | null;
  name: string | null;
  pictures: { forests: PictureChange[]; mountains: PictureChange[]; ground: PictureChange[]; borders: PictureChange[] };
  counts: { forestsA: number; forestsB: number; mountainsA: number; mountainsB: number };
  /** GTileDBI rows of this code. */
  tiles: RowChange[];
}

export interface Counts {
  same: number;
  added: number;
  removed: number;
  changed: number;
}

export interface PictureDiff {
  frames: Counts;
  animations: Counts;
  icons: Counts;
  byArchive: Record<string, { added: number; removed: number; changed: number }>;
  /** Every frame, animation and icon change, by archive then name. */
  changes: PictureChange[];
}

export interface ScriptChange {
  /** Logical name, "modscripts/drawing/x.lua". */
  path: string;
  change: Change;
  a?: string;
  b?: string;
  /** Modifiers whose SCRIPT names the file. */
  modifiers: EntityRef[];
}

export interface SectionCounts {
  added: number;
  changed: number;
  removed: number;
  artOnly: number;
  viaShared: number;
  orphans: number;
  total: number;
}

export interface DiffSummary {
  sections: Record<SectionId, SectionCounts>;
  tables: { compared: number; differ: number; onlyA: string[]; onlyB: string[]; ops: number; set: number; add: number; delete: number; skipped: number; refused: string[]; noIdSpellings: number; translations: number };
  /** Ops given to at least one entity (or a terrain code). */
  assignedOps: number;
  /** Ops of tables no entity covers, listed under their table only. */
  tableOnlyOps: number;
  /** Ops of entity tables that no entity took. Must be 0. */
  unassignedOps: number;
  pictures: { frames: Counts; animations: Counts; icons: Counts };
  scripts: { added: number; changed: number; removed: number };
  races: { changed: string[]; redesigned: string[] };
  terrain: { changed: string[] };
}

export interface ModDiff {
  version: 1;
  a: { id: string; name: string };
  b: { id: string; name: string };
  tables: TableChange[];
  sections: Record<SectionId, EntityChange[]>;
  races: RaceChange[];
  /** capital.dat sections no Grace race matches. */
  capitalOther: CapitalSectionChange[];
  terrain: TerrainChange[];
  /** IsoTerrn pictures of no terrain code (roads, fog, MOM####). */
  terrainOther: PictureChange[];
  pictures: PictureDiff;
  scripts: ScriptChange[];
  /** The scripts of both mods' texts, and whether their wording was compared. */
  texts: TextLanguages;
  summary: DiffSummary;
}
