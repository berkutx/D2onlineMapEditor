// De-risk spike (Stage 0): prove the .sg (MQDB scenario) binary framework on real bytes.
// Validates: magic, CP1251 strings, MAP_SIZE, terrain-block count == ceil(N/8)*ceil(N/4),
// per-type object counts via ".?AVC <TypeName>@@" framing. Node 24 ESM.
import { readFileSync } from "node:fs";

// point at any campaign .sg (env D2_SG or the first CLI arg)
const SG = process.env.D2_SG ?? process.argv[2] ?? "Riders.sg";
const buf = readFileSync(SG);
const cp1251 = new TextDecoder("windows-1251");
const ascii = (b) => b.toString("latin1");

console.log("file:", SG.split("\\").pop(), "bytes:", buf.length);
console.log("magic:", ascii(buf.subarray(0, 10)));

// --- helper: find a null-terminated tag then read the following LE int32 ---
function findTag(tag, from = 0) {
  return buf.indexOf(Buffer.from(tag + "\0", "latin1"), from);
}
function readIntAfterTag(tag, from = 0) {
  const i = findTag(tag, from);
  if (i < 0) return null;
  const at = i + tag.length + 1; // skip tag + NUL
  return buf.readInt32LE(at);
}

// --- MAP_SIZE (authoritative, from MidScenarioInfo) ---
const mapSize = readIntAfterTag("MAP_SIZE");
console.log("MAP_SIZE:", mapSize);

// --- count blocks by ".?AVC <TypeName>@@" framing ---
function countType(typeName) {
  const needle = Buffer.from(typeName + "@@", "latin1");
  let n = 0, i = 0;
  while ((i = buf.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}
const types = [
  "MidgardMap", "MidgardMapBlock", "MidRoad", "MidMountains", "MidStack",
  "MidVillage", "MidFortification", "MidCapital", "MidSiteRuins", "MidSiteMerchant",
  "MidSiteMage", "MidCrystal", "MidLocation", "MidLandmark", "MidUnit",
  "MidStackTemplate", "MidPlayer", "MidScenarioInfo", "MidEvent", "MidDiplomacy",
];
console.log("\nblock counts (.?AVC <Type>@@):");
for (const t of types) {
  const c = countType(t);
  if (c) console.log(`  ${t.padEnd(20)} ${c}`);
}

// --- terrain-block sanity: count == ceil(N/8)*ceil(N/4) ---
const expectedMB = Math.ceil(mapSize / 8) * Math.ceil(mapSize / 4);
const actualMB = countType("MidgardMapBlock");
console.log(`\nterrain blocks: actual=${actualMB} expected(ceil(${mapSize}/8)*ceil(${mapSize}/4))=${expectedMB} -> ${actualMB === expectedMB ? "OK" : "MISMATCH"}`);

// --- read a default-string field (tag\0 + int32 len + CP1251 bytes) ---
function readDefaultString(tag, from = 0) {
  const i = findTag(tag, from);
  if (i < 0) return null;
  let at = i + tag.length + 1;
  const len = buf.readInt32LE(at); at += 4;
  if (len < 0 || len > 4096) return `<len=${len}?>`;
  return cp1251.decode(buf.subarray(at, at + len));
}
// scenario title/description live in MidScenarioInfo
const scIdx = findTag("MidScenarioInfo");
console.log("\nMidScenarioInfo at:", scIdx);
for (const tag of ["NAME_TXT", "DESC_TXT", "BRIEFING", "CREATOR", "NAME", "DESC"]) {
  const v = readDefaultString(tag, scIdx >= 0 ? scIdx : 0);
  if (v) console.log(`  ${tag}: ${JSON.stringify(v).slice(0, 80)}`);
}

// --- a MidMountains record's POS_X/POS_Y (prove field reads within an object) ---
const mlIdx = buf.indexOf(Buffer.from("MidMountains@@", "latin1"));
if (mlIdx >= 0) {
  console.log("\nfirst MidMountains @", mlIdx, "POS_X:", readIntAfterTag("POS_X", mlIdx), "POS_Y:", readIntAfterTag("POS_Y", mlIdx));
}
console.log("\nSPIKE OK");
