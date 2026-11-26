/**
 * A guard by budget: compose a stack out of a mod's units for a wanted STRENGTH, and loot out of
 * its items for a wanted VALUE. Pure and seeded — the same seed gives the same guard, the next
 * seed another one, so a mapmaker can leaf through variants.
 *
 * What it is counted in
 *  - strength = the experience a victory over the stack gives (Gunits XP_KILLED, summed): the
 *    game's own measure of how strong a unit is. Stacks of the shipped maps: a quarter are
 *    below ~200, half below ~450, nine in ten below ~1500.
 *  - loot value = the gold part of the items' VALUE, summed.
 *
 * What the game demands of a stack — measured on the maps the mods ship with, not assumed:
 *  - the leader is a unit of the leader category (L_LEADER); only a leader has a figure on the
 *    map, a stack led by a soldier shows nothing;
 *  - LEADERSHIP counts every slot of the stack, the leader's own included (a thief has 1 and
 *    walks alone; a leader with 4 never has more than four slots taken), a big unit takes two;
 *  - six cells in three rows: cell 2r is the FRONT of row r, 2r+1 its BACK; a big unit takes
 *    both cells of a row. 96% of melee units stand in front, 88% of the others behind.
 *
 * So a guard gets a leader, melee units in front, archers / mages / support behind, and — when
 * there is more than one unit and the roles allow — somebody in each line.
 *
 * The guards of a ruin and the defense of a city are the same six cells with NO leader in them
 * (nobody walks, so nobody needs a figure): `leaderless` composes those out of soldiers alone.
 */

/** What the composer needs of a unit: a subset of the mod's unit catalogue entry. */
export interface GuardUnitInfo {
  id: string;
  /** base level (LEVEL) — a unit never goes below it */
  level: number;
  /** LunitC key: L_LEADER, L_SOLDIER, … */
  catKey: string;
  subraceId: number;
  hp: number;
  /** XP_KILLED at the base level */
  xp?: number;
  leadership?: number;
  /** LunitB key: L_FIGHTER, L_ARCHER, L_MAGE, L_SPECIAL, … */
  branch?: string;
  /** LleadC key of a leader: L_FIGHTER, L_MAGE, L_EXPLORER, L_ROD, L_NOBLE */
  leaderKey?: string;
  /** the main attack only reaches an adjacent enemy */
  melee?: boolean;
  /** the main attack hits several targets at once */
  area?: boolean;
  /** class of the main attack (LattC key) */
  atk?: string;
  /** [DYN_UPG_LV, hp1, xp1, hp2, xp2] — growth per level up to that level, and after it */
  dyn?: number[];
  /** a big unit: both cells of its row */
  large?: boolean;
  /** lives only on water */
  water?: boolean;
}

export type GuardRole = "fighter" | "archer" | "mage" | "support";
export const GUARD_ROLES: readonly GuardRole[] = ["fighter", "archer", "mage", "support"];

/** Attacks that help the unit's own side instead of hurting the enemy. */
const SUPPORT_ATTACKS = new Set(["L_HEAL", "L_CURE", "L_REVIVE", "L_BOOST_DAMAGE", "L_BESTOW_WARDS", "L_GIVE_ATTACK", "L_SUMMON"]);

/**
 * The part a unit plays in a stack. A healer or a summoner is support; whoever must stand next
 * to the enemy to hit is a fighter; of the rest the game's own branch decides (archer / mage),
 * and a unit of neither branch — a monster, a neutral leader — is told apart by its attack:
 * several targets at once is a mage's way, one target an archer's.
 */
export function guardRole(u: GuardUnitInfo): GuardRole {
  if (u.atk && SUPPORT_ATTACKS.has(u.atk)) return "support";
  if (u.melee) return "fighter";
  if (u.branch === "L_ARCHER" || u.leaderKey === "L_EXPLORER") return "archer";
  if (u.branch === "L_MAGE" || u.leaderKey === "L_MAGE") return "mage";
  return u.area ? "mage" : "archer";
}

/** The game does not show more hit points than this. */
const HP_CAP = 9999;

