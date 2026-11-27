/**
 * Fetching what the diff of two mods needs, from the server's mod store:
 *
 *   GET /api/mods, /api/mods/:id                  the mods and their passports (parent)
 *   GET /api/mods/:id/files?prefix=<p>            logical name -> sha256, per prefix
 *   GET <assetBase>/<logical name>                the file itself (immutable)
 *
 * Bytes are kept by sha256 in a {@link BlobCache}: a table both mods share is downloaded
 * once, and a second pair reuses what the first one fetched. A mod whose store has no
 * `tables/` (a closed mod on the public server) is loaded without tables; the caller shows
 * that and compares what is there (pictures, scripts).
 *
 * `fetchFn` is injected so tests can run it without a server.
 */
import { MOD_SHARE_KEY_HEADER, REST, type ModInfo, type ModList, type ModPassport } from "@d2/socket-contract";
import type { SpriteManifest } from "@d2/mod-diff";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * `fetchFn` that sends a share key with every request (a secret link): the server then lists
 * the hidden mods too and serves their files. Its answer to the first request, GET /api/mods
 * (listCompareMods asks it before anything else), also sets the key as a cookie, which the
 * pictures (`<img>`, CSS backgrounds) carry. Unchanged without a key.
 */
export function withShareKey(fetchFn: FetchFn, key: string | null): FetchFn {
  if (!key) return fetchFn;
  return (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set(MOD_SHARE_KEY_HEADER, key);
    return fetchFn(url, { ...init, headers });
  };
}

/** A mod the page can compare. */
export interface CompareMod {
  id: string;
  name: string;
  family: string;
  familyOrder: number;
  /** Root-relative base of the mod's files, as the server names it. */
  assetBase: string;
  /** A derived mod's base. */
  parent: string | null;
  /** Not in the server's list (a closed mod opened by its id). */
  hidden: boolean;
}

export const ICON_FOLDERS = ["uniticons/", "itemicons/", "spellicons/", "lordicons/"] as const;
/** The file-list prefixes one side needs. */
export const FILE_PREFIXES = ["tables/", "capital.dat", ...ICON_FOLDERS, "modscripts/", "manifest.json"] as const;

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`${url}: HTTP ${status}`);
  }
}

async function getJson<T>(fetchFn: FetchFn, url: string): Promise<T> {
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new HttpError(url, res.status);
  return (await res.json()) as T;
}

function toCompareMod(info: ModInfo, passport: ModPassport | null, hidden: boolean): CompareMod {
  return {
    id: info.id,
    name: info.name,
    family: info.family,
    familyOrder: info.familyOrder,
    assetBase: info.assetBase,
    parent: passport?.parent?.modId ?? null,
    hidden,
  };
}

/**
 * The mods to choose from: the server's list with each passport's parent, plus `extraIds`
 * (ids of the address) the list does not show. An extra id the server does not know is
 * returned in `unknown`.
 */
export async function listCompareMods(
  fetchFn: FetchFn,
  deployBase: string,
  extraIds: readonly string[] = [],
): Promise<{ mods: CompareMod[]; defaultModId: string; unknown: string[] }> {
  const list = await getJson<ModList>(fetchFn, deployBase + REST.mods);
  const passport = (id: string) => getJson<ModPassport>(fetchFn, deployBase + REST.mod(encodeURIComponent(id))).catch(() => null);
  const listed = await Promise.all(list.mods.map(async (m) => toCompareMod(m, await passport(m.id), false)));
  const unknown: string[] = [];
  const extra = [...new Set(extraIds)].filter((id) => !listed.some((m) => m.id === id));
  for (const id of extra) {
    const p = await passport(id);
    if (p) listed.push(toCompareMod(p, p, true));
    else unknown.push(id);
  }
  return { mods: listed, defaultModId: list.defaultModId, unknown };
}

/** Bytes by sha256, fetched at most once each (a failed fetch is forgotten). */
export class BlobCache {
  private readonly bytes = new Map<string, Promise<ArrayBuffer>>();
  /** How many downloads were started (tests read it). */
  downloads = 0;

  constructor(private readonly fetchFn: FetchFn) {}

  has(sha: string): boolean {
    return this.bytes.has(sha);
  }

  get(sha: string, url: string): Promise<ArrayBuffer> {
    let p = this.bytes.get(sha);
    if (!p) {
      this.downloads++;
      p = this.fetchFn(url).then(async (res) => {
        if (!res.ok) throw new HttpError(url, res.status);
        return res.arrayBuffer();
      });
      this.bytes.set(sha, p);
      p.catch(() => this.bytes.delete(sha));
    }
    return p;
  }
}

/** One side of the comparison, as loaded. */
export interface SideData {
  mod: CompareMod;
  /** Absolute base URL of the mod's files (deploy base + assetBase). */
  base: string;
  /** Logical name -> sha256 of everything listed (icons, scripts, tables, capital.dat, manifest). */
  files: Record<string, string>;
  /** Table name ("Gunits") -> sha256. */
  tables: Record<string, string>;
  capitalSha: string | null;
  manifest: SpriteManifest | null;
  /** The store has no tables/ for this mod. */
  tablesMissing: boolean;
}

