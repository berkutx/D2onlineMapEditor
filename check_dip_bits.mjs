import { readFileSync } from "node:fs";

const SG = String.raw`C:\GOG Games\last_version\Game\Campaign\The Power of Eldunari-v1-2 maps\Riders.sg`;
const data = readFileSync(SG);

// Find MidDiplomacy block
const dipBegin = data.indexOf(Buffer.from('MidDiplomacy'));
const dipObjBegin = data.indexOf(Buffer.from('BEGOBJECT'), dipBegin);
const blockStart = dipObjBegin + 10; // After "BEGOBJECT\0"

console.log('=== Raw MidDiplomacy bytes starting from BEGOBJECT ===\n');

// OBJ_ID is a 11-byte string reference
// Format: tag "S143DP0000" (10 chars) + terminator = search manually
let pos = 0;

// Look for pattern: "S143DP0000" or similar OBJ_ID
console.log('Looking for OBJ_ID...');
for (let i = blockStart; i < blockStart + 30; i++) {
  const c = String.fromCharCode(data[i]);
  const isAscii = data[i] >= 32 && data[i] < 127;
  process.stdout.write(isAscii ? c : `[${data[i].toString(16).padStart(2, '0')}]`);
}
console.log('\n');

// Next: count (tag matches OBJ_ID, value = number of entries)
console.log('Entry count analysis:');
// Pattern: tag (e.g. "S143DP0000") followed by int32 = count of entries
const countBytes = data.readInt32LE(blockStart + 10); // Assuming OBJ_ID tag ends at position 10
console.log('  First int32 after OBJ_ID tag area: count =', countBytes);

console.log('\nEntry structure (3 entries found):');
console.log('  Each entry: RACE_1(int32) + RACE_2(int32) + RELATION(int32)');
console.log('  Entry offsets relative to BEGOBJECT:\n');

let entryPos = 14; // After "S143DP0000" (10) + "\0" + int32(4)
for (let e = 0; e < 3; e++) {
  const race1 = data.readInt32LE(blockStart + entryPos);
  const race2 = data.readInt32LE(blockStart + entryPos + 4);
  const rel = data.readInt32LE(blockStart + entryPos + 8);
  
  console.log(`  Entry ${e+1} @ offset +${entryPos}:`);
  console.log(`    RACE_1   = ${race1} (0x${race1.toString(16).padStart(8, '0')})`);
  console.log(`    RACE_2   = ${race2} (0x${race2.toString(16).padStart(8, '0')})`);
  console.log(`    RELATION = ${rel} (0x${(rel >>> 0).toString(16).padStart(8, '0')})`);
  
  // Check for bit flags in RELATION
  if (rel !== 0) {
    const bits = rel.toString(2).padStart(32, '0');
    console.log(`    RELATION bits: ${bits}`);
  }
  
  entryPos += 12;
}

// Load other .sg files to see if RELATION ever has non-zero values
console.log('\n\n=== Checking other maps for RELATION bit patterns ===\n');

const fs = require('fs');
const path = require('path');
const mapsDir = String.raw`C:\GOG Games\last_version\Game\Campaign\The Power of Eldunari-v1-2 maps`;

if (fs.existsSync(mapsDir)) {
  const files = fs.readdirSync(mapsDir).filter(f => f.endsWith('.sg'));
  console.log(`Found ${files.length} .sg files. Checking first 3 for MidDiplomacy RELATION patterns:\n`);
  
  for (const file of files.slice(0, 3)) {
    const filePath = path.join(mapsDir, file);
    const mapData = readFileSync(filePath);
    const dipBegin2 = mapData.indexOf(Buffer.from('MidDiplomacy'));
    
    if (dipBegin2 >= 0) {
      const dipObjBegin2 = mapData.indexOf(Buffer.from('BEGOBJECT'), dipBegin2);
      const blockStart2 = dipObjBegin2 + 10;
      const count2 = mapData.readInt32LE(blockStart2 + 10);
      
      console.log(`${file} (${count2} entries):`);
      
      let entryPos2 = 14;
      for (let e = 0; e < Math.min(count2, 3); e++) {
        const rel2 = mapData.readInt32LE(blockStart2 + entryPos2 + 8);
        if (rel2 !== 0) {
          console.log(`  Entry ${e+1}: RELATION = ${rel2} (0x${(rel2 >>> 0).toString(16).padStart(8, '0')})`);
        }
        entryPos2 += 12;
      }
      if (count2 === 0) {
        console.log(`  (no entries)`);
      }
      console.log('');
    }
  }
}
