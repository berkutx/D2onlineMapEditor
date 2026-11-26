/**
 * The edit file of a derived mod: which mod it derives from, and a journal of edits to that
 * parent's tables and archives, with a cursor for undo and redo (the map editor's
 * EditorProject pattern). It is a local working file, never served and not part of
 * Contract D; the derived mod's store entry is built from the parent's install plus these
 * edits (tools/asset-pipeline/derive_mod.py).
 *
 * Rows are named by a key (see keys.ts), never by row number, so an edit still finds its row
 * after the parent is rebuilt. Archive records and picture-index entries are named by name.
 * `was` on an op is the value the edit replaced: replaying onto a parent whose value differs
 * is a conflict instead of a silent overwrite.
 */
import { z } from "zod";
import { ModId, Sha256 } from "@d2/mod-catalog";

export const MOD_EDITS_KIND = "d2-mod-edits" as const;
/** A new op kind or field means version 2; a version-1 reader refuses anything else. */
export const MOD_EDITS_VERSION = 1 as const;

/** A table's file name without ".dbf" ("Gunits", "GAI_exp+"); matched ignoring case. */
export const TableName = z.string().regex(/^[A-Za-z0-9_+-]{1,40}$/, "a table name is its file name without .dbf");
/** A column; matched ignoring case, as DbfTable does. */
export const FieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,10}$/, "not a dBASE field name");
/** An archive by file name, looked for in Imgs, then in Interf. */
export const ArchiveName = z.string().regex(/^[A-Za-z0-9_-]{1,40}\.ff$/i, "an archive is a .ff file name");
/** A record or index name: Latin-1, 1-255 characters. */
export const RecordName = z.string().regex(/^[\u0001-ÿ]{1,255}$/, "a record name is 1-255 Latin-1 characters");

/** A cell as @d2/dbf decodes it: C text, N number or null (blank), L boolean. */
export const CellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type CellValue = z.infer<typeof CellValue>;
/** The key cells of a row, in the order of its table's KeyDecl; [] for an "only" table. */
export const RowKey = z.array(CellValue);
export type RowKey = z.infer<typeof RowKey>;

/**
 * How a table's rows are named: by some columns, by the whole row (tables that are lists,
 * with no column set unique in every mod), or as the table's only row (GVars).
 */
export const KeyDecl = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("columns"), columns: z.array(FieldName).min(1) }),
  z.object({ kind: z.literal("row") }),
  z.object({ kind: z.literal("only") }),
]);
export type KeyDecl = z.infer<typeof KeyDecl>;

export const DbfSet = z.object({
  op: z.literal("dbf.set"),
  table: TableName,
  key: RowKey,
  field: FieldName,
  value: CellValue,
  was: CellValue.optional(),
});
export const DbfAdd = z.object({
  op: z.literal("dbf.add"),
  table: TableName,
  key: RowKey,
  /** Cells by field name; the key's cells among them. Cells not given are blank. */
  values: z.record(FieldName, CellValue),
});
export const DbfDelete = z.object({ op: z.literal("dbf.delete"), table: TableName, key: RowKey });

/** Bytes for a record: a payload file by its hash, or a copy of another record of the archive. */
export const Payload = z.union([
  z.object({ sha256: Sha256, size: z.number().int().nonnegative() }),
  z.object({ copyOf: RecordName }),
]);
export type Payload = z.infer<typeof Payload>;

/** Replace the payload of the record of this name, or add a record by that name. */
export const FfPutRecord = z.object({
  op: z.literal("ff.putRecord"),
  archive: ArchiveName,
  name: RecordName,
  payload: Payload,
  /** sha256 of the payload replaced; null when the record was added. */
  was: Sha256.nullable().optional(),
});
export const FfDeleteRecord = z.object({ op: z.literal("ff.deleteRecord"), archive: ArchiveName, name: RecordName });
/** Point an animation name at these frames (pictures of the same index). */
export const FfSetAnimation = z.object({
  op: z.literal("ff.setAnimation"),
  archive: ArchiveName,
  name: RecordName,
  frames: z.array(RecordName).min(1),
  /** The frames it had; null when the animation was added. */
  was: z.array(RecordName).nullable().optional(),
});
export const FfDeleteIndexEntry = z.object({ op: z.literal("ff.deleteIndexEntry"), archive: ArchiveName, name: RecordName });

export const ModEditOp = z.discriminatedUnion("op", [DbfSet, DbfAdd, DbfDelete, FfPutRecord, FfDeleteRecord, FfSetAnimation, FfDeleteIndexEntry]);
export type ModEditOp = z.infer<typeof ModEditOp>;
export type DbfOp = Extract<ModEditOp, { table: string }>;
export type FfOp = Extract<ModEditOp, { archive: string }>;

