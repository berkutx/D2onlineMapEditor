import type { EditOp } from "@d2/socket-contract";

/** Russian labels for the object types + the patchObject field keys, so history rows read
 *  like the editor, not like the raw model. */
const TYPE_RU: Record<string, string> = {
  stack: "отряд", village: "город", capital: "столица", fort: "форт", ruin: "руины",
  merchant: "лавка", mage: "маг. башня", trainer: "тренер", mercenary: "наёмники",
  mountains: "горы", crystal: "кристалл", landmark: "декор", location: "локация",
  unit: "юнит", treasure: "клад", rod: "жезл", tomb: "гробница", generic: "объект",
};
const FIELD_RU: Record<string, string> = {
  name: "имя", owner: "владелец", garrison: "гарнизон", leaderCell: "лидер", order: "приказ",
  equip: "снаряжение", inventory: "инвентарь", banner: "знамя", baseType: "вид", image: "вид",
  radius: "радиус", items: "предметы", stock: "товары", school: "школа магии", gold: "золото",
  facing: "поворот", morale: "мораль", move: "ход", subRace: "фракция", desc: "описание",
  visitorStack: "гость", tier: "уровень", value: "значение",
  isHuman: "управление человеком", bank: "ресурсы", lordId: "лорд", attitude: "отношение",
  description: "описание", author: "автор", objective: "цель", story: "история",
  winText: "текст победы", loseText: "текст поражения", suggestedLevel: "рекомендуемый уровень",
  difficulty: "сложность", limits: "ограничения",
};
const typeRu = (t: string): string => TYPE_RU[t] ?? t;
const fieldsRu = (fields: Record<string, unknown>): string =>
  Object.keys(fields).map((k) => FIELD_RU[k] ?? k).join(", ");

/** Optional humanizers wired in by the store (avoid hard coupling at module level):
 *  the target object of an op by id, and a decoration name for a G000MG… id. */
export interface OpContext {
  objectOf?: (id: string) => { type: string; name?: string; baseType?: string } | undefined;
  decorName?: (id: string) => string | undefined;
}

/** «столица „Хеленверд“» / «декор „Стена“» — the op target, best effort. */
function targetRu(id: string, ctx?: OpContext): string {
  const o = ctx?.objectOf?.(id);
  if (!o) return "объект";
  const decor = o.type === "landmark" ? ctx?.decorName?.(o.baseType ?? "") : undefined;
  const label = o.name || decor;
  return label ? `${typeRu(o.type)} «${label}»` : typeRu(o.type);
}

/** Humanize one patched value: decoration ids get their catalog name, the rest print as-is. */
function valueRu(key: string, v: unknown, ctx?: OpContext): string {
  if (typeof v === "object") return "…";
  const s = String(v);
  if (key === "baseType") {
    const name = ctx?.decorName?.(s);
    return name ? `${name} (${s})` : s;
  }
  if (key === "image") return `вариант ${s}`;
  return s;
}

function fieldDetails(fields: Record<string, unknown>, ctx?: OpContext): string {
  return Object.entries(fields).map(([key, value]) => {
    const label = FIELD_RU[key] ?? key;
    const formatted = valueRu(key, value, ctx);
    return formatted.length && typeof value !== "object" ? `${label}: ${formatted}` : label;
  }).join("\n");
}

/** Restored faction snapshots are an opaque record in the wire contract. Inspect values
 * before displaying them; never assume that an arbitrary record is a PlayerInfo. */
function restoredPlayer(op: Extract<EditOp, { kind: "addPlayer" }>): string {
  const player = op.snapshot?.player;
  if (!player || typeof player !== "object") return "игрок из сохранённого состояния";
  const name = "name" in player && typeof player.name === "string" ? player.name : "";
  const id = "id" in player && typeof player.id === "string" ? player.id : "";
  return [name && `«${name}»`, id].filter(Boolean).join(" ") || "игрок из сохранённого состояния";
}

/** Adding an EditOp requires updating both formatters, rather than silently displaying
 * an empty history row. The never parameter is checked by the full web typecheck. */
function unhandledOperation(op: never): never {
  throw new Error(`Неизвестная операция истории: ${JSON.stringify(op)}`);
}

