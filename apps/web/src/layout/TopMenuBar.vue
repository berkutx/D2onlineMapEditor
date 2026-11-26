<script setup lang="ts">
/**
 * Top menu bar — a real Element Plus el-menu (mode=horizontal): Файл / Правка /
 * Вид / Карта / Справка, plus a right-aligned cluster (map title, loading +
 * dirty tags, appearance toggle). No loose action buttons; view/grid/undo are
 * each defined in exactly one menu (their rapid surfaces live in the dock).
 */
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { storeToRefs } from "pinia";
import { ElMessage, ElNotification, ElMessageBox } from "element-plus";
import { Check, Moon, Sunny, Share, CircleCheck, WarningFilled } from "@element-plus/icons-vue";
import type { ScenarioEntry, ValidationReport } from "@d2/socket-contract";
import {
  acknowledgeVoiceReturn,
  applyVoiceReturn,
  createNewMap,
  createVoiceHandoff,
  exportProjectPackage,
  getRuntimeFeatures,
  previewVoiceReturn,
  uploadMap,
  VoiceLoginRequiredError,
  VoiceReturnRefreshError,
} from "../services/api";
import { useMapStore } from "../stores/mapStore";
import { useViewStore } from "../stores/viewStore";
import { useEditStore } from "../stores/editStore";
import { useCollabStore } from "../stores/collabStore";
import { useModStore } from "../stores/modStore";
import { getScene } from "../canvas/sceneHolder";
import MapModBadge from "./MapModBadge.vue";
import { tr, trn, trc, intlLocale, LOCALES, currentLocale, switchLocale, type Locale } from "../i18n";

const mapStore = useMapStore();
const modStore = useModStore();

/** Why a map of the list is flagged: its report (attached only to maps that do not fit). */
function misfitHint(compat: { issues: { severity: string; message: string }[] }): string {
  const errors = compat.issues.filter((i) => i.severity === "error");
  return trn("Карта ссылается на то, чего в этом моде нет ({n} таблица). Игра этого мода её не загрузит.|Карта ссылается на то, чего в этом моде нет ({n} таблицы). Игра этого мода её не загрузит.|Карта ссылается на то, чего в этом моде нет ({n} таблиц). Игра этого мода её не загрузит.", errors.length);
}
const viewStore = useViewStore();
/** The interface language of this page (it only changes with a reload). */
const locale = currentLocale();
const editStore = useEditStore();
const collabStore = useCollabStore();

const { scenarios, currentScenarioId, status, readOnly, previewExpiresAt } = storeToRefs(mapStore);
const { peerList, syncState } = storeToRefs(collabStore);

/** Copy a share link (?map=<id>&room=<channel>): the guest opens the same map AND joins
 *  THIS session's collab channel (rooms are private per visitor otherwise). */
async function shareLink(): Promise<void> {
  const id = currentScenarioId.value;
  if (!id) return;
  const chan = collabStore.channel;
  const url = `${window.location.origin}${window.location.pathname}?map=${id}${chan ? `&room=${chan}` : ""}`;
  try {
    await navigator.clipboard.writeText(url);
    ElMessage.success(tr("Ссылка для совместного редактирования скопирована"));
  } catch {
    ElMessage.info(url);
  }
}

/** Two-letter initials for a peer avatar. */
const initials = (name: string): string =>
  name.replace(/[^\p{L}\p{N}]/gu, " ").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
const { dirty, edited, undoable, redoable, report, busy } = storeToRefs(editStore);

const previewClock = ref(Date.now());
let previewClockTimer: ReturnType<typeof setInterval> | undefined;
const previewCountdown = computed(() => {
  const deadline = previewExpiresAt.value;
  if (!deadline) return "";
  const seconds = Math.max(0, Math.ceil((deadline - previewClock.value) / 1000));
  if (seconds === 0) return tr("удалена с сервера");
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return tr("удаление через {time}", { time: `${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` });
});

/** Honest sync badge (replaces the old always-on «есть правки»): only when the map actually
 *  differs from base, and it reflects REAL sync — synced ✓ / saving ⟳ / not-synced ⚠. */
const syncBadge = computed(() => {
  if (!edited.value) return null;
  switch (syncState.value) {
    case "synced": return { text: tr("✓ синхронизировано"), type: "success" as const };
    case "syncing": return { text: tr("⟳ сохранение…"), type: "info" as const };
    default: return { text: tr("⚠ не синхронизировано"), type: "warning" as const };
  }
});

/** Current map name for the bar: liveDoc (base + applied edits — reflects a setScenarioInfo
 *  rename immediately) with the BASE file's name as fallback before a project exists. */
const liveMapName = computed(() => editStore.liveDoc?.header.name || mapStore.mapName);
watch(
  liveMapName,
  (name) => {
    document.title = name ? `${name} — D2 Editor` : "D2 Editor";
  },
  { immediate: true },
);

/** Persistent validity indicator ("will this map save?"). null = not checked since the last
 *  edit; the map auto-re-checks ~2.5s after the user stops editing (editStore). */
