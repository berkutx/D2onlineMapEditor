// Pin down field-decoding details for A2: framing markers, MAP_SIZE bytes,
// the scenario-info type name, and POS_X value encoding within an object.
import { readFileSync } from "node:fs";
// point at any campaign .sg (env D2_SG or the first CLI arg)
const SG = process.env.D2_SG ?? process.argv[2] ?? "Riders.sg";
const buf = readFileSync(SG);
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const asc = (b) => [...b].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join("");

function dump(label, at, len = 48) {
  if (at < 0) { console.log(label, "NOT FOUND"); return; }
  const s = buf.subarray(at, at + len);
  console.log(`${label} @${at}\n   hex: ${hex(s)}\n   asc: ${asc(s)}`);
}
const find = (s, from = 0) => buf.indexOf(Buffer.from(s, "latin1"), from);

// framing markers present?
for (const m of ["WHAT", ".?AVC", "@@", "BEGOBJECT", "ENDOBJECT", "OBJ_ID"]) {
  console.log(`marker ${m.padEnd(10)} firstAt=${find(m)}`);
}

// scenario-info type name: list distinct ".?AVC <Name>@@" type names that contain 'cen' or 'SC'
console.log("\n-- type names containing 'cen'/'Info' --");
const re = /\.\?AVC([A-Za-z0-9_]+)@@/g;
const txt = buf.toString("latin1");
const names = new Set();
let m;
while ((m = re.exec(txt))) names.add(m[1]);
console.log([...names].filter((n) => /cen|Info|Scen/i.test(n)));
console.log("total distinct block type names:", names.size);

// MAP_SIZE: show bytes around every occurrence
let i = -1, c = 0;
while ((i = find("MAP_SIZE", i + 1)) >= 0 && c < 3) { dump("MAP_SIZE", i, 32); c++; }

// POS_X within first real object (after first BEGOBJECT): show encoding
const beg = find("BEGOBJECT");
const px = find("POS_X", beg);
dump("first POS_X after BEGOBJECT", px, 40);

// QTY_LAND / SIZE_X style size fields (alt map-size source)
for (const t of ["QTY_LAND", "SIZE_X", "SIZE_Y", "WIDTH", "MAP_NAME", "SCEN_NAME"]) dump(t, find(t), 28);
