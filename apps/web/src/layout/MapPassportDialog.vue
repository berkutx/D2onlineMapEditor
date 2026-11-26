<script setup lang="ts">
/**
 * The map passport: a picture of the WHOLE map and the map in numbers — what a map maker
 * posts next to the file. Opened from Файл ▸ Паспорт карты, and offered after an export
 * (`exported` = the name of the file just saved). The window only OFFERS: the picture, the
 * sheet and the text are taken with the buttons, nothing is saved by itself.
 */
import { computed, ref, watch } from "vue";
import { ElDialog, ElButton, ElSegmented, ElCheckbox, ElMessage, ElScrollbar } from "element-plus";
import { mapPassport } from "@d2/map-edit";
import { useEditStore } from "../stores/editStore";
import { useModStore } from "../stores/modStore";
import { getScene } from "../canvas/sceneHolder";
import { passportSections, passportSheet, passportText } from "../services/passportText";
import { tr, intlLocale } from "../i18n";

const props = defineProps<{ modelValue: boolean; exported?: string | null }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const editStore = useEditStore();
const modStore = useModStore();

/** localStorage: "0" = do not open the passport after an export. */
const AFTER_EXPORT_KEY = "d2.passport.afterExport";
function readAfterExport(): boolean {
  try {
    return window.localStorage.getItem(AFTER_EXPORT_KEY) !== "0";
  } catch {
    return true;
  }
}
const afterExport = ref(readAfterExport());
function setAfterExport(v: boolean | string | number): void {
  afterExport.value = v === true;
  try {
    window.localStorage.setItem(AFTER_EXPORT_KEY, afterExport.value ? "1" : "0");
  } catch {
    /* storage blocked: the choice lasts for this page */
  }
}

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});

const modName = computed(() => (modStore.activeModId && modStore.mods.length > 1 ? modStore.nameOf(modStore.activeModId) : undefined));
// taken when the window opens — the numbers of the map as it is now, edits included
const passport = computed(() => (props.modelValue && editStore.liveDoc ? mapPassport(editStore.liveDoc) : null));
const sections = computed(() => (passport.value ? passportSections(passport.value, { modName: modName.value }) : []));

/** The whole-map picture sizes on offer: 1 = the game's own pixels. */
type ScaleKey = "full" | "half" | "quarter";
const SCALES: Record<ScaleKey, number> = { full: 1, half: 0.5, quarter: 0.25 };
const scaleKey = ref<ScaleKey>("half");
const scaleOptions = computed(() =>
  (Object.keys(SCALES) as ScaleKey[]).map((key) => {
    const size = getScene()?.mapSnapshotSize(SCALES[key]);
    const dims = size ? `${size.width.toLocaleString(intlLocale())}×${size.height.toLocaleString(intlLocale())}` : "";
    const name = key === "full" ? tr("Полный размер") : key === "half" ? tr("Половина") : tr("Четверть");
    return { value: key, label: dims ? `${name} · ${dims}` : name };
  }),
);

const previewUrl = ref<string | null>(null);
const busy = ref<"" | "map" | "copy" | "sheet">("");

/** The preview: the whole map at about the window's width. */
function drawPreview(): void {
  const scene = getScene();
  if (!scene) return;
  const full = scene.mapSnapshotSize(1);
  const canvas = scene.renderMapSnapshot(Math.min(1, 1500 / full.width));
  previewUrl.value = canvas ? canvas.toDataURL("image/png") : null;
}
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      afterExport.value = readAfterExport();
      // after the window has painted: the snapshot blocks for a moment on a large map
      window.setTimeout(drawPreview, 60);
    } else previewUrl.value = null;
  },
);

const fileBase = computed(() => {
  const name = (passport.value?.name || "map").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return name || "map";
});

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(tr("браузер не смог собрать картинку такого размера")))), "image/png");
  });
}
function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
/** Let the button show its spinner before the snapshot blocks the page. */
const paint = (): Promise<void> => new Promise((r) => window.setTimeout(r, 30));

async function mapPicture(scale: number): Promise<HTMLCanvasElement> {
  await paint();
  const canvas = getScene()?.renderMapSnapshot(scale);
  if (!canvas) throw new Error(tr("карта ещё не готова к снимку"));
  return canvas;
}

async function downloadMap(): Promise<void> {
  busy.value = "map";
  try {
    const canvas = await mapPicture(SCALES[scaleKey.value]);
    save(await toBlob(canvas), `${fileBase.value} — ${tr("карта")}.png`);
  } catch (e) {
    ElMessage.error(tr("Не удалось сделать снимок карты: {error}", { error: e instanceof Error ? e.message : String(e) }));
  } finally {
    busy.value = "";
  }
}

async function copyMap(): Promise<void> {
  busy.value = "copy";
  try {
    const canvas = await mapPicture(SCALES[scaleKey.value]);
    const blob = await toBlob(canvas);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    ElMessage.success(tr("Снимок карты скопирован"));
  } catch (e) {
    ElMessage.error(tr("Не удалось скопировать снимок: {error}", { error: e instanceof Error ? e.message : String(e) }));
  } finally {
    busy.value = "";
  }
}

