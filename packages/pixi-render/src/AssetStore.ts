/**
 * AssetStore — loads the manifest's spritesheets into PixiJS v8 textures and
 * resolves frame keys / animation ids to `Texture` / `Texture[]`.
 *
 * Touches `pixi.js` (`Assets`, `Spritesheet`, `Texture`) so it is COMPILE-ONLY
 * under vitest (needs a browser/WebGL to actually run). Structured so a browser
 * host can `await store.load(...)` once and then synchronously resolve textures.
 *
 * Loading strategy (framework-agnostic, no bundler magic):
 *   1. `fetch` each `SpritesheetRef.meta` JSON (a Pixi-native spritesheet hash).
 *   2. `Assets.load` the atlas image -> base `Texture`.
 *   3. `new Spritesheet(baseTexture, json)` + `await sheet.parse()`.
 * The resulting per-sheet `textures` / `animations` maps are merged into global
 * lookups keyed by the manifest's logical frame keys.
 */
import { Assets, Spritesheet, Texture } from "pixi.js";
import type { SpritesheetData } from "pixi.js";
import type {
  AssetManifest,
  SpritesheetRef,
  AnimationDef,
} from "@d2/asset-manifest";

/** Optional override hooks so a host can control URL resolution / fetching. */
export interface AssetStoreOptions {
  /** Prefix prepended to every manifest-relative path (e.g. "/assets/"). */
  baseUrl?: string;
  /** Custom JSON fetcher (defaults to global `fetch`). Useful for tests/SSR. */
  fetchJson?: (url: string) => Promise<unknown>;
}

interface LoadedSheet {
  ref: SpritesheetRef;
  sheet: Spritesheet;
}

export class AssetStore {
  private readonly opts: AssetStoreOptions;
  private manifest?: AssetManifest;

  private readonly sheets = new Map<string, LoadedSheet>();
  /** logical/global frame key -> Texture */
  private readonly textures = new Map<string, Texture>();
  /** animation id -> ordered Texture[] */
  private readonly animations = new Map<string, Texture[]>();
  /** every manifest AnimationDef by id (incl. ones whose lazy atlas isn't loaded yet). */
  private readonly animDefs = new Map<string, AnimationDef>();

  /** every sheet id -> its ref (incl. lazy unit chunks not loaded upfront). */
  private readonly refById = new Map<string, SpritesheetRef>();
  /** in-flight lazy sheet loads, deduped by sheet id. */
  private readonly loadingSheets = new Map<string, Promise<void>>();
  /** per atlas-GROUP frame->concrete-sheet maps (built from page metas on demand). */
  private readonly frameLocCache = new Map<string, Promise<Map<string, string>>>();
  /** Sum of manifest-declared sizes (png+json) of LOADED sheets — the honest download
   *  counter (worker image fetches never reach main-thread resource timing). */
  private bytesLoaded = 0;
  /** Sheets loaded whose ref lacks `bytes` (old manifest) — makes the counter honest. */
  private bytesUnknown = 0;

  private loaded = false;

  constructor(options: AssetStoreOptions = {}) {
    this.opts = options;
  }

  /** Sheets loaded ON DEMAND (not in the initial {@link load}):
   *  - "unit-<impl>" per-unit chunks — a map only pulls its own leaders;
   *  - "iso-anim-*" animation frame atlases (82 MB!) — needed only to PLAY animations
   *    (every object's STATIC frame lives in the eager iso-still/iso-cmon sheets, and
   *    ObjectLayer falls back to it when an animation isn't built) — {@link ensureAnimations};
   *  - "capital-*" city-screen backgrounds (66 MB) — not referenced by the map renderer
   *    at all today, reachable via ensureLoaded if a future feature needs them. */
  private static isLazy(ref: SpritesheetRef): boolean {
    return (
      ref.id.startsWith("unit-") ||
      ref.id.startsWith("iso-anim-") ||
      ref.id.startsWith("capital-")
    );
  }

  /** True once {@link load} has completed. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  private url(path: string): string {
    const base = this.opts.baseUrl ?? "";
    if (!base) return path;
    const sep = base.endsWith("/") || path.startsWith("/") ? "" : "/";
    return `${base}${sep}${path}`;
  }

  private async fetchJson(url: string): Promise<unknown> {
    if (this.opts.fetchJson) return this.opts.fetchJson(url);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`AssetStore: failed to fetch ${url} (${res.status})`);
    }
    return res.json();
  }

  /**
   * Load every spritesheet referenced by the manifest and build the texture /
   * animation lookups. Idempotent-ish: calling twice reloads.
   */
  async load(manifest: AssetManifest): Promise<void> {
    this.manifest = manifest;
    this.sheets.clear();
    this.textures.clear();
    this.animations.clear();
    this.loadingSheets.clear();
    this.refById.clear();
    this.animDefs.clear();
    this.frameLocCache.clear();
    this.bytesLoaded = 0;
    this.bytesUnknown = 0;
    for (const ref of manifest.spritesheets) this.refById.set(ref.id, ref);
    for (const anim of manifest.animations) this.animDefs.set(anim.id, anim);

    // Load everything EXCEPT the lazy sheets (units / animation atlases / capitals).
    await Promise.all(
      manifest.spritesheets
        .filter((ref) => !AssetStore.isLazy(ref))
        .map((ref) => this.loadSheet(ref)),
    );

    // Build named animation lists from the manifest. An animation whose atlas is a LAZY,
    // not-yet-loaded sheet finds no frame textures and is simply skipped here (the
    // frames.length guard) — it materializes later via {@link ensureAnimations}.
    for (const anim of manifest.animations) {
      this.buildAnimation(anim);
    }

    this.loaded = true;
  }

