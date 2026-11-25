/**
 * Mod datasets known to this server.
 *
 * A MOD is one game data set (Globals tables, sprites, scripts) the editor can open maps
 * against. Everything the server derives from generated assets — the atlas manifest, the
 * talisman template set, wall/decor sets, landmark footprints, the id tables used to tell
 * mods apart — belongs to a mod and is cached per {@link ModContext}.
 *
 * Mods come from the asset store the pipeline's build_mod.py writes into ASSETS_DIR:
 *
 *   mods/index.json            the installed mods
 *   mods/<modId>/mod.json      one mod: identity + logical file name -> blob
 *   blobs/<xx>/<sha256>.<ext>  immutable files shared by all mods
 *
 * A deployment whose ASSETS_DIR has no `mods/index.json` still has the flat layout the
 * pipeline used to write (catalogs and atlases side by side). It is served as ONE implicit
 * mod, `default`, so such a deployment keeps working unchanged until its assets are rebuilt.
 */

import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildWallSet, buildDecorSet, type WallSet, type DecorSet } from "@d2/map-edit";
import { collectGlobalIds, collectScriptGlobalIds } from "@d2/sg-parser";
import {
  IdSets,
  ModIndex,
  ModManifest,
  detectMod,
  indexIdSets,
  type IdIndex,
  type ModCompatibility,
  type ModDetection,
} from "@d2/mod-catalog";
import type { ModInfo } from "@d2/socket-contract";
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

/** A map matched against the installed mods. */
export interface MapAnalysis {
  /** The decision among mods a map can be opened on (`ready` ones). */
  detection: ModDetection;
  /** How the map fits EVERY mod that has id tables, including `data-only` ones. */
  all: ModCompatibility[];
}

const NO_LANDMARK_SIZE: LandmarkSizeFn = () => undefined;

/** Where a mod's files are: the flat legacy directory, or the store through a file table. */
type ModSource =
  | { kind: "flat"; dir: string }
  | { kind: "store"; root: string; manifest: ModManifest; rev: string };

export class ModContext {
  private talismans: ReadonlySet<string> | null = null;
  private talismanWarned = false;
  private catalogs: CatalogSets | null = null;
  private landmarkFn: LandmarkSizeFn | null = null;
  private manifestCache: { mtimeMs: number; json: unknown } | null = null;
  private ids: IdIndex | null | undefined;

  constructor(
    readonly id: string,
    private readonly source: ModSource,
  ) {}

  /** A mod over the flat pre-multi-mod layout: every logical name is a file in `dir`. */
  static flat(id: string, dir: string): ModContext {
    return new ModContext(id, { kind: "flat", dir });
  }

  /** Directory of the flat layout, or of the store this mod's blobs live in. */
  get assetsDir(): string {
    return this.source.kind === "flat" ? this.source.dir : this.source.root;
  }

  /** True for the implicit mod over the flat layout (no manifest, no id tables). */
  get isFlat(): boolean {
    return this.source.kind === "flat";
  }

  /** Changes whenever the mod's files are rebuilt; part of every asset URL of the mod. */
  get rev(): string {
    return this.source.kind === "flat" ? "flat" : this.source.rev;
  }

  /** Public description of the mod (GET /api/mods). */
  get info(): ModInfo {
    if (this.source.kind === "flat") {
      return {
        id: this.id,
        name: this.id,
        family: this.id,
        familyOrder: 0,
        status: "ready",
        rev: this.rev,
        assetBase: "/assets",
      };
    }
    const m = this.source.manifest;
    return {
      id: m.id,
      name: m.name,
      family: m.family,
      familyOrder: m.familyOrder,
      status: m.status,
      contentFingerprint: m.contentFingerprint,
      rev: this.rev,
      assetBase: `/assets/mods/${m.id}/${this.rev}`,
    };
  }

  /**
   * Absolute path of one of the mod's files by its LOGICAL name ("unitCatalog.json",
   * "itemicons/g000ig0001.png"), or undefined when the mod has no such file. For the flat
   * layout the path is returned without checking that the file exists.
   */
  filePath(logical: string): string | undefined {
    if (this.source.kind === "flat") return join(this.source.dir, ...logical.split("/"));
    const blob = this.source.manifest.files[logical];
    return blob ? join(this.source.root, ...blob.split("/")) : undefined;
  }

  private async readJson(logical: string): Promise<unknown> {
    const path = this.filePath(logical);
    if (!path) throw new Error(`mod ${this.id} has no ${logical}`);
    return JSON.parse(await readFile(path, "utf-8"));
  }

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
      const items = (await this.readJson("itemCatalog.json")) as { id: string; catKey?: string }[];
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
      const json = (await this.readJson("decorCatalog.json")) as never;
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
   * rebuild of the flat layout is picked up without restarting the server (a store blob
   * never changes, so there the cache simply always hits). Throws when the file is absent.
   */
  async manifest(): Promise<unknown> {
    const path = this.filePath("manifest.json");
    if (!path) throw new Error(`mod ${this.id} has no atlas manifest`);
    const st = await stat(path);
    if (!this.manifestCache || this.manifestCache.mtimeMs !== st.mtimeMs) {
      this.manifestCache = { mtimeMs: st.mtimeMs, json: JSON.parse(await readFile(path, "utf8")) };
    }
    return this.manifestCache.json;
  }