async function downloadSheet(): Promise<void> {
  if (!passport.value) return;
  busy.value = "sheet";
  try {
    const scene = getScene();
    const full = scene?.mapSnapshotSize(1);
    const canvas = full ? await mapPicture(Math.min(1, 1504 / full.width)) : null;
    const sheet = passportSheet(passport.value, canvas, { modName: modName.value });
    save(await toBlob(sheet), `${fileBase.value} — ${tr("паспорт")}.png`);
  } catch (e) {
    ElMessage.error(tr("Не удалось собрать паспорт: {error}", { error: e instanceof Error ? e.message : String(e) }));
  } finally {
    busy.value = "";
  }
}

async function copyText(): Promise<void> {
  if (!passport.value) return;
  try {
    await navigator.clipboard.writeText(passportText(passport.value, { modName: modName.value }));
    ElMessage.success(tr("Описание скопировано"));
  } catch (e) {
    ElMessage.error(tr("Не удалось скопировать описание: {error}", { error: e instanceof Error ? e.message : String(e) }));
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="tr('Паспорт карты')" width="min(1180px, 94vw)" top="5vh" class="passport-dialog">
    <div v-if="exported" class="pp-exported">
      {{ tr("Карта сохранена в файл «{name}». Ниже — её паспорт: возьмите из него то, что нужно для публикации.", { name: exported }) }}
    </div>
    <div v-if="passport" class="pp-body">
      <div class="pp-map">
        <div class="pp-frame">
          <img v-if="previewUrl" :src="previewUrl" :alt="tr('Снимок всей карты')" />
          <div v-else class="pp-wait">{{ tr("Снимаю карту…") }}</div>
        </div>
        <div class="pp-map-actions">
          <el-segmented v-model="scaleKey" :options="scaleOptions" size="small" />
          <el-button size="small" type="primary" :loading="busy === 'map'" :disabled="!!busy" @click="downloadMap()">
            {{ tr("Скачать снимок (PNG)") }}
          </el-button>
          <el-button size="small" :loading="busy === 'copy'" :disabled="!!busy" @click="copyMap()">{{ tr("Скопировать") }}</el-button>
        </div>
        <div class="pp-note">
          {{ tr("Снимок — рельеф и объекты без сетки, локаций и подсветок, на прозрачном фоне. Полный размер — пиксель в пиксель как в игре.") }}
        </div>
      </div>

      <el-scrollbar class="pp-facts" max-height="62vh">
        <div class="pp-name">{{ passport.name || tr("Карта без названия") }}</div>
        <div v-if="passport.description" class="pp-desc">{{ passport.description }}</div>
        <section v-for="s in sections" :key="s.title" class="pp-section">
          <h4>{{ s.title }}</h4>
          <div v-for="r in s.rows" :key="r.label" class="pp-row">
            <span class="pp-label">{{ r.label }}</span>
            <span class="pp-value">{{ r.value }}</span>
          </div>
        </section>
      </el-scrollbar>
    </div>
    <div v-else class="pp-wait">{{ tr("Сначала откройте карту") }}</div>

    <template #footer>
      <div class="pp-footer">
        <el-checkbox :model-value="afterExport" @change="setAfterExport">{{ tr("Показывать паспорт после экспорта") }}</el-checkbox>
        <span class="pp-spring" />
        <el-button :disabled="!passport" @click="copyText()">{{ tr("Скопировать описание") }}</el-button>
        <el-button :loading="busy === 'sheet'" :disabled="!passport || !!busy" @click="downloadSheet()">
          {{ tr("Скачать паспорт одной картинкой") }}
        </el-button>
        <el-button type="primary" @click="visible = false">{{ tr("Закрыть") }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.pp-exported {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--el-color-success) 14%, transparent);
  color: var(--el-text-color-primary);
  font-size: 13px;
}
.pp-body {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(280px, 1fr);
  gap: 20px;
}
@media (max-width: 900px) {
  .pp-body {
    grid-template-columns: 1fr;
  }
}
.pp-frame {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 220px;
  border-radius: 8px;
  background: #0b0e12;
  overflow: hidden;
}
.pp-frame img {
  display: block;
  max-width: 100%;
  max-height: 56vh;
}
.pp-wait {
  padding: 40px 12px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  text-align: center;
}
.pp-map-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.pp-map-actions .el-button + .el-button {
  margin-left: 0;
}
.pp-note {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--el-text-color-secondary);
}
.pp-name {
  font-size: 18px;
  font-weight: 600;
}
.pp-desc {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--el-text-color-secondary);
  white-space: pre-line;
}
.pp-section {
  margin-top: 14px;
}
.pp-section h4 {
  margin: 0 0 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--el-text-color-secondary);
}
.pp-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 2px 0;
  font-size: 13px;
}
.pp-label {
  color: var(--el-text-color-secondary);
}
.pp-value {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pp-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.pp-footer .el-button + .el-button {
  margin-left: 0;
}
.pp-spring {
  flex: 1;
}
</style>
