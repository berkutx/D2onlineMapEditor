/**
 * The map passport in words: the rows the passport window shows, the same rows as plain
 * text to paste into a post, and the picture of the whole sheet. The numbers come from
 * `mapPassport` (@d2/map-edit); only the wording lives here.
 */
import type { MapPassport, PassportPlayer } from "@d2/map-edit";
import { tr, trn, intlLocale } from "../i18n";

export interface PassportSection {
  title: string;
  rows: { label: string; value: string }[];
}

/** Race of a player by its Grace record index (the standard six). */
const RACE_NAMES: Record<number, string> = {
  0: tr("Империя"), 1: tr("Кланы Гор"), 2: tr("Легионы Проклятых"), 3: tr("Орды Нежити"),
  4: tr("Нейтралы"), 5: tr("Эльфийский Союз"),
};
/** Land by terrain id (the cell's low three bits). */
const LAND_NAMES: Record<number, string> = {
  1: tr("Империя"), 2: tr("Кланы Гор"), 3: tr("Легионы Проклятых"), 4: tr("Орды Нежити"),
  5: tr("нейтральная"), 6: tr("Эльфийский Союз"),
};
/** Mana crystals by resource; index 0 is a gold mine. */
const MANA_NAMES = [tr("Золото"), tr("Инферно"), tr("Жизнь"), tr("Смерть"), tr("Руны"), tr("Природа")];

const num = (n: number): string => n.toLocaleString(intlLocale());
const percent = (part: number, whole: number): string => {
  if (whole <= 0 || part <= 0) return "0%";
  const p = (part / whole) * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
};

export function raceName(race: number): string {
  return RACE_NAMES[race] ?? tr("раса {n}", { n: race });
}

/** «Империя — Дагар (человек)»: a side as one phrase. */
export function sideLabel(p: PassportPlayer): string {
  const race = raceName(p.race);
  const who = p.name && p.name !== race ? `${race} — ${p.name}` : race;
  return p.human ? tr("{side} (человек)", { side: who }) : tr("{side} (ИИ)", { side: who });
}

/** How a player's fog stands in the file, in a few words. */
export function fogLabel(p: PassportPlayer): string {
  if (!p.fog) return tr("нет блока тумана");
  if (p.fog.hidden === 0) return tr("не задан (вся карта открыта)");
  if (p.fog.hidden === p.fog.total) return tr("вся карта скрыта");
  return tr("открыто {open} из {total}", { open: num(p.fog.total - p.fog.hidden), total: num(p.fog.total) });
}

