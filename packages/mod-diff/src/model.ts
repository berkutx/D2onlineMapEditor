/**
 * The entity map: which table makes which entity, which tables an entity owns, and where
 * every link column points. Measured on the four mods (semga, semga-2, smns3, nazar-legacy);
 * see the plan's research report.
 */
import type { CellValue } from "@d2/mod-edit";
import { classifyId, normId } from "./ids.js";
import type { Row, SectionId } from "./types.js";

export type LinkTarget =
  | { kind: "entity"; section: SectionId }
  | { kind: "lookup"; table: string }
  | { kind: "text" }
  | { kind: "script" };

interface LinkRule {
  column: string | RegExp;
  target: LinkTarget;
  /** A change of the target shows under the row's owner as "via-shared". */
  shared?: true;
}

const ent = (section: SectionId, shared?: true): Pick<LinkRule, "target" | "shared"> => ({ target: { kind: "entity", section }, ...(shared ? { shared } : {}) });
const lk = (table: string): Pick<LinkRule, "target"> => ({ target: { kind: "lookup", table } });
const TEXT: Pick<LinkRule, "target"> = { target: { kind: "text" } };
const texts = (...cols: string[]): LinkRule[] => cols.map((column) => ({ column, ...TEXT }));

const UNIT_LINKS: LinkRule[] = [
  { column: "UNIT_CAT", ...lk("LunitC") },
  { column: "PREV_ID", ...ent("units") },
  { column: "RACE_ID", ...ent("races") },
  { column: "SUBRACE", ...lk("LSubRace") },
  { column: "BRANCH", ...lk("LunitB") },
  { column: "ENROLL_B", ...ent("buildings") },
  ...texts("NAME_TXT", "DESC_TXT", "ABIL_TXT"),
  { column: "ATTACK_ID", ...ent("attacks", true) },
  { column: "ATTACK2_ID", ...ent("attacks", true) },
  { column: "BASE_UNIT", ...ent("units") },
  { column: "UPGRADE_B", ...ent("buildings") },
  { column: "LEADER_CAT", ...lk("LleadC") },
  { column: "DYN_UPG1", ...ent("dynamicUpgrades", true) },
  { column: "DYN_UPG2", ...ent("dynamicUpgrades", true) },
  { column: "DEATH_ANIM", ...lk("LDthAnim") },
];

const AI_LINKS: LinkRule[] = [{ column: "CATEGORY", ...lk("LaiAtt") }, ...texts("NAME_TXT", "DESC_TXT")];

