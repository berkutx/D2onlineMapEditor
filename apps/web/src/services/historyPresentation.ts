import type { EditOp } from "@d2/socket-contract";
import { tr, trn } from "../i18n";

/** Labels (Russian is the source language) for the object types + the patchObject field
 *  keys, so history rows read like the editor, not like the raw model. */
const TYPE_RU: Record<string, string> = {
  stack: tr("отряд"), village: tr("город"), capital: tr("столица"), fort: tr("форт"), ruin: tr("руины"),
  merchant: tr("лавка"), mage: tr("маг. башня"), trainer: tr("тренер"), mercenary: tr("наёмники"),
  mountains: tr("горы"), crystal: tr("кристалл"), landmark: tr("декор"), location: tr("локация"),
  unit: tr("юнит"), treasure: tr("клад"), rod: tr("жезл"), tomb: tr("гробница"), generic: tr("объект"),
};
const FIELD_RU: Record<string, string> = {
  name: tr("имя"), owner: tr("владелец"), garrison: tr("гарнизон"), leaderCell: tr("лидер"), order: tr("приказ"),
  equip: tr("снаряжение"), inventory: tr("инвентарь"), banner: tr("знамя"), baseType: tr("вид"), image: tr("вид"),
  radius: tr("радиус"), items: tr("предметы"), stock: tr("товары"), school: tr("школа магии"), gold: tr("золото"),
  facing: tr("поворот"), morale: tr("мораль"), move: tr("ход"), subRace: tr("фракция"), desc: tr("описание"),
  visitorStack: tr("гость"), tier: tr("уровень"), value: tr("значение"),
  isHuman: tr("управление человеком"), bank: tr("ресурсы"), lordId: tr("лорд"), attitude: tr("отношение"),
  description: tr("описание"), author: tr("автор"), objective: tr("цель"), story: tr("история"),
  winText: tr("текст победы"), loseText: tr("текст поражения"), suggestedLevel: tr("рекомендуемый уровень"),
  difficulty: tr("сложность"), limits: tr("ограничения"),
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
  if (!o) return tr("объект");
  const decor = o.type === "landmark" ? ctx?.decorName?.(o.baseType ?? "") : undefined;
  const label = o.name || decor;
  return label ? tr("{type} «{name}»", { type: typeRu(o.type), name: label }) : typeRu(o.type);
}

/** Humanize one patched value: decoration ids get their catalog name, the rest print as-is. */
function valueRu(key: string, v: unknown, ctx?: OpContext): string {
  if (typeof v === "object") return "…";
  const s = String(v);
  if (key === "baseType") {
    const name = ctx?.decorName?.(s);
    return name ? `${name} (${s})` : s;
  }
  if (key === "image") return tr("вариант {value}", { value: s });
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
  if (!player || typeof player !== "object") return tr("игрок из сохранённого состояния");
  const name = "name" in player && typeof player.name === "string" ? player.name : "";
  const id = "id" in player && typeof player.id === "string" ? player.id : "";
  return [name && tr("«{name}»", { name }), id].filter(Boolean).join(" ") || tr("игрок из сохранённого состояния");
}

/** Adding an EditOp requires updating both formatters, rather than silently displaying
 * an empty history row. The never parameter is checked by the full web typecheck. */
function unhandledOperation(op: never): never {
  throw new Error(tr("Неизвестная операция истории: {op}", { op: JSON.stringify(op) }));
}

