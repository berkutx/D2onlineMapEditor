/**
 * The generation session (genStore): variants are regenerated from their seeds, and the
 * session only ever undoes its own commit while that is still the user's latest action.
 *
 * The server is mocked: a "variant" is one edit that renames player PL1 to `v<seed>x<amount>`,
 * so the name on the live map tells which variant is applied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { MapDocument } from "@d2/map-schema";
import { emptyProject, makeCell } from "@d2/map-edit";
import { useEditStore } from "../src/stores/editStore";
import { useGenStore, type GenRequest } from "../src/stores/genStore";
import * as api from "../src/services/api";

vi.mock("../src/services/api", () => ({
  validateProject: vi.fn(), exportProject: vi.fn(), generateRegion: vi.fn(), copilotLlm: vi.fn(),
  fetchProjectRemote: vi.fn(), saveProjectRemote: vi.fn(), fetchGenRecipes: vi.fn(),
}));

const generateRegion = vi.mocked(api.generateRegion);
const OK = { ok: true, identity: true, semantic: { ok: true }, structural: { ok: true, errors: [], warnings: [] } };
const REFUSED = { ...OK, ok: false, structural: { ok: false, errors: ["nope"], warnings: [] } };

function fixture() {
  return MapDocument.parse({
    schemaVersion: "0.3", size: 8, header: { size: 8, version: "S143", playerSlots: Array<number>(13).fill(99) },
    terrain: { size: 8, cells: Array.from({ length: 64 }, (_, i) => makeCell(i % 8, Math.floor(i / 8), 0)) },
    players: [
      { id: "PL1", playerNo: 1, race: 0, raceId: "G000RR0000", name: "bare" },
      { id: "PL2", playerNo: 2, race: 1, raceId: "G000RR0001", name: "other" },
    ],
    objects: [],
  });
}

const REQ: GenRequest = { recipeId: "relief_ridge", region: { x: 0, y: 0, w: 8, h: 8 }, cells: null, stroke: false, protect: false };

function setup(collab: boolean) {
  const edit = useEditStore();
  edit.project = emptyProject("gen-test");
  edit.setBaseDoc(fixture());
  if (collab) edit.setCollab(true, vi.fn());
  const gen = useGenStore();
  /** Which variant is on the map (the name the mocked server gives PL1). */
  const onMap = (): string | undefined => edit.liveDoc?.players.find((p) => p.id === "PL1")?.name;
  return { edit, gen, onMap };
}

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  generateRegion.mockReset();
  generateRegion.mockImplementation(async (_id, _project, _recipe, _region, seed, _cells, _protect, _slot, amount) => ({
    ops: [{ kind: "patchPlayer", id: "PL1", fields: { name: `v${seed}x${amount ?? 1}` } }],
    report: OK,
    debug: { serverMs: 1, opCount: 1, seed, amount: amount ?? 1, validation: { ok: true, identity: true, semantic: true, structural: true } },
  }) as never);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

