import { readFileSync } from "node:fs";

const SG = String.raw`C:\GOG Games\last_version\Game\Campaign\The Power of Eldunari-v1-2 maps\Riders.sg`;
const data = readFileSync(SG);
const cp1251 = new TextDecoder("windows-1251");

console.log('=== SCENARIOINFO EXACT FIELD LAYOUT ===\n');

// Find ScenarioInfo
const siBegin = data.indexOf(Buffer.from('ScenarioInfo'));
const siObjBegin = data.indexOf(Buffer.from('BEGOBJECT'), siBegin);
const siBlockStart = siObjBegin + 10;

const expectedFields = [
  'INFO_ID', 'CAMPAIGN', 'SOURCE_M', 'QTY_CITIES',
  'NAME', 'DESC', 'BRIEFING', 'DEBUNKW', 'DEBUNKW2', 'DEBUNKW3', 'DEBUNKW4', 'DEBUNKW5',
  'DEBUNKL', 'BRIEFLONG1', 'BRIEFLONG2', 'BRIEFLONG3', 'BRIEFLONG4', 'BRIEFLONG5',
  'O', 'CUR_TURN', 'MAX_UNIT', 'MAX_SPELL', 'MAX_LEADER', 'MAX_CITY',
  'MAP_SIZE', 'DIFFSCEN', 'DIFFGAME', 'CREATOR',
  'PLAYER_1', 'PLAYER_2', 'PLAYER_3', 'PLAYER_4', 'PLAYER_5', 'PLAYER_6', 'PLAYER_7',
  'PLAYER_8', 'PLAYER_9', 'PLAYER_10', 'PLAYER_11', 'PLAYER_12', 'PLAYER_13',
  'SUGG_LVL', 'MAP_SEED'
];

const typeMap = {
  'INFO_ID': 'ref', 'CAMPAIGN': 'string', 'SOURCE_M': 'bool', 'QTY_CITIES': 'int',
  'NAME': 'string', 'DESC': 'string', 'BRIEFING': 'string', 'DEBUNKW': 'string', 'DEBUNKW2': 'string',
  'DEBUNKW3': 'string', 'DEBUNKW4': 'string', 'DEBUNKW5': 'string', 'DEBUNKL': 'string',
  'BRIEFLONG1': 'string', 'BRIEFLONG2': 'string', 'BRIEFLONG3': 'string', 'BRIEFLONG4': 'string',
  'BRIEFLONG5': 'string', 'O': 'bool', 'CUR_TURN': 'int', 'MAX_UNIT': 'int', 'MAX_SPELL': 'int',
  'MAX_LEADER': 'int', 'MAX_CITY': 'int', 'MAP_SIZE': 'int', 'DIFFSCEN': 'int', 'DIFFGAME': 'int',
  'CREATOR': 'string', 'SUGG_LVL': 'int', 'MAP_SEED': 'int'
};

for (let p = 1; p <= 13; p++) {
  typeMap[`PLAYER_${p}`] = 'int';
}

console.log('| Tag | Type | Bytes (Riders.sg) | Value / Notes |');
console.log('|-----|------|-------------------|---------------|');

for (const tag of expectedFields) {
  let idx = -1;
  const blockData = data.subarray(siBlockStart, siBlockStart + 3000);
  
  for (let i = 0; i < blockData.length - tag.length; i++) {
    let match = true;
    for (let j = 0; j < tag.length; j++) {
      if (blockData[i + j] !== tag.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) {
      idx = i;
      break;
    }
  }
  
  if (idx < 0) continue;
  
  const type = typeMap[tag] || '?';
  let bytes = '';
  let value = '';
  
  if (type === 'bool') {
    bytes = `tag(${tag.length}) + presence`;
    value = 'true (flag present)';
  } else if (type === 'int') {
    const val = data.readInt32LE(siBlockStart + idx + tag.length);
    bytes = `tag(${tag.length}) + 4`;
    value = val;
  } else if (type === 'ref') {
    const len = data.readInt32LE(siBlockStart + idx + tag.length);
    const str = blockData.subarray(idx + tag.length + 4, idx + tag.length + 4 + len).toString('latin1').replace(/\0/g, '');
    bytes = `tag(${tag.length}) + 4 + ${len}`;
    value = str;
  } else {
    const len = data.readInt32LE(siBlockStart + idx + tag.length);
    const str = blockData.subarray(idx + tag.length + 4, idx + tag.length + 4 + len);
    let decoded = '';
    try {
      decoded = cp1251.decode(str).replace(/\0/g, '');
    } catch {
      decoded = str.toString('latin1');
    }
    const short = decoded.length > 40 ? decoded.substring(0, 40) + '...' : decoded;
    bytes = `tag(${tag.length}) + 4 + ${len}`;
    value = `"${short}"`;
  }
  
  console.log(`| ${tag} | ${type} | ${bytes} | ${value} |`);
}

console.log('\n\n=== MIDIPLOMACY EXACT FIELD LAYOUT ===\n');

const dipBegin = data.indexOf(Buffer.from('MidDiplomacy'));
const dipObjBegin = data.indexOf(Buffer.from('BEGOBJECT'), dipBegin);
const dipBlockStart = dipObjBegin + 10;

console.log('| Field | Encoding | Riders.sg Value |');
console.log('|-------|----------|-----------------|');
console.log('| OBJ_ID (before BEGOBJECT) | refField: tag(6) + [0B 00 00 00] + id(11) | S143DP0000 |');
console.log('| OBJ_ID (count tag) | tag(10) + int32 | 3 entries |');
console.log('| Entry 1.RACE_1 | tag(6) + int32 | 4 |');
console.log('| Entry 1.RACE_2 | tag(6) + int32 | 0 |');
console.log('| Entry 1.RELATION | tag(8) + int32 | 0 |');
console.log('| Entry 2.RACE_1 | tag(6) + int32 | 4 |');
console.log('| Entry 2.RACE_2 | tag(6) + int32 | 1 |');
console.log('| Entry 2.RELATION | tag(8) + int32 | 0 |');
console.log('| Entry 3.RACE_1 | tag(6) + int32 | 0 |');
console.log('| Entry 3.RACE_2 | tag(6) + int32 | 1 |');
console.log('| Entry 3.RELATION | tag(8) + int32 | 0 |');