  /**
   * Materialize the manifest ANIMATIONS among `keys` (ids that name an AnimationDef):
   * load each definition's lazy frame atlas (iso-anim / capital sheets) and build its
   * Texture[] list, so `resolveAnimation(id)` starts returning frames. Keys that are
   * plain frame names or already-built animations are skipped. This is the play-time
   * counterpart of {@link ensureLoaded} — call it only when animations must actually
   * PLAY (the static render uses the eager iso-still/iso-cmon first-frames instead).
   */
  async ensureAnimations(keys: Iterable<string>): Promise<void> {
    // NOTE: an AnimationDef's atlas — and its frames' index entries — name the LOGICAL
    // atlas GROUP ("iso-anim"), not a concrete sheet ("iso-anim-18"): one animation's
    // frames are packed across several pages. The concrete page per frame is only known
    // from the pages' own metas, so we scan the group's (tiny) meta JSONs once, then
    // load just the pages that carry the needed frames.
    const index = this.manifest?.index;
    if (!index) return;
    const defs: AnimationDef[] = [];
    const frames = new Set<string>();
    for (const key of keys) {
      if (this.animations.has(key)) continue; // already built (eager atlas or prior call)
      const def = this.animDefs.get(key);
      if (!def) continue;
      defs.push(def);
      for (const f of def.frames) frames.add(f);
    }
    if (defs.length === 0) return;

    const sheetIds = new Set<string>();
    const groups = new Set<string>();
    for (const f of frames) {
      const entry = index[f];
      if (!entry) continue;
      if (this.refById.has(entry.sheet)) {
        if (!this.sheets.has(entry.sheet)) sheetIds.add(entry.sheet); // concrete id
      } else {
        groups.add(entry.sheet); // a group name — resolve via the page metas below
      }
    }
    for (const group of groups) {
      const loc = await this.frameLocations(group);
      for (const f of frames) {
        const sheetId = loc.get(f);
        if (sheetId && !this.sheets.has(sheetId)) sheetIds.add(sheetId);
      }
    }
    await Promise.all([...sheetIds].map((id) => this.loadSheetOnce(id)));
    for (const def of defs) this.buildAnimation(def);
  }

  /** frame key -> concrete sheet id for one logical atlas group ("iso-anim"), built by
   *  scanning every page's meta JSON once (small; images are NOT fetched). Cached. */
  private frameLocations(group: string): Promise<Map<string, string>> {
    const cached = this.frameLocCache.get(group);
    if (cached) return cached;
    const p = (async () => {
      const loc = new Map<string, string>();
      const refs = [...this.refById.values()].filter((r) => r.id.startsWith(`${group}-`));
      await Promise.all(
        refs.map(async (ref) => {
          const json = (await this.fetchJson(this.url(ref.meta))) as SpritesheetData;
          for (const key of Object.keys(json.frames ?? {})) loc.set(key, ref.id);
        }),
      );
      return loc;
    })();
    this.frameLocCache.set(group, p);
    return p;
  }

  /**
   * Lazily load the (lazy) sheets that contain `keys` — used to pull in just the
   * units a freshly-opened map references, instead of every unit upfront. Resolves
   * once those sheets are parsed; concurrent calls for the same sheet are deduped.
   * Keys whose sheet is already loaded (or unknown) are skipped.
   */
  async ensureLoaded(keys: Iterable<string>): Promise<void> {
    const index = this.manifest?.index;
    if (!index) return;
    const sheetIds = new Set<string>();
    for (const key of keys) {
      const entry = index[key];
      if (entry && !this.sheets.has(entry.sheet)) sheetIds.add(entry.sheet);
    }
    await Promise.all([...sheetIds].map((id) => this.loadSheetOnce(id)));
  }

  /** Load a sheet by id at most once (dedupes in-flight + already-loaded). */
  private loadSheetOnce(id: string): Promise<void> {
    if (this.sheets.has(id)) return Promise.resolve();
    const existing = this.loadingSheets.get(id);
    if (existing) return existing;
    const ref = this.refById.get(id);
    if (!ref) return Promise.resolve();
    const p = this.loadSheet(ref).finally(() => this.loadingSheets.delete(id));
    this.loadingSheets.set(id, p);
    return p;
  }