  /**
   * The ids this mod's Globals tables define, indexed for lookup — what a map's references
   * are checked against. null when the mod has no id tables (the flat layout).
   */
  async idIndex(): Promise<IdIndex | null> {
    if (this.ids !== undefined) return this.ids;
    if (this.source.kind === "flat" || !this.source.manifest.files["ids.json"]) {
      this.ids = null;
      return null;
    }
    try {
      this.ids = indexIdSets(IdSets.parse(await this.readJson("ids.json")));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[mods:${this.id}] ids.json unreadable — the mod is left out of detection (${String(e)})`);
      this.ids = null;
    }
    return this.ids;
  }
}

/** How often the index file is re-checked for a rebuild, at most. */
const RECHECK_MS = 1000;

export class ModRegistry {
  private mods = new Map<string, ModContext>();
  private defaultId = DEFAULT_MOD_ID;
  /** mtime of mods/index.json the current state was loaded from (null = no index file). */
  private indexMtimeMs: number | null | undefined;
  private checkedAt = 0;
  private generation = 0;

  constructor(private readonly assetsDir: string = config.ASSETS_DIR) {
    this.reload();
  }

  private indexPath(): string {
    return join(this.assetsDir, "mods", "index.json");
  }

  private indexMtime(): number | null {
    try {
      return statSync(this.indexPath()).mtimeMs;
    } catch {
      return null;
    }
  }

  /** (Re)read the store's index and every mod manifest. A broken mod is skipped with a warning. */
  private reload(): void {
    const mtime = this.indexMtime();
    const mods = new Map<string, ModContext>();
    let defaultId: string | undefined;
    if (mtime !== null) {
      try {
        const index = ModIndex.parse(JSON.parse(readFileSync(this.indexPath(), "utf-8")));
        for (const row of index.mods) {
          try {
            const raw = readFileSync(join(this.assetsDir, "mods", row.id, "mod.json"));
            const manifest = ModManifest.parse(JSON.parse(raw.toString("utf-8")));
            if (manifest.id !== row.id) throw new Error(`mod.json is for ${manifest.id}`);
            const rev = createHash("sha256").update(raw).digest("hex").slice(0, 12);
            mods.set(row.id, new ModContext(row.id, { kind: "store", root: this.assetsDir, manifest, rev }));
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(`[mods] ${row.id}: mod.json unusable, mod skipped (${String(e)})`);
          }
        }
        defaultId = index.defaultModId;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[mods] mods/index.json unusable — serving the flat layout (${String(e)})`);
      }
    }
    if (mods.size === 0) {
      mods.set(DEFAULT_MOD_ID, ModContext.flat(DEFAULT_MOD_ID, this.assetsDir));
      defaultId = DEFAULT_MOD_ID;
    }
    if (!defaultId || !mods.has(defaultId)) {
      // prefer a mod maps can actually be opened on
      defaultId = ([...mods.values()].find((m) => m.info.status === "ready") ?? [...mods.values()][0]!).id;
    }
    this.mods = mods;
    this.defaultId = defaultId;
    this.indexMtimeMs = mtime;
    this.generation++;
  }

  /** Pick up a rebuilt store (a new or changed mods/index.json). Cheap: one stat per second. */
  refresh(force = false): void {
    const now = Date.now();
    if (!force && now - this.checkedAt < RECHECK_MS) return;
    this.checkedAt = now;
    if (this.indexMtime() !== this.indexMtimeMs) this.reload();
  }

  /** Changes every time the set of mods is reloaded — a key for anything derived from it. */
  get revision(): number {
    return this.generation;
  }

  /** The mod used when nothing more specific is known. */
  default(): ModContext {
    return this.mods.get(this.defaultId)!;
  }

  has(id: string | null | undefined): boolean {
    return !!id && this.mods.has(id);
  }

  /** A mod by id; an unknown or absent id resolves to the default mod. */
  get(id: string | null | undefined): ModContext {
    return (id ? this.mods.get(id) : undefined) ?? this.default();
  }

  /** All known mods (stable order: the index's order). */
  list(): ModContext[] {
    return [...this.mods.values()];
  }

  /**
   * Match a map's bytes against the mods that have id tables. Returns null when none has
   * (the flat layout): there is nothing to tell mods apart with.
   */
  async analyze(bytes: Uint8Array): Promise<MapAnalysis | null> {
    const candidates = [];
    for (const mod of this.mods.values()) {
      const idSets = await mod.idIndex();
      if (!idSets) continue;
      const { family, familyOrder, status } = mod.info;
      candidates.push({ id: mod.id, family, familyOrder, status, idSets });
    }
    if (candidates.length === 0) return null;
    const refs = collectGlobalIds(bytes);
    const scriptRefs = collectScriptGlobalIds(bytes);
    return {
      detection: detectMod(refs, candidates, { scriptRefs }),
      all: detectMod(refs, candidates, { scriptRefs, includeDataOnly: true }).candidates,
    };
  }
}
