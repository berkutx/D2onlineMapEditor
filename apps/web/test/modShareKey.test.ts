/**
 * The secret link of the compare page: `?mods...#key=<key>`. The key is read from the
 * fragment, sent with every request of the page, and kept in the address when the page
 * rewrites it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { MOD_SHARE_KEY_HEADER } from "@d2/socket-contract";
import { shareKeyOf } from "../src/mods/pair";
import { withShareKey, type FetchFn } from "../src/mods/loader";
import { useCompareStore } from "../src/mods/compareStore";
import { fakeServer, sampleMods } from "./modCompareServer";

const KEY = "a-long-share-key-0123456789abcdef";

describe("the share key in the address", () => {
  it("is read from the fragment only", () => {
    expect(shareKeyOf(`#key=${KEY}`)).toBe(KEY);
    expect(shareKeyOf(`key=${KEY}`)).toBe(KEY);
    expect(shareKeyOf(`#x=1&key=${KEY}`)).toBe(KEY);
    expect(shareKeyOf("#key=")).toBeNull();
    expect(shareKeyOf("")).toBeNull();
    expect(shareKeyOf("#card=race:G000RR0001")).toBeNull();
  });
});

describe("withShareKey", () => {
  it("adds the key to every request and keeps the other headers", async () => {
    const seen: Headers[] = [];
    const base: FetchFn = async (_url, init) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}");
    };
    const f = withShareKey(base, KEY);
    await f("/api/mods", { headers: { accept: "application/json" } });
    await f("/assets/mods/x/r/tables/Gunits.dbf");
    expect(seen.map((h) => h.get(MOD_SHARE_KEY_HEADER))).toEqual([KEY, KEY]);
    expect(seen[0]!.get("accept")).toBe("application/json");
    expect(withShareKey(base, null)).toBe(base);
  });
});

describe("the compare store with a secret link", () => {
  let loc: { search: string; pathname: string; hash: string };
  let written: string[];
  beforeEach(() => {
    setActivePinia(createPinia());
    loc = { search: "", pathname: "/map/", hash: `#key=${KEY}` };
    written = [];
    vi.stubGlobal("window", {
      location: loc,
      history: {
        replaceState: (_s: unknown, _t: string, url: string) => {
          written.push(url);
          loc.search = url.slice(url.indexOf("?"), url.includes("#") ? url.indexOf("#") : undefined);
        },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends the key with every request and keeps it in the address", async () => {
    const server = fakeServer(sampleMods(), "semga");
    const keys: (string | null)[] = [];
    const fetchFn: FetchFn = (url, init) => {
      keys.push(new Headers(init?.headers).get(MOD_SHARE_KEY_HEADER));
      return server.fetchFn(url);
    };
    const store = useCompareStore();
    await store.init("?mods&b=semga-2", { fetchFn, hash: loc.hash });
    expect(store.phase).toBe("ready");
    expect(keys.length).toBeGreaterThan(5);
    expect(keys.every((k) => k === KEY)).toBe(true);
    expect(written.at(-1)).toBe(`/map/?mods&a=semga&b=semga-2#key=${KEY}`);
    store.openView("units");
    expect(written.at(-1)).toBe(`/map/?mods&a=semga&b=semga-2&view=units#key=${KEY}`);
  });

  it("without a key nothing is added", async () => {
    loc.hash = "";
    const server = fakeServer(sampleMods(), "semga");
    const keys: (string | null)[] = [];
    const fetchFn: FetchFn = (url, init) => {
      keys.push(new Headers(init?.headers).get(MOD_SHARE_KEY_HEADER));
      return server.fetchFn(url);
    };
    const store = useCompareStore();
    await store.init("?mods&b=semga-2", { fetchFn, hash: "" });
    expect(keys.every((k) => k === null)).toBe(true);
    expect(written.at(-1)).toBe("/map/?mods&a=semga&b=semga-2");
  });
});
