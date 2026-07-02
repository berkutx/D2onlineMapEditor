import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SG = String.raw`C:\GOG Games\last_version\Game\Campaign\The Power of Eldunari-v1-2 maps\Riders.sg`;
const data = readFileSync(SG);

// Find MidDiplomacy block
const dipBegin = data.indexOf(Buffer.from('MidDiplomacy'));
const dipObjBegin = data.indexOf(Buffer.from('BEGOBJECT'), dipBegin);
const dipObjEnd = data.indexOf(Buffer.from('ENDOBJECT'), dipObjBegin);
const blockStart = dipObjBegin + 10; // After "BEGOBJECT\0"

console.log('=== MidDiplomacy Structure Analysis ===\n');
console.log('BEGOBJECT at byte:', dipObjBegin);
console.log('Block content starts at:', blockStart);
console.log('ENDOBJECT at byte:', dipObjEnd);
console.log('Block size:', dipObjEnd - blockStart, 'bytes\n');

// Parse the raw bytes
const blockData = data.subarray(blockStart, dipObjEnd);

console.log('First 50 bytes (hex + ASCII):\n');
let hexLine = '';
let ascLine = '';
for (let i = 0; i < Math.min(50, blockData.length); i++) {
  const b = blockData[i];
  hexLine += b.toString(16).padStart(2, '0') + ' ';
  ascLine += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
  if ((i + 1) % 16 === 0) {
    console.log(hexLine + '  ' + ascLine);
    hexLine = '';
    ascLine = '';
  }
}
if (hexLine) console.log(hexLine + '  ' + ascLine);

console.log('\n\nStructure interpretation:\n');

// Expected: OBJ_ID (reference, 11 bytes), then count tag with its value
// OBJ_ID = "S143DP0000" (10 chars) + null terminator = tag  + int32 length (11) + 11 bytes (10 + null)
console.log('Offset 0: OBJ_ID reference');
console.log('  Tag: S143DP0000 (literal, 10 chars at offset 0-9)');
console.log('  Value (int32 at offset 10-13):', data.readInt32LE(blockStart + 10), '(expect 11 for ref)');
const refBytes = blockData.subarray(14, 24);
console.log('  Ref ID:', refBytes.toString('latin1').replace(/\0/g, ''));

// Next comes the count - the tag is the OBJ_ID itself (per toolsqt code)
console.log('\nOffset 24: Entry count (tag = OBJ_ID, value = count)');
console.log('  Tag: S143DP0000 (10 chars at offset 24-33)');
console.log('  Value (int32 at offset 34-37):', data.readInt32LE(blockStart + 34), '(count)');

// Now 3 entries
let entryStart = 38;
console.log('\nEntries start at offset:', entryStart);

for (let e = 0; e < 3; e++) {
  console.log(`\n  Entry ${e + 1} (offset ${entryStart}):`);
  
  // RACE_1 tag (6 chars) + value (int32, 4 bytes)
  const race1Tag = blockData.subarray(entryStart, entryStart + 6).toString('latin1');
  console.log(`    Offset +${entryStart}: tag="${race1Tag}"`);
  const race1Val = data.readInt32LE(blockStart + entryStart + 6);
  console.log(`    Offset +${entryStart + 6}: value=${race1Val}`);
  
  // RACE_2 tag (6 chars) + value
  entryStart += 10;
  const race2Tag = blockData.subarray(entryStart, entryStart + 6).toString('latin1');
  console.log(`    Offset +${entryStart}: tag="${race2Tag}"`);
  const race2Val = data.readInt32LE(blockStart + entryStart + 6);
  console.log(`    Offset +${entryStart + 6}: value=${race2Val}`);
  
  // RELATION tag (8 chars) + value
  entryStart += 10;
  const relTag = blockData.subarray(entryStart, entryStart + 8).toString('latin1');
  console.log(`    Offset +${entryStart}: tag="${relTag}"`);
  const relVal = data.readInt32LE(blockStart + entryStart + 8);
  console.log(`    Offset +${entryStart + 8}: value=${relVal} (0x${(relVal >>> 0).toString(16).padStart(8, '0')})`);
  
  entryStart += 12;
}

console.log('\n\n=== Diplomacy values from toolsqt code ===');
console.log('From D2ScenarioInfo write() / readMultyStringPart():');
console.log('  RELATION field contains a single int32 value.');
console.log('  No documentation of bit layout in D2ScenarioInfo.h or D2Diplomacy.h.');
console.log('  Raw observed values: all 0 in Riders.sg');
console.log('  Interpretation: likely enum or bitmask (unknown without game source).');
