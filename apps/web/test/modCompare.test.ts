import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { compareSearch, defaultPair, isComparePage, parseCompareQuery, predecessorOf, type PairCandidate } from "../src/mods/pair";
import { BlobCache, buildPayload, listCompareMods, loadSide } from "../src/mods/loader";
import { runPayload } from "../src/mods/prepare";
import { useCompareStore } from "../src/mods/compareStore";
import { fakeServer, referenceMods, sampleMods, U1, U3 } from "./modCompareServer";

describe("the default pair", () => {
  const mods: PairCandidate[] = [
    { id: "default", family: "default", familyOrder: 0 },
    { id: "semga", family: "semga", familyOrder: 1 },
    { id: "semga-2", family: "semga", familyOrder: 2, parent: "semga" },
    { id: "semga-3", family: "semga", familyOrder: 3 },
    { id: "nazar", family: "nazar", familyOrder: 1 },
    { id: "nazar-legacy", family: "nazar", familyOrder: 0, parent: "semga" },
  ];

  it("compares a derived mod with its parent", () => {
    expect(predecessorOf(mods, "semga-2", "default")).toBe("semga");
    expect(predecessorOf(mods, "nazar-legacy", "default")).toBe("semga");
  });
  it("else with the previous version of its family", () => {
    expect(predecessorOf(mods, "semga-3", "default")).toBe("semga-2");
    expect(predecessorOf(mods, "nazar", "default")).toBe("nazar-legacy");
  });
  it("else with the default mod; the default mod itself with another mod", () => {
    expect(predecessorOf(mods, "semga", "default")).toBe("default");
    const alone: PairCandidate[] = [
      { id: "default", family: "default", familyOrder: 0 },
      { id: "x", family: "x", familyOrder: 0 },
    ];
    expect(predecessorOf(alone, "default", "default")).toBe("x");
    const family: PairCandidate[] = [
      { id: "s1", family: "s", familyOrder: 1 },
      { id: "s2", family: "s", familyOrder: 2 },
    ];
    expect(predecessorOf(family, "s1", "s1")).toBe("s2");
    expect(predecessorOf([{ id: "only", family: "only", familyOrder: 0 }], "only", "only")).toBe("only");
  });
  it("a parent the server does not list is passed over", () => {
    const orphan: PairCandidate[] = [
      { id: "default", family: "default", familyOrder: 0 },
      { id: "child", family: "c", familyOrder: 1, parent: "gone" },
    ];
    expect(predecessorOf(orphan, "child", "default")).toBe("default");
  });

  it("without B: the newest version of the default mod's family", () => {
    expect(defaultPair(mods, "semga", {})).toEqual({ a: "semga-2", b: "semga-3" });
    expect(defaultPair(mods, "default", {})).toEqual({ a: "semga", b: "default" });
  });
  it("B from the address, A by the rule", () => {
    expect(defaultPair(mods, "default", { b: "semga-2" })).toEqual({ a: "semga", b: "semga-2" });
    expect(defaultPair(mods, "default", { a: "nazar", b: "semga-2" })).toEqual({ a: "nazar", b: "semga-2" });
  });
  it("only A in the address: B by the rule, never A itself", () => {
    expect(defaultPair(mods, "semga", { a: "semga" })).toEqual({ a: "semga", b: "semga-3" });
    expect(defaultPair(mods, "semga", { a: "semga-3" })).toEqual({ a: "semga-3", b: "semga-2" });
  });
  it("ids the server does not have are ignored; no mods gives no pair", () => {
    expect(defaultPair(mods, "default", { a: "nope", b: "gone" })).toEqual({ a: "semga", b: "default" });
    expect(defaultPair([], "default", { b: "semga" })).toEqual({ a: null, b: null });
  });

  it("with the unmodded game listed: every mod but a derived one is compared with it", () => {
    const withGame: PairCandidate[] = [{ id: "vanilla", family: "vanilla", familyOrder: 0, reference: true }, ...mods];
    expect(predecessorOf(withGame, "semga", "default")).toBe("vanilla");
    expect(predecessorOf(withGame, "semga-3", "default")).toBe("vanilla");
    expect(predecessorOf(withGame, "default", "default")).toBe("vanilla");
    // a derived mod keeps its parent
    expect(predecessorOf(withGame, "semga-2", "default")).toBe("semga");
    // the game itself: by the other rules
    expect(predecessorOf(withGame, "vanilla", "default")).toBe("default");
    expect(defaultPair(withGame, "semga", {})).toEqual({ a: "vanilla", b: "semga-3" });
  });
});

