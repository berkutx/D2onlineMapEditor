/**
 * The sprite keys the renderer BUILDS (objectSprite.ts ports the editor's naming rules, with
 * the prefixes "G000FT0000", "G000SI0000", "MOMNE", … written into the code) against what
 * each mod's graphics actually HOLD. A mod that names its art differently would draw empty
 * objects; this is where that shows.
 *
 * Needs the local asset store (public/assets/mods) with built mods — skipped without it, as
 * the other real-data tests are skipped without a game install.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MapObject } from "@d2/map-schema";
import { objectSprites, type SpriteKeyContext, type SubSprite } from "../src/objectSprite";

const STORE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "public", "assets");
const INDEX = join(STORE, "mods", "index.json");

interface Mod {
  id: string;
  keys: Set<string>;
  ids: Record<string, string[]>;
  ctx: SpriteKeyContext & { graceFortCodes: Record<number, string>; graceRaceType: Record<number, number> };
  boats: Record<string, number>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadMods(): Mod[] {
  if (!existsSync(INDEX)) return [];
  const index = readJson<{ mods: { id: string; status?: string }[] }>(INDEX);
  const out: Mod[] = [];
  for (const row of index.mods) {
    if ((row.status ?? "ready") !== "ready") continue;
    const files = readJson<{ files: Record<string, string> }>(join(STORE, "mods", row.id, "mod.json")).files;
    const file = <T>(name: string): T => readJson<T>(join(STORE, ...files[name]!.split("/")));
    const manifest = file<{
      frames?: Record<string, unknown>;
      index?: Record<string, unknown>;
      animations: { id: string }[];
    }>("manifest.json");
    const data = file<{
      graceFortCodes: Record<number, string>;
      graceRaceType: Record<number, number>;
      unitBoat: Record<string, number>;
    }>("objectdata.json");
    out.push({
      id: row.id,
      // a key shows when it is a frame — or an animation, which the renderer asks for first
      keys: new Set([
        ...Object.keys(manifest.frames ?? manifest.index ?? {}),
        ...manifest.animations.map((a) => a.id),
      ]),
      ids: file<{ tables: Record<string, string[]> }>("ids.json").tables,
      ctx: { graceFortCodes: data.graceFortCodes, graceRaceType: data.graceRaceType },
      boats: data.unitBoat,
    });
  }
  return out;
}

const MODS = loadMods();
const obj = (fields: Record<string, unknown>): MapObject => ({ id: "S143XX0000", x: 0, y: 0, ...fields }) as MapObject;
/** Does this sub-sprite draw? (the key, or the editor's documented second try) */
const draws = (mod: Mod, sub: SubSprite): boolean =>
  mod.keys.has(sub.key) || (sub.fallback !== undefined && mod.keys.has(sub.fallback));
const first = (mod: Mod, fields: Record<string, unknown>, ctx?: SpriteKeyContext): boolean =>
  draws(mod, objectSprites(obj(fields), ctx ?? mod.ctx)[0]!);
/** At least one of images 0..n of an object kind exists (art sets start at 0 or 1). */
const anyImage = (mod: Mod, fields: Record<string, unknown>, n: number, ctx?: SpriteKeyContext): boolean =>
  Array.from({ length: n + 1 }, (_, image) => image).some((image) => first(mod, { ...fields, image }, ctx));

