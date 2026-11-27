/**
 * Who points at whom in one mod: for every link column of every table, the entity (or the
 * row no entity covers) that holds the link. Gives "used by" lists, the owners of a text,
 * and the users a shared row's change is shown under.
 */
import { classifyId, isNoId, normId } from "./ids.js";
import { linkOf, ownedSpecs, rootOf, TILE_TABLE } from "./model.js";
import type { ModSide } from "./side.js";
import type { Owner, Row, SectionId } from "./types.js";

export interface Ref {
  /** "Gunits.ATTACK_ID" */
  via: string;
  /** The entity holding the link; null for a row no entity covers. */
  owner: { section: SectionId; id: string } | null;
  /** The holding row's label when `owner` is null ("LAttR#5"). */
  label: string;
  shared: boolean;
}

export interface RefIndex {
  /** `${section}|${id}` -> links to that entity */
  entity: Map<string, Ref[]>;
  /** text id -> text columns naming it */
  text: Map<string, Ref[]>;
}

/** The entities a row belongs to: its root entity, or the owners of an owned row, or a terrain code. */
export function rowOwners(lower: string, tableName: string, row: Row): Owner[] {
  const spec = rootOf(lower);
  if (spec) return [{ section: spec.section, id: spec.idOf(row, tableName) }];
  const owned = ownedSpecs(lower);
  if (owned.length) return owned.map((o) => ({ section: o.section, id: normId(row[o.column]) || "-" }));
  if (lower === TILE_TABLE) return [{ section: "terrain", id: normId(row.TERRAIN) || "-" }];
  return [];
}

const push = (m: Map<string, Ref[]>, k: string, r: Ref) => {
  const list = m.get(k);
  if (list) list.push(r);
  else m.set(k, [r]);
};

export function buildRefs(side: ModSide, canonical: (lower: string) => string): RefIndex {
  const out: RefIndex = { entity: new Map(), text: new Map() };
  for (const lower of side.tableNames()) {
    if (lower === "gunits_2") continue; // a copy of Gunits; its links would repeat every unit's
    const t = side.table(lower)!;
    const cols = t.fields
      .map((f) => f.name.toUpperCase())
      .map((c) => ({ c, link: linkOf(lower, c) }))
      .filter((x): x is { c: string; link: NonNullable<ReturnType<typeof linkOf>> } => !!x.link && (x.link.target.kind === "entity" || x.link.target.kind === "text"));
    if (!cols.length) continue;
    const name = canonical(lower);
    const owned = ownedSpecs(lower);
    const ownerColumn = owned[0]?.column;
    const first = t.fields[0]?.name.toUpperCase() ?? "";
    for (const row of side.liveRows(lower)) {
      const owners = rowOwners(lower, name, row).filter((o): o is { section: SectionId; id: string } => o.section !== "terrain");
      const label = owners.length ? owners.map((o) => o.id).join(",") : `${name}#${String(row.ID ?? row[first] ?? "")}`;
      for (const { c, link } of cols) {
        const v = row[c];
        if (typeof v !== "string" || isNoId(v)) continue;
        const via = `${name}.${c}`;
        if (link.target.kind === "text") {
          push(out.text, normId(v), { via, owner: owners[0] ?? null, label, shared: false });
          continue;
        }
        if (link.target.kind !== "entity" || c === ownerColumn) continue;
        const section = classifyId(v)?.section ?? link.target.section;
        const id = normId(v);
        const froms = owners.filter((o) => !(o.section === section && o.id === id));
        if (!owners.length) push(out.entity, `${section}|${id}`, { via, owner: null, label, shared: false });
        for (const o of froms) push(out.entity, `${section}|${id}`, { via, owner: o, label, shared: link.shared });
      }
    }
  }
  return out;
}
