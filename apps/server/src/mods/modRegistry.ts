/**
 * Mod datasets known to this server.
 *
 * A MOD is one game data set (Globals tables, sprites, scripts) the editor can open maps
 * against. Everything the server derives from generated assets — the atlas manifest, the
 * talisman template set, wall/decor sets, landmark footprints — belongs to a mod, so it is
 * cached per {@link ModContext} instead of in module-level singletons.
 *
 * Stage 0 knows exactly one mod: the implicit `default`, whose data is the flat
 * `ASSETS_DIR` layout the pipeline has always written. Every map resolves to it.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildWallSet, buildDecorSet, type WallSet, type DecorSet } from "@d2/map-edit";
import { config } from "../config.js";

/** Id of the implicit mod backed by the flat (pre-multi-mod) assets layout. */
export const DEFAULT_MOD_ID = "default";

/** GLmark `[w,h]` footprint of a landmark base type, or undefined (⇒ 1×1) when unknown. */
export type LandmarkSizeFn = (baseType: string) => readonly [number, number] | undefined;

export interface CatalogSets {
  walls: WallSet;
  decor: DecorSet;
  /** UPPERCASE landmark id → [cx, cy]. */
  landmarkSizes: Record<string, readonly [number, number]>;
}

/** What the export/validate pipeline needs from the map's mod. */
export interface ValidationInputs {
  talismanTemplates: ReadonlySet<string>;
  landmarkSize: LandmarkSizeFn;
}

const NO_LANDMARK_SIZE: LandmarkSizeFn = () => undefined;

export class ModContext {
  private talismans: ReadonlySet<string> | null = null;
  private talismanWarned = false;
  private catalogs: CatalogSets | null = null;
  private landmarkFn: LandmarkSizeFn | null = null;
  private manifestCache: { mtimeMs: number; json: unknown } | null = null;

  constructor(
    readonly id: string,
    /** Directory holding this mod's generated catalogs + atlas manifest. */
    readonly assetsDir: string,
  ) {}

  /**
   * The TALISMAN template-id set from itemCatalog.json (catKey L_TALISMAN) — the byte writer
   * adds a MidTalismanCharges entry per minted talisman instance (the reference's addItem
   * cascade). A missing catalog degrades to an empty set (entries simply not added) with one
   * warning, so asset volumes without the catalog stay usable; the failure is NOT cached, so
   * a catalog that appears later (a finished pipeline run) is picked up without a restart.
   */
  async talismanTemplates(): Promise<ReadonlySet<string>> {
    if (this.talismans) return this.talismans;
    try {
      const path = join(this.assetsDir, "itemCatalog.json");
      const items = JSON.parse(await readFile(path, "utf-8")) as { id: string; catKey?: string }[];
      this.talismans = new Set(items.filter((i) => i.catKey === "L_TALISMAN").map((i) => i.id));
      return this.talismans;
    } catch (e) {
      if (!this.talismanWarned) {
        this.talismanWarned = true;
        // eslint-disable-next-line no-console
        console.warn(`[mods:${this.id}] itemCatalog.json unavailable — talisman charges entries disabled (${String(e)})`);
      }
      return new Set();
    }
  }

  /**
   * The decoration catalog as a wall set (by iso orient) + a decor set (1×1 by shape) +
   * landmark footprints (for the generation occupancy guard), all from decorCatalog.json
   * (read once). Throws when the catalog is missing — generation cannot run without it.
   */
  async catalogSets(): Promise<CatalogSets> {
    if (!this.catalogs) {
      const path = join(this.assetsDir, "decorCatalog.json");
      const json = JSON.parse(await readFile(path, "utf-8")) as never;
      const landmarkSizes: Record<string, readonly [number, number]> = {};
      const entries = Array.isArray(json)
        ? (json as { id: string; cx?: number; cy?: number }[])
        : Object.values(json as Record<string, { id: string; cx?: number; cy?: number }>);
      for (const e of entries) landmarkSizes[e.id.toUpperCase()] = [e.cx ?? 1, e.cy ?? 1];
      this.catalogs = { walls: buildWallSet(json), decor: buildDecorSet(json), landmarkSizes };
    }
    return this.catalogs;
  }

  /**
   * A baseType → GLmark `[w,h]` resolver for the byte writer's plan footprints + the mechanics
   * overlap check. Degrades to `undefined` (⇒ 1×1) when the catalog is missing, so asset
   * volumes without decorCatalog.json validate exactly as before. Only a SUCCESSFUL load is
   * cached: one failed read must not pin every later validation of this mod to 1×1.
   */
  async landmarkSizeFn(): Promise<LandmarkSizeFn> {
    if (this.landmarkFn) return this.landmarkFn;
    try {
      const { landmarkSizes } = await this.catalogSets();
      this.landmarkFn = (baseType: string) => landmarkSizes[(baseType ?? "").toUpperCase()];
      return this.landmarkFn;
    } catch {
      return NO_LANDMARK_SIZE;
    }
  }

  /** Both inputs of the export/validate pipeline, loaded together. */
  async validationInputs(): Promise<ValidationInputs> {
    const [talismanTemplates, landmarkSize] = await Promise.all([
      this.talismanTemplates(),
      this.landmarkSizeFn(),
    ]);
    return { talismanTemplates, landmarkSize };
  }

  /**
   * The atlas manifest (manifest.json). Read fresh and lightly cached by mtime so a pipeline
   * rebuild is picked up without restarting the server. Throws when the file is absent.
   */
  async manifest(): Promise<unknown> {
    const path = join(this.assetsDir, "manifest.json");
    const st = await stat(path);
    if (!this.manifestCache || this.manifestCache.mtimeMs !== st.mtimeMs) {
      this.manifestCache = { mtimeMs: st.mtimeMs, json: JSON.parse(await readFile(path, "utf8")) };
    }
    return this.manifestCache.json;
  }
}

export class ModRegistry {
  private readonly mods = new Map<string, ModContext>();

  constructor(assetsDir: string = config.ASSETS_DIR) {
    this.mods.set(DEFAULT_MOD_ID, new ModContext(DEFAULT_MOD_ID, assetsDir));
  }

  /** The mod used when nothing more specific is known. */
  default(): ModContext {
    return this.mods.get(DEFAULT_MOD_ID)!;
  }

  /** A mod by id; an unknown or absent id resolves to the default mod. */
  get(id: string | null | undefined): ModContext {
    return (id ? this.mods.get(id) : undefined) ?? this.default();
  }

  /** All known mods (stable order: registration order). */
  list(): ModContext[] {
    return [...this.mods.values()];
  }

  /**
   * The mod a map belongs to. Call sites are already map-scoped so that per-map mod
   * selection only has to change this one method.
   */
  forMap(_mapId: string): ModContext {
    return this.default();
  }
}