/** Link columns by table (lower case). */
const LINKS: Record<string, LinkRule[]> = {
  gunits: UNIT_LINKS,
  gunits_2: UNIT_LINKS,
  gattacks: [
    ...texts("NAME_TXT", "DESC_TXT"),
    { column: "SOURCE", ...lk("LattS") },
    { column: "CLASS", ...lk("LattC") },
    { column: "REACH", ...lk("LAttR") },
    { column: "ALT_ATTACK", ...ent("attacks", true) },
    { column: /^WARD\d+$/, ...ent("modifiers", true) },
  ],
  gitem: [
    { column: "ITEM_CAT", ...lk("LmagItm") },
    ...texts("NAME_TXT", "DESC_TXT"),
    { column: "MOD_EQUIP", ...ent("modifiers", true) },
    { column: "MOD_POTION", ...ent("modifiers", true) },
    { column: "SPELL_ID", ...ent("spells", true) },
    { column: "ATTACK_ID", ...ent("attacks", true) },
    { column: "UNIT_ID", ...ent("units") },
  ],
  gspells: [
    { column: "CATEGORY", ...lk("Lspell") },
    ...texts("NAME_TXT", "DESC_TXT", "MODIF_TXT"),
    { column: "UNIT_ID", ...ent("units") },
    { column: "MODIF_ID", ...ent("modifiers", true) },
    { column: "DAMAGE_SRC", ...lk("LattS") },
    { column: "AI_CAT", ...lk("LAiSpell") },
    { column: "GROUND_CAT", ...lk("Lground") },
    { column: /^WARD\d+$/, ...ent("modifiers", true) },
  ],
  gbuild: [...texts("NAME_TXT", "DESC_TXT"), { column: "REQUIRED", ...ent("buildings") }, { column: "CATEGORY", ...lk("Lbuild") }, { column: "BRANCH", ...lk("LunitB") }],
  gbuilist: [
    { column: "LORD_ID", ...ent("lords") },
    { column: "BUILD_ID", ...ent("buildings") },
  ],
  glord: [{ column: "RACE_ID", ...ent("races") }, { column: "CATEGORY", ...lk("Llord") }, ...texts("NAME_TXT", "DESC_TXT")],
  gleaupg: [{ column: "BELONGS_TO", ...ent("lords") }, { column: "MODIF_ID", ...ent("modifiers", true) }, ...texts("NAME_TXT", "DESC_TXT")],
  gspellr: [
    { column: "LORD_ID", ...ent("lords") },
    { column: "SPELL_ID", ...ent("spells") },
  ],
  grace: [
    { column: /^(GUARDIAN|NOBLE|LEADER_\d+|SOLDIER_\d+)$/, ...ent("units") },
    { column: "PROTECTION", ...ent("modifiers", true) },
    ...texts("NAME_TXT"),
    { column: "RACE_TYPE", ...lk("Lrace") },
  ],
  gsubrace: [...texts("NAME_TXT"), { column: "RACE_TYPE", ...lk("LSubRace") }],
  gcityinf: [
    { column: "RACE_ID", ...ent("races") },
    { column: "PROTECTION", ...ent("modifiers", true) },
  ],
  gmodif: [{ column: "SOURCE", ...lk("LModifS") }, ...texts("DESC_TXT"), { column: "SCRIPT", target: { kind: "script" } }],
  gmodifl: [
    { column: "BELONGS_TO", ...ent("modifiers") },
    ...texts("DESC"),
    { column: "TYPE", ...lk("LmodifE") },
    { column: "ABILITY", ...lk("LleadA") },
    { column: "IMMUNITY", ...lk("LattS") },
    { column: "IMMUNITYC", ...lk("LattC") },
    { column: "IMMUNECAT", ...lk("LImmune") },
    { column: "IMMUNECATC", ...lk("LImmune") },
    { column: "MOVE", ...lk("Lground") },
  ],
  gumodif: [
    { column: "UNIT_ID", ...ent("units") },
    { column: /^MODIF_\d+$/, ...ent("modifiers", true) },
  ],
  gimmu: [{ column: "UNIT_ID", ...ent("units") }, { column: "IMMUNITY", ...lk("LattS") }, { column: "IMMUNECAT", ...lk("LImmune") }],
  gimmuc: [{ column: "UNIT_ID", ...ent("units") }, { column: "IMMUNITY", ...lk("LattC") }, { column: "IMMUNECAT", ...lk("LImmune") }],
  glabi: [{ column: "UNIT_ID", ...ent("units") }, { column: "L_ABILITY", ...lk("LleadA") }],
  gmabi: [{ column: "UNIT_ID", ...ent("units") }, { column: "M_ABILITY", ...lk("Lground") }],
  gtransf: [
    { column: "ATTACK_ID", ...ent("attacks") },
    { column: "TRANSF_ID", ...ent("units") },
  ],
  glmark: [...texts("NAME_TXT", "DESC_TXT"), { column: "CATEGORY", ...lk("LLMCat") }],
  gaction: [{ column: "CATEGORY", ...lk("Laction") }, ...texts("NAME_TXT", "DESC_TXT")],
  tleader: [{ column: "RACE_ID", ...ent("races") }],
  taimsg: [{ column: "RACE_ID", ...ent("races") }, { column: "MSG_CAT", ...lk("LAiMsg") }],
  tplayer: [{ column: "RACE_ID", ...ent("races") }],
  lattr: texts("REACH_TXT", "TARGET_TXT"),
  latts: texts("NAME_TXT"),
  levcond: texts("INFO", "BRIEF", "DESCR"),
};

const isAi = (t: string) => /^gai($|_)/.test(t);

export interface Link {
  target: LinkTarget;
  shared: boolean;
}

/** table as given -> column as given -> link (null: none). */
const linkCache = new Map<string, Map<string, Link | null>>();

/** Where a column points, or undefined for a plain value. */
export function linkOf(table: string, column: string): Link | undefined {
  let byColumn = linkCache.get(table);
  if (!byColumn) linkCache.set(table, (byColumn = new Map()));
  const hit = byColumn.get(column);
  if (hit !== undefined) return hit ?? undefined;
  const t = table.toLowerCase();
  const c = column.toUpperCase();
  const rules = LINKS[t] ?? (isAi(t) ? AI_LINKS : undefined);
  const rule = rules?.find((r) => (typeof r.column === "string" ? r.column === c : r.column.test(c)));
  const link = rule ? { target: rule.target, shared: !!rule.shared } : null;
  byColumn.set(column, link);
  return link ?? undefined;
}

