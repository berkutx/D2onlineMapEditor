/**
 * diffMods: two mods' data -> the difference a modder recognises.
 *
 *   1. every table: diffTable ops (tables.ts);
 *   2. every op goes to the entities its row belongs to (a Gunits row to its unit, a Gimmu
 *      row to its unit, a GbuiList row to its lord and its building, a GTileDBI row to its
 *      terrain code); ops of tables no entity covers stay under their table;
 *   3. texts, scripts and pictures that changed go to the entities that name them;
 *   4. a shared row's change (an attack, a dynamic upgrade, a modifier) is shown under every
 *      entity that uses it, one level deep;
 *   5. races, terrain and the summary are built from the entities.
 */
import type { CellValue } from "@d2/mod-edit";
import { diffCapital, parseCapitalDat } from "./capital.js";
import { classifyId, isNoId, normId, sameEmptyId, stripStyle } from "./ids.js";
import { defaultRootName, ownedSpecs, RACE_SLOT_HEAD, RACE_SLOT_TAIL, rootOf } from "./model.js";
import { diffPictures, indexFrames, pictureOwnerId, shaOf } from "./pictures.js";
import { buildRefs, rowOwners, type Ref } from "./refs.js";
import { ModSide } from "./side.js";
import { diffTables, textScripts, type TableWork } from "./tables.js";
import { countTerrainArt, terrainCodes, terrainPictures } from "./terrain.js";
import {
  SECTIONS,
  type CapitalSectionChange,
  type DiffOptions,
  type DiffSummary,
  type EntityChange,
  type EntityRef,
  type EntityStatus,
  type FieldChange,
  type LinkedChange,
  type ListChange,
  type ModData,
  type ModDiff,
  type OpRef,
  type PictureChange,
  type RaceChange,
  type RaceMembers,
  type Row,
  type RowChange,
  type ScriptChange,
  type ScriptRef,
  type SectionCounts,
  type SectionId,
  type SlotChange,
  type TableChange,
  type TerrainChange,
  type TextChange,
  type UsedBy,
} from "./types.js";

type Skip = TableChange["skipped"][number];

interface OpAt {
  work: TableWork;
  index: number;
}

interface Builder {
  section: SectionId;
  id: string;
  /** Root table, lower case. */
  root: string;
  ops: OpAt[];
  skips: { work: TableWork; skip: Skip }[];
  texts: TextChange[];
  scripts: ScriptRef[];
  pictures: PictureChange[];
  children: LinkedChange[];
  shared: LinkedChange[];
  inA: boolean;
  inB: boolean;
  base: EntityStatus | null;
  status: EntityStatus | null;
}

const OWN_STATUSES = new Set<EntityStatus>(["added", "removed", "changed"]);
const blank = (v: CellValue | undefined) => v === false || v === 0 || sameEmptyId(v, null);
const sameCell = (a: CellValue | undefined, b: CellValue | undefined) =>
  sameEmptyId(a, b) || (typeof a === "string" || typeof b === "string" ? normId(a ?? "") === normId(b ?? "") : (a ?? null) === (b ?? null));