  private async loadSheet(ref: SpritesheetRef): Promise<void> {
    const metaUrl = this.url(ref.meta);
    const json = (await this.fetchJson(metaUrl)) as SpritesheetData;

    // The image path: prefer the manifest ref, fall back to meta.image.
    const imagePath = ref.image || json.meta?.image || "";
    const imageUrl = this.url(imagePath);
    const baseTexture = await Assets.load<Texture>(imageUrl);

    // D2 sprites are pixel art and the editor draws them unsmoothed. Nearest
    // filtering matches that AND stops linear sampling from bleeding adjacent
    // packed atlas frames at frame edges — that bleed showed up as hard seams in
    // dense overlapping objects (e.g. mountain ranges).
    baseTexture.source.scaleMode = "nearest";

    const sheet = new Spritesheet(baseTexture, json);
    await sheet.parse();

    this.sheets.set(ref.id, { ref, sheet });
    // download accounting: manifest-declared file sizes (see bytesLoaded docstring)
    if (typeof ref.bytes === "number") this.bytesLoaded += ref.bytes;
    else this.bytesUnknown++;

    // Merge this sheet's frame textures into the global lookup. Frame keys are
    // assumed unique across sheets (the pipeline namespaces them); on collision,
    // first writer wins and we keep a sheet-qualified key as a fallback too.
    for (const [frameKey, tex] of Object.entries(sheet.textures)) {
      if (!this.textures.has(frameKey)) this.textures.set(frameKey, tex);
      this.textures.set(`${ref.id}/${frameKey}`, tex);
    }
    // Pixi-native per-sheet animations -> register under their own keys.
    for (const [animKey, texList] of Object.entries(sheet.animations)) {
      if (!this.animations.has(animKey)) this.animations.set(animKey, texList);
      this.animations.set(`${ref.id}/${animKey}`, texList);
    }
  }

  private buildAnimation(anim: AnimationDef): void {
    const sheet = this.sheets.get(anim.atlas)?.sheet;
    const frames: Texture[] = [];
    for (const key of anim.frames) {
      const tex =
        sheet?.textures[key] ??
        this.textures.get(`${anim.atlas}/${key}`) ??
        this.textures.get(key);
      if (tex) frames.push(tex);
    }
    if (frames.length > 0) this.animations.set(anim.id, frames);
  }

  // --- resolution API (synchronous, post-load) ---

  /**
   * Resolve a logical name (a `MapObject.imageName`, a terrain frame key, etc.)
   * to a Texture. Resolution order:
   *   1. the manifest `index` (logicalName -> {sheet, frame})
   *   2. a direct frame-key hit in any loaded sheet
   *   3. a sheet-qualified `sheetId/frame` key
   * Returns `Texture.EMPTY` (never null) so callers can always build a Sprite.
   */
  resolveTexture(name: string | undefined): Texture {
    if (!name) return Texture.EMPTY;

    const indexEntry = this.manifest?.index?.[name];
    if (indexEntry) {
      const viaIndex =
        this.sheets.get(indexEntry.sheet)?.sheet.textures[indexEntry.frame] ??
        this.textures.get(`${indexEntry.sheet}/${indexEntry.frame}`) ??
        this.textures.get(indexEntry.frame);
      if (viaIndex) return viaIndex;
    }

    return this.textures.get(name) ?? Texture.EMPTY;
  }

  /** True if `name` resolves to a real (non-empty) texture. */
  hasTexture(name: string | undefined): boolean {
    if (!name) return false;
    if (this.manifest?.index?.[name]) return true;
    return this.textures.has(name);
  }

  /** Resolve an animation id to its ordered Texture[] (empty array if unknown). */
  resolveAnimation(id: string | undefined): Texture[] {
    if (!id) return [];
    return this.animations.get(id) ?? [];
  }

  /** A raw loaded `Spritesheet` by its manifest id (for tilemap tileset wiring). */
  getSheet(id: string): Spritesheet | undefined {
    return this.sheets.get(id)?.sheet;
  }

  /** Bytes downloaded for loaded sheets per the manifest's declared sizes, or null when
   *  the manifest predates the `bytes` field entirely (nothing to sum honestly). */
  get downloadedBytes(): number | null {
    if (this.bytesLoaded === 0 && this.bytesUnknown > 0) return null;
    return this.bytesLoaded;
  }

  /** Number of sheets currently loaded (for the HUD's "sheets X" companion stat). */
  get loadedSheetCount(): number {
    return this.sheets.size;
  }

  /** Estimated GPU memory of ALL resident atlas textures (width*height*4), regardless of
   *  what is on screen — complements the Scene's visible-only estimate. */
  textureBytes(): number {
    let b = 0;
    for (const { sheet } of this.sheets.values()) {
      const s = sheet.textureSource as { pixelWidth?: number; pixelHeight?: number; width: number; height: number };
      b += (s.pixelWidth ?? s.width) * (s.pixelHeight ?? s.height) * 4;
    }
    return b;
  }

  /** All resolved frame-key -> Texture pairs (used by the terrain tilemap). */
  allTextures(): ReadonlyMap<string, Texture> {
    return this.textures;
  }

  /** Free GPU resources. Does not unload the shared Assets cache by default. */
  destroy(): void {
    for (const { sheet } of this.sheets.values()) {
      sheet.destroy(false);
    }
    this.sheets.clear();
    this.textures.clear();
    this.animations.clear();
    this.loaded = false;
  }
}