// ---------------------------------------------------------------- roots and owned tables

export interface RootSpec {
  section: SectionId;
  /** The table's usual name ("Gunits"; "GAI" for the AI tables). */
  name: string;
  match: (lowerTable: string) => boolean;
  idColumns: string[];
  /** The entity id of a row. */
  idOf: (row: Row, tableName: string) => string;
  nameColumn?: string;
  /** Its own change also changes this entity (a leader upgrade's lord). */
  parent?: { section: SectionId; column: string };
  /** Group name -> column. */
  group: [string, string][];
  /** Constant groups. */
  tags?: Record<string, string>;
}

const one = (column: string) => (row: Row) => normId(row[column]);
const exact = (name: string) => (t: string) => t === name;

export const ROOTS: readonly RootSpec[] = [
  {
    section: "units",
    name: "Gunits",
    match: exact("gunits"),
    idColumns: ["UNIT_ID"],
    idOf: one("UNIT_ID"),
    nameColumn: "NAME_TXT",
    group: [["race", "RACE_ID"], ["subrace", "SUBRACE"], ["level", "LEVEL"], ["category", "UNIT_CAT"], ["branch", "BRANCH"], ["leaderCategory", "LEADER_CAT"], ["small", "SIZE_SMALL"]],
  },
  { section: "attacks", name: "Gattacks", match: exact("gattacks"), idColumns: ["ATT_ID"], idOf: one("ATT_ID"), nameColumn: "NAME_TXT", group: [["source", "SOURCE"], ["class", "CLASS"], ["reach", "REACH"]] },
  { section: "items", name: "GItem", match: exact("gitem"), idColumns: ["ITEM_ID"], idOf: one("ITEM_ID"), nameColumn: "NAME_TXT", group: [["category", "ITEM_CAT"]] },
  { section: "spells", name: "Gspells", match: exact("gspells"), idColumns: ["SPELL_ID"], idOf: one("SPELL_ID"), nameColumn: "NAME_TXT", group: [["category", "CATEGORY"], ["level", "LEVEL"]] },
  { section: "buildings", name: "Gbuild", match: exact("gbuild"), idColumns: ["BUILD_ID"], idOf: one("BUILD_ID"), nameColumn: "NAME_TXT", group: [["category", "CATEGORY"], ["branch", "BRANCH"], ["level", "LEVEL"]] },
  { section: "lords", name: "Glord", match: exact("glord"), idColumns: ["LORD_ID"], idOf: one("LORD_ID"), nameColumn: "NAME_TXT", group: [["race", "RACE_ID"], ["category", "CATEGORY"]] },
  { section: "races", name: "Grace", match: exact("grace"), idColumns: ["RACE_ID"], idOf: one("RACE_ID"), nameColumn: "NAME_TXT", group: [["raceType", "RACE_TYPE"], ["playable", "PLAYABLE"]], tags: { kind: "race" } },
  { section: "races", name: "GSubRace", match: exact("gsubrace"), idColumns: ["RACE_ID"], idOf: one("RACE_ID"), nameColumn: "NAME_TXT", group: [["subraceType", "RACE_TYPE"]], tags: { kind: "subrace" } },
  { section: "modifiers", name: "Gmodif", match: exact("gmodif"), idColumns: ["MODIF_ID"], idOf: one("MODIF_ID"), nameColumn: "DESC_TXT", group: [["source", "SOURCE"]] },
  { section: "landmarks", name: "GLmark", match: exact("glmark"), idColumns: ["LMARK_ID"], idOf: one("LMARK_ID"), nameColumn: "NAME_TXT", group: [["category", "CATEGORY"], ["mountain", "MOUNTAIN"]] },
  {
    section: "leaderUpgrades",
    name: "GleaUpg",
    match: exact("gleaupg"),
    idColumns: ["BELONGS_TO", "MODIF_ID"],
    idOf: (row) => `${normId(row.BELONGS_TO)}:${normId(row.MODIF_ID)}`,
    nameColumn: "NAME_TXT",
    parent: { section: "lords", column: "BELONGS_TO" },
    group: [["lord", "BELONGS_TO"], ["minLevel", "MIN_LEVEL"], ["modifier", "MODIF_ID"]],
  },
  { section: "dynamicUpgrades", name: "GDynUpgr", match: exact("gdynupgr"), idColumns: ["UPGRADE_ID"], idOf: one("UPGRADE_ID"), group: [] },
  { section: "texts", name: "Tglobal", match: exact("tglobal"), idColumns: ["TXT_ID"], idOf: one("TXT_ID"), nameColumn: "TEXT", group: [], tags: { table: "Tglobal" } },
  { section: "texts", name: "TApp", match: exact("tapp"), idColumns: ["TXT_ID"], idOf: one("TXT_ID"), nameColumn: "TEXT", group: [], tags: { table: "TApp" } },
  { section: "texts", name: "TAppEdit", match: exact("tappedit"), idColumns: ["TXT_ID"], idOf: one("TXT_ID"), nameColumn: "TEXT", group: [], tags: { table: "TAppEdit" } },
  { section: "rules", name: "GVars", match: exact("gvars"), idColumns: [], idOf: () => "GVars", group: [], tags: { kind: "vars" } },
  { section: "rules", name: "GAI", match: isAi, idColumns: ["CATEGORY"], idOf: (row, t) => `${t}#${String(row.CATEGORY ?? "")}`, nameColumn: "NAME_TXT", group: [["aiCategory", "CATEGORY"]], tags: { kind: "ai" } },
  { section: "rules", name: "Gaction", match: exact("gaction"), idColumns: ["ACTION_ID"], idOf: one("ACTION_ID"), nameColumn: "NAME_TXT", group: [["category", "CATEGORY"]], tags: { kind: "thief-action" } },
];

