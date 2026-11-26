<script setup lang="ts">
/**
 * Help of the command bar, as ONE list to look through: every generator with a picture of
 * what it draws (a sample plan from the server — the generator's real output over an empty
 * zone, drawn as a schematic), then what else the bar understands — where to generate, how
 * much, tools, view, a jump to a cell, a search by name.
 *
 * Opened from Справка ▸ Командная строка и генераторы, and from the bar itself.
 */
import { computed, nextTick, ref, watch } from "vue";
import { ElDialog, ElScrollbar, ElTag } from "element-plus";
import type { GenRecipePreview } from "@d2/socket-contract";
import { useViewStore } from "../stores/viewStore";
import { useGenStore } from "../stores/genStore";
import { fetchGenPreviews } from "../services/api";
import { drawGenPlan } from "../services/genPlanDraw";
import { tr } from "../i18n";

const view = useViewStore();
const gen = useGenStore();

const visible = computed({
  get: () => view.commandHelpVisible,
  set: (v: boolean) => view.setCommandHelp(v),
});

const plans = ref<Map<string, GenRecipePreview>>(new Map());
const loadError = ref("");
let plansP: Promise<void> | null = null;
function loadPlans(): Promise<void> {
  plansP ??= fetchGenPreviews()
    .then((list) => {
      plans.value = new Map(list.map((p) => [p.id, p]));
      loadError.value = "";
    })
    .catch((e: unknown) => {
      plansP = null; // try again the next time the window opens
      loadError.value = e instanceof Error ? e.message : String(e);
    });
  return plansP;
}

/** canvases by recipe id (a function ref per card) */
const canvases = new Map<string, HTMLCanvasElement>();
function bindCanvas(id: string, el: unknown): void {
  if (el instanceof HTMLCanvasElement) canvases.set(id, el);
  else canvases.delete(id);
}
function paint(): void {
  for (const [id, canvas] of canvases) {
    const plan = plans.value.get(id);
    if (plan) drawGenPlan(canvas, plan, 188);
  }
}
watch(
  () => view.commandHelpVisible,
  (open) => {
    if (!open) return;
    void gen.loadCatalog().catch(() => undefined);
    void loadPlans().then(() => nextTick(paint));
  },
);
watch([plans, () => gen.groups], () => void nextTick(paint));

/** How a generator can be started besides the palette. */
function waysOf(r: { stroke?: "line" | "brush"; amountLabel?: string }): string[] {
  const out: string[] = [];
  if (r.stroke === "line") out.push(tr("✎ по линии"));
  if (r.stroke === "brush") out.push(tr("✎ по мазку"));
  if (r.amountLabel) out.push(tr("± количество"));
  return out;
}

/** What else the bar understands — one row per kind of command, with what to type. */
const COMMANDS: { what: string; examples: string; note?: string }[] = [
  { what: tr("Где генерировать"), examples: tr("«озеро на севере» · «лес по краю» · «горы в центре» · «снег везде» · «камни 16×16»"), note: tr("Без слов о месте работает выбранная область: 👁 экран, ⛶ нарисованная зона или 📍 точка под курсором.") },
  { what: tr("Сколько"), examples: tr("«побольше леса» · «чуть-чуть камней» · «густо»"), note: tr("То же делают кнопки − и + в полосе результата, не меняя рисунок.") },
  { what: tr("Инструмент"), examples: tr("«кисть» · «вода» · «дорога» · «туман» · «локации»"), note: tr("Или цифра 1–0 на клавиатуре.") },
  { what: tr("Вид и окна"), examples: tr("«сетка» · «миникарта» · «события» · «паспорт» · «экспорт» · «проверить»") },
  { what: tr("Перейти к клетке"), examples: tr("«20 30» · «клетка 20 30»") },
  { what: tr("Найти объект по имени"), examples: tr("«найти Столица» · «найти руины»"), note: tr("Города, руины, лавки, локации и декорации с подписью; выбранный объект окажется в центре.") },
];
</script>

<template>
  <el-dialog v-model="visible" :title="tr('Командная строка и генераторы')" width="min(1120px, 94vw)" top="4vh" class="cmdhelp">
    <el-scrollbar max-height="76vh">
      <p class="ch-lead">
        {{ tr("Строка внизу карты понимает слова на русском, английском и польском и подсказывает, что сделает, ещё до Enter. Клавиша / ставит в неё курсор. Ниже — всё, что она умеет.") }}
      </p>

      <h3 class="ch-h">{{ tr("Генераторы") }}</h3>
      <p class="ch-sub">
        {{ tr("Картинка — схема того, что генератор рисует на пустом участке: по ней видно форму, а не графику мода. Каждый можно запустить из палитры строки, набрать словом, а отмеченные ✎ — ещё и нарисовать штрихом.") }}
      </p>
      <div v-if="loadError" class="ch-error">{{ tr("Схемы не загрузились: {error}", { error: loadError }) }}</div>
      <template v-for="g in gen.groups" :key="g.id">
        <div class="ch-group">{{ g.icon }} {{ g.title }}</div>
        <div class="ch-cards">
          <div v-for="r in g.recipes" :key="r.id" class="ch-card" :class="{ lacking: !!r.lacks }">
            <div class="ch-pic"><canvas :ref="(el) => bindCanvas(r.id, el)" /></div>
            <div class="ch-title">{{ tr(r.title) }}</div>
            <div class="ch-ways">
              <el-tag v-for="w in waysOf(r)" :key="w" size="small" type="info" effect="plain" round>{{ w }}</el-tag>
              <el-tag v-if="r.lacks" size="small" type="warning" effect="plain" round>{{ tr(r.lacks) }}</el-tag>
            </div>
          </div>
        </div>
      </template>
      <div v-if="!gen.groups.length" class="ch-error">{{ tr("Список генераторов ещё не загружен — откройте карту.") }}</div>

      <h3 class="ch-h">{{ tr("Что ещё можно набрать") }}</h3>
      <div class="ch-rows">
        <div v-for="c in COMMANDS" :key="c.what" class="ch-row">
          <div class="ch-what">{{ c.what }}</div>
          <div class="ch-how">
            <div class="ch-ex">{{ c.examples }}</div>
            <div v-if="c.note" class="ch-note">{{ c.note }}</div>
          </div>
        </div>
      </div>
    </el-scrollbar>
  </el-dialog>
</template>

<style scoped>
.ch-lead {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.5;
}
.ch-h {
  margin: 16px 0 4px;
  font-size: 15px;
  font-weight: 600;
}
.ch-sub {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--el-text-color-secondary);
}
.ch-group {
  margin: 12px 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--el-text-color-secondary);
}
.ch-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 10px;
}
.ch-card {
  padding: 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-extra-light);
}
.ch-card.lacking {
  opacity: 0.55;
}
.ch-pic {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  min-height: 112px;
  border-radius: 6px;
  background: #12161b;
}
.ch-pic canvas {
  display: block;
}
.ch-title {
  margin-top: 6px;
  font-size: 13px;
  font-weight: 600;
}
.ch-ways {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 22px;
  margin-top: 4px;
}
.ch-error {
  padding: 8px 0;
  font-size: 12px;
  color: var(--el-color-warning);
}
.ch-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
}
.ch-row {
  display: grid;
  grid-template-columns: 190px 1fr;
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.ch-what {
  font-size: 13px;
  font-weight: 600;
}
.ch-ex {
  font-size: 13px;
}
.ch-note {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
@media (max-width: 700px) {
  .ch-row {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>