export function diffMods(a: ModData, b: ModData, options: DiffOptions = {}): ModDiff {
  const sa = new ModSide(a);
  const sb = new ModSide(b);
  const canonical = (lower: string) => sa.displayName(lower) ?? sb.displayName(lower) ?? lower;
  sa.canonical = sb.canonical = canonical;
  const { a: scriptA, b: scriptB } = textScripts(sa, sb);
  const mode = options.texts ?? "compare";
  const skipTexts = mode === "skip" || (mode === "auto" && !!scriptA && !!scriptB && scriptA !== scriptB);
  const works = diffTables(sa, sb, skipTexts);
  const builders = new Map<string, Builder>();
  const terrainOps = new Map<string, OpAt[]>();

  const exists = (section: SectionId, id: string) => sa.sectionRows(section, id).length > 0 || sb.sectionRows(section, id).length > 0;
  const rootFor = (section: SectionId, id: string) =>
    sa.sectionRows(section, id)[0]?.table ?? sb.sectionRows(section, id)[0]?.table ?? defaultRootName(section, id).toLowerCase();
  const nameOf = (section: SectionId, id: string) => sb.entityName(section, id) ?? sa.entityName(section, id);
  const get = (section: SectionId, id: string, root?: string): Builder => {
    const r = root ?? rootFor(section, id);
    const key = `${section}|${r}|${id}`;
    let x = builders.get(key);
    if (!x) {
      x = { section, id, root: r, ops: [], skips: [], texts: [], scripts: [], pictures: [], children: [], shared: [], inA: sa.root(r).has(id), inB: sb.root(r).has(id), base: null, status: null };
      builders.set(key, x);
    }
    return x;
  };

  // ---- 2. ops to entities
  for (const w of works) {
    const ch = w.change;
    const isRoot = !!rootOf(w.lower);
    ch.ops.forEach((op, index) => {
      const row = op.op === "dbf.add" ? op.values : op.op === "dbf.delete" ? op.was : (w.rowA(op.keyText) ?? w.rowB(op.keyText));
      const owners = row ? rowOwners(w.lower, ch.name, row) : [];
      op.owners = owners;
      if (!owners.length) {
        if (ch.coverage === "entities") ch.unassigned++;
        return;
      }
      for (const o of owners) {
        if (o.section === "terrain") {
          const list = terrainOps.get(o.id);
          if (list) list.push({ work: w, index });
          else terrainOps.set(o.id, [{ work: w, index }]);
        } else get(o.section, o.id, isRoot ? w.lower : undefined).ops.push({ work: w, index });
      }
    });
    const keyCols = new Set(ch.keyColumns);
    for (const skip of ch.skipped) {
      if (keyCols.has(skip.field) || !("a" in skip) || !("b" in skip) || sameCell(skip.a, skip.b)) continue;
      const row = w.rowA(skip.keyText);
      if (!row) continue;
      for (const o of rowOwners(w.lower, ch.name, row)) if (o.section !== "terrain") get(o.section, o.id, isRoot ? w.lower : undefined).skips.push({ work: w, skip });
    }
  }

  // ---- 3. pictures, capital layers, scripts, texts
  const fa = indexFrames(a.manifest);
  const fb = indexFrames(b.manifest);
  const pictures = diffPictures(a, b, fa, fb);
  for (const c of pictures.changes) {
    const id = pictureOwnerId(c);
    const kind = id ? classifyId(id) : undefined;
    if (id && kind && exists(kind.section, id)) get(kind.section, id).pictures.push(c);
  }

  const haveCapital = a.capitalDat !== undefined || b.capitalDat !== undefined;
  const capital = haveCapital
    ? diffCapital(a.capitalDat, b.capitalDat, { a: (id) => sa.entityName("buildings", id), b: (id) => sb.entityName("buildings", id) })
    : [];
  const capitalSections = [...parseCapitalDat(a.capitalDat ?? ""), ...parseCapitalDat(b.capitalDat ?? "")];
  const capitalPictures = new Map<string, Set<string>>(); // Capital.ff picture -> buildings
  for (const s of capitalSections) {
    for (const l of s.layers) {
      if (!l.build) continue;
      const set = capitalPictures.get(l.picture) ?? new Set<string>();
      set.add(l.build);
      capitalPictures.set(l.picture, set);
    }
  }
  for (const s of capital) {
    for (const l of s.layers) {
      if (!l.build || !exists("buildings", l.build)) continue;
      const z = (l.b ?? l.a)!.z;
      get("buildings", l.build).pictures.push({ kind: "capital-layer", name: `${s.name}/LAYER_${z}`, archive: "capital.dat", change: l.change, ...(l.a ? { a: { layer: l.a } } : {}), ...(l.b ? { b: { layer: l.b } } : {}) });
    }
  }
  for (const c of pictures.changes) {
    if (!c.archive || !/^capital\.ff$/i.test(c.archive)) continue;
    for (const build of capitalPictures.get(c.name.toUpperCase()) ?? []) if (exists("buildings", build)) get("buildings", build).pictures.push(c);
  }

  const scripts = diffScripts(a, b, sa, sb, nameOf);
  for (const s of scripts) for (const m of s.modifiers) get("modifiers", m.id).scripts.push({ path: s.path, change: s.change });

  const refsA = buildRefs(sa, canonical);
  const refsB = buildRefs(sb, canonical);
  // a text that changed under the same id: shown under every entity whose rows name it in both mods
  for (const x of [...builders.values()]) {
    if (skipTexts || x.section !== "texts" || !x.inA || !x.inB) continue;
    const ta = sa.root(x.root).get(x.id)?.TEXT;
    const tb = sb.root(x.root).get(x.id)?.TEXT;
    if (ta === tb) continue;
    const textA = typeof ta === "string" ? stripStyle(ta) : null;
    const textB = typeof tb === "string" ? stripStyle(tb) : null;
    const inB = new Set((refsB.text.get(x.id) ?? []).map((r) => `${r.via}|${r.owner?.section}|${r.owner?.id}`));
    const seen = new Set<string>();
    for (const r of refsA.text.get(x.id) ?? []) {
      const k = `${r.via}|${r.owner?.section}|${r.owner?.id}`;
      if (!r.owner || !inB.has(k) || seen.has(k)) continue;
      seen.add(k);
      get(r.owner.section, r.owner.id).texts.push({ via: r.via, id: x.id, a: textA, b: textB });
    }
  }

  // ---- 4. statuses: own changes, children, shared rows
  // an add/delete of the root row is its presence, unless both mods have it (a whole-row table)
  const ownOf = (x: Builder) =>
    x.ops.some((o) => o.work.lower !== x.root || o.work.change.ops[o.index]!.op === "dbf.set" || (x.inA && x.inB)) ||
    x.skips.length > 0 ||
    x.texts.length > 0 ||
    x.scripts.length > 0 ||
    x.children.length > 0;
  const baseOf = (x: Builder): EntityStatus | null => {
    if (!x.inA && x.inB) return "added";
    if (x.inA && !x.inB) return "removed";
    if (ownOf(x)) return "changed";
    if (x.pictures.length) return "art-only";
    return null;
  };
  for (const x of builders.values()) if (x.section !== "lords") x.base = baseOf(x);
  for (const x of [...builders.values()]) {
    if (x.section !== "leaderUpgrades" || !x.base || !OWN_STATUSES.has(x.base)) continue;
    const lord = x.id.split(":")[0]!;
    if (!exists("lords", lord)) continue;
    get("lords", lord).children.push({ via: "GleaUpg.BELONGS_TO", section: x.section, id: x.id, name: nameOf(x.section, x.id), status: x.base });
  }
  for (const x of builders.values()) if (x.section === "lords") x.base = baseOf(x);
  for (const x of [...builders.values()]) {
    if (!x.base || !OWN_STATUSES.has(x.base) || x.section === "texts") continue;
    const k = `${x.section}|${x.id}`;
    const seen = new Set<string>();
    for (const refs of [refsA.entity.get(k), refsB.entity.get(k)]) {
      for (const r of refs ?? []) {
        if (!r.shared || !r.owner || !exists(r.owner.section, r.owner.id)) continue;
        const sk = `${r.via}|${r.owner.section}|${r.owner.id}`;
        if (seen.has(sk)) continue;
        seen.add(sk);
        get(r.owner.section, r.owner.id).shared.push({ via: r.via, section: x.section, id: x.id, name: nameOf(x.section, x.id), status: x.base });
      }
    }
  }
  for (const x of builders.values()) {
    x.base ??= baseOf(x);
    x.status = x.base === "art-only" && x.shared.length ? "changed" : (x.base ?? (x.shared.length ? "via-shared" : null));
  }

  // ---- entities
  const listCache = new Map<string, Map<string, Row[]>>();
  const ownerRows = (side: ModSide, tag: string, lower: string, column: string, owner: string): Row[] => {
    const k = `${tag}|${lower}|${column}`;
    let m = listCache.get(k);
    if (!m) {
      m = new Map();
      for (const row of side.liveRows(lower)) {
        const o = normId(row[column]);
        const list = m.get(o);
        if (list) list.push(row);
        else m.set(o, [row]);
      }
      listCache.set(k, m);
    }
    return m.get(owner) ?? [];
  };
  const buildingRaces = (side: ModSide) => {
    const lordRace = new Map<string, string>();
    for (const [id, row] of side.root("glord")) lordRace.set(id, normId(row.RACE_ID));
    const out = new Map<string, Set<string>>();
    for (const row of side.liveRows("gbuilist")) {
      const race = lordRace.get(normId(row.LORD_ID));
      if (!race) continue;
      const bid = normId(row.BUILD_ID);
      const set = out.get(bid) ?? new Set<string>();
      set.add(race);
      out.set(bid, set);
    }
    return out;
  };
  const racesOfBuildingA = buildingRaces(sa);
  const racesOfBuildingB = buildingRaces(sb);

  const usedByOf = (section: SectionId, id: string): UsedBy[] => {
    const lists: [Ref[] | undefined, "a" | "b"][] =
      section === "texts"
        ? [
            [refsA.text.get(id), "a"],
            [refsB.text.get(id), "b"],
          ]
        : [
            [refsA.entity.get(`${section}|${id}`), "a"],
            [refsB.entity.get(`${section}|${id}`), "b"],
          ];
    const m = new Map<string, UsedBy>();
    for (const [refs, side] of lists) {
      for (const r of refs ?? []) {
        const k = `${r.via}|${r.owner ? `${r.owner.section}|${r.owner.id}` : `row|${r.label}`}`;
        const e = m.get(k);
        if (e) {
          if (e.side !== side) e.side = "both";
          continue;
        }
        m.set(k, { via: r.via, section: r.owner?.section ?? null, id: r.owner?.id ?? r.label, name: r.owner ? nameOf(r.owner.section, r.owner.id) : null, side });
      }
    }
    return [...m.values()];
  };

  const sections = Object.fromEntries(SECTIONS.map((s) => [s, [] as EntityChange[]])) as Record<SectionId, EntityChange[]>;
  const entityOf = new Map<string, EntityChange>(); // `${section}|${id}` -> entity (first root)
  for (const x of builders.values()) {
    if (!x.status) continue;
    const e = buildEntity(x);
    sections[x.section].push(e);
    const k = `${x.section}|${x.id}`;
    if (!entityOf.has(k)) entityOf.set(k, e);
  }
  for (const s of SECTIONS) sections[s].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : p.table.localeCompare(q.table)));

  function fieldOf(work: TableWork, index: number): FieldChange | undefined {
    const op = work.change.ops[index]!;
    if (op.op !== "dbf.set") return undefined;
    const f: FieldChange = { table: work.change.name, field: op.field, a: op.was, b: op.value };
    if (op.wasText !== undefined) f.aText = op.wasText;
    if (op.valueText !== undefined) f.bText = op.valueText;
    return f;
  }

  function uncarried(work: TableWork, skip: Skip): FieldChange {
    const f: FieldChange = { table: work.change.name, field: skip.field, a: skip.a ?? null, b: skip.b ?? null, uncarried: true };
    const at = sa.display(work.lower, skip.field, skip.a ?? null);
    const bt = sb.display(work.lower, skip.field, skip.b ?? null);
    if (at !== undefined) f.aText = at;
    if (bt !== undefined) f.bText = bt;
    return f;
  }

  function rowChanges(ops: OpAt[], skips: { work: TableWork; skip: Skip }[]): RowChange[] {
    const m = new Map<string, RowChange>();
    const at = (work: TableWork, keyText: string, key: CellValue[]) => {
      const k = `${work.lower}|${keyText}`;
      let rc = m.get(k);
      if (!rc) {
        rc = { table: work.change.name, key, keyText, change: "changed", fields: [], ops: [] };
        const ra = work.rowA(keyText);
        const rb = work.rowB(keyText);
        if (ra) rc.rowA = ra;
        if (rb) rc.rowB = rb;
        m.set(k, rc);
      }
      return rc;
    };
    for (const { work, index } of ops) {
      const op = work.change.ops[index]!;
      const rc = at(work, op.keyText, op.key);
      rc.ops.push(index);
      if (op.op === "dbf.add") rc.change = "added";
      else if (op.op === "dbf.delete") rc.change = "removed";
      else rc.fields.push(fieldOf(work, index)!);
    }
    for (const { work, skip } of skips) at(work, skip.keyText, skip.key).fields.push(uncarried(work, skip));
    return [...m.values()];
  }

  function buildEntity(x: Builder): EntityChange {
    const table = sa.displayName(x.root) ?? sb.displayName(x.root) ?? defaultRootName(x.section, x.id);
    const spec = rootOf(x.root)!;
    const rowA = sa.root(x.root).get(x.id);
    const rowB = sb.root(x.root).get(x.id);
    const fields: FieldChange[] = [];
    const ownedOps: OpAt[] = [];
    const ownedSkips: { work: TableWork; skip: Skip }[] = [];
    const listOps = new Map<string, OpAt[]>();
    const ops: OpRef[] = [];
    for (const o of x.ops) {
      ops.push({ table: o.work.change.name, index: o.index });
      if (o.work.lower === x.root) {
        const f = fieldOf(o.work, o.index);
        if (f) fields.push(f);
      } else if (o.work.change.key?.kind === "row") {
        const list = listOps.get(o.work.lower);
        if (list) list.push(o);
        else listOps.set(o.work.lower, [o]);
      } else ownedOps.push(o);
    }
    for (const s of x.skips) {
      if (s.work.lower === x.root) fields.push(uncarried(s.work, s.skip));
      else ownedSkips.push(s);
    }
    const lists: ListChange[] = [];
    for (const [lower, list] of listOps) {
      const work = list[0]!.work;
      const column = ownedSpecs(lower).find((o) => o.section === x.section)?.column ?? "";
      const removed: Row[] = [];
      const added: Row[] = [];
      for (const o of list) {
        const op = work.change.ops[o.index]!;
        if (op.op === "dbf.add") added.push(op.values);
        else if (op.op === "dbf.delete") removed.push(op.was);
      }
      lists.push({ table: work.change.name, ownerColumn: column, owner: x.id, a: ownerRows(sa, "a", lower, column, x.id), b: ownerRows(sb, "b", lower, column, x.id), removed, added, ops: list.map((o) => o.index) });
    }
    const newColumns: FieldChange[] = [];
    if (rowA && rowB) {
      for (const [f, v] of Object.entries(rowB)) if (!(f in rowA) && !blank(v)) newColumns.push({ table, field: f, a: null, b: v, ...(sb.display(x.root, f, v) ? { bText: sb.display(x.root, f, v)! } : {}) });
      for (const [f, v] of Object.entries(rowA)) if (!(f in rowB) && !blank(v)) newColumns.push({ table, field: f, a: v, b: null, ...(sa.display(x.root, f, v) ? { aText: sa.display(x.root, f, v)! } : {}) });
    }
    const group: EntityChange["group"] = {};
    const groupText: Record<string, string> = {};
    const gr = rowB ?? rowA;
    const gside = rowB ? sb : sa;
    for (const [g, col] of spec.group) {
      if (!gr || !(col in gr)) continue;
      const v = gr[col]!;
      group[g] = typeof v === "string" && classifyId(v) ? normId(v) : v;
      const t = gside.display(x.root, col, v);
      if (t) groupText[g] = t;
    }
    for (const [k, v] of Object.entries(spec.tags ?? {})) group[k] = v;
    if (x.section === "buildings") {
      const races = [...(racesOfBuildingB.get(x.id) ?? racesOfBuildingA.get(x.id) ?? [])].sort();
      group.races = races;
      const names = races.map((r) => nameOf("races", r)).filter((n): n is string => !!n);
      if (names.length) groupText.races = names.join(", ");
    }
    if (x.section === "leaderUpgrades") {
      const lord = x.id.split(":")[0]!;
      const lr = sb.root("glord").get(lord) ?? sa.root("glord").get(lord);
      if (lr) {
        group.race = normId(lr.RACE_ID);
        const n = nameOf("races", group.race);
        if (n) groupText.race = n;
      }
      const ln = nameOf("lords", lord);
      if (ln) groupText.lord = ln;
    }
    if (x.section === "texts") group.kind = classifyId(x.id)?.code ?? "";
    if (x.section === "rules") group.table = table;
    const textName = (row: Row | undefined) => (row && typeof row.TEXT === "string" ? stripStyle(row.TEXT) : null);
    const e: EntityChange = {
      uid: `${x.section}:${table}:${x.id}`,
      section: x.section,
      table,
      id: x.id,
      nameA: x.section === "texts" ? textName(rowA) : x.inA ? sa.entityName(x.section, x.id) : null,
      nameB: x.section === "texts" ? textName(rowB) : x.inB ? sb.entityName(x.section, x.id) : null,
      status: x.status!,
      fields,
      newColumns,
      owned: rowChanges(ownedOps, ownedSkips),
      lists,
      texts: x.texts,
      scripts: x.scripts,
      children: x.children,
      shared: x.shared,
      pictures: x.pictures,
      usedBy: usedByOf(x.section, x.id),
      group,
      groupText,
      ops,
    };
    if (!x.inA && !x.inB) e.orphan = true;
    if (rowA) {
      e.rowA = rowA;
      e.rowTextA = sa.rowText(x.root, rowA)!;
    }
    if (rowB) {
      e.rowB = rowB;
      e.rowTextB = sb.rowText(x.root, rowB)!;
    }
    return e;
  }

  // ---- 5. races, terrain, summary
  const ref = (section: SectionId, id: string): EntityRef => ({ section, id, name: nameOf(section, id) });
  // a unit's picture file by unit id, and the first unit of A with each picture
  const unitIcons = (files: ModData["files"]) => {
    const m = new Map<string, string>();
    for (const [name, file] of Object.entries(files ?? {})) {
      const id = /^uniticons\/([^/]+)\.png$/i.exec(name)?.[1];
      const sha = shaOf(file);
      if (id && sha) m.set(id.toUpperCase(), sha);
    }
    return m;
  };
  const iconsB = unitIcons(b.files);
  const unitByIconA = new Map<string, string>();
  for (const [id, sha] of [...unitIcons(a.files)].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (!unitByIconA.has(sha)) unitByIconA.set(sha, id);
  }
  const copyOf = (section: SectionId, id: string): string | undefined => {
    if (section !== "units") return undefined;
    const sha = iconsB.get(id.toUpperCase());
    return sha ? unitByIconA.get(sha) : undefined;
  };
  const members = (section: SectionId, ida: Set<string>, idb: Set<string>): RaceMembers => {
    const changed: RaceMembers["changed"] = [];
    for (const id of ida) {
      if (!idb.has(id)) continue;
      const e = entityOf.get(`${section}|${id}`);
      if (e) changed.push({ ...ref(section, id), status: e.status });
    }
    const added = [...idb].filter((id) => !ida.has(id));
    const copies: RaceMembers["copies"] = [];
    for (const id of added) {
      const of = copyOf(section, id);
      if (of) copies.push({ ...ref(section, id), of: ref(section, of) });
    }
    return {
      countA: ida.size,
      countB: idb.size,
      added: added.map((id) => ref(section, id)),
      removed: [...ida].filter((id) => !idb.has(id)).map((id) => ref(section, id)),
      changed,
      copies,
    };
  };
  const byRace = (side: ModSide, lower: string, column: string) => {
    const m = new Map<string, Set<string>>();
    for (const [id, row] of side.root(lower)) {
      const r = normId(row[column]);
      const set = m.get(r) ?? new Set<string>();
      set.add(id);
      m.set(r, set);
    }
    return m;
  };
  const raceBuildings = (side: ModSide) => {
    const m = new Map<string, Set<string>>();
    for (const [bid, races] of buildingRaces(side)) {
      for (const r of races) {
        const set = m.get(r) ?? new Set<string>();
        set.add(bid);
        m.set(r, set);
      }
    }
    return m;
  };
  const unitsA = byRace(sa, "gunits", "RACE_ID");
  const unitsB = byRace(sb, "gunits", "RACE_ID");
  const lordsA = byRace(sa, "glord", "RACE_ID");
  const lordsB = byRace(sb, "glord", "RACE_ID");
  const buildA = raceBuildings(sa);
  const buildB = raceBuildings(sb);
  const capitalByName = new Map(capital.map((c) => [c.name, c]));
  const usedCapital = new Set<string>();
  const threshold = options.redesignThreshold ?? 0.5;
  const tc = terrainCodes([sa, sb]);
  const raceIds = [...new Set([...sa.root("grace").keys(), ...sb.root("grace").keys()])];
  const races: RaceChange[] = raceIds.map((id) => {
    const rowA = sa.root("grace").get(id);
    const rowB = sb.root("grace").get(id);
    const e = entityOf.get(`races|${id}`);
    const raceType = (rowB?.RACE_TYPE ?? rowA?.RACE_TYPE ?? null) as number | null;
    const lrace = sb.lookup("Lrace", raceType) ?? sa.lookup("Lrace", raceType) ?? null;
    const capitalSection = lrace ? lrace.replace(/^L_/i, "").toUpperCase() : null;
    const code0 = capitalSection ? capitalSection.slice(0, 2) : null;
    const code = code0 && tc.codes.has(code0) ? code0 : null;
    // slots
    const soldiers = Math.max(
      7,
      ...[rowA, rowB].flatMap((r) => Object.keys(r ?? {}).map((k) => /^SOLDIER_(\d+)$/.exec(k)?.[1]).filter((n): n is string => !!n).map(Number)),
    );
    const slotNames = [...RACE_SLOT_HEAD, ...Array.from({ length: soldiers }, (_, i) => `SOLDIER_${i + 1}`), ...RACE_SLOT_TAIL];
    const slots: SlotChange[] = slotNames.map((slot) => {
      const va = rowA ? (rowA[slot] ?? null) : null;
      const vb = rowB ? (rowB[slot] ?? null) : null;
      const s: SlotChange = { slot, a: va, b: vb, changed: !sameCell(va, vb) };
      const ta = sa.display("grace", slot, va);
      const tb = sb.display("grace", slot, vb);
      if (ta) s.aText = ta;
      if (tb) s.bText = tb;
      return s;
    });
    const cap = capitalSection ? capitalByName.get(capitalSection) : undefined;
    if (cap) usedCapital.add(cap.name);
    // pictures: by RACE_ID (the race entity's) and by the race's code
    const pics: PictureChange[] = [...(e?.pictures ?? [])];
    const capitalNames = new Set<string>();
    for (const s of capitalSections) if (s.name === capitalSection) for (const l of s.layers) capitalNames.add(l.picture);
    if (code) {
      const byCode = new RegExp(`^(G000FT0000${code}|G000FT0000NE\\d${code}|LORD${code}|CAP${code}$|CITY${code}|UPGRADE${code}|FACE_${code}_)`, "i");
      for (const c of pictures.changes) {
        if (c.kind === "icon") continue;
        const isCapital = !!c.archive && /^capital\.ff$/i.test(c.archive) && capitalNames.has(c.name.toUpperCase());
        if ((byCode.test(c.name) || isCapital) && !pics.includes(c)) pics.push(c);
      }
    }
    const units = members("units", unitsA.get(id) ?? new Set(), unitsB.get(id) ?? new Set());
    const buildings = members("buildings", buildA.get(id) ?? new Set(), buildB.get(id) ?? new Set());
    const lords = members("lords", lordsA.get(id) ?? new Set(), lordsB.get(id) ?? new Set());
    // how much of the race in B is new: what B has that A does not (a copy under a new id
    // is not new); what B cut is no new content and does not count
    const fresh = (m: RaceMembers) => (m.countB ? Math.min(1, (m.added.length - m.copies.length) / m.countB) : 0);
    const parts = {
      units: fresh(units),
      buildings: fresh(buildings),
      capital: cap && cap.layersB ? Math.min(1, cap.layers.filter((l) => l.change !== "removed").length / cap.layersB) : 0,
      slots: slots.filter((s) => s.changed).length / slots.length,
    };
    const score = Math.round((0.35 * parts.units + 0.35 * parts.buildings + 0.2 * parts.capital + 0.1 * parts.slots) * 1000) / 1000;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    return {
      id,
      nameA: rowA ? sa.entityName("races", id) : null,
      nameB: rowB ? sb.entityName("races", id) : null,
      presence: rowA && rowB ? "both" : rowA ? "onlyA" : "onlyB",
      status: e?.status ?? null,
      raceType,
      lrace,
      capitalSection,
      code,
      slots,
      units,
      buildings,
      lords,
      owned: e?.owned ?? [],
      lists: e?.lists ?? [],
      capital: cap ?? null,
      pictures: pics,
      redesign: { score, redesigned: score >= threshold, parts: { units: round(parts.units), buildings: round(parts.buildings), capital: round(parts.capital), slots: round(parts.slots) } },
    };
  });
  const capitalOther: CapitalSectionChange[] = capital.filter((c) => !usedCapital.has(c.name));

  const artA = countTerrainArt(fa, tc);
  const artB = countTerrainArt(fb, tc);
  const tp = terrainPictures(pictures.changes, tc);
  const terrain: TerrainChange[] = [...tc.codes].map(([code, info]) => ({
    code,
    id: info.id,
    name: info.name,
    pictures: tp.byCode.get(code) ?? { forests: [], mountains: [], ground: [], borders: [] },
    counts: { forestsA: artA.get(code)?.forests ?? 0, forestsB: artB.get(code)?.forests ?? 0, mountainsA: artA.get(code)?.mountains ?? 0, mountainsB: artB.get(code)?.mountains ?? 0 },
    tiles: rowChanges(terrainOps.get(code) ?? [], []),
  }));
  for (const [code, ops] of terrainOps) if (!tc.codes.has(code)) terrain.push({ code, id: null, name: null, pictures: { forests: [], mountains: [], ground: [], borders: [] }, counts: { forestsA: 0, forestsB: 0, mountainsA: 0, mountainsB: 0 }, tiles: rowChanges(ops, []) });

  const tables = works.map((w) => w.change);
  const summary = summarize(tables, sections, pictures, scripts, races, terrain);
  return {
    version: 1,
    a: { id: a.id, name: a.name },
    b: { id: b.id, name: b.name },
    tables,
    sections,
    races,
    capitalOther,
    terrain,
    terrainOther: tp.other,
    pictures,
    scripts,
    texts: { a: scriptA, b: scriptB, skipped: skipTexts },
    summary,
  };
}