const validity = computed<"ok" | "fail" | null>(() => {
  const r = report.value;
  if (!r) return null;
  return r.ok ? "ok" : "fail";
});
const validateHint = computed(() =>
  validity.value === "ok"
    ? tr("Проверка пройдена: карта корректна и сохранится/экспортируется")
    : validity.value === "fail"
      ? tr("Карта НЕ пройдёт сохранение — кликните за подробной причиной")
      : tr("Проверить карту (после правок проверяется автоматически)"),
);
const {
  terrainVisible, objectsVisible, gridVisible, locationsVisible,
  animate, objectPanelVisible, eventPanelVisible, anchorsVisible, rolesVisible, minimapVisible, debugOverlay, copilotVisible, dark, overlayTints,
} = storeToRefs(viewStore);

const dialogVisible = ref(false);
const listLoading = ref(false);
const shortcutsVisible = ref(false);
const voiceBusy = ref(false);
const voiceEnabled = ref(false);
let integrationAutoStarted = false;

async function openDialog(): Promise<void> {
  dialogVisible.value = true;
  listLoading.value = true;
  try {
    await mapStore.loadScenarios();
  } catch (e) {
    ElMessage.error(tr("Не удалось получить список: {error}", { error: e instanceof Error ? e.message : String(e) }));
  } finally {
    listLoading.value = false;
  }
}

async function chooseScenario(entry: ScenarioEntry): Promise<void> {
  dialogVisible.value = false;
  try {
    await mapStore.openMap(entry.id);
  } catch (e) {
    ElMessage.error(tr("Не удалось открыть «{name}»: {error}", { name: entry.name, error: e instanceof Error ? e.message : String(e) }));
  }
}

/** scenarios grouped by campaign, for the Карта submenu. */
const scenariosByCampaign = computed(() => {
  const groups = new Map<string, ScenarioEntry[]>();
  for (const s of scenarios.value) {
    const k = s.campaign || "—";
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
  }
  return [...groups.entries()].map(([campaign, maps]) => ({ campaign, maps }));
});

async function onMapCommand(id: string): Promise<void> {
  if (id === currentScenarioId.value) return;
  try {
    await mapStore.openMap(id);
  } catch (e) {
    ElMessage.error(tr("Не удалось открыть карту: {error}", { error: e instanceof Error ? e.message : String(e) }));
  }
}

// Keep an EditorProject alive for whichever map is open (restores persisted edits).
watch(
  [currentScenarioId, readOnly],
  ([id, isReadOnly]) => {
    if (id) editStore.ensureProject(id, { readOnly: isReadOnly });
  },
  { immediate: true },
);

const yn = (b: boolean): string => (b ? "✓" : "✗");

// The notification is rendered with dangerouslyUseHTMLString — the semantic reason + structural
// messages now embed user-controlled VALUES (unit/player names, winText, descriptions), so escape
// every dynamic part before it becomes HTML. The static prefixes carry no metacharacters.
const escHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);

function showReport(r: ValidationReport): void {
  const lines = [
    `identity ${yn(r.identity)} · semantic ${yn(r.semantic.ok)} · structural ${yn(r.structural.ok)}`,
    `${trn("{n} правка|{n} правки|{n} правок", r.opCount)} · ${trn("{size} байт|{size} байта|{size} байт", r.byteLength, { size: r.byteLength.toLocaleString(intlLocale()) })}`,
  ];
  if (!r.semantic.ok && r.semantic.reason) lines.push(`semantic: ${escHtml(r.semantic.reason)}`);
  if (r.structural.errors.length) lines.push(tr("ошибки: {list}", { list: escHtml(r.structural.errors.slice(0, 3).join("; ")) }));
  if (r.structural.warnings.length) {
    lines.push(tr("предупреждения ({count}): {list}", { count: r.structural.warnings.length, list: escHtml(r.structural.warnings.slice(0, 2).join("; ")) }));
  }
  ElNotification({
    title: r.ok ? tr("Карта корректна") : tr("Карта не прошла проверку"),
    message: lines.join("<br>"),
    dangerouslyUseHTMLString: true,
    type: r.ok ? "success" : "error",
    duration: r.ok ? 4000 : 0,
  });
}

async function doValidate(): Promise<void> {
  if (!currentScenarioId.value) {
    ElMessage.warning(tr("Сначала откройте карту"));
    return;
  }
  try {
    const r = await editStore.validate();
    if (r) showReport(r);
  } catch (e) {
    ElMessage.error(tr("Проверка не удалась: {error}", { error: e instanceof Error ? e.message : String(e) }));
  }
}

