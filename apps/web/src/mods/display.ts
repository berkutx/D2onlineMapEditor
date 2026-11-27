/**
 * Cells in words: a link column shows the linked entity's name, an L* column its constant
 * in words, a text column the text. Uses the diff's own display texts first, then the
 * per-side look-ups the worker gathered.
 */
import { isNoId, linkOf, normId, type FieldChange, type Row, type SectionId } from "@d2/mod-diff";
import { tr } from "../i18n";
import { fieldLabel, lookupLabel } from "./labels";
import type { SideExtras } from "./prepare";

export type Cell = Row[string] | undefined;

/** A column's label, else its name. */
export function labelOf(table: string, field: string): string {
  return fieldLabel(table, field) ?? field;
}

export function plain(v: Cell): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? tr("Да") : tr("Нет");
  return String(v).trim() || "—";
}

/** The entity a cell names, when the column is an entity link and the cell names one. */
export function cellLink(table: string, column: string, v: Cell): { section: SectionId; id: string } | null {
  const link = linkOf(table, column);
  if (!link || link.target.kind !== "entity" || typeof v !== "string" || isNoId(v)) return null;
  return { section: link.target.section, id: normId(v) };
}

function lookupWords(lookupTable: string, constant: string, ex: SideExtras | null): string {
  const t = lookupTable.toLowerCase();
  return lookupLabel(t, constant, ex?.lookupNames[t]?.[constant]);
}

/** A cell of `table`.`column` in words, with one side's look-ups. */
export function cellText(table: string, column: string, v: Cell, ex: SideExtras | null): string {
  if (v === null || v === undefined || v === "") return "—";
  const link = linkOf(table, column);
  if (link) {
    const t = link.target;
    if (t.kind === "entity") {
      if (isNoId(v)) return "—";
      return ex?.names[normId(v)] ?? String(v);
    }
    if (t.kind === "lookup") {
      const constant = ex?.lookups[t.table.toLowerCase()]?.[String(v)];
      return constant ? lookupWords(t.table, constant, ex) : String(v);
    }
    if (t.kind === "text") {
      if (isNoId(v)) return "—";
      return ex?.texts[normId(v)] ?? ex?.names[normId(v)] ?? String(v);
    }
  }
  return plain(v);
}

/** One side of a changed field in words. */
export function fieldText(f: FieldChange, side: "a" | "b", ex: SideExtras | null): string {
  const shown = side === "a" ? f.aText : f.bText;
  const v = side === "a" ? f.a : f.b;
  if (shown !== undefined && shown !== "") {
    const link = linkOf(f.table, f.field);
    if (link?.target.kind === "lookup") return lookupWords(link.target.table, shown, ex);
    return shown;
  }
  return cellText(f.table, f.field, v, ex);
}

/** True when the cell shows something other than its raw value (worth showing the raw one too). */
export function isWorded(table: string, column: string, v: Cell): boolean {
  return v !== null && v !== undefined && v !== "" && !!linkOf(table, column) && !isNoId(v);
}

/** The columns of a whole row in display order, blanks left out unless `keepBlank`. */
export function rowFields(row: Row | undefined, keepBlank = false): string[] {
  if (!row) return [];
  return Object.keys(row).filter((k) => keepBlank || (row[k] !== null && row[k] !== "" && row[k] !== undefined));
}

/** A key as people read it: ["G000UU0001", 3] -> "G000UU0001 · 3". */
export function keyText(key: readonly unknown[]): string {
  return key.length ? key.map((k) => String(k)).join(" · ") : "—";
}

/** A row in one line: "COL=value; COL=value". */
export function rowLine(row: Row | undefined): string {
  if (!row) return "";
  return rowFields(row)
    .map((k) => `${k}=${plain(row[k])}`)
    .join("; ");
}
