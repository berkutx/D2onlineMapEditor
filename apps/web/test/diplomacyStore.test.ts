import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { MapDocument } from "@d2/map-schema";
import { emptyProject, makeCell } from "@d2/map-edit";
import { useEditStore } from "../src/stores/editStore";
import { useEventStore } from "../src/stores/eventStore";
vi.mock("../src/services/api", () => ({ validateProject: vi.fn(), exportProject: vi.fn(), generateRegion: vi.fn(), copilotLlm: vi.fn(), fetchProjectRemote: vi.fn(), saveProjectRemote: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); setActivePinia(createPinia()); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function setup(word: number) {
  const edit = useEditStore(); edit.project = emptyProject("packed-diplomacy");
  edit.setBaseDoc(MapDocument.parse({ schemaVersion: "0.3", size: 8, header: { size: 8, version: "S143" },
    terrain: { size: 8, cells: Array.from({ length: 64 }, (_, i) => makeCell(i % 8, Math.floor(i / 8), 0)) },
    players: [], objects: [], diplomacy: [{ race1: 3, race2: 0, relation: word }, { race1: 0, race2: 3, relation: -1 }] }));
  const send = vi.fn(); edit.setCollab(true, send); return { edit, store: useEventStore(), send };
}
describe("actual diplomacy store transactions", () => {
  it("commits packed meter changes and keeps undo/redo and collaboration byte-exact", () => {
    const original = (0x80000001 | (81 << 8) | (17 << 1)) | 0, { edit, store, send } = setup(original);
    store.setDiplomacyRelation(0, 3, 49);
    expect(store.diplomacy.map(e => e.relation)).toEqual([((original & ~254) | 98) | 0, -1]); expect(send).toHaveBeenCalledTimes(1);
    edit.undoEdit(); expect(store.diplomacy[0]!.relation).toBe(original);
    edit.redoEdit(); expect(store.diplomacy[0]!.relation).toBe(((original & ~254) | 98) | 0);
  });
  it("creates no edit/broadcast for perpetual-war and unchanged meter requests", () => {
    const { edit, store, send } = setup(0x40000062), previous = edit.project;
    store.setDiplomacyRelation(0, 3, 100); expect(edit.project).toBe(previous); expect(send).not.toHaveBeenCalled();
    expect(store.diplomacy[0]!.relation).toBe(0x40000062);
  });
  it("encodes new pair presets without setting alliance", () => {
    const { store } = setup(0); store.setDiplomacyRelation(1, 5, 49);
    expect(store.diplomacy.at(-1)).toEqual({ race1: 1, race2: 5, relation: 98 });
  });
});
import { beforeAll, afterAll } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
let componentServer: ViteDevServer;
let DiplomacyComponent: any;
let ssrEditStore: typeof useEditStore;
let ssrElementPlus: Record<string, any>;
beforeAll(async () => {
  componentServer = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const fixture = await componentServer.ssrLoadModule('/test/diplomacySsr.fixture.ts');
  DiplomacyComponent = fixture.DiplomacyComponent;
  ssrEditStore = fixture.useEditStore;
  ssrElementPlus = fixture;
});
afterAll(async () => { await componentServer?.close(); });
async function renderDiplomacy(word: number) {
  const pinia = createPinia(), edit = ssrEditStore(pinia);
  edit.project = emptyProject('diplomacy-component');
  edit.setBaseDoc(MapDocument.parse({ schemaVersion: '0.3', size: 8, header: { size: 8, version: 'S143' },
    terrain: { size: 8, cells: Array.from({ length: 64 }, (_, i) => makeCell(i % 8, Math.floor(i / 8), 0)) }, objects: [],
    players: [
      { id: 'PL0001', playerNo: 1, race: 0, raceId: 'G000RR0000', name: 'Empire' },
      { id: 'PL0002', playerNo: 2, race: 1, raceId: 'G000RR0001', name: 'Clans' },
      { id: 'PL0003', playerNo: 3, race: 3, raceId: 'G000RR0003', name: 'Undead' },
      { id: 'PL0004', playerNo: 4, race: 9, raceId: 'G000RR0009', name: 'Unknown' },
    ], diplomacy: [{ race1: 3, race2: 0, relation: word }, { race1: 0, race2: 1, relation: 0x4000007e }] }));
  const controls: Array<{ modelValue: number; disabled: boolean }> = [];
  const app = createSSRApp({ render: () => h(DiplomacyComponent) }).use(pinia);
  app.provide(ssrElementPlus.ID_INJECTION_KEY, { prefix: 1, current: 0 });
  app.provide(ssrElementPlus.ZINDEX_INJECTION_KEY, { current: 0 });
  app.mixin({ created() { if (this.$options.name === 'ElInputNumber') controls.push({ modelValue: this.$props.modelValue, disabled: this.$props.disabled }); } });
  const html = await renderToString(app);
  return { html, edit, controls };
}
describe('rendered diplomacy controls', () => {
  it('resolves clan category3, shows missing0, and disables perpetual-war and unknown-race editing', async () => {
    const { html, edit, controls } = await renderDiplomacy(34);
    expect(controls).toEqual([{ modelValue: 17, disabled: false }, { modelValue: 63, disabled: true }, { modelValue: 0, disabled: false }]);
    expect(html).toContain('Вечная война');
    expect(html).toContain('Раса не распознана');
    expect(html).not.toContain('Значение отношения: Empire — Unknown');
    expect(edit.project!.journal).toHaveLength(0);
  });
  it('keeps raw127 without InputNumber immediately normalizing it and creating an edit', async () => {
    const { html, edit } = await renderDiplomacy(254);
    expect(html).toContain('127 (из файла)');
    expect(edit.liveDoc!.diplomacy![0]!.relation).toBe(254);
    expect(edit.project!.journal).toHaveLength(0);
  });
});