async function doExport(): Promise<void> {
  if (!currentScenarioId.value) {
    ElMessage.warning(tr("Сначала откройте карту"));
    return;
  }
  try {
    const r = await editStore.exportSg();
    if (!r) return;
    if (r.ok) ElMessage.success(tr("Экспортировано «{name}» (проверено)", { name: r.filename }));
    else {
      showReport(r.report);
      ElMessage.error(tr("Экспорт заблокирован — карта не прошла проверку"));
    }
  } catch (e) {
    ElMessage.error(tr("Экспорт не удался: {error}", { error: e instanceof Error ? e.message : String(e) }));
  }
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Default game-ready export. The editor backend builds the current .sg and the private voice
 * service appends only audio referenced by that exact revision. */
async function doPackageExport(allowMissing = false): Promise<void> {
  const id = currentScenarioId.value, project = editStore.project;
  if (!id || !project) {
    ElMessage.warning(tr("Сначала откройте карту"));
    return;
  }
  try {
    const returnUrl = new URL(window.location.href);
    returnUrl.searchParams.delete("resumeVoiceExport");
    const r = await exportProjectPackage(id, project, allowMissing, returnUrl.pathname + returnUrl.search);
    if (!r.ok) {
      const names = r.missing.slice(0, 20).map((x) => `${x.kind === "music" ? "MusicP" : "SoundsP"}/${x.name}`).join("\n");
      await ElMessageBox.confirm(
        `${tr("В голосовом проекте не найдены файлы:")}\n\n${names}${r.missing.length > 20 ? `\n${tr("…ещё {count}", { count: r.missing.length - 20 })}` : ""}\n\n${tr("Скачать пакет без них?")}`,
        tr("Не хватает пользовательского аудио"),
        { type: "warning", confirmButtonText: tr("Скачать без них"), cancelButtonText: tr("Отмена") },
      );
      return void doPackageExport(true);
    }
    saveBlob(r.blob, r.filename); ElMessage.success(tr("Готов пакет «{name}»", { name: r.filename }));
  } catch (e) {
    if (e instanceof VoiceLoginRequiredError) {
      sessionStorage.setItem("d2.voice.export", allowMissing ? "allow-missing" : "1");
      window.location.href = e.loginUrl;
      return;
    }
    if (String(e).includes("голосовой проект не найден")) return void doExport();
    if (e === "cancel" || e === "close") return;
    ElMessage.error(tr("Экспорт пакета не удался: {error}", { error: e instanceof Error ? e.message : String(e) }));
  }
}

function cleanIntegrationUrl(): void {
  const u = new URL(window.location.href);
  u.searchParams.delete("voiceReturn"); u.searchParams.delete("resumeVoice");
  u.searchParams.delete("resumeVoiceExport");
  history.replaceState(null, "", u.pathname + u.search + u.hash);
}

async function startVoiceHandoff(): Promise<void> {
  const id = currentScenarioId.value, project = editStore.project;
  if (!id || !project || voiceBusy.value) return;
  voiceBusy.value = true;
  try {
    const returnUrl = new URL(window.location.href);
    returnUrl.searchParams.delete("voiceReturn"); returnUrl.searchParams.delete("resumeVoice");
    const result = await createVoiceHandoff(id, project, returnUrl.pathname + returnUrl.search);
    if ("loginRequired" in result) {
      sessionStorage.setItem("d2.voice.resume", "1"); window.location.href = result.loginUrl; return;
    }
    window.location.href = result.launchUrl;
  } catch (e) {
    ElNotification({ title: tr("Переход в озвучку не выполнен"), message: e instanceof Error ? e.message : String(e), type: "error", duration: 0 });
  } finally { voiceBusy.value = false; }
}

async function resolveVoiceReturn(token: string): Promise<void> {
  const id = currentScenarioId.value, project = editStore.project;
  if (!id || !project || voiceBusy.value) return;
  voiceBusy.value = true;
  try {
    let preview = await previewVoiceReturn(id, token, project);
    let applied;
    for (;;) {
      const resolutions: Record<string, "editor" | "voice"> = {};
      for (const c of preview.conflicts) {
        try {
          await ElMessageBox.confirm(
            `${tr("Редактор:")}\n${c.editorSummary}\n\n${tr("Войсер:")}\n${c.voiceSummary}`,
            tr("Конфликт события «{name}»", { name: c.eventName || c.eventId }),
            {
              type: "warning", confirmButtonText: tr("Взять из войсера"), cancelButtonText: tr("Оставить редактор"),
              distinguishCancelAndClose: true, closeOnClickModal: false,
            },
          );
          resolutions[c.eventId] = "voice";
        } catch (action) {
          if (action === "cancel") resolutions[c.eventId] = "editor";
          else throw new Error(tr("Возврат отложен — результат сохранён в войсере"));
        }
      }
      try {
        applied = await applyVoiceReturn(id, token, editStore.project!, resolutions, preview.currentEventHashes);
        break;
      } catch (e) {
        if (!(e instanceof VoiceReturnRefreshError)) throw e;
        preview = e.preview;
        ElMessage.warning(tr("События успели измениться — окно конфликтов обновлено"));
      }
    }
    if (applied.ops.length) editStore.commitExternal(applied.ops, applied.uids);
    if (!editStore.project) throw new Error(tr("Проект редактора исчез во время возврата"));
    await acknowledgeVoiceReturn(id, token, editStore.project);
    cleanIntegrationUrl();
    ElMessage.success(applied.ops.length ? tr("Возвращено событий: {count}", { count: applied.ops.length }) : tr("Изменения уже были применены"));
  } catch (e) {
    ElNotification({ title: tr("Возврат из озвучки не завершён"), message: e instanceof Error ? e.message : String(e), type: "warning", duration: 0 });
  } finally { voiceBusy.value = false; }
}

// --- New Map -----------------------------------------------------------------
const newMapVisible = ref(false);
const newMapBusy = ref(false);
const newMap = ref<{ size: number; fill: string; name: string; races: string[]; modId?: string }>(
  { size: 72, fill: "default", name: trc("Новая карта"), races: ["empire", "undead"] },
);
// a new map is made for the mod being worked on (else the server's default) — offered once
// the dialog opens, when the mod list is certainly loaded
watch(newMapVisible, (open) => {
  if (!open) return;
  const ids = modStore.openableMods.map((m) => m.id);
  if (newMap.value.modId && ids.includes(newMap.value.modId)) return;
  const preferred = [modStore.activeModId, modStore.defaultModId].find((id) => id && ids.includes(id));
  newMap.value.modId = preferred ?? ids[0];
});
/** Playable races (the addRace port): each = player + capital + guardian + hero. */
const raceOptions = [
  { value: "empire", label: tr("Империя") },
  { value: "undead", label: tr("Орды Нежити") },
  { value: "clans", label: tr("Кланы Гор") },
  { value: "legions", label: tr("Легионы Проклятых") },
  { value: "elves", label: tr("Эльфийский Союз") },
];
const fillOptions = [
  { value: "default", label: tr("Нейтральная земля") },
  { value: "empire", label: tr("Империя (зелень)") },
  { value: "undead", label: tr("Нежить (пустошь)") },
  { value: "legions", label: tr("Легионы (инферно)") },
  { value: "elf", label: tr("Эльфы (лес)") },
  { value: "snow", label: tr("Горные кланы (снег)") },
  { value: "water", label: tr("Вода") },
];

async function doCreateNewMap(): Promise<void> {
  newMapBusy.value = true;
  try {
    const id = await createNewMap(newMap.value);
    await mapStore.openMap(id);
    editStore.ensureProject(id);
    newMapVisible.value = false;
    ElMessage.success(tr("Создана карта {size}×{size}", { size: newMap.value.size }));
  } catch (e) {
    // PERSISTENT notification (not an auto-dismissing toast): a silent failure here left the
    // editor on the previous map with its "есть правки" tag — which read as "the new map
    // inherited the old edits". Be explicit that NOTHING changed.
    ElNotification({
      type: "error",
      title: tr("Карта НЕ создана"),
      message: tr("Сервер не ответил ({error}). Открыта прежняя карта — её правки не тронуты. Попробуйте ещё раз.", { error: e instanceof Error ? e.message : String(e) }),
      duration: 0,
    });
  } finally {
    newMapBusy.value = false;
  }
}

// --- Upload .sg --------------------------------------------------------------
// Registers a user's own .sg as a PRIVATE map: listed only to this browser (owner-scoped by
// x-client-id), permanent (the temporary-copy sweeper never touches it), shareable only via its
// id link. Native file picker (hidden input) — one open per pick; the input is reset so re-picking
// the same file fires `change` again.
const uploadInput = ref<HTMLInputElement | null>(null);
const uploadBusy = ref(false);
function triggerUpload(): void {
  uploadInput.value?.click();
}
async function onUploadFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // allow re-picking the same file
  if (!file || uploadBusy.value) return;
  uploadBusy.value = true;
  try {
    const id = await uploadMap(file);
    await mapStore.openMap(id);
    editStore.ensureProject(id);
    dialogVisible.value = false;
    ElMessage.success(tr("Загружена «{name}» — карта приватная (видят только по вашей ссылке)", { name: file.name }));
  } catch (err) {
    ElNotification({
      title: tr("Загрузка не удалась"),
      message: err instanceof Error ? err.message : String(err),
      type: "error",
      duration: 0,
    });
  } finally {
    uploadBusy.value = false;
  }
}