/** A short, human-readable Russian summary of an op for the history panel. */
export function summarize(op: EditOp, ctx?: OpContext): string {
  switch (op.kind) {
    case "setCell":
      // roadType rides along on every INVERSE setCell (exact restore; -1 = «нет дороги») —
      // call it a road op only when it lays road (≥0), so terrain reverts don't read «дорога»
      return op.roadType !== undefined && op.roadType >= 0
        ? `🛣 дорога (${op.x}, ${op.y})` : `⛰ рельеф (${op.x}, ${op.y})`;
    case "addObject":
      return `➕ ${typeRu(op.object.type)}`;
    case "moveObject":
      return `⇄ ${targetRu(op.id, ctx)} → (${op.x}, ${op.y})`;
    case "patchObject":
      return `✎ ${fieldsRu(op.fields) || "свойства"} — ${targetRu(op.id, ctx)}`;
    case "deleteObject":
      return `🗑 ${targetRu(op.id, ctx)}`;
    case "patchPlayer":
      return `✎ игрок ${op.id} — ${fieldsRu(op.fields) || "свойства"}`;
    case "addPlayer":
      return op.spec ? `➕ игрок «${op.spec.name || op.spec.race}»` : `↶ восстановлен ${restoredPlayer(op)}`;
    case "removePlayer":
      return `🗑 игрок ${op.id}`;
    case "upsertEvent":
      return `⚡ событие «${op.event.name || op.event.id}»`;
    case "deleteEvent":
      return "🗑 удалено событие";
    case "setVariables":
      return `𝑥 переменные (${op.variables.length})`;
    case "upsertTemplate":
      return `⛨ шаблон «${op.template.name || op.template.id}»`;
    case "deleteTemplate":
      return "🗑 удалён шаблон";
    case "setScenarioInfo":
      return `✎ сценарий — ${fieldsRu(op.fields) || "настройки"}`;
    case "setDiplomacy":
      return `⚑ дипломатия (${op.diplomacy.length})`;
  }
  return unhandledOperation(op);
}

/** One-line summary for a whole COMMIT collapsed into ONE row — «⛰ рельеф — 412 кл.» instead
 *  of 412 «⛰ рельеф (x, y)» rows (the whole point of batching). */
export function summarizeBatch(ops: readonly EditOp[], ctx?: OpContext): string {
  const n = ops.length;
  if (n === 1) return summarize(ops[0]!, ctx);
  const allCells = ops.every((o) => o.kind === "setCell");
  if (allCells) {
    const roads = ops.filter((o) => o.kind === "setCell" && o.roadType !== undefined && o.roadType >= 0).length;
    if (roads === n) return `🛣 дороги — ${n} кл.`;
    if (roads === 0) return `⛰ рельеф — ${n} кл.`;
    return `⛰ рельеф + 🛣 дороги — ${n} кл.`;
  }
  const allSameAdd = ops.every((o) => o.kind === "addObject");
  if (allSameAdd) return `➕ объектов: ${n}`;
  return `✎ правок за операцию: ${n}`;
}
export function detailBatch(ops: readonly EditOp[]): string {
  const by = new Map<string, number>();
  for (const o of ops) by.set(o.kind, (by.get(o.kind) ?? 0) + 1);
  const tally = [...by].map(([k, c]) => `${k} × ${c}`).join(", ");
  return `${ops.length} правок за одну операцию\n${tally}`;
}

/** A slightly longer description revealed when a history row is clicked. */
export function detailOf(op: EditOp, ctx?: OpContext): string {
  switch (op.kind) {
    case "setCell":
      return `клетка (${op.x}, ${op.y}), значение ${op.value}${op.roadType !== undefined ? `, дорога ${op.roadType}` : ""}`;
    case "addObject":
      return `${typeRu(op.object.type)} «${("name" in op.object && op.object.name) || op.object.id}» в (${op.object.pos.x}, ${op.object.pos.y})`;
    case "moveObject":
      return `${targetRu(op.id, ctx)} (${op.id}) → клетка (${op.x}, ${op.y})`;
    case "patchObject":
      return `${targetRu(op.id, ctx)} (${op.id})\n${fieldDetails(op.fields, ctx)}`;
    case "deleteObject":
      return `${targetRu(op.id, ctx)} (${op.id})`;
    case "patchPlayer":
      return `игрок ${op.id}\n${fieldDetails(op.fields, ctx)}`;
    case "addPlayer":
      return op.spec
        ? `игрок «${op.spec.name || op.spec.race}», раса ${op.spec.race}\nстолица в (${op.spec.x}, ${op.spec.y})`
        : `восстановление: ${restoredPlayer(op)}`;
    case "removePlayer":
      return `удалён игрок ${op.id} и принадлежащие ему объекты`;
    case "upsertEvent":
      return `${op.event.id}\nусловий: ${op.event.conditions.length}, эффектов: ${op.event.effects.length}, шанс ${op.event.chance}%`;
    case "deleteEvent":
      return `событие ${op.id}`;
    case "setVariables":
      return op.variables.map((v) => `${v.name} = ${v.value}`).join("\n") || "нет переменных";
    case "upsertTemplate":
      return `${op.template.id}\nюнитов: ${op.template.units.filter(Boolean).length}, лидер: ${op.template.leader || "—"}`;
    case "deleteTemplate":
      return `шаблон ${op.id}`;
    case "setScenarioInfo":
      return `настройки сценария\n${fieldDetails(op.fields, ctx)}`;
    case "setDiplomacy":
      return op.diplomacy.map((entry) => `расы ${entry.race1} ↔ ${entry.race2}: ${entry.relation}`).join("\n") || "дипломатические отношения очищены";
  }
  return unhandledOperation(op);
}