/**
 * A unit brought to `level`: its level (never below the base one), hit points and strength.
 * Each level above the base adds the unit's growth — the first set (hp1, xp1) while the level
 * is not above DYN_UPG_LV, the second after it. Checked against the leveled units of the maps a
 * mod ships with: this rule gives the stored hit points of 89% of them, the alternatives
 * (boundary one level earlier, first set only) 68% and 75%; the rest were made for older tables.
 * A unit with no growth data stays at its base level.
 */
export function unitAtLevel(u: GuardUnitInfo, level: number | undefined): { level: number; hp: number; xp: number } {
  let hp = u.hp;
  let xp = u.xp ?? 0;
  const dyn = u.dyn;
  const want = Math.floor(level ?? 0);
  if (!dyn || dyn.length < 5 || !(want > u.level)) return { level: u.level, hp, xp };
  const [turn, hp1, xp1, hp2, xp2] = dyn as [number, number, number, number, number];
  for (let n = u.level + 1; n <= want; n++) {
    const first = n <= turn;
    hp += first ? hp1 : hp2;
    xp += first ? xp1 : xp2;
  }
  return { level: want, hp: Math.min(hp, HP_CAP), xp };
}

export interface GuardOptions {
  /** wanted strength: the experience a victory over the stack gives, in total */
  budget: number;
  /** variant number: the same seed composes the same guard */
  seed: number;
  /** bring every unit to at least this level (units whose base level is higher keep it) */
  level?: number;
  /** "one" = one subrace per stack, picked per variant (default) · "mixed" = any units ·
   *  a number = that subrace only */
  subrace?: number | "one" | "mixed";
  /** which roles may be taken, the leader included (default: all four) */
  roles?: readonly GuardRole[];
  /** the stack stands on water: units that live only on water may be taken (never on land) */
  onWater?: boolean;
  /** at most this many units (1..6, default 6) */
  maxUnits?: number;
  /** keep this unit as the leader (a unit id of a leader category) and compose the rest around
   *  it; with "one" subrace the guard is of the leader's subrace. The roles do not bind it. */
  leader?: string;
  /** unit ids never to take (the mapmaker struck them out) */
  exclude?: readonly string[];
  /** a garrison — the guards of a ruin, the defense of a city: soldiers only, nobody leads,
   *  all six cells are free (`leaderCell` of the result is −1) */
  leaderless?: boolean;
}

export interface GuardMember {
  unit: string;
  level: number;
  hp: number;
  /** its strength at that level */
  xp: number;
  role: GuardRole;
  big: boolean;
}

export interface GuardResult {
  /** six formation cells; a big unit is the SAME member in both cells of its row */
  cells: (GuardMember | null)[];
  /** the cell of the leader (the front one for a big leader); −1 for a leaderless garrison */
  leaderCell: number;
  /** the stack's strength: Σ xp of its units (≤ the budget whenever any stack fits it) */
  strength: number;
  /** Σ hit points */
  hp: number;
  /** units in the stack */
  count: number;
  /** subraces met in the stack, ascending */
  subraces: number[];
  /** true when even the cheapest leader alone (the cheapest soldier, for a garrison) is above
   *  the budget (so `strength` is too) */
  overBudget: boolean;
}