/** The passport as titled sections of label → value rows (empty rows are left out). */
export function passportSections(p: MapPassport, ctx: { modName?: string } = {}): PassportSection[] {
  const o = p.objects;
  const sides = p.players.filter((x) => !x.neutral);
  const sections: PassportSection[] = [];
  const add = (title: string, rows: ({ label: string; value: string } | null | false | undefined)[]): void => {
    const kept = rows.filter((r): r is { label: string; value: string } => !!r && r.value !== "");
    if (kept.length) sections.push({ title, rows: kept });
  };
  const count = (label: string, n: number): { label: string; value: string } | null => (n > 0 ? { label, value: num(n) } : null);

  add(tr("Карта"), [
    { label: tr("Размер"), value: `${p.size}×${p.size}` },
    ctx.modName ? { label: tr("Мод"), value: ctx.modName } : null,
    p.author ? { label: tr("Автор"), value: p.author } : null,
    { label: tr("Сторон"), value: String(p.sides) },
    p.closestCapitals ? { label: tr("Между ближайшими столицами"), value: trn("{n} клетка|{n} клетки|{n} клеток", p.closestCapitals.distance) } : null,
    p.suggestedLevel !== undefined && p.suggestedLevel > 0 ? { label: tr("Рекомендуемый уровень"), value: String(p.suggestedLevel) } : null,
  ]);

  add(tr("Стороны"), sides.map((s) => ({
    label: sideLabel(s),
    value: [
      s.capital ? tr("столица ({x}, {y})", { x: s.capital.x, y: s.capital.y }) : tr("без столицы"),
      s.cities ? trn("{n} город|{n} города|{n} городов", s.cities) : "",
      s.parties ? trn("{n} отряд|{n} отряда|{n} отрядов", s.parties) : "",
    ].filter(Boolean).join(" · "),
  })));

  const tiers = o.citiesByTier.map((n, i) => (n ? tr("ур. {tier}: {n}", { tier: i + 1, n }) : "")).filter(Boolean).join(", ");
  add(tr("Объекты"), [
    o.cities ? { label: tr("Города"), value: tiers ? `${num(o.cities)} (${tiers})` : num(o.cities) } : null,
    count(tr("Руины"), o.ruins),
    count(tr("Торговцы"), o.merchants),
    count(tr("Башни магов"), o.mages),
    count(tr("Тренеры"), o.trainers),
    count(tr("Лагеря наёмников"), o.mercenaries),
    count(tr("Рынки ресурсов"), o.resourceMarkets),
    o.chests ? { label: tr("Сундуки"), value: o.chestItems ? tr("{chests} (предметов: {items})", { chests: num(o.chests), items: num(o.chestItems) }) : num(o.chests) } : null,
    o.neutralParties ? { label: tr("Нейтральные отряды"), value: num(o.neutralParties) } : null,
    count(tr("Нейтральных юнитов (отряды, руины, гарнизоны)"), o.neutralUnits),
  ]);

  add(tr("Ресурсы"), o.crystals.map((n, i) => (n ? { label: i === 0 ? tr("Золотые рудники") : MANA_NAMES[i]!, value: num(n) } : null)));

  const land = p.terrain.land
    .map((n, id) => ({ id, n }))
    .filter((x) => x.n > 0 && LAND_NAMES[x.id])
    .sort((a, b) => b.n - a.n)
    .map((x) => `${LAND_NAMES[x.id]} ${percent(x.n, p.cells)}`)
    .join(", ");
  add(tr("Ландшафт"), [
    { label: tr("Вода"), value: percent(p.terrain.water, p.cells) },
    { label: tr("Лес"), value: percent(p.terrain.forest, p.cells) },
    { label: tr("Горы"), value: percent(p.terrain.mountainCells, p.cells) },
    p.terrain.roads ? { label: tr("Дороги"), value: trn("{n} клетка|{n} клетки|{n} клеток", p.terrain.roads) } : null,
    land ? { label: tr("Земли"), value: land } : null,
    count(tr("Декорации"), o.landmarks),
  ]);

  add(tr("Сценарий"), [
    count(tr("События"), p.scenario.events),
    count(tr("Переменные"), p.scenario.variables),
    count(tr("Шаблоны отрядов"), p.scenario.templates),
    count(tr("Локации"), o.locations),
    p.limits ? {
      label: tr("Пределы"),
      value: tr("уровень юнитов {unit}, заклинаний {spell}, лидеров {leader}, городов {city}", p.limits),
    } : null,
  ]);

  add(tr("Туман войны в файле"), sides.map((s) => ({ label: sideLabel(s), value: fogLabel(s) })));
  return sections;
}

/** The passport as plain text, ready to paste next to the map file. */
export function passportText(p: MapPassport, ctx: { modName?: string } = {}): string {
  const lines: string[] = [p.name ? `«${p.name}»` : tr("Карта без названия")];
  if (p.description) lines.push(p.description);
  for (const s of passportSections(p, ctx)) {
    lines.push("", s.title);
    for (const r of s.rows) lines.push(`  ${r.label}: ${r.value}`);
  }
  return lines.join("\n");
}

/** Break a text into lines no wider than `width` for the canvas font in use. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/**
 * The passport as ONE picture: the title, the whole map, the sections in columns.
 * `map` is the map picture (any size — it is fitted to the sheet's width).
 */
