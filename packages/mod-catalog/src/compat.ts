/**
 * Does a map fit a mod — and which installed mod does a map belong to?
 *
 * A `.sg` carries no mod marker. What it does carry is ids into the Globals tables, and the
 * tables differ per mod, so the ids a mod does NOT define are both the reason the game
 * rejects a map built for another mod and the signal that tells mods apart: a map scores
 * zero unresolved ids on its own mod and dozens on a different family.
 *
 * The report has the shape of the engine SDK's `CompatibilityReport` (playable / issues /
 * capabilities) so editor and engine reports stay interchangeable.
 */
import { z } from "zod";
import { Capability, ModId } from "./manifest.js";
import type { ModStatus } from "./manifest.js";
import type { GlobalIdRefs, IdSets } from "./ids.js";

/** An id field of the map points at a row the mod's tables do not have. Severity: error. */
export const UNRESOLVED_GLOBAL_ID = "UNRESOLVED_GLOBAL_ID";
/** Script text embedded in the map quotes an id the mod does not define. Severity: warning. */
export const UNRESOLVED_SCRIPT_ID = "UNRESOLVED_SCRIPT_ID";
/** A scenario variable the mod gives no meaning to. Severity: warning. */
export const UNKNOWN_SCEN_VARIABLE = "UNKNOWN_SCEN_VARIABLE";
/** The map needs a capability the target does not provide. Severity: error. */
export const UNSUPPORTED_CAPABILITY = "UNSUPPORTED_CAPABILITY";

export const CompatibilityIssue = z.object({
  code: z.string().min(1),
  capability: z.string().optional(),
  message: z.string(),
  severity: z.enum(["error", "warning"]),
});
export type CompatibilityIssue = z.infer<typeof CompatibilityIssue>;

export const CompatibilityReport = z.object({
  /** No error-level issue: the map can be opened and saved for this mod. */
  playable: z.boolean(),
  issues: z.array(CompatibilityIssue),
  capabilities: z.array(Capability),
});
export type CompatibilityReport = z.infer<typeof CompatibilityReport>;

/** Table code → ids. */
const IdsByTable = z.record(z.string(), z.array(z.string()));

/** How one map fits one mod. */
export const ModCompatibility = z.object({
  modId: ModId,
  family: z.string(),
  familyOrder: z.number().int(),
  /** Distinct ids in the map's id FIELDS, counting only tables the mod indexes. */
  checked: z.number().int().nonnegative(),
  /** …of which the mod does not define. */
  missing: z.number().int().nonnegative(),
  missingByTable: IdsByTable,
  /** The same two counts for ids quoted in embedded script text. */
  scriptChecked: z.number().int().nonnegative(),
  scriptMissing: z.number().int().nonnegative(),
  scriptMissingByTable: IdsByTable,
  report: CompatibilityReport,
});
export type ModCompatibility = z.infer<typeof ModCompatibility>;

/** The outcome of matching one map against the installed mods. */
export const ModDetection = z.object({
  /**
   * `detected`     — one mod family fits best; `modId` is its newest version that fits.
   * `undetermined` — several families fit equally (an empty or tiny map uses ids every mod
   *                  has) or no mod is installed; the caller falls back to an explicit
   *                  choice or the default mod.
   */
  status: z.enum(["detected", "undetermined"]),
  modId: ModId.nullable(),
  /**
   * How many more unresolved ids the best mod of ANOTHER family has than the winner —
   * the strength of the evidence. null when no other family is installed.
   */
  margin: z.number().int().nullable(),
  /** Every considered mod, best first. */
  candidates: z.array(ModCompatibility),
});
export type ModDetection = z.infer<typeof ModDetection>;

/** A mod's ids indexed for lookup: table code → set of ids ({@link indexIdSets}). */
export type IdIndex = ReadonlyMap<string, ReadonlySet<string>>;

/** What {@link detectMod} needs to know about an installed mod. */
export interface ModCandidateInput {
  id: string;
  family: string;
  familyOrder: number;
  status?: ModStatus;
  /** The mod's ids. Pass a prebuilt {@link IdIndex} when matching many maps against one mod. */
  idSets: IdSets | IdIndex;
}

/** How many example ids an issue message lists. */
const MESSAGE_SAMPLE = 8;

