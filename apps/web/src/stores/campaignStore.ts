/**
 * Campaigns — the game's custom sagas (`.csg`): the listing, the campaign being worked on and
 * which of its missions is open. A mission is an ordinary map (its own id, its own project of
 * edits); the campaign says which maps, in what order, under which header.
 *
 * The open campaign lives in the address (`?campaign=<id>&mission=<n>`, n from 1, next to the
 * `?map=` of the open map), so a reload — and the reload that opening a mission of another mod
 * causes (mapStore.reloadOnMap) — keeps it. The dialogs (CampaignDialogs.vue) are opened from
 * the menu and the campaign bar through this store.
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import type { CampaignEntry, CampaignHeaderInfo, CampaignInput, CampaignMissionIssue } from "@d2/socket-contract";
import { campaignMissionIssues, type EditorProject } from "@d2/map-edit";
import {
  copyCampaign,
  createCampaign,
  deleteCampaign,
  exportCampaign,
  fetchCampaign,
  fetchCampaigns,
  updateCampaign,
  uploadCampaign,
  type CampaignExportResult,
} from "../services/api";
import { useMapStore } from "./mapStore";
import { savedProjectOf, useEditStore } from "./editStore";
import { tr } from "../i18n";

const CAMPAIGN_PARAM = "campaign";
const MISSION_PARAM = "mission";

/** What a mission issue means, for a tooltip. */
export function issueText(issue: CampaignMissionIssue): string {
  switch (issue) {
    case "no-seat":
      return tr("В миссии нет игрока расы кампании — человеку негде играть.");
    case "no-capital-stack":
      return tr("В столице игрока нет отряда: игра вылетит, когда перенесёт в миссию героя.");
    case "unreadable":
      return tr("Редактор не открывает эту миссию (старый формат или её нет в саге).");
  }
}

/** The campaign of the address and its mission (0-based), as boot reads them. */
export function campaignFromUrl(): { id: string; mission: number | null } | null {
  const q = new URLSearchParams(window.location.search);
  const id = q.get(CAMPAIGN_PARAM);
  if (!id) return null;
  const n = Number(q.get(MISSION_PARAM));
  return { id, mission: Number.isInteger(n) && n >= 1 ? n - 1 : null };
}

/** Put the campaign (and its open mission) into the address, or take it out. The address also
 *  carries the open map itself (`?map=`, kept by the canvas host): a reload opens that map and
 *  brings the campaign back around it; `mission` serves a link without the map. */