export interface SideProgress {
  stage: "files" | "tables" | "manifest" | "done";
  done: number;
  total: number;
}

/** Table name of a logical "tables/<Name>.dbf". */
export function tableNameOf(logical: string): string {
  return logical.slice("tables/".length).replace(/\.dbf$/i, "");
}

/** The URL of one logical file of a side. */
export function fileUrl(base: string, logical: string): string {
  return `${base}/${logical.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Load one side: its file lists, every table's bytes into `cache`, capital.dat, and its
 * sprite manifest (parsed; `manifests` keeps parsed ones by sha). Rejects on a network or
 * HTTP error of the lists or a table.
 */
export async function loadSide(
  mod: CompareMod,
  opts: {
    fetchFn: FetchFn;
    deployBase: string;
    cache: BlobCache;
    manifests?: Map<string, Promise<SpriteManifest>>;
    onProgress?: (p: SideProgress) => void;
  },
): Promise<SideData> {
  const { fetchFn, deployBase, cache } = opts;
  const base = deployBase + mod.assetBase;
  opts.onProgress?.({ stage: "files", done: 0, total: FILE_PREFIXES.length });
  const files: Record<string, string> = {};
  let listed = 0;
  await Promise.all(
    FILE_PREFIXES.map(async (prefix) => {
      const url = `${deployBase}${REST.modFiles(encodeURIComponent(mod.id))}?prefix=${encodeURIComponent(prefix)}`;
      const body = await getJson<{ files: Record<string, string> }>(fetchFn, url);
      Object.assign(files, body.files);
      opts.onProgress?.({ stage: "files", done: ++listed, total: FILE_PREFIXES.length });
    }),
  );
  const tables: Record<string, string> = {};
  for (const [logical, sha] of Object.entries(files)) if (logical.startsWith("tables/") && /\.dbf$/i.test(logical)) tables[tableNameOf(logical)] = sha;
  const capitalSha = files["capital.dat"] ?? null;
  const names = Object.keys(tables);
  const tablesMissing = names.length === 0;
  const total = names.length + (capitalSha ? 1 : 0);
  let done = 0;
  opts.onProgress?.({ stage: "tables", done, total });
  const tick = () => opts.onProgress?.({ stage: "tables", done: ++done, total });
  const jobs: Promise<unknown>[] = names.map((name) => cache.get(tables[name]!, fileUrl(base, `tables/${name}.dbf`)).then(tick));
  if (capitalSha) jobs.push(cache.get(capitalSha, fileUrl(base, "capital.dat")).then(tick));
  await Promise.all(jobs);

  let manifest: SpriteManifest | null = null;
  const manifestSha = files["manifest.json"];
  if (manifestSha) {
    opts.onProgress?.({ stage: "manifest", done: 0, total: 1 });
    const parsed = opts.manifests?.get(manifestSha);
    const p =
      parsed ??
      cache.get(manifestSha, fileUrl(base, "manifest.json")).then((buf) => JSON.parse(new TextDecoder().decode(buf)) as SpriteManifest);
    opts.manifests?.set(manifestSha, p);
    try {
      manifest = await p;
    } catch {
      opts.manifests?.delete(manifestSha);
      manifest = null; // pictures are not compared; the tables still are
    }
  }
  opts.onProgress?.({ stage: "done", done: total, total });
  return { mod, base, files, tables, capitalSha, manifest, tablesMissing };
}

/** What the diff worker gets for one side: names and hashes; the bytes travel in `blobs`. */
export interface PayloadSide {
  id: string;
  name: string;
  tables: Record<string, string>;
  capitalSha: string | null;
  manifest: SpriteManifest | null;
  /** Icons and modscripts: logical name -> sha256. */
  files: Record<string, string>;
}

export interface DiffPayload {
  a: PayloadSide;
  b: PayloadSide;
  /** sha256 -> bytes of every table and capital.dat the sides name (one entry per hash). */
  blobs: Record<string, ArrayBuffer>;
  /** False when either side has no tables: then only pictures and scripts are compared. */
  compareTables: boolean;
}

function payloadSide(s: SideData, withTables: boolean): PayloadSide {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.files)) if (/^[a-z]*icons\//i.test(k) || k.startsWith("modscripts/")) files[k] = v;
  return {
    id: s.mod.id,
    name: s.mod.name,
    tables: withTables ? s.tables : {},
    capitalSha: withTables ? s.capitalSha : null,
    manifest: s.manifest,
    files,
  };
}

/** The worker's input for two loaded sides (bytes from `cache`, each hash once). */
export async function buildPayload(a: SideData, b: SideData, cache: BlobCache): Promise<DiffPayload> {
  const compareTables = !a.tablesMissing && !b.tablesMissing;
  const pa = payloadSide(a, compareTables);
  const pb = payloadSide(b, compareTables);
  const blobs: Record<string, ArrayBuffer> = {};
  const shas = new Set<string>();
  for (const p of [pa, pb]) {
    for (const sha of Object.values(p.tables)) shas.add(sha);
    if (p.capitalSha) shas.add(p.capitalSha);
  }
  for (const sha of shas) {
    // every hash was fetched by loadSide; the URL is not used again
    blobs[sha] = await cache.get(sha, "");
  }
  return { a: pa, b: pb, blobs, compareTables };
}