describe("the address", () => {
  it("is the compare page only with the mods key", () => {
    expect(isComparePage("?mods")).toBe(true);
    expect(isComparePage("?mods&a=x")).toBe(true);
    expect(isComparePage("?map=x")).toBe(false);
    expect(isComparePage("")).toBe(false);
  });
  it("reads and writes the state, leaving empty fields out", () => {
    const q = { a: "semga", b: "semga-2", view: "units", card: "units:Gunits:G000UU0019", item: null, texts: null };
    const s = compareSearch(q);
    expect(s).toBe("?mods&a=semga&b=semga-2&view=units&card=units%3AGunits%3AG000UU0019");
    expect(parseCompareQuery(s)).toEqual(q);
    expect(compareSearch({})).toBe("?mods");
    expect(parseCompareQuery("?mods&a=&b=%20x%20")).toEqual({ a: null, b: "x", view: null, card: null, item: null, texts: null });
    expect(parseCompareQuery(compareSearch({ item: "modscripts/a b.lua" })).item).toBe("modscripts/a b.lua");
    expect(compareSearch({ a: "x", texts: "skip" })).toBe("?mods&a=x&texts=skip");
    expect(parseCompareQuery("?mods&texts=compare").texts).toBe("compare");
    // anything else is auto
    expect(parseCompareQuery("?mods&texts=maybe").texts).toBeNull();
  });
});

describe("loading the mods", () => {
  async function sides() {
    const server = fakeServer(sampleMods(), "semga");
    const { mods } = await listCompareMods(server.fetchFn, "", ["closed"]);
    const mod = (id: string) => mods.find((m) => m.id === id)!;
    return { server, mods, mod };
  }

  it("lists the mods with their parents, and a hidden mod named in the address", async () => {
    const { mods } = await sides();
    expect(mods.map((m) => [m.id, m.parent, m.hidden])).toEqual([
      ["semga", null, false],
      ["semga-2", "semga", false],
      ["closed", null, true],
    ]);
    const server = fakeServer(sampleMods(), "semga");
    const r = await listCompareMods(server.fetchFn, "", ["nope"]);
    expect(r.unknown).toEqual(["nope"]);
    expect(r.defaultModId).toBe("semga");
  });

  it("downloads a table both mods share once, and only once more for a second pair", async () => {
    const { server, mod } = await sides();
    const cache = new BlobCache(server.fetchFn);
    const opts = { fetchFn: server.fetchFn, deployBase: "", cache };
    const [a, b] = await Promise.all([loadSide(mod("semga"), opts), loadSide(mod("semga-2"), opts)]);
    expect(server.count("/tables/Tglobal.dbf")).toBe(1);
    expect(server.count("/tables/Gattacks.dbf")).toBe(1);
    expect(server.count("/tables/Gunits.dbf")).toBe(2);
    expect(cache.downloads).toBe(4);
    expect(Object.keys(a.tables).sort()).toEqual(["Gattacks", "Gunits", "Tglobal"]);
    expect(a.tablesMissing).toBe(false);

    const payload = await buildPayload(a, b, cache);
    expect(payload.compareTables).toBe(true);
    expect(Object.keys(payload.blobs)).toHaveLength(4);
    const { diff } = runPayload(payload);
    const units = diff.sections.units ?? [];
    expect(units.find((e) => e.id === U1)?.status).toBe("changed");
    expect(units.find((e) => e.id === U3)?.status).toBe("added");
    expect(diff.scripts.map((s) => s.path)).toEqual(["modscripts/a.lua"]);

    // the same mod again: nothing is downloaded twice
    const before = cache.downloads;
    await loadSide(mod("semga-2"), opts);
    expect(cache.downloads).toBe(before);
  });

  it("a mod without tables is loaded without them and compares pictures and scripts only", async () => {
    const { server, mod } = await sides();
    const cache = new BlobCache(server.fetchFn);
    const opts = { fetchFn: server.fetchFn, deployBase: "", cache };
    const a = await loadSide(mod("semga"), opts);
    const b = await loadSide(mod("closed"), opts);
    expect(b.tablesMissing).toBe(true);
    expect(b.tables).toEqual({});
    expect(b.files["modscripts/a.lua"]).toBeTruthy();
    const payload = await buildPayload(a, b, cache);
    expect(payload.compareTables).toBe(false);
    expect(payload.a.tables).toEqual({});
    expect(payload.blobs).toEqual({});
    const { diff } = runPayload(payload);
    expect(diff.summary.tables.ops).toBe(0);
    expect(diff.scripts).toHaveLength(1);
  });

  it("a failed download is not kept", async () => {
    let fail = true;
    const fetchFn = async () => (fail ? new Response("x", { status: 503 }) : new Response(new Uint8Array([1])));
    const cache = new BlobCache(fetchFn);
    await expect(cache.get("s", "/x")).rejects.toThrow("503");
    fail = false;
    expect(new Uint8Array(await cache.get("s", "/x"))).toEqual(new Uint8Array([1]));
    expect(cache.downloads).toBe(2);
  });
});

