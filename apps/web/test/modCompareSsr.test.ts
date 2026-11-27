// The compare page's screens rendered on the server from a real (small) diff: they render
// without errors and show what changed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSSRApp, h, type Component } from "vue";
import { renderToString } from "vue/server-renderer";
import { createPinia } from "pinia";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { fakeServer, sampleMods, U1 } from "./modCompareServer";

let server: ViteDevServer;
let fx: Record<string, any>;

// Loading the page's modules through Vite takes several seconds, more on a busy machine.
beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    // The fake server answers at the root; the Docker build sets VITE_BASE=/map/, which the
    // config would otherwise turn into the page's base.
    base: "/",
    // No HMR socket: another SSR suite running in parallel holds the default port.
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  fx = await server.ssrLoadModule("/test/modCompareSsr.fixture.ts");
}, 60_000);
afterAll(async () => {
  await server?.close();
});

async function render(search: string, view: (store: ReturnType<typeof fx.useCompareStore>) => { c: Component; props?: Record<string, unknown> }) {
  const pinia = createPinia();
  const store = fx.useCompareStore(pinia);
  await store.init(search, { fetchFn: fakeServer(sampleMods(), "semga").fetchFn });
  expect(store.phase, store.error ?? "").toBe("ready");
  const { c, props } = view(store);
  const app = createSSRApp({ render: () => h(c, props) }).use(pinia).use(fx.ElementPlus);
  app.provide(fx.ID_INJECTION_KEY, { prefix: 1, current: 0 });
  app.provide(fx.ZINDEX_INJECTION_KEY, { current: 0 });
  const errors: unknown[] = [];
  app.config.errorHandler = (e) => void errors.push(e);
  app.config.warnHandler = () => {};
  const html = await renderToString(app);
  expect(errors).toEqual([]);
  return { html, store };
}

describe("compare page screens", () => {
  it("the overview shows the pair and the section tiles", async () => {
    const { html } = await render("?mods&b=semga-2", () => ({ c: fx.OverviewView }));
    expect(html).toContain("Semga → Semga 2");
    expect(html).toContain("Юниты");
    expect(html).toContain("Скрипты");
  });

  // el-table registers its columns on mount, so SSR shows no cells: the counts are checked
  it("the units list counts the changed and the new unit", async () => {
    const { html } = await render("?mods&b=semga-2", () => ({ c: fx.EntityListView, props: { section: "units" } }));
    expect(html).toContain("2 из 2");
    expect(html).toMatch(/Добавлено <span[^>]*>1<\/span>/);
    expect(html).toMatch(/Изменено <span[^>]*>1<\/span>/);
  });

  it("a unit's card shows the field that changed, A and B", async () => {
    const { html } = await render("?mods&b=semga-2", (store) => ({ c: fx.EntityCard, props: { uid: store.entity("units", U1)!.uid } }));
    expect(html).toContain("Squire");
    expect(html).toContain("Здоровье");
    expect(html).toContain("100");
    expect(html).toContain("120");
  });

  it("the tables screen lists the tables and opens one", async () => {
    const { html } = await render("?mods&b=semga-2&view=tables&item=Gunits", () => ({ c: fx.TablesView }));
    expect(html).toContain("Gunits");
    expect(html).toContain("Строк: 2 → 3");
    expect(html).toContain("Изменённые ячейки (1)");
    expect(html).toContain("Новые строки (1)");
  });

  it("a mod without tables: the races screen says so", async () => {
    const { html } = await render("?mods&a=semga&b=closed", () => ({ c: fx.RacesView }));
    expect(html).toContain("расы сравнить нельзя");
  });
});
