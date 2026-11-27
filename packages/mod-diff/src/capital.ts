/**
 * Imgs/capital.dat: the capital screen of each race, an INI-like text file. A section per
 * race ([HUMAN] [UNDEAD] [HERETIC] [DWARF] [ELF]); `LAYERINFO_nn=flag,BUILD_ID,` lists the
 * buildings, `LAYER_<z>=BUILD_ID,PICTURE,...,x0,y0,x1,y1` draws a Capital.ff picture at depth
 * z (BUILD_ID empty for backgrounds and animations).
 */
import { normId } from "./ids.js";
import type { CapitalLayer, CapitalLayerChange, CapitalSection, CapitalSectionChange } from "./types.js";

export function parseCapitalDat(text: string): CapitalSection[] {
  const out: CapitalSection[] = [];
  let cur: CapitalSection | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("//")) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      cur = { name: sec[1]!.trim().toUpperCase(), infos: [], layers: [], other: {} };
      out.push(cur);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || !cur) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const info = /^LAYERINFO_(\w+)$/i.exec(key);
    const layer = /^LAYER_(\w+)$/i.exec(key);
    if (info) {
      const [flag = "", build = ""] = value.split(",").map((s) => s.trim());
      cur.infos.push({ n: info[1]!, flag, build: build ? normId(build) : null });
    } else if (layer) {
      const parts = value.split(",").map((s) => s.trim());
      const build = parts[0] ?? "";
      const nums = parts.slice(-4).map(Number);
      cur.layers.push({
        z: layer[1]!,
        build: build ? normId(build) : null,
        picture: (parts[1] ?? "").toUpperCase(),
        values: parts.slice(2),
        rect: parts.length >= 6 && nums.every((n) => Number.isFinite(n)) ? nums : null,
      });
    } else cur.other[key] = value;
  }
  return out;
}

/** Layers by "<build>|<PICTURE>", a repeat of the pair numbered "#2", "#3". */
function layerKeys(layers: CapitalLayer[]): Map<string, CapitalLayer> {
  const out = new Map<string, CapitalLayer>();
  for (const l of layers) {
    const base = `${l.build ?? ""}|${l.picture}`;
    let k = base;
    for (let n = 2; out.has(k); n++) k = `${base}#${n}`;
    out.set(k, l);
  }
  return out;
}

const sameLayer = (a: CapitalLayer, b: CapitalLayer) => a.z === b.z && a.values.join(",") === b.values.join(",");

export function diffCapitalSection(a: CapitalSection | undefined, b: CapitalSection | undefined, names?: { a: (id: string) => string | null; b: (id: string) => string | null }): CapitalSectionChange {
  const name = (a ?? b)!.name;
  const la = layerKeys(a?.layers ?? []);
  const lb = layerKeys(b?.layers ?? []);
  const layers: CapitalLayerChange[] = [];
  for (const [k, x] of la) {
    const y = lb.get(k);
    if (!y) layers.push({ key: k, build: x.build, picture: x.picture, change: "removed", a: x });
    else if (!sameLayer(x, y)) layers.push({ key: k, build: x.build, picture: x.picture, change: "changed", a: x, b: y });
  }
  for (const [k, y] of lb) if (!la.has(k)) layers.push({ key: k, build: y.build, picture: y.picture, change: "added", b: y });
  const byBuild = new Map<string, CapitalLayerChange[]>();
  for (const l of layers) {
    const k = l.build ?? "";
    const list = byBuild.get(k);
    if (list) list.push(l);
    else byBuild.set(k, [l]);
  }
  const buildings = [...byBuild].map(([build, ls]) => ({
    build,
    nameA: build && names ? names.a(build) : null,
    nameB: build && names ? names.b(build) : null,
    added: ls.filter((l) => l.change === "added").length,
    removed: ls.filter((l) => l.change === "removed").length,
    changed: ls.filter((l) => l.change === "changed").length,
    layers: ls,
  }));
  const infoA = new Set((a?.infos ?? []).map((i) => i.build).filter((x): x is string => !!x));
  const infoB = new Set((b?.infos ?? []).map((i) => i.build).filter((x): x is string => !!x));
  return {
    name,
    presence: a && b ? "both" : a ? "onlyA" : "onlyB",
    layersA: a?.layers.length ?? 0,
    layersB: b?.layers.length ?? 0,
    layers,
    buildings,
    infoAdded: [...infoB].filter((x) => !infoA.has(x)),
    infoRemoved: [...infoA].filter((x) => !infoB.has(x)),
  };
}

/** Every section of either file, in A's order then B's new ones. */
export function diffCapital(a: string | undefined, b: string | undefined, names?: Parameters<typeof diffCapitalSection>[2]): CapitalSectionChange[] {
  const sa = new Map(parseCapitalDat(a ?? "").map((s) => [s.name, s]));
  const sb = new Map(parseCapitalDat(b ?? "").map((s) => [s.name, s]));
  const order = [...sa.keys(), ...[...sb.keys()].filter((k) => !sa.has(k))];
  return order.map((k) => diffCapitalSection(sa.get(k), sb.get(k), names));
}