describe.skipIf(MODS.length === 0)("the renderer's sprite keys exist in every built mod", () => {
  for (const mod of MODS) {
    describe(mod.id, () => {
      /** Grace indexes of the factions a player can be (everything but the neutrals). */
      const factions = Object.entries(mod.ctx.graceFortCodes)
        .filter(([, code]) => code !== "NE")
        .map(([race]) => Number(race));

      it("has graphics at all", () => {
        expect(mod.keys.size).toBeGreaterThan(1000);
        expect(factions.length).toBeGreaterThanOrEqual(5);
      });

      it("capitals, villages and rods of every faction", () => {
        for (const race of factions) {
          expect(first(mod, { type: "capital", race }), `capital of race ${race}`).toBe(true);
          expect(first(mod, { type: "rod", race }), `rod of race ${race}`).toBe(true);
        }
        for (let tier = 1; tier <= 5; tier++) {
          for (const race of factions) {
            expect(first(mod, { type: "village", race, tier }), `village tier ${tier}, race ${race}`).toBe(true);
          }
        }
      });

      it("every crystal, the tomb, and the banner flags", () => {
        for (let resource = 0; resource < 6; resource++) {
          expect(first(mod, { type: "crystal", resource }), `crystal ${resource}`).toBe(true);
        }
        expect(first(mod, { type: "tomb" })).toBe(true);
        const banners = Array.from({ length: 16 }, (_, i) => i).filter((bannerIndex) => {
          const subs = objectSprites(obj({ type: "capital", race: factions[0], bannerIndex }), mod.ctx);
          return subs.length === 2 && draws(mod, subs[1]!);
        });
        expect(banners.length, "banner flags").toBeGreaterThanOrEqual(5);
      });

      it("sites, ruins, bags and mountains", () => {
        for (const type of ["merchant", "mage", "mercenary", "trainer"]) {
          expect(anyImage(mod, { type }, 12), `${type} site`).toBe(true);
        }
        expect(anyImage(mod, { type: "ruin" }, 30), "ruin").toBe(true);
        expect(anyImage(mod, { type: "ruin", looted: true }, 30), "looted ruin").toBe(true);
        expect(anyImage(mod, { type: "treasure" }, 12, { ...mod.ctx, water: false }), "bag on land").toBe(true);
        expect(anyImage(mod, { type: "treasure" }, 12, { ...mod.ctx, water: true }), "bag on water").toBe(true);
        const mountain = objectSprites(obj({ type: "mountains", w: 1, image: 0 }))[0]!.key;
        expect(mountain).toMatch(/^MOMNE\d{4}$/);
        expect([...mod.keys].some((k) => /^MOMNE\d{4}$/.test(k)), "mountains").toBe(true);
      });

      it("boats of every race that sails, and leaders on land", () => {
        const boatRaces = new Set(Object.values(mod.boats));
        expect(boatRaces.size).toBeGreaterThan(0);
        const sailor = (race: number): string => Object.keys(mod.boats).find((u) => mod.boats[u] === race)!;
        const withoutBoat: number[] = [];
        for (const race of [...boatRaces].sort()) {
          const leaderImage = sailor(race);
          const subs = objectSprites(obj({ type: "stack", leaderImage, facing: 0 }), { ...mod.ctx, unitBoat: mod.boats, water: true });
          if (!draws(mod, subs[0]!)) withoutBoat.push(race);
        }
        expect(boatRaces.size - withoutBoat.length, "races with a boat").toBeGreaterThanOrEqual(5);
        // KNOWN GAP, present in every mod's IsoUnit.ff: the game ships boat sets for races
        // 0..4 only, there is no G000RR0005SBOA*. The editor's rule (boat race = the leader's
        // race) therefore finds nothing for an ELVEN leader on water, and neither do we.
        // Which boat the game itself shows there is not known; any OTHER race missing a boat
        // is a new problem.
        expect(withoutBoat.filter((race) => race !== 5), "races without a boat besides the elves").toEqual([]);
        // a unit sprite belongs to a unit the mod's tables define (not the other way round:
        // only leaders walk the map, so most units have no map sprite)
        const units = new Set(mod.ids["UU"] ?? []);
        const sprites = [...mod.keys].map((k) => /^(G\w{3}UU\d{4})STOP0$/.exec(k)?.[1]).filter((u): u is string => !!u);
        expect(sprites.length).toBeGreaterThan(50);
        const known = sprites.filter((u) => units.has(u)).length;
        expect(known / sprites.length, `${sprites.length - known} unit sprites without a GUnits row`).toBeGreaterThan(0.9);
      });

      it("the landmarks its tables define", () => {
        const landmarks = mod.ids["MG"] ?? [];
        expect(landmarks.length).toBeGreaterThan(100);
        const drawn = landmarks.filter((id) => first(mod, { type: "landmark", baseType: id })).length;
        // a few rows of every mod have no art (the game shows nothing for them either)
        expect(drawn / landmarks.length, `${landmarks.length - drawn} of ${landmarks.length} landmarks have no sprite`).toBeGreaterThan(0.9);
      });
    });
  }
});