/** el-menu dispatcher — one place routes every menu-item index to its action. */
function onSelect(index: string): void {
  if (readOnly.value && !index.startsWith("view:") && !index.startsWith("help:")) {
    ElMessage.info(tr("Временная карта открыта только для просмотра"));
    return;
  }
  switch (index) {
    case "file:open": return void openDialog();
    case "file:new": newMapVisible.value = true; return;
    case "file:upload": return triggerUpload();
    case "file:export": return void (voiceEnabled.value ? doPackageExport() : doExport());
    case "file:exportSg": return void doExport();
    case "edit:undo": return editStore.undoEdit();
    case "edit:redo": return editStore.redoEdit();
    case "edit:validate": return void doValidate();
    case "edit:discard": editStore.reset(); ElMessage.info(tr("Правки сброшены")); return;
    case "view:terrain": return viewStore.setLayerVisible("terrain", !terrainVisible.value);
    case "view:objects": return viewStore.setLayerVisible("objects", !objectsVisible.value);
    case "view:grid": return viewStore.toggleGrid();
    case "view:locations": return viewStore.toggleLocations();
    case "view:animate": return viewStore.toggleAnimate();
    case "view:objectPanel": return viewStore.toggleObjectPanel();
    case "view:eventPanel": return viewStore.toggleEventPanel();
    case "view:anchors": return viewStore.toggleAnchors();
    case "view:roles": return viewStore.toggleRoles();
    case "view:minimap": return viewStore.toggleMinimap();
    case "view:debug": return viewStore.toggleDebugOverlay();
    case "view:fit": getScene()?.fitView(); return;
    case "view:copilot": return viewStore.toggleCopilot();
    case "view:appearance": return viewStore.toggleDark();
    case "help:keys": shortcutsVisible.value = true; return;
  }
  if (index.startsWith("view:tint:")) return viewStore.toggleOverlayTint(index.slice(10) as never);
  if (index.startsWith("map:")) return void onMapCommand(index.slice(4));
}