function writeUrl(id: string | null, mission: number): void {
  const url = new URL(window.location.href);
  if (id) {
    url.searchParams.set(CAMPAIGN_PARAM, id);
    if (mission >= 0) url.searchParams.set(MISSION_PARAM, String(mission + 1));
  } else {
    url.searchParams.delete(CAMPAIGN_PARAM);
    url.searchParams.delete(MISSION_PARAM);
  }
  if (url.href !== window.location.href) history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** The header as a campaign is saved with (its race must be one of the six). */
function inputHeader(h: CampaignHeaderInfo): CampaignInput["header"] {
  if (!h.race) throw new Error(tr("У кампании не указана раса"));
  return { ...h, race: h.race };
}

export const useCampaignStore = defineStore("campaign", () => {
  const mapStore = useMapStore();
  const editStore = useEditStore();

  const list = ref<CampaignEntry[]>([]);
  const listLoading = ref(false);
  /** The campaign being worked on, as REST.campaign returns it (missions with their issues). */
  const current = ref<CampaignEntry | null>(null);
  const busy = ref(false);

  /** «Открыть кампанию» dialog. */
  const openVisible = ref(false);
  /** The campaign window: a new campaign (`create`) or the current one (`edit`). */
  const editorVisible = ref(false);
  const editorMode = ref<"create" | "edit">("edit");

  /** Which mission of the current campaign the open map is (-1: the map is not one of them). */
  const missionIndex = computed(() => {
    const id = mapStore.currentScenarioId;
    return current.value && id ? current.value.missions.findIndex((m) => m.mapId === id) : -1;
  });

  /** What breaks the open mission in the game, with this browser's edits. */
  const liveIssues = computed<CampaignMissionIssue[]>(() => {
    void editStore.rev; // the live document changes in place: these ticks say when
    void editStore.objectsRev;
    const c = current.value;
    const doc = editStore.liveDoc;
    const index = missionIndex.value;
    if (!c || !doc || index < 0) return [];
    return campaignMissionIssues(doc, c.header.race, index);
  });

  /** The issues of mission `index`: live for the open one, as stored for the others. */
  function issuesOf(index: number): CampaignMissionIssue[] {
    if (index === missionIndex.value && editStore.liveDoc) return liveIssues.value;
    return current.value?.missions[index]?.issues ?? [];
  }

  // the address follows the mission being worked on
  watch(missionIndex, (index) => {
    if (current.value && index >= 0) writeUrl(current.value.id, index);
  });

  async function loadList(): Promise<CampaignEntry[]> {
    listLoading.value = true;
    try {
      list.value = await fetchCampaigns();
      return list.value;
    } finally {
      listLoading.value = false;
    }
  }

  /** `wanted` when the editor opens it, else the first mission it opens (-1: none). */
  function readableMission(c: CampaignEntry, wanted: number): number {
    if (c.missions[wanted]?.mapId) return wanted;
    return c.missions.findIndex((m) => m.mapId);
  }

  /** Open mission `index` of the current campaign. */
  async function openMission(index: number): Promise<void> {
    const c = current.value;
    const m = c?.missions[index];
    if (!c || !m) return;
    if (!m.mapId) throw new Error(tr("Эту миссию редактор не открывает (старый формат)"));
    // before the map opens: a mission of another mod reloads the page with this address
    writeUrl(c.id, index);
    if (m.mapId === mapStore.currentScenarioId) return;
    await mapStore.openMap(m.mapId);
  }

  /** Make `id` the campaign being worked on and open its mission `mission` (else its first). */
  async function open(id: string, mission = 0): Promise<void> {
    const c = await fetchCampaign(id);
    const target = readableMission(c, mission);
    if (target < 0) throw new Error(tr("В кампании нет миссий, которые открывает редактор"));
    current.value = c;
    await openMission(target);
  }

  /** Step to the previous (-1) or next (+1) mission the editor opens. */
  async function step(dir: -1 | 1): Promise<void> {
    const c = current.value;
    if (!c) return;
    for (let i = missionIndex.value + dir; i >= 0 && i < c.missions.length; i += dir) {
      if (c.missions[i]!.mapId) return openMission(i);
    }
  }

  /** The neighbour step() would go to, or -1. */
  function neighbour(dir: -1 | 1): number {
    const c = current.value;
    if (!c) return -1;
    const from = missionIndex.value < 0 ? (dir > 0 ? -1 : c.missions.length) : missionIndex.value;
    for (let i = from + dir; i >= 0 && i < c.missions.length; i += dir) if (c.missions[i]!.mapId) return i;
    return -1;
  }

  /**
   * At startup: bring back the campaign of the address. With `mission` (0-based) its mission
   * is opened; with null the map already open stays. Returns whether a mission was opened. A
   * campaign that is gone is dropped from the address.
   */
  async function restore(id: string, mission: number | null): Promise<boolean> {
    let c: CampaignEntry;
    try {
      c = await fetchCampaign(id);
    } catch {
      writeUrl(null, -1);
      return false;
    }
    current.value = c;
    if (mission === null) {
      writeUrl(c.id, missionIndex.value);
      return false;
    }
    const target = readableMission(c, mission);
    if (target < 0) return false;
    await openMission(target);
    return true;
  }

  function close(): void {
    current.value = null;
    writeUrl(null, -1);
  }

  /** Read the current campaign again (its missions' names and issues). */
  async function refresh(): Promise<void> {
    if (current.value) current.value = await fetchCampaign(current.value.id);
  }

  function adopt(c: CampaignEntry): void {
    current.value = c;
    writeUrl(c.id, missionIndex.value);
    const at = list.value.findIndex((x) => x.id === c.id);
    if (at >= 0) list.value.splice(at, 1, c);
    else list.value.unshift(c);
  }

  /** Create an own campaign and make it the current one; its first mission opens when the
   *  open map is not one of its missions. */
  async function create(input: CampaignInput): Promise<CampaignEntry> {
    busy.value = true;
    try {
      const c = await createCampaign(input);
      adopt(c);
      if (missionIndex.value < 0) await openMission(Math.max(0, readableMission(c, 0)));
      return c;
    } finally {
      busy.value = false;
    }
  }

  /** Save the current (own) campaign's header and missions. */
  async function save(input: CampaignInput): Promise<CampaignEntry> {
    const c = current.value;
    if (!c) throw new Error(tr("Кампания не открыта"));
    busy.value = true;
    try {
      const next = await updateCampaign(c.id, input);
      adopt(next);
      return next;
    } finally {
      busy.value = false;
    }
  }

  /** Append a map to the current campaign as its last mission. */
  async function addMission(mapId: string): Promise<CampaignEntry> {
    const c = current.value;
    if (!c) throw new Error(tr("Кампания не открыта"));
    const missions = c.missions.flatMap((m) => (m.mapId ? [m.mapId] : []));
    return save({ header: inputHeader(c.header), missions: [...missions, mapId] });
  }

  /** An own copy of the current campaign (a mod's saga changes only so); it becomes current. */
  async function copy(): Promise<CampaignEntry> {
    const c = current.value;
    if (!c) throw new Error(tr("Кампания не открыта"));
    busy.value = true;
    try {
      const own = await copyCampaign(c.id);
      adopt(own);
      return own;
    } finally {
      busy.value = false;
    }
  }

  /** Delete the current (own) campaign; its maps stay. */
  async function remove(): Promise<void> {
    const c = current.value;
    if (!c) return;
    busy.value = true;
    try {
      await deleteCampaign(c.id);
      list.value = list.value.filter((x) => x.id !== c.id);
      close();
    } finally {
      busy.value = false;
    }
  }

  /** A `.csg` from disk becomes an own campaign; its first mission opens. */
  async function upload(file: File): Promise<CampaignEntry> {
    busy.value = true;
    try {
      const c = await uploadCampaign(file);
      current.value = c;
      list.value.unshift(c);
      await mapStore.loadScenarios().catch(() => []); // its missions are new maps of the list
      await openMission(Math.max(0, readableMission(c, 0)));
      return c;
    } finally {
      busy.value = false;
    }
  }

  /** Download the current campaign as a `.csg`, every mission with this browser's edits. */
  async function exportCsg(): Promise<CampaignExportResult | null> {
    const c = current.value;
    if (!c) return null;
    const projects: Record<string, EditorProject> = {};
    for (const m of c.missions) {
      if (!m.mapId) continue;
      const open = editStore.project?.baseScenarioId === m.mapId && !editStore.readOnly ? editStore.project : null;
      const p = open ?? savedProjectOf(m.mapId);
      if (p) projects[m.mapId] = p;
    }
    busy.value = true;
    try {
      const r = await exportCampaign(c.id, projects);
      if (r.ok) saveBlob(r.blob, r.filename);
      return r;
    } finally {
      busy.value = false;
    }
  }

  function showOpen(): void {
    openVisible.value = true;
  }
  function showEditor(mode: "create" | "edit"): void {
    editorMode.value = mode;
    editorVisible.value = true;
  }

  return {
    list,
    listLoading,
    current,
    busy,
    openVisible,
    editorVisible,
    editorMode,
    missionIndex,
    liveIssues,
    issuesOf,
    loadList,
    open,
    openMission,
    step,
    neighbour,
    restore,
    close,
    refresh,
    create,
    save,
    addMission,
    copy,
    remove,
    upload,
    exportCsg,
    showOpen,
    showEditor,
  };
});