export const Commit = z.object({
  ops: z.array(ModEditOp).min(1),
  note: z.string().optional(),
  /** ISO time, for the author's history only. */
  at: z.string().optional(),
});
export type Commit = z.infer<typeof Commit>;

export const ModEdits = z.object({
  kind: z.literal(MOD_EDITS_KIND),
  version: z.literal(MOD_EDITS_VERSION),
  /** The derived mod's id in the store. */
  modId: ModId,
  name: z.string().min(1),
  /** The mod the journal edits, and its contentFingerprint when the journal was started. */
  parent: z.object({ modId: ModId, contentFingerprint: Sha256.optional() }),
  /** Rank in the parent's family; default: the parent's minus 1, so the parent keeps ties. */
  familyOrder: z.number().int().optional(),
  /**
   * The id namespace of this mod's new rows: the 3-digit index of "G230UU0001". Chosen once
   * (ids.ts pickNamespace) so that no id of the parent and no other derived mod uses it.
   */
  ids: z.object({ namespace: z.string().regex(/^(2[34]\d|25[0-4])$/, "a namespace is 230-254") }).optional(),
  /** The key of every table an op names, fixed when the table is first edited. */
  tables: z.record(TableName, KeyDecl).default({}),
  journal: z.array(Commit).default([]),
  /** How many commits are applied; the rest is the redo tail. */
  cursor: z.number().int().nonnegative().default(0),
});
export type ModEdits = z.infer<typeof ModEdits>;

/** A new, empty edit file. */
export function newModEdits(init: { modId: string; name: string; parent: { modId: string; contentFingerprint?: string }; namespace?: string; familyOrder?: number }): ModEdits {
  return ModEdits.parse({
    kind: MOD_EDITS_KIND,
    version: MOD_EDITS_VERSION,
    modId: init.modId,
    name: init.name,
    parent: init.parent,
    ...(init.familyOrder === undefined ? {} : { familyOrder: init.familyOrder }),
    ...(init.namespace ? { ids: { namespace: init.namespace } } : {}),
  });
}

/** Parse an edit file; throws a readable error for anything else. */
export function parseModEdits(json: unknown): ModEdits {
  const r = ModEdits.safeParse(json);
  if (!r.success) throw new Error(`not a ${MOD_EDITS_KIND} v${MOD_EDITS_VERSION} file: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  if (r.data.cursor > r.data.journal.length) throw new Error(`the cursor (${r.data.cursor}) is past the journal (${r.data.journal.length} commits)`);
  return r.data;
}

/** The ops of the applied commits, in order. */
export function activeOps(e: ModEdits): ModEditOp[] {
  return e.journal.slice(0, e.cursor).flatMap((c) => c.ops);
}

/** A commit after the cursor; the redo tail is dropped. Tables new to the file get `keys`. */
export function pushCommit(e: ModEdits, ops: ModEditOp[], opts: { note?: string; at?: string; keys?: Record<string, KeyDecl> } = {}): ModEdits {
  if (ops.length === 0) return e;
  const tables = { ...e.tables };
  for (const op of ops) {
    if (!("table" in op)) continue;
    const known = Object.keys(tables).find((t) => t.toLowerCase() === op.table.toLowerCase());
    if (known) continue;
    const decl = Object.entries(opts.keys ?? {}).find(([t]) => t.toLowerCase() === op.table.toLowerCase())?.[1];
    if (!decl) throw new Error(`no key for table ${op.table}: give it in keys (see declareKey)`);
    tables[op.table] = decl;
  }
  const commit: Commit = { ops: ops.map((op) => ModEditOp.parse(op)), ...(opts.note ? { note: opts.note } : {}), ...(opts.at ? { at: opts.at } : {}) };
  return { ...e, tables, journal: [...e.journal.slice(0, e.cursor), commit], cursor: e.cursor + 1 };
}

export function canUndo(e: ModEdits): boolean {
  return e.cursor > 0;
}

export function canRedo(e: ModEdits): boolean {
  return e.cursor < e.journal.length;
}

export function undo(e: ModEdits): ModEdits {
  return canUndo(e) ? { ...e, cursor: e.cursor - 1 } : e;
}

export function redo(e: ModEdits): ModEdits {
  return canRedo(e) ? { ...e, cursor: e.cursor + 1 } : e;
}

/** The key declared for a table, by name ignoring case. */
export function tableKey(e: Pick<ModEdits, "tables">, table: string): KeyDecl | undefined {
  return Object.entries(e.tables).find(([t]) => t.toLowerCase() === table.toLowerCase())?.[1];
}