function unresolved(
  refs: GlobalIdRefs | undefined,
  defined: IdIndex,
): { checked: number; missing: number; byTable: Record<string, string[]> } {
  let checked = 0;
  let missing = 0;
  const byTable: Record<string, string[]> = {};
  for (const table of Object.keys(refs ?? {}).sort()) {
    const known = defined.get(table);
    if (!known) continue; // the mod does not index this table: nothing to check against
    const absent: string[] = [];
    for (const raw of refs![table]!) {
      const id = raw.toUpperCase();
      checked++;
      if (!known.has(id)) absent.push(id);
    }
    if (absent.length > 0) {
      byTable[table] = absent.sort();
      missing += absent.length;
    }
  }
  return { checked, missing, byTable };
}

function issuesOf(code: string, severity: "error" | "warning", where: string, byTable: Record<string, string[]>): CompatibilityIssue[] {
  return Object.entries(byTable).map(([table, ids]) => {
    const sample = ids.slice(0, MESSAGE_SAMPLE).join(", ");
    const more = ids.length > MESSAGE_SAMPLE ? `, … (+${ids.length - MESSAGE_SAMPLE})` : "";
    return {
      code,
      severity,
      message: `${ids.length} ${table} id(s) ${where} are not defined by this mod: ${sample}${more}`,
    };
  });
}

/** Index a mod's id sets for lookup. Build once per mod, reuse for every map. */
export function indexIdSets(idSets: IdSets): IdIndex {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [table, ids] of Object.entries(idSets.tables)) out.set(table, new Set(ids));
  return out;
}

const asIndex = (ids: IdSets | IdIndex): IdIndex => (ids instanceof Map ? ids : indexIdSets(ids as IdSets));

/**
 * Check a map's id references against one mod's tables.
 *
 * @param refs        ids of the map's id fields (`collectGlobalIds`)
 * @param scriptRefs  ids quoted in embedded script text (`collectScriptGlobalIds`)
 * @param defined     the mod's ids, from {@link indexIdSets}
 */
export function scoreCompatibility(
  refs: GlobalIdRefs,
  defined: IdIndex,
  scriptRefs?: GlobalIdRefs,
): Omit<ModCompatibility, "modId" | "family" | "familyOrder"> {
  const fields = unresolved(refs, defined);
  const script = unresolved(scriptRefs, defined);
  const issues = [
    ...issuesOf(UNRESOLVED_GLOBAL_ID, "error", "referenced by the map", fields.byTable),
    ...issuesOf(UNRESOLVED_SCRIPT_ID, "warning", "quoted in the map's script text", script.byTable),
  ];
  return {
    checked: fields.checked,
    missing: fields.missing,
    missingByTable: fields.byTable,
    scriptChecked: script.checked,
    scriptMissing: script.missing,
    scriptMissingByTable: script.byTable,
    report: { playable: fields.missing === 0, issues, capabilities: [] },
  };
}

/** Unresolved ids of both kinds — the number mods are ranked by. */
const total = (c: ModCompatibility): number => c.missing + c.scriptMissing;

/**
 * Match a map against the installed mods.
 *
 * Mods are ranked by unresolved ids (fields + script text), fewest first. Zero is NOT
 * required: a map may reference ids its own mod lacks and still be that mod's map. Among
 * versions of one family that fit equally, the highest `familyOrder` wins. When the best
 * score is shared by different families the result is `undetermined`.
 *
 * Mods with status `data-only` are not candidates unless `includeDataOnly` is set.
 */
export function detectMod(
  refs: GlobalIdRefs,
  mods: readonly ModCandidateInput[],
  opts: { scriptRefs?: GlobalIdRefs; includeDataOnly?: boolean } = {},
): ModDetection {
  const candidates: ModCompatibility[] = mods
    .filter((m) => opts.includeDataOnly || (m.status ?? "ready") === "ready")
    .map((m) => ({
      modId: m.id,
      family: m.family,
      familyOrder: m.familyOrder,
      ...scoreCompatibility(refs, asIndex(m.idSets), opts.scriptRefs),
    }))
    .sort(
      (a, b) =>
        total(a) - total(b) ||
        (a.family === b.family ? b.familyOrder - a.familyOrder : a.family.localeCompare(b.family)) ||
        a.modId.localeCompare(b.modId),
    );

  const best = candidates[0];
  if (!best) return { status: "undetermined", modId: null, margin: null, candidates };

  const bestScore = total(best);
  const tiedFamilies = new Set(candidates.filter((c) => total(c) === bestScore).map((c) => c.family));
  const others = candidates.filter((c) => c.family !== best.family);
  const margin = others.length > 0 ? Math.min(...others.map(total)) - bestScore : null;

  if (tiedFamilies.size > 1) return { status: "undetermined", modId: null, margin: 0, candidates };
  // `best` is already the highest familyOrder of the winning family at this score (sort order)
  return { status: "detected", modId: best.modId, margin, candidates };
}
