import { readFileSync } from "node:fs";

const SG = String.raw`C:\GOG Games\last_version\Game\Campaign\The Power of Eldunari-v1-2 maps\Riders.sg`;
const data = readFileSync(SG);

const dipBegin = data.indexOf(Buffer.from('MidDiplomacy'));
console.log('=== Full MidDiplomacy block context ===\n');

const from = dipBegin - 50;
const to = dipBegin + 200;

console.log('Bytes from 50 before MidDiplomacy to 200 after:\n');

for (let i = from; i < to; i += 16) {
  let hex = '';
  let asc = '';
  for (let j = 0; j < 16 && i + j < to; j++) {
    const b = data[i + j];
    hex += b.toString(16).padStart(2, '0') + ' ';
    asc += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
  }
  const marker = i === dipBegin ? ' <-- MidDiplomacy' : (i === data.indexOf(Buffer.from('BEGOBJECT'), dipBegin) ? ' <-- BEGOBJECT' : '');
  console.log(`+${(i - from).toString().padStart(4)} |  ${hex.padEnd(48)} | ${asc}${marker}`);
}

console.log('\n=== Interpretation ===');
const objBegin = data.indexOf(Buffer.from('BEGOBJECT'), dipBegin);
const blockStart = objBegin + 10;

console.log(`\nBEGOBJECT at: ${objBegin}`);
console.log(`Block content starts at: ${blockStart} (after "BEGOBJECT\0")`);

const blockData = data.subarray(blockStart, blockStart + 120);

console.log('\nFirst 120 bytes of block content (hex + ASCII):\n');
for (let i = 0; i < 120; i += 16) {
  let hex = '';
  let asc = '';
  for (let j = 0; j < 16 && i + j < 120; j++) {
    const b = blockData[i + j];
    hex += b.toString(16).padStart(2, '0') + ' ';
    asc += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
  }
  console.log(`+${i.toString().padStart(3)} |  ${hex.padEnd(48)} | ${asc}`);
}

console.log('\n=== Expected sequence from toolsqt ===');
console.log('1. OBJ_ID refField: tag="OBJ_ID" + [0B 00 00 00] + "S143DP0000" + 00');
console.log('2. Count intField: tag="S143DP0000" + count int32');
console.log('3. For each entry:');
console.log('   - RACE_1: tag="RACE_1" + int32');
console.log('   - RACE_2: tag="RACE_2" + int32');
console.log('   - RELATION: tag="RELATION" + int32');