/** The usual root table of an entity of a section ("races" + "G000BR0001" -> GSubRace). */
export function defaultRootName(section: SectionId, id: string): string {
  const kind = classifyId(id);
  if (kind && kind.section === section) return kind.table;
  return ROOTS.find((r) => r.section === section)!.name;
}

/** The root spec of a table, or undefined. */
export function rootOf(table: string): RootSpec | undefined {
  const t = table.toLowerCase();
  return ROOTS.find((r) => r.match(t));
}

export interface OwnedSpec {
  table: string;
  section: SectionId;
  column: string;
}

/** Tables whose rows belong to an entity through an owner column. A row may have two owners. */
export const OWNED: readonly OwnedSpec[] = [
  { table: "gimmu", section: "units", column: "UNIT_ID" },
  { table: "gimmuc", section: "units", column: "UNIT_ID" },
  { table: "glabi", section: "units", column: "UNIT_ID" },
  { table: "gmabi", section: "units", column: "UNIT_ID" },
  { table: "gumodif", section: "units", column: "UNIT_ID" },
  { table: "gtransf", section: "attacks", column: "ATTACK_ID" },
  { table: "gbuilist", section: "lords", column: "LORD_ID" },
  { table: "gbuilist", section: "buildings", column: "BUILD_ID" },
  { table: "gspellr", section: "lords", column: "LORD_ID" },
  { table: "gspellr", section: "spells", column: "SPELL_ID" },
  { table: "gcityinf", section: "races", column: "RACE_ID" },
  { table: "tplayer", section: "races", column: "RACE_ID" },
  { table: "tleader", section: "races", column: "RACE_ID" },
  { table: "taimsg", section: "races", column: "RACE_ID" },
  { table: "gmodifl", section: "modifiers", column: "BELONGS_TO" },
];

export function ownedSpecs(table: string): OwnedSpec[] {
  const t = table.toLowerCase();
  return OWNED.filter((o) => o.table === t);
}

/** The table that holds terrain tile counts by code. */
export const TILE_TABLE = "gtiledbi";

/** True when an entity or terrain takes the table's ops; false for L*, Gunits_2 and unknown tables. */
export function coveredTable(table: string): boolean {
  const t = table.toLowerCase();
  return !!rootOf(t) || ownedSpecs(t).length > 0 || t === TILE_TABLE;
}

/** Grace columns shown as race slots, in this order (SOLDIER_n up to what either side has). */
export const RACE_SLOT_HEAD = ["GUARDIAN", "NOBLE", "LEADER_1", "LEADER_2", "LEADER_3", "LEADER_4"];
export const RACE_SLOT_TAIL = ["SCOUT", "REGEN_H", "INCOME", "PROTECTION"];

export function cellText(v: CellValue | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}
