import { readFileSync } from "node:fs";

const SG = String.raw`C:\GOG Games\last_version\Game\Campaign\The Power of Eldunari-v1-2 maps\Riders.sg`;
const data = readFileSync(SG);
const cp1251 = new TextDecoder("windows-1251");

console.log('File size:', data.length, 'bytes\n');

// Find ScenarioInfo block
let pos = data.indexOf(Buffer.from('ScenarioInfo'));
if (pos < 0) {
  console.log('ScenarioInfo not found');
  process.exit(1);
}

// Find BEGOBJECT after ScenarioInfo
const beginIdx = data.indexOf(Buffer.from('BEGOBJECT'), pos);
const endIdx = data.indexOf(Buffer.from('ENDOBJECT'), beginIdx);

console.log('=== ScenarioInfo BLOCK (BEGOBJECT..ENDOBJECT) ===');
console.log('Byte range:', beginIdx + 10, 'to', endIdx);
console.log('Block size:', endIdx - (beginIdx + 10), 'bytes\n');

const blockData = data.subarray(beginIdx + 10, endIdx);
console.log('Field dump (raw bytes + parsed values):\n');

// List of expected ScenarioInfo fields from toolsqt D2ScenarioInfo.h read() order
const expectedFields = [
  'OBJ_ID', 'INFO_ID', 'CAMPAIGN', 'SOURCE_M', 'QTY_CITIES',
  'NAME', 'DESC', 'BRIEFING', 'DEBUNKW', 'DEBUNKW2', 'DEBUNKW3', 'DEBUNKW4', 'DEBUNKW5',
  'DEBUNKL', 'BRIEFLONG1', 'BRIEFLONG2', 'BRIEFLONG3', 'BRIEFLONG4', 'BRIEFLONG5',
  'O', 'CUR_TURN', 'MAX_UNIT', 'MAX_SPELL', 'MAX_LEADER', 'MAX_CITY',
  'MAP_SIZE', 'DIFFSCEN', 'DIFFGAME', 'CREATOR',
  'PLAYER_1', 'PLAYER_2', 'PLAYER_3', 'PLAYER_4', 'PLAYER_5', 'PLAYER_6', 'PLAYER_7',
  'PLAYER_8', 'PLAYER_9', 'PLAYER_10', 'PLAYER_11', 'PLAYER_12', 'PLAYER_13',
  'SUGG_LVL', 'MAP_SEED'
];

let foundCount = 0;
for (const tag of expectedFields) {
  let tagIdx = -1;
  // Search for tag in the block
  for (let i = 0; i < blockData.length - tag.length; i++) {
    let match = true;
    for (let j = 0; j < tag.length; j++) {
      if (blockData[i + j] !== tag.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) {
      tagIdx = i;
      break;
    }
  }
  
  if (tagIdx >= 0) {
    foundCount++;
    const after = tagIdx + tag.length;
    const nextByte = blockData[after] || 0;
    
    if (tag === 'SOURCE_M' || tag === 'O') {
      // Boolean flag - no value, just presence
      console.log(`  ${tag.padEnd(12)} | BOOL | present (true)`);
    } else if (tag.startsWith('PLAYER_') || tag === 'QTY_CITIES' || tag === 'CUR_TURN' || 
               tag === 'MAX_UNIT' || tag === 'MAX_SPELL' || tag === 'MAX_LEADER' || 
               tag === 'MAX_CITY' || tag === 'MAP_SIZE' || tag === 'DIFFSCEN' || 
               tag === 'DIFFGAME' || tag === 'SUGG_LVL' || tag === 'MAP_SEED') {
      // int32 field
      const val = data.readInt32LE(beginIdx + 10 + after);
      console.log(`  ${tag.padEnd(12)} | int32   | ${val} (0x${val.toString(16)})`);
    } else if (tag === 'OBJ_ID' || tag === 'INFO_ID') {
      // reference field: tag + int32(11) + 10-char id + NUL
      const len = data.readInt32LE(beginIdx + 10 + after);
      const refBytes = blockData.subarray(after + 4, after + 4 + len);
      const ref = refBytes.toString('latin1').replace(/\0/g, '');
      console.log(`  ${tag.padEnd(12)} | ref(11) | len=${len} id="${ref}"`);
    } else {
      // string field
      const len = data.readInt32LE(beginIdx + 10 + after);
      const strBytes = blockData.subarray(after + 4, after + 4 + len);
      let str = '';
      try {
        str = cp1251.decode(strBytes).replace(/\0/g, '');
      } catch (e) {
        str = '[decode error]';
      }
      const strShort = str.length > 70 ? str.substring(0, 70) + '...' : str;
      console.log(`  ${tag.padEnd(12)} | string  | len=${len} value="${strShort}"`);
    }
  }
}

console.log(`\nFound ${foundCount}/${expectedFields.length} expected fields\n`);

// Find MidDiplomacy block
const dipBegin = data.indexOf(Buffer.from('MidDiplomacy'));
if (dipBegin < 0) {
  console.log('=== MidDiplomacy NOT FOUND ===');
} else {
  const dipObjBegin = data.indexOf(Buffer.from('BEGOBJECT'), dipBegin);
  const dipObjEnd = data.indexOf(Buffer.from('ENDOBJECT'), dipObjBegin);
  
  console.log('=== MidDiplomacy BLOCK (BEGOBJECT..ENDOBJECT) ===');
  console.log('Byte range:', dipObjBegin + 10, 'to', dipObjEnd);
  console.log('Block size:', dipObjEnd - (dipObjBegin + 10), 'bytes\n');
  
  const dipData = data.subarray(dipObjBegin + 10, dipObjEnd);
  console.log('Raw hex dump of entire block:\n');
  
  let hexStr = '';
  for (let i = 0; i < dipData.length; i++) {
    hexStr += dipData[i].toString(16).padStart(2, '0') + ' ';
    if ((i + 1) % 16 === 0) {
      hexStr += '\n';
    }
  }
  console.log(hexStr);
  
  console.log('\n\nField interpretation:\n');
  
  let j = 0;
  const dipTags = ['OBJ_ID', 'S143DP0000', 'RACE_1', 'RACE_2', 'RELATION'];
  let entryNum = 0;
  
  while (j < dipData.length && j < 1000) {
    // Search for any known tag
    let foundTag = null;
    let tagIdx = -1;
    
    for (const tag of ['OBJ_ID', 'RACE_1', 'RACE_2', 'RELATION']) {
      let idx = -1;
      for (let i = j; i < Math.min(j + 50, dipData.length) - tag.length; i++) {
        let match = true;
        for (let k = 0; k < tag.length; k++) {
          if (dipData[i + k] !== tag.charCodeAt(k)) {
            match = false;
            break;
          }
        }
        if (match) {
          idx = i;
          break;
        }
      }
      if (idx >= 0 && (foundTag === null || idx < tagIdx)) {
        foundTag = tag;
        tagIdx = idx;
      }
    }
    
    if (foundTag === null) break;
    
    const after = tagIdx + foundTag.length;
    
    if (foundTag === 'RACE_1') {
      entryNum++;
      console.log(`  Entry ${entryNum}:`);
    }
    
    const val = data.readInt32LE(dipObjBegin + 10 + after);
    const valHex = (val >>> 0).toString(16).padStart(8, '0');
    console.log(`    ${foundTag.padEnd(12)} = ${val} (0x${valHex})`);
    
    j = after + 4;
  }
}