onMounted(() => {
  previewClockTimer = setInterval(() => { previewClock.value = Date.now(); }, 1000);
  void mapStore.loadScenarios().catch(() => {});
  void getRuntimeFeatures().then((f) => { voiceEnabled.value = f.voiceIntegration; }).catch(() => {});
});
onBeforeUnmount(() => clearInterval(previewClockTimer));

watch(
  () => [currentScenarioId.value, editStore.project?.baseScenarioId] as const,
  ([id, projectId]) => {
    if (!id || projectId !== id || readOnly.value || integrationAutoStarted) return;
    const q = new URLSearchParams(window.location.search);
    const returnToken = q.get("voiceReturn");
    const resume = q.get("resumeVoice") === "1" || sessionStorage.getItem("d2.voice.resume") === "1";
    const resumeExport = q.get("resumeVoiceExport") === "1" || sessionStorage.getItem("d2.voice.export") != null;
    if (returnToken) { integrationAutoStarted = true; void resolveVoiceReturn(returnToken); }
    else if (resume) {
      integrationAutoStarted = true; sessionStorage.removeItem("d2.voice.resume"); cleanIntegrationUrl(); void startVoiceHandoff();
    }
    else if (resumeExport) {
      integrationAutoStarted = true;
      const allowMissing = sessionStorage.getItem("d2.voice.export") === "allow-missing";
      sessionStorage.removeItem("d2.voice.export"); cleanIntegrationUrl(); void doPackageExport(allowMissing);
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="menu-bar">
    <span class="app-title"><span class="app-mark" />Disciples II</span>

    <el-menu class="topmenu" mode="horizontal" :ellipsis="false" :default-active="''" @select="onSelect">
      <el-sub-menu v-if="!readOnly" index="file">
        <template #title>{{ tr("Файл") }}</template>
        <el-menu-item index="file:open">{{ tr("Открыть карту…") }}<span class="mkbd">Ctrl+O</span></el-menu-item>
        <el-menu-item index="file:new">{{ tr("Новая карта…") }}</el-menu-item>
        <el-menu-item index="file:upload">{{ tr("Загрузить .sg…") }}</el-menu-item>
        <el-menu-item index="file:export">{{ voiceEnabled ? tr('Скачать карту с аудио (.zip)…') : tr('Экспорт .sg…') }}</el-menu-item>
        <el-menu-item v-if="voiceEnabled" index="file:exportSg">{{ tr("Экспорт только .sg…") }}</el-menu-item>
      </el-sub-menu>

      <!-- Правка / Вид / Карта / Справка consolidated under ONE menu — the freed bar space
           hosts direct-access buttons (Сценарий, Проверка). Canonical homes stay here. -->
      <el-sub-menu index="more">
        <template #title>{{ tr("Меню") }}</template>
      <el-sub-menu v-if="!readOnly" index="edit">
        <template #title>{{ tr("Правка") }}</template>
        <el-menu-item index="edit:undo" :disabled="!undoable">{{ tr("Отменить") }}<span class="mkbd">Ctrl+Z</span></el-menu-item>
        <el-menu-item index="edit:redo" :disabled="!redoable">{{ tr("Вернуть") }}<span class="mkbd">Ctrl+⇧Z</span></el-menu-item>
        <el-menu-item index="edit:validate">{{ tr("Проверить карту") }}</el-menu-item>
        <el-menu-item index="edit:discard" :disabled="!dirty">{{ tr("Сбросить правки") }}</el-menu-item>
      </el-sub-menu>

      <el-sub-menu index="view">
        <template #title>{{ tr("Вид") }}</template>
        <el-menu-item index="view:terrain"><el-icon class="mck" :style="{ visibility: terrainVisible ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Слой рельефа") }}<span class="mkbd">T</span></el-menu-item>
        <el-menu-item index="view:objects"><el-icon class="mck" :style="{ visibility: objectsVisible ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Слой объектов") }}<span class="mkbd">O</span></el-menu-item>
        <el-menu-item index="view:grid"><el-icon class="mck" :style="{ visibility: gridVisible ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Сетка") }}<span class="mkbd">G</span></el-menu-item>
        <el-menu-item index="view:locations"><el-icon class="mck" :style="{ visibility: locationsVisible ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Локации") }}<span class="mkbd">L</span></el-menu-item>
        <el-menu-item index="view:animate"><el-icon class="mck" :style="{ visibility: animate ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Анимация") }}<span class="mkbd">A</span></el-menu-item>
        <el-menu-item index="view:objectPanel"><el-icon class="mck" :style="{ visibility: objectPanelVisible ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Панель объектов") }}<span class="mkbd">P</span></el-menu-item>
        <el-menu-item v-if="!readOnly" index="view:eventPanel"><el-icon class="mck" :style="{ visibility: eventPanelVisible ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Сценарий (события)") }}<span class="mkbd">E</span></el-menu-item>
        <el-menu-item v-if="!readOnly" index="view:anchors"><el-icon class="mck" :style="{ visibility: anchorsVisible ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Связи (якоря ⚓)") }}</el-menu-item>
        <el-menu-item index="view:roles"><el-icon class="mck" :style="{ visibility: rolesVisible ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Роли локаций") }}</el-menu-item>
        <el-menu-item index="view:minimap"><el-icon class="mck" :style="{ visibility: minimapVisible ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Миникарта") }}</el-menu-item>
        <el-menu-item index="view:debug"><el-icon class="mck" :style="{ visibility: debugOverlay ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Отладка") }}<span class="mkbd">D</span></el-menu-item>
        <el-sub-menu index="view:tints">
          <template #title>{{ tr("Подсветки") }}</template>
          <el-menu-item index="view:tint:passable"><el-icon class="mck" :style="{ visibility: overlayTints.passable ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Проходимость") }}</el-menu-item>
          <el-menu-item index="view:tint:danger"><el-icon class="mck" :style="{ visibility: overlayTints.danger ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Опасность") }}</el-menu-item>
          <el-menu-item index="view:tint:terraform"><el-icon class="mck" :style="{ visibility: overlayTints.terraform ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Террформинг") }}</el-menu-item>
          <el-menu-item index="view:tint:forest"><el-icon class="mck" :style="{ visibility: overlayTints.forest ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Лес") }}</el-menu-item>
          <el-menu-item index="view:tint:roads"><el-icon class="mck" :style="{ visibility: overlayTints.roads ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Дороги") }}</el-menu-item>
        </el-sub-menu>
        <el-menu-item index="view:fit">{{ tr("К размеру окна") }}<span class="mkbd">F</span></el-menu-item>
        <el-menu-item v-if="!readOnly" index="view:copilot"><el-icon class="mck" :style="{ visibility: copilotVisible ? 'visible' : 'hidden' }"><Check /></el-icon>Copilot<span class="mkbd">/</span></el-menu-item>
        <el-menu-item index="view:appearance"><el-icon class="mck" :style="{ visibility: dark ? 'visible' : 'hidden' }"><Check /></el-icon>{{ tr("Тёмная тема") }}</el-menu-item>
      </el-sub-menu>

      <el-sub-menu v-if="!readOnly" index="map">
        <template #title>{{ tr("Карта") }}</template>
        <el-sub-menu v-for="g in scenariosByCampaign" :key="g.campaign" :index="'map:camp:' + g.campaign">
          <template #title>{{ g.campaign }}</template>
          <el-menu-item v-for="m in g.maps" :key="m.id" :index="'map:' + m.id">
            <el-icon class="mck" :style="{ visibility: m.id === currentScenarioId ? 'visible' : 'hidden' }"><Check /></el-icon>
            {{ m.name }} <span class="mkbd">{{ m.mapSize }}×{{ m.mapSize }}</span>
          </el-menu-item>
        </el-sub-menu>
      </el-sub-menu>

      <el-sub-menu index="help">
        <template #title>{{ tr("Справка") }}</template>
        <el-menu-item index="help:keys">{{ tr("Горячие клавиши…") }}</el-menu-item>
      </el-sub-menu>
      </el-sub-menu>
    </el-menu>

    <!-- direct-access buttons (rapid surface; canonical homes stay in the menu) -->
    <el-button
      v-if="!readOnly"
      class="quick-btn"
      size="small"
      :class="{ 'is-open': eventPanelVisible }"
      :disabled="!currentScenarioId"
      @click="viewStore.toggleEventPanel()"
    >{{ tr("Сценарий") }}</el-button>

    <el-button
      v-if="voiceEnabled && !readOnly"
      class="quick-btn"
      size="small"
      :loading="voiceBusy"
      :disabled="!currentScenarioId"
      @click="startVoiceHandoff()"
    >{{ tr("Диалоги и озвучка") }}</el-button>

    <span class="bar-spacer" />

    <span v-if="liveMapName" class="map-title">{{ liveMapName }}</span>
    <MapModBadge />
    <el-tag v-if="readOnly" size="small" type="warning" effect="dark" round>
      {{ tr("Только просмотр") }} · {{ previewCountdown }}
    </el-tag>
    <el-tag v-if="status === 'loading'" size="small" type="warning" effect="plain" round>{{ tr("Загрузка…") }}</el-tag>
    <el-tag v-if="syncBadge" size="small" :type="syncBadge.type" effect="plain" round>{{ syncBadge.text }}</el-tag>

    <!-- Check button IS the status (no separate chip): the map auto-re-checks ~2.5s after
         the last edit; the button turns green (ok) / RED PULSING (won't save; click for the
         detailed reasons). Neutral while unchecked/pending. -->
    <el-tooltip v-if="!readOnly" :content="validateHint" placement="bottom" :show-after="200">
      <el-button
        class="validate-btn"
        :class="{ pulse: validity === 'fail' }"
        size="small"
        :type="validity === 'ok' ? 'success' : validity === 'fail' ? 'danger' : ''"
        :plain="validity === 'ok'"
        :loading="busy"
        :disabled="!currentScenarioId"
        @click="doValidate()"
      >
        <el-icon v-if="validity === 'ok'" class="chip-ico"><CircleCheck /></el-icon>
        <el-icon v-else-if="validity === 'fail'" class="chip-ico"><WarningFilled /></el-icon>
        {{ validity === 'fail' ? tr('не сохранится!') : tr('Проверка') }}
      </el-button>
    </el-tooltip>

    <!-- collaborators present in this map's room (each in their assigned colour) -->
    <span v-if="peerList.length" class="peers">
      <el-tooltip
        v-for="p in peerList"
        :key="p.socketId"
        :content="p.name"
        placement="bottom"
        :show-after="200"
      >
        <span class="peer-avatar" :style="{ background: p.color }">{{ initials(p.name) }}</span>
      </el-tooltip>
    </span>
    <el-tooltip v-if="!readOnly" :content="tr('Скопировать ссылку для совместного редактирования')" placement="bottom" :show-after="300">
      <el-button class="appearance" text :icon="Share" :disabled="!currentScenarioId" @click="shareLink()" />
    </el-tooltip>

    <!-- interface language: the button shows the current one; choosing another reloads the page -->
    <el-dropdown trigger="click" @command="(l: Locale) => switchLocale(l)">
      <el-button class="appearance lang-btn" text :title="tr('Язык интерфейса')">{{ locale.toUpperCase() }}</el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-for="l in LOCALES" :key="l.value" :command="l.value" :class="{ 'lang-current': l.value === locale }">
            {{ l.label }}
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <el-tooltip :content="dark ? tr('Светлая тема') : tr('Тёмная тема')" placement="bottom" :show-after="300">
      <el-button class="appearance" text :icon="dark ? Sunny : Moon" @click="viewStore.toggleDark()" />
    </el-tooltip>

    <el-dialog v-model="dialogVisible" :title="tr('Открыть карту')" width="640px" :close-on-click-modal="true">
      <el-table
        v-loading="listLoading"
        :data="scenarios"
        height="360"
        highlight-current-row
        @row-click="chooseScenario"
      >
        <el-table-column prop="name" :label="tr('Название')" min-width="200" />
        <el-table-column prop="campaign" :label="tr('Кампания')" min-width="160" />
        <el-table-column v-if="modStore.mods.length > 1" :label="tr('Мод')" min-width="120">
          <template #default="{ row }">
            {{ modStore.nameOf(row.mod) }}
            <!-- the server attaches a report only to maps that do not fit their mod -->
            <el-tooltip
              v-if="row.compat && !row.compat.playable"
              placement="top"
              :show-after="200"
              :content="misfitHint(row.compat)"
            >
              <span class="mod-misfit" :aria-label="tr('не подходит моду')">⚠</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column :label="tr('Размер')" width="90">
          <template #default="{ row }">{{ row.mapSize }}×{{ row.mapSize }}</template>
        </el-table-column>
        <el-table-column prop="players" :label="tr('Игроки')" width="90" />
        <el-table-column label="" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.id === currentScenarioId" size="small" type="success">{{ tr("открыта") }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <div class="open-footer">
          <span class="dialog-hint">{{ tr("Кликните строку, чтобы открыть карту.") }}</span>
          <el-button size="small" :loading="uploadBusy" @click="triggerUpload">{{ tr("Загрузить свою .sg…") }}</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- Native file picker for «Загрузить .sg…» (menu + Open-map dialog). Uploaded maps are private
         (owner-scoped, shareable only by their id link) and never swept by the temporary-copy watcher. -->
    <input ref="uploadInput" type="file" accept=".sg" style="display: none" @change="onUploadFile" />

    <el-dialog v-model="newMapVisible" :title="tr('Новая карта')" width="380px">
      <el-form label-width="90px" label-position="left">
        <el-form-item :label="tr('Название')">
          <el-input v-model="newMap.name" :placeholder="tr('Новая карта')" />
        </el-form-item>
        <el-form-item v-if="modStore.openableMods.length > 1" :label="tr('Мод')">
          <el-select v-model="newMap.modId">
            <el-option v-for="m in modStore.openableMods" :key="m.id" :label="m.name" :value="m.id" />
          </el-select>
          <div class="nm-hint">{{ tr("Юниты, предметы и графика карты берутся из этого мода.") }}</div>
        </el-form-item>
        <el-form-item :label="tr('Размер')">
          <el-select v-model="newMap.size">
            <el-option v-for="s in [48, 72, 96, 120, 144]" :key="s" :label="`${s} × ${s}`" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item :label="tr('Заливка')">
          <el-select v-model="newMap.fill">
            <el-option v-for="o in fillOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item :label="tr('Фракции')">
          <el-checkbox-group v-model="newMap.races" class="nm-races">
            <el-checkbox v-for="r in raceOptions" :key="r.value" :value="r.value">{{ r.label }}</el-checkbox>
          </el-checkbox-group>
          <!-- гейт ≥1 фракции: сервер отклоняет карту без рас — подсказываем сразу -->
          <div v-if="!newMap.races.length" class="nm-hint nm-hint-error">{{ tr("выберите хотя бы одну фракцию") }}</div>
          <div class="nm-hint">{{ tr("Каждая фракция получает игрока, столицу со стражем и героя.") }}</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="newMapVisible = false">{{ tr("Отмена") }}</el-button>
        <el-button type="primary" :loading="newMapBusy" :disabled="!newMap.races.length" @click="doCreateNewMap()">{{ tr("Создать") }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="shortcutsVisible" :title="tr('Горячие клавиши')" width="420px">
      <div class="keys">
        <div class="krow"><kbd>T</kbd> <kbd>O</kbd> <kbd>G</kbd> <kbd>L</kbd> <span>{{ tr("слои: рельеф / объекты / сетка / локации") }}</span></div>
        <div class="krow"><kbd>A</kbd> <kbd>P</kbd> <kbd>D</kbd> <span>{{ tr("анимация / панель объектов / отладка") }}</span></div>
        <div class="krow"><kbd>F</kbd> <span>{{ tr("вписать карту в окно") }}</span></div>
        <div class="krow"><kbd>/</kbd> <span>{{ tr("фокус на Copilot") }}</span></div>
        <div class="krow"><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>⇧</kbd>+<kbd>Z</kbd> <span>{{ tr("отменить / вернуть") }}</span></div>
        <div class="krow"><kbd>Ctrl</kbd>+{{ tr("тащить") }} <span>{{ tr("двигать карту · колесо — масштаб") }}</span></div>
        <div class="krow"><kbd>R</kbd> <kbd>[</kbd> <kbd>]</kbd> <span>{{ tr("облик декора (инструменты Декор / Двигать)") }}</span></div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.menu-bar {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 var(--d2-sp-3);
  gap: var(--d2-sp-2);
  background: var(--el-bg-color);
  border-bottom: var(--d2-hairline);
}
.peers {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin: 0 2px;
}
.peer-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.5);
  box-shadow: 0 0 0 1.5px var(--el-bg-color);
}
.app-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 600;
  font-size: 13px;
  margin-right: var(--d2-sp-2);
  color: var(--el-text-color-primary);
  white-space: nowrap;
}
.app-mark {
  width: 16px;
  height: 16px;
  border-radius: 5px;
  background: var(--el-color-primary);
}
/* el-menu reset: flat, header-height, no underline, transparent so the bar bg shows */
.topmenu.el-menu--horizontal {
  height: var(--d2-header-h);
  border-bottom: none;
  background: transparent;
  --el-menu-bg-color: transparent;
  --el-menu-hover-bg-color: var(--el-fill-color-light);
  --el-menu-active-color: var(--el-text-color-primary);
}
.topmenu.el-menu--horizontal :deep(.el-sub-menu__title) {
  height: calc(var(--d2-header-h) - 6px);
  line-height: calc(var(--d2-header-h) - 6px);
  border-bottom: none !important;
  border-radius: var(--d2-radius);
  padding: 0 10px;
  font-size: 13px;
}
.topmenu.el-menu--horizontal :deep(.el-sub-menu) {
  margin: 0 1px;
}
.bar-spacer {
  flex: 1;
}
.map-title {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.appearance {
  flex: 0 0 auto;
  /* icon-only actions sit back until pointed at (calmer) */
  opacity: 0.6;
  transition: opacity 0.12s ease;
}
.appearance:hover {
  opacity: 1;
}
.lang-btn {
  min-width: 34px;
  padding: 0 6px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
:global(.lang-current) {
  color: var(--el-color-primary);
  font-weight: 600;
}
.validate-btn {
  flex: 0 0 auto;
  margin-left: 4px;
}
/* the RED "won't save" state pulses to catch the eye immediately */
.validate-btn.pulse {
  animation: d2-pulse 1.1s ease-in-out infinite;
}
@keyframes d2-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(245, 108, 108, 0.55); }
  50% { box-shadow: 0 0 0 5px rgba(245, 108, 108, 0); }
}
.quick-btn {
  flex: 0 0 auto;
  margin-left: 6px;
}
.quick-btn.is-open {
  background: var(--d2-active-bg);
  color: var(--d2-active-fg);
  border-color: transparent;
}
.chip-ico {
  vertical-align: -2px;
  margin-right: 3px;
}
.dialog-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.open-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.nm-races {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 10px;
}
.nm-races :deep(.el-checkbox) {
  height: 24px;
  margin-right: 0;
}
.mod-misfit {
  margin-left: 4px;
  color: var(--el-color-warning);
  cursor: help;
}
.nm-hint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  line-height: 1.4;
  margin-top: 2px;
}
.nm-hint-error {
  color: var(--el-color-danger);
}
.keys {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.krow {
  display: flex;
  align-items: center;
  gap: 6px;
}
.krow span {
  color: var(--el-text-color-secondary);
}
kbd {
  font-family: inherit;
  font-size: 11px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  padding: 1px 6px;
}
</style>

<!-- Menu popups teleport to <body>; style their items + checkmark column unscoped. -->
<style>
.el-menu--horizontal .el-menu .el-menu-item,
.el-menu--horizontal .el-menu .el-sub-menu__title {
  height: 34px;
  line-height: 34px;
  font-size: 13px;
}
.el-menu--horizontal .el-menu-item .mck,
.el-menu--horizontal .el-menu .mck {
  margin-right: 6px;
  color: var(--el-color-primary);
}
.el-menu--horizontal .el-menu-item .mkbd,
.el-menu .el-menu-item .mkbd {
  margin-left: auto;
  padding-left: 18px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
</style>