describe("the compare store and the address", () => {
  let loc: { search: string; pathname: string };
  beforeEach(() => {
    setActivePinia(createPinia());
    loc = { search: "", pathname: "/" };
    vi.stubGlobal("window", {
      location: loc,
      history: { replaceState: (_s: unknown, _t: string, url: string) => (loc.search = url.slice(url.indexOf("?"))) },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("settles the pair from the address and writes it back", async () => {
    const server = fakeServer(sampleMods(), "semga");
    const store = useCompareStore();
    await store.init("?mods&b=semga-2", { fetchFn: server.fetchFn });
    expect(store.phase).toBe("ready");
    expect([store.aId, store.bId]).toEqual(["semga", "semga-2"]);
    expect(loc.search).toBe("?mods&a=semga&b=semga-2");

    store.openView("units");
    expect(parseCompareQuery(loc.search).view).toBe("units");
    expect(store.openEntity("units", U1)).toBe(true);
    const card = parseCompareQuery(loc.search).card;
    expect(card && store.index.byUid.get(card)?.id).toBe(U1);
    store.closeCard();
    expect(parseCompareQuery(loc.search).card).toBeNull();
    store.openView("tables");
    store.openItem("Gunits");
    expect(loc.search).toBe("?mods&a=semga&b=semga-2&view=tables&item=Gunits");
  });

  it("restores the screen from the address; an unknown mod is noted", async () => {
    const server = fakeServer(sampleMods(), "semga");
    const store = useCompareStore();
    const card = `race:G000RR9999`;
    await store.init(`?mods&a=nope&b=semga-2&view=tables&item=Gunits&card=${card}`, { fetchFn: server.fetchFn });
    expect([store.aId, store.bId]).toEqual(["semga", "semga-2"]);
    expect(store.notices).toEqual(["Мода «nope» на этом сервере нет"]);
    expect(store.view).toBe("tables");
    expect(store.item).toBe("Gunits");
    // a card the diff does not have is dropped
    expect(store.card).toBeNull();
    expect(loc.search).toBe("?mods&a=semga&b=semga-2&view=tables&item=Gunits");
  });

  it("a hidden mod opens by its id and shows that its tables are missing", async () => {
    const server = fakeServer(sampleMods(), "semga");
    const store = useCompareStore();
    await store.init("?mods&a=semga&b=closed", { fetchFn: server.fetchFn });
    expect(store.phase).toBe("ready");
    expect(store.modB?.hidden).toBe(true);
    expect(store.tablesMissing).toEqual({ a: false, b: true });
    expect(store.diff?.scripts).toHaveLength(1);
  });

  it("an unreachable server is an error in words", async () => {
    const store = useCompareStore();
    await store.init("?mods", { fetchFn: async () => new Response("down", { status: 502 }) });
    expect(store.phase).toBe("error");
    expect(store.error).toBe("Не удалось получить список модов: Сервер ответил 502 на /api/mods");
  });

  it("compares a mod with the unmodded game, skipping a translation's texts, and lets the user compare them", async () => {
    const server = fakeServer(referenceMods(), "semga");
    const store = useCompareStore();
    await store.init("?mods&b=semga-ru", { fetchFn: server.fetchFn });
    expect([store.aId, store.bId]).toEqual(["vanilla", "semga-ru"]);
    expect(store.modA?.reference).toBe(true);
    // English → Russian: auto skips the wording; the unit's own change stays
    expect(store.diff?.texts).toEqual({ a: "latin", b: "cyrillic", skipped: true });
    expect(store.diff?.summary.tables.translations).toBe(4);
    expect(store.index.tables.get("tglobal")?.ops).toEqual([]);
    expect(store.entity("units", U1)?.fields.map((f) => f.field)).toEqual(["HIT_POINT"]);
    expect(loc.search).toBe("?mods&a=vanilla&b=semga-ru");

    // the user asks for the texts: the loaded sides are diffed again, nothing is downloaded
    const files = server.calls.length;
    await store.setTexts(false);
    expect(store.phase).toBe("ready");
    expect(server.calls.length).toBe(files);
    expect(store.diff?.texts.skipped).toBe(false);
    expect(store.index.tables.get("tglobal")?.counts.set).toBe(4);
    expect(loc.search).toBe("?mods&a=vanilla&b=semga-ru&texts=compare");

    // a new pair starts on auto again; semga → semga-2 is English on both sides
    store.setPair("semga", "semga-2");
    await vi.waitFor(() => expect(store.phase).toBe("ready"));
    expect(store.texts).toBeNull();
    expect(store.diff?.texts.skipped).toBe(false);
    expect(loc.search).toBe("?mods&a=semga&b=semga-2");

    // and the choice in the address is kept
    setActivePinia(createPinia());
    const store2 = useCompareStore();
    await store2.init("?mods&a=semga&b=semga-2&texts=skip", { fetchFn: server.fetchFn });
    expect(store2.diff?.texts.skipped).toBe(true);
  });

  it("the same mod on both sides is loaded once", async () => {
    const server = fakeServer(sampleMods(), "semga");
    const store = useCompareStore();
    await store.init("?mods&a=semga&b=semga", { fetchFn: server.fetchFn });
    expect(store.identical).toBe(true);
    expect(server.count("/api/mods/semga/files")).toBe(8); // one list per prefix, for one side
    expect(store.diff?.summary.tables.ops).toBe(0);
  });
});