/** modscripts/* files by hash, with the modifiers whose SCRIPT names each. */
function diffScripts(a: ModData, b: ModData, sa: ModSide, sb: ModSide, nameOf: (s: SectionId, id: string) => string | null): ScriptChange[] {
  const files = (f: ModData["files"]) => {
    const m = new Map<string, { path: string; hash: string }>();
    for (const [path, v] of Object.entries(f ?? {})) if (/^modscripts\//i.test(path)) m.set(path.toLowerCase(), { path, hash: shaOf(v) ?? v });
    return m;
  };
  const fa = files(a.files);
  const fb = files(b.files);
  const users = new Map<string, Set<string>>();
  for (const side of [sa, sb]) {
    for (const [id, row] of side.root("gmodif")) {
      if (typeof row.SCRIPT !== "string" || isNoId(row.SCRIPT)) continue;
      const k = `modscripts/${row.SCRIPT.trim().replace(/\\/g, "/")}`.toLowerCase();
      const set = users.get(k) ?? new Set<string>();
      set.add(id);
      users.set(k, set);
    }
  }
  const out: ScriptChange[] = [];
  const mods = (k: string): EntityRef[] => [...(users.get(k) ?? [])].sort().map((id) => ({ section: "modifiers", id, name: nameOf("modifiers", id) }));
  for (const [k, x] of fa) {
    const y = fb.get(k);
    if (!y) out.push({ path: x.path, change: "removed", a: x.hash, modifiers: mods(k) });
    else if (x.hash !== y.hash) out.push({ path: y.path, change: "changed", a: x.hash, b: y.hash, modifiers: mods(k) });
  }
  for (const [k, y] of fb) if (!fa.has(k)) out.push({ path: y.path, change: "added", b: y.hash, modifiers: mods(k) });
  out.sort((p, q) => p.path.localeCompare(q.path));
  return out;
}

function summarize(
  tables: TableChange[],
  sections: Record<SectionId, EntityChange[]>,
  pictures: ModDiff["pictures"],
  scripts: ScriptChange[],
  races: RaceChange[],
  terrain: TerrainChange[],
): DiffSummary {
  const counts = (list: EntityChange[]): SectionCounts => ({
    added: list.filter((e) => e.status === "added").length,
    changed: list.filter((e) => e.status === "changed").length,
    removed: list.filter((e) => e.status === "removed").length,
    artOnly: list.filter((e) => e.status === "art-only").length,
    viaShared: list.filter((e) => e.status === "via-shared").length,
    orphans: list.filter((e) => e.orphan).length,
    total: list.length,
  });
  let ops = 0;
  let set = 0;
  let add = 0;
  let del = 0;
  let skipped = 0;
  let assigned = 0;
  let tableOnly = 0;
  let unassigned = 0;
  let noIdSpellings = 0;
  let translations = 0;
  for (const t of tables) {
    noIdSpellings += t.noIdSpellings;
    translations += t.translations;
    ops += t.ops.length;
    set += t.counts.set;
    add += t.counts.add;
    del += t.counts.delete;
    skipped += t.skipped.length;
    for (const op of t.ops) {
      if (op.owners.length) assigned++;
      else if (t.coverage === "table") tableOnly++;
      else unassigned++;
    }
  }
  return {
    sections: Object.fromEntries(SECTIONS.map((s) => [s, counts(sections[s])])) as Record<SectionId, SectionCounts>,
    tables: {
      compared: tables.filter((t) => t.presence === "both").length,
      differ: tables.filter((t) => t.ops.length > 0).length,
      onlyA: tables.filter((t) => t.presence === "onlyA").map((t) => t.name),
      onlyB: tables.filter((t) => t.presence === "onlyB").map((t) => t.name),
      ops,
      set,
      add,
      delete: del,
      skipped,
      refused: tables.filter((t) => t.error).map((t) => t.name),
      noIdSpellings,
      translations,
    },
    assignedOps: assigned,
    tableOnlyOps: tableOnly,
    unassignedOps: unassigned,
    pictures: { frames: pictures.frames, animations: pictures.animations, icons: pictures.icons },
    scripts: {
      added: scripts.filter((s) => s.change === "added").length,
      changed: scripts.filter((s) => s.change === "changed").length,
      removed: scripts.filter((s) => s.change === "removed").length,
    },
    races: {
      changed: races.filter((r) => r.status || r.units.added.length || r.units.removed.length || r.buildings.added.length || r.buildings.removed.length || r.capital?.layers.length || r.slots.some((s) => s.changed)).map((r) => r.id),
      redesigned: races.filter((r) => r.redesign.redesigned).map((r) => r.id),
    },
    terrain: {
      changed: terrain.filter((t) => t.tiles.length || Object.values(t.pictures).some((l) => l.length)).map((t) => t.code),
    },
  };
}
