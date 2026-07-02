import { readFileSync } from "node:fs";

const SG = String.raw`C:\GOG Games\last_version\Game\Campaign\The Power of Eldunari-v1-2 maps\Riders.sg`;
const data = readFileSync(SG);

const dipBegin = data.indexOf(Buffer.from('MidDiplomacy'));
const dipObjBegin = data.indexOf(Buffer.from('BEGOBJECT'), dipBegin);
const dipObjEnd = data.indexOf(Buffer.from('ENDOBJECT'), dipObjBegin);
const blockStart = dipObjBegin + 10; // After "BEGOBJECT\0"

console.log('=== MidDiplomacy EXACT BYTE LAYOUT ===\n');

const blockData = data.subarray(blockStart, dipObjEnd);

// Field 1: OBJ_ID (string field: tag "OBJ_ID" + length + data)
console.log('Position 0: OBJ_ID field');
console.log('  Tag: "OBJ_ID" (6 bytes)');
console.log('  Next 20 bytes (hex):', Array.from(blockData.subarray(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' '));

let pos = 6; // After tag
const objIdLen = data.readInt32LE(blockStart + pos);
console.log(`  Length (int32 @ pos 6): ${objIdLen}`);
const objIdStr = blockData.subarray(pos + 4, pos + 4 + objIdLen).toString('latin1').replace(/\0/g, '');
console.log(`  Value: "${objIdStr}"\n`);

pos += 4 + objIdLen;

// Field 2: Count (tag = OBJ_ID string value "S143DP0000", length = count)
console.log(`Position ${pos}: Entry count field`);
const countTag = blockData.subarray(pos, pos + 10).toString('latin1');
console.log(`  Tag: "${countTag}" (10 bytes, matches OBJ_ID value)`);

const entryCount = data.readInt32LE(blockStart + pos + 10);
console.log(`  Count (int32 @ pos ${pos + 10}): ${entryCount}\n`);

pos += 14;

// Field 3-N: Entries (RACE_1, RACE_2, RELATION for each)
for (let e = 0; e < entryCount; e++) {
  console.log(`Entry ${e + 1} @ position ${pos}:`);
  
  // RACE_1
  const r1Tag = blockData.subarray(pos, pos + 6).toString('latin1');
  const r1Val = data.readInt32LE(blockStart + pos + 6);
  console.log(`  ${r1Tag}: ${r1Val} (0x${r1Val.toString(16).padStart(8, '0')})`);
  
  pos += 10;
  
  // RACE_2
  const r2Tag = blockData.subarray(pos, pos + 6).toString('latin1');
  const r2Val = data.readInt32LE(blockStart + pos + 6);
  console.log(`  ${r2Tag}: ${r2Val} (0x${r2Val.toString(16).padStart(8, '0')})`);
  
  pos += 10;
  
  // RELATION
  const relTag = blockData.subarray(pos, pos + 8).toString('latin1');
  const relVal = data.readInt32LE(blockStart + pos + 8);
  console.log(`  ${relTag}: ${relVal} (0x${(relVal >>> 0).toString(16).padStart(8, '0')})`);
  
  pos += 12;
  console.log('');
}

console.log('\n=== Summary for porting ===');
console.log('MidDiplomacy block code: 0x14 (20 decimal)');
console.log('Short ID: "DP"');
console.log('TypeName: "MidDiplomacy"');
console.log('Fields in order:');
console.log('  1. OBJ_ID (string): version+short+hex4(second) reference string');
console.log('  2. Count tag (uses OBJ_ID value as tag name): int32 entry count');
console.log('  3. For each entry:');
console.log('     - RACE_1: int32 (race ID 0-5, or player ID indices)');
console.log('     - RACE_2: int32 (race ID 0-5, or player ID indices)');
console.log('     - RELATION: int32 (0 = neutral, unknown semantics for non-zero)');