for (const collab of [false, true]) {
  describe(`a generation session (${collab ? "in a room" : "solo"})`, () => {
    it("steps through variants by regenerating them from their seeds", async () => {
      const { gen, onMap } = setup(collab);
      await gen.run(REQ);
      const first = gen.session!.seeds[0]!;
      expect(onMap()).toBe(`v${first}x1`);
      expect(gen.session).toMatchObject({ index: 0, opCount: 1, valid: true, amount: 1 });

      expect(await gen.another()).toBe(true);
      const second = gen.session!.seeds[1]!;
      expect(second).not.toBe(first);
      expect(gen.session!.index).toBe(1);
      expect(onMap()).toBe(`v${second}x1`);

      // back: the EARLIER picture, made again from its seed — not merely an undo
      expect(await gen.step(-1)).toBe(true);
      expect(gen.session!.index).toBe(0);
      expect(onMap()).toBe(`v${first}x1`);
      expect(generateRegion.mock.calls.at(-1)![4]).toBe(first);
      await gen.step(1);
      expect(onMap()).toBe(`v${second}x1`);
      await gen.step(5); // clamped to the last one tried
      expect(gen.session!.index).toBe(1);
    });

    it("more or less of the same variant keeps its seed and becomes the next default", async () => {
      const { gen, onMap } = setup(collab);
      await gen.run(REQ);
      const seed = gen.session!.seeds[0]!;
      await gen.retune(1.5);
      expect(onMap()).toBe(`v${seed}x1.5`);
      expect(gen.session).toMatchObject({ amount: 1.5, index: 0 });
      expect(gen.session!.seeds).toEqual([seed]);
      expect(gen.amount).toBe(1.5);
      // a new generation starts with it
      await gen.run(REQ);
      expect(generateRegion.mock.calls.at(-1)![8]).toBe(1.5);
    });

    it("taking a variant away restores the map; keeping it leaves an ordinary undo step", async () => {
      const { edit, gen, onMap } = setup(collab);
      await gen.run(REQ);
      gen.discard();
      expect(onMap()).toBe("bare");
      expect(gen.session).toBeNull();

      await gen.run(REQ);
      const kept = onMap();
      gen.keep();
      expect(gen.session).toBeNull();
      expect(onMap()).toBe(kept);
      edit.undoEdit(); // the user's own Ctrl+Z still takes it back
      expect(onMap()).toBe("bare");
    });

    it("never undoes anything once the user has edited the map themselves", async () => {
      const { edit, gen, onMap } = setup(collab);
      await gen.run(REQ);
      const variant = onMap();
      edit.commit([{ kind: "patchPlayer", id: "PL2", fields: { name: "mine" } }]);
      const calls = generateRegion.mock.calls.length;

      // asked before the session has even noticed: refused, nothing undone, nothing generated
      expect(await gen.another()).toBe(false);
      expect(gen.session).toBeNull();
      expect(generateRegion.mock.calls.length).toBe(calls);
      expect(onMap()).toBe(variant);
      expect(edit.liveDoc?.players.find((p) => p.id === "PL2")?.name).toBe("mine");
    });

    // peers exist only in a room: solo, every journal entry is the user's own
    it.runIf(collab)("ends by itself when the user moves on, and a peer's edit does not end it", async () => {
      const { edit, gen, onMap } = setup(collab);
      await gen.run(REQ);
      edit.applyIncoming([{ kind: "patchPlayer", id: "PL2", fields: { name: "peer" } }]);
      await nextTick();
      expect(gen.session).not.toBeNull(); // somebody else's edit is not MY history
      expect(await gen.another()).toBe(true);

      const variant = onMap();
      edit.undoEdit(); // the user's own undo
      await nextTick();
      expect(gen.session).toBeNull();
      expect(onMap()).not.toBe(variant);
    });

    it("a refused variant is not applied and does not get undone later", async () => {
      const { edit, gen, onMap } = setup(collab);
      edit.commit([{ kind: "patchPlayer", id: "PL2", fields: { name: "before" } }]);
      generateRegion.mockImplementationOnce(async () => ({ ops: [{ kind: "patchPlayer", id: "PL1", fields: { name: "bad" } }], report: REFUSED }) as never);
      const report = await gen.run(REQ);
      expect(report?.ok).toBe(false);
      expect(onMap()).toBe("bare");
      expect(gen.session).toMatchObject({ valid: false, opCount: 0 });

      // another one: there was nothing of ours to take back, so the user's earlier edit stays
      expect(await gen.another()).toBe(true);
      expect(gen.session).toMatchObject({ valid: true, opCount: 1, index: 1 });
      expect(edit.liveDoc?.players.find((p) => p.id === "PL2")?.name).toBe("before");
      gen.discard();
      expect(onMap()).toBe("bare");
      expect(edit.liveDoc?.players.find((p) => p.id === "PL2")?.name).toBe("before");
    });
  });
}

describe("what a generation request carries", () => {
  it("tells the server whether the mask was drawn, and to protect existing relief", async () => {
    const { gen } = setup(false);
    const cells: [number, number][] = [[1, 1], [2, 1]];
    await gen.run({ ...REQ, cells, stroke: true, protect: true }, { amount: 0.75, seed: 42 });
    const call = generateRegion.mock.calls.at(-1)!;
    expect(call.slice(2)).toEqual(["relief_ridge", REQ.region, 42, cells, true, 0, 0.75, true]);
    expect(gen.session).toMatchObject({ seeds: [42], stroke: true, protect: true, amount: 0.75 });
  });

  it("loads the catalogue once and names recipes by it", async () => {
    vi.mocked(api.fetchGenRecipes).mockResolvedValue([
      { id: "relief_ridge", title: "Горная гряда", group: "mountains", stroke: "line", strokeWidth: 3 },
      { id: "water_lake", title: "Озеро", group: "water", amountLabel: "размер озера" },
      { id: "odd", title: "Нечто", group: "unknown-group" },
    ]);
    const { gen } = setup(false);
    expect(gen.titleOf("relief_ridge")).toBe("relief ridge"); // before the list arrives
    await Promise.all([gen.loadCatalog(), gen.loadCatalog()]);
    expect(api.fetchGenRecipes).toHaveBeenCalledTimes(1);
    expect(gen.titleOf("relief_ridge")).toBe("Горная гряда");
    expect(gen.iconOf("water_lake")).toBe("🌊");
    expect(gen.groups.map((g) => g.id)).toEqual(["mountains", "water", "unknown-group"]); // known order, strangers last
    expect(gen.drawable.map((r) => r.id)).toEqual(["relief_ridge"]);
  });
});
