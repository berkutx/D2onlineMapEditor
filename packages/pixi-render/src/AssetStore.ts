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

  private loaded = false;

  constructor(options: AssetStoreOptions = {}) {
    this.opts = options;
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

    await Promise.all(
      manifest.spritesheets.map((ref) => this.loadSheet(ref)),
    );

    // Build named animation lists from the manifest (cross-sheet aware).
    for (const anim of manifest.animations) {
      this.buildAnimation(anim);
    }

    this.loaded = true;
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