/** A short, human-readable summary of an op for the history panel. */
export function summarize(op: EditOp, ctx?: OpContext): string {
  switch (op.kind) {
    case "setCell":
      // roadType rides along on every INVERSE setCell (exact restore; -1 = «нет дороги») —
      // call it a road op only when it lays road (≥0), so terrain reverts don't read «дорога»
      return op.roadType !== undefined && op.roadType >= 0
        ? tr("🛣 дорога ({x}, {y})", { x: op.x, y: op.y }) : tr("⛰ рельеф ({x}, {y})", { x: op.x, y: op.y });
    case "addObject":
      return `➕ ${typeRu(op.object.type)}`;
    case "moveObject":
      return `⇄ ${targetRu(op.id, ctx)} → (${op.x}, ${op.y})`;
    case "patchObject":
      return `✎ ${fieldsRu(op.fields) || tr("свойства")} — ${targetRu(op.id, ctx)}`;
    case "deleteObject":
      return `🗑 ${targetRu(op.id, ctx)}`;
    case "patchPlayer":
      return tr("✎ игрок {id} — {fields}", { id: op.id, fields: fieldsRu(op.fields) || tr("свойства") });
    case "addPlayer":
      return op.spec
        ? tr("➕ игрок «{name}»", { name: op.spec.name || op.spec.race })
        : tr("↶ восстановлен {player}", { player: restoredPlayer(op) });
    case "removePlayer":
      return tr("🗑 игрок {id}", { id: op.id });
    case "upsertEvent":
      return tr("⚡ событие «{name}»", { name: op.event.name || op.event.id });
    case "deleteEvent":
      return tr("🗑 удалено событие");
    case "setVariables":
      return tr("𝑥 переменные ({count})", { count: op.variables.length });
    case "upsertTemplate":
      return tr("⛨ шаблон «{name}»", { name: op.template.name || op.template.id });
    case "deleteTemplate":
      return tr("🗑 удалён шаблон");
    case "setScenarioInfo":
      return tr("✎ сценарий — {fields}", { fields: fieldsRu(op.fields) || tr("настройки") });
    case "setDiplomacy":
      return tr("⚑ дипломатия ({count})", { count: op.diplomacy.length });
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
    // the Russian «кл.» is one form for every number; a translation carries its own plural forms
    if (roads === n) return trn("🛣 дороги — {n} кл.", n);
    if (roads === 0) return trn("⛰ рельеф — {n} кл.", n);
    return trn("⛰ рельеф + 🛣 дороги — {n} кл.", n);
  }
  const allSameAdd = ops.every((o) => o.kind === "addObject");
  if (allSameAdd) return tr("➕ объектов: {count}", { count: n });
  return tr("✎ правок за операцию: {count}", { count: n });
}
export function detailBatch(ops: readonly EditOp[]): string {
  const by = new Map<string, number>();
  for (const o of ops) by.set(o.kind, (by.get(o.kind) ?? 0) + 1);
  const tally = [...by].map(([k, c]) => `${k} × ${c}`).join(", ");
  return `${trn("{n} правок за одну операцию", ops.length)}\n${tally}`;
}

/** A slightly longer description revealed when a history row is clicked. */
export function detailOf(op: EditOp, ctx?: OpContext): string {
  switch (op.kind) {
    case "setCell":
      return op.roadType !== undefined
        ? tr("клетка ({x}, {y}), значение {value}, дорога {road}", { x: op.x, y: op.y, value: op.value, road: op.roadType })
        : tr("клетка ({x}, {y}), значение {value}", { x: op.x, y: op.y, value: op.value });
    case "addObject":
      return tr("{type} «{name}» в ({x}, {y})", {
        type: typeRu(op.object.type), name: ("name" in op.object && op.object.name) || op.object.id,
        x: op.object.pos.x, y: op.object.pos.y,
      });
    case "moveObject":
      return tr("{target} ({id}) → клетка ({x}, {y})", { target: targetRu(op.id, ctx), id: op.id, x: op.x, y: op.y });
    case "patchObject":
      return `${targetRu(op.id, ctx)} (${op.id})\n${fieldDetails(op.fields, ctx)}`;
    case "deleteObject":
      return `${targetRu(op.id, ctx)} (${op.id})`;
    case "patchPlayer":
      return `${tr("игрок {id}", { id: op.id })}\n${fieldDetails(op.fields, ctx)}`;
    case "addPlayer":
      return op.spec
        ? `${tr("игрок «{name}», раса {race}", { name: op.spec.name || op.spec.race, race: op.spec.race })}\n${tr("столица в ({x}, {y})", { x: op.spec.x, y: op.spec.y })}`
        : tr("восстановление: {player}", { player: restoredPlayer(op) });
    case "removePlayer":
      return tr("удалён игрок {id} и принадлежащие ему объекты", { id: op.id });
    case "upsertEvent":
      return `${op.event.id}\n${tr("условий: {conditions}, эффектов: {effects}, шанс {chance}%", { conditions: op.event.conditions.length, effects: op.event.effects.length, chance: op.event.chance })}`;
    case "deleteEvent":
      return tr("событие {id}", { id: op.id });
    case "setVariables":
      return op.variables.map((v) => `${v.name} = ${v.value}`).join("\n") || tr("нет переменных");
    case "upsertTemplate":
      return `${op.template.id}\n${tr("юнитов: {units}, лидер: {leader}", { units: op.template.units.filter(Boolean).length, leader: op.template.leader || "—" })}`;
    case "deleteTemplate":
      return tr("шаблон {id}", { id: op.id });
    case "setScenarioInfo":
      return `${tr("настройки сценария")}\n${fieldDetails(op.fields, ctx)}`;
    case "setDiplomacy":
      return op.diplomacy.map((entry) => tr("расы {race1} ↔ {race2}: {relation}", { race1: entry.race1, race2: entry.race2, relation: entry.relation })).join("\n") || tr("дипломатические отношения очищены");
  }
  return unhandledOperation(op);
}