export function passportSheet(p: MapPassport, map: HTMLCanvasElement | null, ctx: { modName?: string } = {}): HTMLCanvasElement {
  const W = 1600, PAD = 48, COLS = 3, GAP = 40;
  const FONT = `"Segoe UI", system-ui, -apple-system, sans-serif`;
  const sections = passportSections(p, ctx);
  const colW = (W - 2 * PAD - (COLS - 1) * GAP) / COLS;

  // measure first (a throw-away context), then draw at the exact height
  const probe = document.createElement("canvas").getContext("2d")!;
  const layoutSection = (s: PassportSection): { title: string; lines: { label: string; value: string[] }[]; height: number } => {
    probe.font = `15px ${FONT}`;
    const lines = s.rows.map((r) => ({ label: r.label, value: wrap(probe, r.value, colW) }));
    const height = 34 + lines.reduce((h, l) => h + 20 + l.value.length * 20 + 8, 0) + 18;
    return { title: s.title, lines, height };
  };
  const laid = sections.map(layoutSection);
  // greedy columns: put each section into the shortest column
  const cols: { items: typeof laid; height: number }[] = Array.from({ length: COLS }, () => ({ items: [], height: 0 }));
  for (const s of laid) {
    const target = cols.reduce((a, b) => (b.height < a.height ? b : a));
    target.items.push(s);
    target.height += s.height;
  }
  probe.font = `15px ${FONT}`;
  const descLines = p.description ? wrap(probe, p.description, W - 2 * PAD).slice(0, 6) : [];
  const mapH = map ? Math.round(((W - 2 * PAD) * map.height) / map.width) : 0;
  const headH = 96 + descLines.length * 22 + (descLines.length ? 12 : 0);
  const H = headH + mapH + 36 + Math.max(...cols.map((c) => c.height), 0) + 60;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#101418";
  g.fillRect(0, 0, W, H);

  g.textBaseline = "alphabetic";
  g.fillStyle = "#f2f4f7";
  g.font = `600 38px ${FONT}`;
  g.fillText(p.name || tr("Карта без названия"), PAD, 64);
  g.fillStyle = "#9aa4b2";
  g.font = `17px ${FONT}`;
  const sub = [`${p.size}×${p.size}`, ctx.modName, trn("{n} сторона|{n} стороны|{n} сторон", p.sides), p.author].filter(Boolean).join("  ·  ");
  g.fillText(sub, PAD, 92);
  g.fillStyle = "#c9d1dc";
  g.font = `15px ${FONT}`;
  descLines.forEach((line, i) => g.fillText(line, PAD, 124 + i * 22));

  let y = headH;
  if (map) {
    g.fillStyle = "#0b0e12";
    g.fillRect(PAD, y, W - 2 * PAD, mapH);
    g.imageSmoothingQuality = "high";
    g.drawImage(map, PAD, y, W - 2 * PAD, mapH);
    y += mapH + 36;
  }

  cols.forEach((col, ci) => {
    const x = PAD + ci * (colW + GAP);
    let cy = y;
    for (const s of col.items) {
      g.fillStyle = "#e7c873";
      g.font = `600 17px ${FONT}`;
      g.fillText(s.title, x, cy + 20);
      g.fillStyle = "#2a323d";
      g.fillRect(x, cy + 28, colW, 1);
      let ly = cy + 34;
      for (const l of s.lines) {
        g.fillStyle = "#9aa4b2";
        g.font = `13px ${FONT}`;
        g.fillText(l.label, x, ly + 16);
        g.fillStyle = "#f2f4f7";
        g.font = `15px ${FONT}`;
        l.value.forEach((v, i) => g.fillText(v, x, ly + 20 + 16 + i * 20));
        ly += 20 + l.value.length * 20 + 8;
      }
      cy += s.height;
    }
  });

  g.fillStyle = "#5c6673";
  g.font = `12px ${FONT}`;
  g.fillText(tr("Паспорт карты · редактор карт Disciples II"), PAD, H - 24);
  return canvas;
}