/** mulberry32 — a small seeded generator, enough for picking variants */
function rng(seed: number): () => number {
  let a = (seed | 0) ^ 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T>(items: readonly T[], weight: (item: T) => number, rand: () => number): T | undefined {
  let total = 0;
  const ws = items.map((it) => {
    const w = Math.max(0, weight(it));
    total += w;
    return w;
  });
  if (!(total > 0)) return items.length ? items[Math.floor(rand() * items.length)] : undefined;
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= ws[i] as number;
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** a unit as the composer sees it: leveled, with its role and line */
interface Cand {
  u: GuardUnitInfo;
  level: number;
  hp: number;
  xp: number;
  role: GuardRole;
  big: boolean;
  /** stands in front (melee); a big unit stands in both lines */
  front: boolean;
  slots: number;
}

/** Above this many hit points per point of strength a record is not a creature to meet in the
 *  field: a summoned one that gives no experience (xp 1), a technical dummy. The real units of
 *  the four mods end at about 6. */
const MAX_HP_PER_XP = 20;

/** May the unit serve in a guard at all? Leaders and soldiers with a strength of their own. */
function eligible(u: GuardUnitInfo): "leader" | "soldier" | null {
  const xp = u.xp ?? 0;
  if (!(u.hp > 0) || !(xp > 0) || u.hp / xp > MAX_HP_PER_XP) return null;
  if (u.catKey === "L_LEADER") {
    // a rod-bearer plants rods and a thief steals: neither guards anything
    return u.leaderKey === "L_ROD" || u.leaderKey === "L_NOBLE" ? null : "leader";
  }
  // a soldier record with a leader kind is a technical copy of a hero, not a soldier to hire
  if (u.catKey === "L_SOLDIER") return u.leaderKey ? null : "soldier";
  return null; // capital guardians, summons, illusions, thieves
}

/** How close a value is to the one wanted: 1 at the target, falling off on both sides. */
const closeness = (value: number, target: number): number => {
  const t = Math.max(1, target);
  const d = Math.abs(value - t) / t;
  return 1 / (1 + 6 * d * d);
};

/** how many units a stack tends to have (the shipped maps: three or four most often) */
const COUNT_WEIGHTS = [0, 0.5, 1.2, 2, 2, 1.4, 1];
const ROW_ORDER = [1, 0, 2]; // the middle row first: that is where a leader usually stands
const ATTEMPTS = 80;

interface Draft {
  leader: Cand | null;
  others: Cand[];
  total: number;
}

/** capacity of a formation: three front cells, three back cells; a big unit takes one of each */
function fits(members: readonly Cand[], add: Cand, slotCap: number): boolean {
  let front = 0, back = 0, slots = 0;
  for (const m of [...members, add]) {
    slots += m.slots;
    if (m.big) { front++; back++; } else if (m.front) front++; else back++;
  }
  return front <= 3 && back <= 3 && slots <= slotCap;
}

const inFront = (m: Cand): boolean => m.big || m.front;
const inBack = (m: Cand): boolean => m.big || !m.front;

/**
 * Compose a guard. Returns null only when the mod has no unit that may lead one under the
 * given options (no leader of the chosen subrace and roles) — for a leaderless garrison, no
 * soldier to take.
 */
export function composeGuard(units: readonly GuardUnitInfo[], opts: GuardOptions): GuardResult | null {
  const budget = Math.max(1, Math.floor(opts.budget));
  const roles = new Set<GuardRole>(opts.roles?.length ? opts.roles : GUARD_ROLES);
  const maxUnits = Math.min(6, Math.max(1, Math.floor(opts.maxUnits ?? 6)));
  const subrace = opts.subrace ?? "one";

  const excluded = new Set(opts.exclude ?? []);
  const cand = (u: GuardUnitInfo): Cand => {
    const big = !!u.large;
    return { u, ...unitAtLevel(u, opts.level), role: guardRole(u), big, front: !!u.melee, slots: big ? 2 : 1 };
  };
  // a leader the mapmaker keeps: taken as it is, whatever the filters say
  const keptUnit = opts.leader ? units.find((u) => u.id === opts.leader && (u.catKey === "L_LEADER" || u.catKey === "L_NOBLE")) : undefined;
  const kept = keptUnit ? cand(keptUnit) : null;

  let leaders: Cand[] = [];
  const soldiers: Cand[] = [];
  for (const u of units) {
    const kind = eligible(u);
    if (!kind || excluded.has(u.id)) continue;
    if (u.water && !opts.onWater) continue;
    if (typeof subrace === "number" && u.subraceId !== subrace) continue;
    const c = cand(u);
    if (!roles.has(c.role)) continue;
    (kind === "leader" ? leaders : soldiers).push(c);
  }
  const leaderless = !!opts.leaderless;
  if (kept && !leaderless) leaders = [kept];
  if (leaderless ? !soldiers.length : !leaders.length) return null;
  // a stable order, so the result depends on the seed and not on how the catalogue was sorted
  const byId = (a: Cand, b: Cand): number => (a.u.id < b.u.id ? -1 : a.u.id > b.u.id ? 1 : 0);
  leaders.sort(byId);
  soldiers.sort(byId);

  const rand = rng(opts.seed);
  // whoever a guard starts with: its leader, or — in a garrison — any soldier
  const starters = leaderless ? soldiers : leaders;
  const cheapestStarter = starters.reduce((a, b) => (b.xp < a.xp ? b : a));
  const overBudget = cheapestStarter.xp > budget;
  const alone: Draft = leaderless
    ? { leader: null, others: [cheapestStarter], total: cheapestStarter.xp }
    : { leader: cheapestStarter, others: [], total: cheapestStarter.xp };

  const subracesAble = [...new Set(starters.filter((c) => c.xp <= budget).map((c) => c.u.subraceId))].sort((a, b) => a - b);

  let best: Draft | null = null;
  let bestScore = Infinity;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    // ---- whose guard it is
    let pool = soldiers;
    let heads = leaders;
    if (subrace === "one" && subracesAble.length) {
      const sid = subracesAble[Math.floor(rand() * subracesAble.length)] as number;
      heads = leaders.filter((l) => l.u.subraceId === sid);
      pool = soldiers.filter((s) => s.u.subraceId === sid);
    }
    // ---- how many units
    const wanted = Number(pickWeighted([1, 2, 3, 4, 5, 6].filter((n) => n <= maxUnits), (n) => COUNT_WEIGHTS[n] ?? 1, rand) ?? 1);
    const members: Cand[] = [];
    let leader: Cand | null = null;
    let slotCap = 6;
    let left = budget;
    if (!leaderless) {
      // ---- the leader: a share of the budget a little above an even one
      const affordable = heads.filter((l) => l.xp <= budget);
      if (!affordable.length) {
        if (!best) { best = alone; bestScore = 1e9; }
        continue;
      }
      leader = pickWeighted(affordable, (l) => closeness(l.xp, (budget / wanted) * 1.3), rand) as Cand;
      slotCap = Math.max(leader.u.leadership && leader.u.leadership > 0 ? leader.u.leadership : 6, leader.slots);
      members.push(leader);
      left -= leader.xp;
    } else if (!pool.some((c) => c.xp <= budget)) {
      if (!best) { best = alone; bestScore = 1e9; }
      continue;
    }
    /** the first member that is not the leader */
    const first = members.length;

    // ---- the rest, one by one: each about an even share of what is left
    const cheapest = pool.length ? pool.reduce((a, b) => (b.xp < a.xp ? b : a)).xp : Infinity;
    for (let i = first; i < wanted && left >= cheapest; i++) {
      const still = wanted - i; // units yet to take, this one included
      const share = left / still;
      const needFront = !members.some(inFront);
      const needBack = !members.some(inBack);
      let options = pool.filter((c) => c.xp <= left - (still - 1) * cheapest && fits(members, c, slotCap));
      if (!options.length) options = pool.filter((c) => c.xp <= left && fits(members, c, slotCap));
      if (!options.length) break;
      // somebody in each line: once a line is still empty, prefer whoever fills it
      const filling = options.filter((c) => (needFront && inFront(c)) || (needBack && inBack(c)));
      if (filling.length && (needFront || needBack)) options = filling;
      const pick = pickWeighted(options, (c) => closeness(c.xp, share), rand) as Cand;
      members.push(pick);
      left -= pick.xp;
    }

    // ---- spend what is left: swap a unit for a stronger one of the same line and size
    for (let pass = 0; pass < 12 && left > 0; pass++) {
      const idx = first + Math.floor(rand() * Math.max(1, members.length - first));
      const cur = members[idx];
      if (!cur) break;
      const rest = members.filter((_, k) => k !== idx);
      const better = pool.filter((c) => c.xp > cur.xp && c.xp <= cur.xp + left && c.big === cur.big && c.front === cur.front && fits(rest, c, slotCap));
      if (!better.length) continue;
      const pick = pickWeighted(better, (c) => closeness(c.xp, cur.xp + left), rand) as Cand;
      members[idx] = pick;
      left -= pick.xp - cur.xp;
    }
    // … or one more cheap unit, when a cell and the leadership allow
    while (members.length < maxUnits && left >= cheapest) {
      const extra = pool.filter((c) => c.xp <= left && fits(members, c, slotCap));
      if (!extra.length) break;
      const pick = pickWeighted(extra, (c) => closeness(c.xp, left), rand) as Cand;
      members.push(pick);
      left -= pick.xp;
    }

    // ---- how good this one is: budget left unspent, a line left empty, a lonely leader
    const total = budget - left;
    const others = members.slice(first);
    let score = left / budget;
    const canFront = (!!leader && inFront(leader)) || pool.some(inFront);
    const canBack = (!!leader && inBack(leader)) || pool.some(inBack);
    if (members.length > 1 && canFront && canBack && !(members.some(inFront) && members.some(inBack))) score += 1;
    if (members.length === 1 && maxUnits > 1 && cheapest <= left) score += 0.5;
    if (score < bestScore) { best = { leader, others, total }; bestScore = score; }
    // good enough: take it, so that the next seed shows another guard and not the same optimum
    if (score <= 0.04) break;
  }
  if (!best) return null;

  // ---- formation: the leader in the middle row, big units next, then the rest by strength
  // (with no leader the strongest take the middle)
  const cells: (GuardMember | null)[] = [null, null, null, null, null, null];
  const member = (c: Cand): GuardMember => ({ unit: c.u.id, level: c.level, hp: c.hp, xp: c.xp, role: c.role, big: c.big });
  const place = (c: Cand): number => {
    const m = member(c);
    for (const r of ROW_ORDER) {
      const f = 2 * r, b = f + 1;
      if (c.big) {
        if (!cells[f] && !cells[b]) { cells[f] = m; cells[b] = m; return f; }
      } else if (c.front) {
        if (!cells[f]) { cells[f] = m; return f; }
      } else if (!cells[b]) { cells[b] = m; return b; }
    }
    return -1;
  };
  const leaderCell = best.leader ? place(best.leader) : -1;
  const rest = [...best.others].sort((a, b) => Number(b.big) - Number(a.big) || b.xp - a.xp || byId(a, b));
  for (const c of rest) place(c);

  const placed = [...new Set(cells.filter((c): c is GuardMember => !!c))];
  const subraceOf = new Map(units.map((u) => [u.id, u.subraceId]));
  return {
    cells,
    leaderCell,
    strength: placed.reduce((s, m) => s + m.xp, 0),
    hp: placed.reduce((s, m) => s + m.hp, 0),
    count: placed.length,
    subraces: [...new Set(placed.map((m) => subraceOf.get(m.unit) ?? -1))].sort((a, b) => a - b),
    overBudget,
  };
}

/** The cheapest and the costliest guard the options allow: the range a strength slider makes sense in. */
export function guardBudgetRange(units: readonly GuardUnitInfo[], opts: Omit<GuardOptions, "budget" | "seed">): { min: number; max: number } | null {
  const roles = new Set<GuardRole>(opts.roles?.length ? opts.roles : GUARD_ROLES);
  let min = Infinity;
  const tops: number[] = [];
  for (const u of units) {
    const kind = eligible(u);
    if (!kind || (u.water && !opts.onWater)) continue;
    if (typeof opts.subrace === "number" && u.subraceId !== opts.subrace) continue;
    if (!roles.has(guardRole(u))) continue;
    if (opts.leaderless && kind === "leader") continue; // a garrison is soldiers only
    const xp = unitAtLevel(u, opts.level).xp;
    if (kind === (opts.leaderless ? "soldier" : "leader")) min = Math.min(min, xp);
    tops.push(xp);
  }
  if (!Number.isFinite(min)) return null;
  tops.sort((a, b) => b - a);
  return { min, max: tops.slice(0, 6).reduce((s, v) => s + v, 0) };
}

// ───────────────────────────── loot ─────────────────────────────

/** What the loot composer needs of an item: a subset of the mod's item catalogue entry. */
export interface LootItemInfo {
  id: string;
  /** LmagItm key: L_POTION_HEAL, L_SCROLL, L_VALUABLE, … */
  catKey: string;
  /** the gold part of the item's VALUE */
  gold: number;
}

export interface LootOptions {
  /** wanted value, gold */
  budget: number;
  seed: number;
  /** item categories to take from (LmagItm keys); empty / absent = every category but the
   *  special (quest) items, which a guard must not hand out by chance */
  cats?: readonly string[];
  /** at most this many items (default 5) */
  maxItems?: number;
}

export interface LootResult {
  /** item template ids, costliest first; an item may repeat (two potions) */
  items: string[];
  /** Σ gold (≤ the budget; 0 with no items when nothing is that cheap) */
  value: number;
}

/** Quest items and the like: never picked unless the category is asked for by name. */
export const LOOT_SPECIAL_CATS: readonly string[] = ["L_SPECIAL"];

/** Compose loot worth about `budget` gold: a few items, never above the budget. */
export function composeLoot(items: readonly LootItemInfo[], opts: LootOptions): LootResult {
  const budget = Math.max(0, Math.floor(opts.budget));
  const maxItems = Math.min(12, Math.max(1, Math.floor(opts.maxItems ?? 5)));
  const cats = opts.cats?.length ? new Set(opts.cats) : null;
  const pool = items
    .filter((it) => it.gold > 0 && it.gold <= budget && (cats ? cats.has(it.catKey) : !LOOT_SPECIAL_CATS.includes(it.catKey)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!pool.length) return { items: [], value: 0 };
  const rand = rng(opts.seed ^ 0x51ed270b);
  const cheapest = pool.reduce((a, b) => (b.gold < a.gold ? b : a)).gold;

  let best: LootItemInfo[] = [];
  let bestLeft = Infinity;
  for (let attempt = 0; attempt < 60; attempt++) {
    const wanted = 1 + Math.floor(rand() * maxItems);
    const picked: LootItemInfo[] = [];
    let left = budget;
    for (let i = 0; i < wanted && left >= cheapest; i++) {
      const share = left / (wanted - i);
      const options = pool.filter((it) => it.gold <= left);
      if (!options.length) break;
      const pick = pickWeighted(options, (it) => closeness(it.gold, share), rand) as LootItemInfo;
      picked.push(pick);
      left -= pick.gold;
    }
    // spend the remainder: a costlier item instead of one of the picked
    for (let pass = 0; pass < 8 && left > 0 && picked.length; pass++) {
      const idx = Math.floor(rand() * picked.length);
      const cur = picked[idx] as LootItemInfo;
      const better = pool.filter((it) => it.gold > cur.gold && it.gold <= cur.gold + left);
      if (!better.length) continue;
      const pick = pickWeighted(better, (it) => closeness(it.gold, cur.gold + left), rand) as LootItemInfo;
      picked[idx] = pick;
      left -= pick.gold - cur.gold;
    }
    if (left < bestLeft) { best = picked; bestLeft = left; }
    if (left <= budget * 0.03) break;
  }
  best.sort((a, b) => b.gold - a.gold || (a.id < b.id ? -1 : 1));
  return { items: best.map((it) => it.id), value: best.reduce((s, it) => s + it.gold, 0) };
}

export interface RuinReward {
  /** the artifact of the ruin (an item template id), or null when nothing fits */
  item: string | null;
  /** gold for the rest of the value */
  gold: number;
  /** gold of the item + `gold` */
  value: number;
}

/** The CASH field of a ruin holds four digits of gold. */
const RUIN_GOLD_CAP = 9999;

/**
 * A ruin gives ONE item and cash. Split the wanted value between them: an item for a share of it
 * (from two fifths to all of it — the share comes with the variant), the rest in gold, so the two
 * together come to the value asked (as far as four digits of gold allow).
 */
export function composeRuinReward(items: readonly LootItemInfo[], opts: Omit<LootOptions, "maxItems">): RuinReward {
  const budget = Math.max(0, Math.floor(opts.budget));
  const rand = rng(opts.seed ^ 0x2f6e2b1);
  const share = 0.4 + 0.6 * rand();
  const loot = composeLoot(items, { ...opts, budget: Math.round(budget * share), maxItems: 1 });
  const item = loot.items[0] ?? null;
  const gold = Math.min(RUIN_GOLD_CAP, budget - loot.value);
  return { item, gold, value: loot.value + gold };
}
