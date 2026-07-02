# Reference gap map: events, triggers, scenario setup — and the porting plan

Researched 2026-07-02 from four cross-checked sources: toolsqt `D2Event.h` (the .sg
serialization), D2ModdingToolset mss32 headers (game-engine structs/enums/ranges),
d2mapeditorqt QML (editor UX semantics), and the game's own `LEvCond.DBF`/`LEvEffct.DBF`
(authoritative numeric ids) — field order byte-verified on `Riders.sg`. Verbatim D2Event.h
copy: see session tool-results (line refs "TQ" below refer to it).

---

## 1. The event system (MidEvent) — complete enumeration

**Block**: type name `MidEvent`, code 0x10, id prefix `EV` (`S143EV0001`). Riders has **746**
of them. Victory/defeat conditions are NOT in ScenarioInfo — they are events with the
WIN_OR_LOSE_SCENARIO effect.

**Field order inside BEGOBJECT** (byte-verified):
`NAME_TXT` → applies-to race bools `HUMAN,DWARF,UNDEAD,HERETIC,NEUTRAL[,ELF]` →
can-trigger bools `VERHUMAN..VERNEUTRAL[,VERELF]` → `ENABLED`,`OCCUR_ONCE` →
`CHANCE`(0-100), `ORDER` → `COND_QTY` + N×(`CATEGORY` + payload) → `EFFECT_QTY` +
M×(`CATEGORY` + `NUM` + payload). ELF/VERELF and several effect extras exist only under the
`D2EESFISIG` magic (our target).

### Conditions (LEvCond ids; 0-18 vanilla, 19-23 = D2ModdingToolset extensions †)

| id | name | payload tags | semantics |
|----|------|--------------|-----------|
| 0 | FREQUENCY | `FREQUENCY`:int | every N days, N∈[1..500] |
| 2 | ENTERING_A_PREDEFINED_ZONE | `ID_LOC` | triggerer enters location |
| 3 | ENTERING_A_CITY | `ID_CITY` | |
| 4 | OWNING_A_CITY | `ID_CITY` | |
| 5 | DESTROY_STACK | `ID_STACK` | |
| 6 | OWNING_AN_ITEM | `TYPE_ITEM` (GItem template id) | |
| 7 | SPECIFIC_LEADER_OWNING_AN_ITEM | `TYPE_ITEM`,`ID_STACK` | |
| 8 | DIPLOMACY_RELATIONS | `ID_PLAYER1/2`,`DIPLOMACY`:int | range [-100..100]; presets Peace=100/Neutral=49/War=0 |
| 9 | ALLIANCE | `ID_PLAYER1/2` | |
| 10 | LOOTING_A_RUIN | `ID_RUIN` | |
| 11 | TRANSFORMING_LAND | `PCT_LAND`:int | % of land transformed |
| 12 | VISITING_A_SITE | `ID_SITE` | |
| 14 | STACK_IN_LOCATION | `ID_STACK`,`ID_LOC` | |
| 15 | STACK_IN_CITY | `ID_STACK`,`ID_CITY` | |
| 16 | ITEM_TO_LOCATION | `TYPE_ITEM`,`ID_LOC` | |
| 17 | STACK_EXISTANCE | `ID_STACK`,`MISC_INT` | 0=must exist, 1=must not |
| 18 | VARIABLE_IS_IN_RANGE | `MISC_INT..MISC_INT7` | var1,min,max,var2,min,max,relation(0=ignore2nd,1=AND,2=OR) |
| 19† | RESOURCE_AMOUNT | `BANK`:str,`GRE`:bool | bank `"G0000:R0000:Y0000:E0000:W0000:B0000"`, GRE = ≥ |
| 20† | CHECK_GAMEMODE | `MODE`:int | 0=Single,1=Hotseat,2=Online |
| 21† | CHECK_FOR_HUMAN | `AI`:bool | false=human, true=AI |
| 22† | COMPARE_VAR | `VAR1`,`VAR2`,`CMP` | CMP 0..5 = ==,!=,>,>=,<,<= |
| 23† | CUSTOM_SCRIPT | `CODE`,`DESCR` (raw len+bytes) | Lua, entry gets `scenario`, returns bool |

(ids 1 and 13 are deleted vanilla rows — never appear in maps.)

### Effects (LEvEffct ids 0-23, no gaps; every payload starts with `NUM` = apply order)

| id | name | payload after NUM | notes |
|----|------|-------------------|-------|
| 0 | WIN_OR_LOSE_SCENARIO | `WIN_SCEN`:bool,`ID_PLAYER1` | THE victory/defeat mechanic |
| 1 | CREATE_NEW_STACK | `ID_STKTEMP`,`ID_LOC` | spawn stack-template at location |
| 2 | CAST_SPELL_ON_TRIGGERER | `TYPE_SPELL`,`ID_PLAYER1` | |
| 3 | CAST_SPELL_AT_SPECIFIC_LOCATION | `TYPE_SPELL`,`ID_LOC`,`ID_PLAYER1` | |
| 4 | CHANGE_STACK_OWNER | `ID_STACK`,`ID_PLAYER1`,`FIRST_ONLY`,`PLAY_ANIM` | |
| 5 | MOVE_STACK_NEXT_TO_TRIGGERER | `ID_STACK` | |
| 6 | GO_INTO_BATTLE | `ID_STACK`,`FIRST_ONLY` | |
| 7 | ENABLE_DISABLE_ANOTHER_EVENT | `ID_EVENT`,`ENABLE` | the chaining primitive |
| 8 | GIVE_SPELL | `TYPE_SPELL` | |
| 9 | GIVE_ITEM | `GIVETO`(0=triggerer,1=capital),`TYPE_ITEM` | |
| 10 | MOVE_STACK_TO_SPECIFIC_LOCATION | `ID_STKTEMP`,`ID_LOC`[,`BOOLVALUE`] | BOOLVALUE=move triggerer |
| 11 | ALLY_TWO_AI_PLAYERS | `ID_PLAYER1/2`,`PERMALLI` | |
| 12 | CHANGE_PLAYER_DIPLOMACY_METER | `ID_PLAYER1/2`,`DIPLOMACY`,`ENABLE` | ENABLE=alwaysAtWar; presets +«Always war» |
| 13 | UNFOG_OR_FOG_AN_AREA | `ID_LOC`, count + entries(`EVENT_ID`+`PLAYER`)[,`ENABLE`,`NUMVALUE`] | radius enum 0..24 = 1x1..49x49 ⚠ TQ vs game naming — resolve at impl |
| 14 | REMOVE_MOUNTAINS_AROUND_A_LOCATION | `ID_LOC` | |
| 15 | REMOVE_LANDMARK | `ID_LMARK`[,`BOOLVALUE`=playAnim] | |
| 16 | CHANGE_SCENARIO_OBJECTIVE_TEXT | `OBJECT_TXT` | |
| 17 | DISPLAY_POPUP_MESSAGE | `POPUP_TXT`,`MUSIC`,`SOUND`,`IMAGE`,`IMAGE2`,`LEFT_SIDE`,`POPUP_SHOW`("TRI"/"ALL"/"AFF")[,`BOOLVALUE`] | text supports `\fLarge;` markup |
| 18 | CHANGE_STACK_ORDER | `ID_STACK`,`ORDER_TARG`,`FIRST_ONLY`,`ORDER` | LOrderCategory |
| 19 | DESTROY_ITEM | `TYPE_ITEM`,`TRIG_ONLY` | |
| 20 | REMOVE_STACK | `ID_STACK`,`FIRST_ONLY` | |
| 21 | CHANGE_LANDMARK | `ID_LMARK`,`TYPE_LMARK` | swap decor look |
| 22 | CHANGE_TERRAIN | `ID_LOC`,`LOOKUP`(1=Empire..6=Elves),`NUMVALUE`=size | |
| 23 | MODIFY_VARIABLE | `LOOKUP`(0=Add,1=Sub,2=Mul,3=Div,4=Set),`NUMVALUE`,`NUMVALUE2`=varId | |

### Triggering semantics
- Order matters on 3 levels: event `ORDER`, condition list order, effect `NUM`.
- `ENABLED` + effect 7 = chains; `OCCUR_ONCE` (editor "infinite" = inverse); `CHANCE` 0-100%.
- TWO race bitsets: *applies-to* (HUMAN..ELF) vs *can-trigger* (VERHUMAN..VERELF).
- Engine tests conditions per (player, triggererStack): `ITestCondition::test(objectMap,
  playerId, eventId)`. "Triggerer" surfaces in effects 2/5/9/10/17/19.
- Editor-side validity check exists in-game (`CMidEventApi::checkValid`) — our validator tier
  should port it (refs must resolve: location/stack/city/item/variable ids).
- **Variables**: singleton `MidScenVariables` (code 0x18, `SV`): count + per-var
  `ID`:int,`NAME`:str,`VALUE`:int. **Stack templates**: `MidStackTemplate` (`TM..`, 79 in
  Riders) — spawn armies for effect 1/10.

---

## 2. Block gap table (Riders census vs our parser)

Modeled (14): landmark, road, location, terrain, stack, bag, crystal, ruin, sites×4,
village, capital, mountains, rod/tomb. Side-tables (4): MidItem, MidUnit, MidSubRace
(banner), MidPlayer (partial), MidgardMap(size), ScenarioInfo (6 of ~31 fields).

Remaining stubs (byte-preserved, invisible):

| block | count | what it is | effort |
|---|---|---|---|
| **MidEvent** | 746 | all scripting + win/lose | L (this doc) |
| **MidStackTemplate** | 79 | spawn templates | M (reader ≈ readStack); pairs with events |
| **MidScenVariables** | 1 | script variables | S; pairs with events |
| **MidDiplomacy** | 1 | N×{race1,race2,relation:int} triplets | S-M; alliance bits need RE |
| MidPlayer (full) | 3 | LORD_ID, BANK, ATTITUDE, FOG/KNOWN/BUILDS refs… | M scalars; add/remove player = L (addRace) |
| MidgardMapFog | 3/player | fog bitmap (mapSize/8 B per row) | M; needed for addRace |
| PlayerBuildings / PlayerKnownSpells | 3+3 | per-player lists | S each (+ Gbuild catalog) |
| MidQuestLog | 1 | quest lines grouping events | S-M; editor-side grouping (see §4) |
| MidStackDestroyed / TalismanCharges / SpellEffects / SpellCast / TurnSummary | 1 each | runtime state | skip/S |
| MidgardPlan | 1 | passability plan | delete-purge done; ADD-path entries TODO |

### ScenarioInfo fields we ignore today
BRIEFING + BRIEFLONG1-5, victory/defeat texts (DEBUNKW/W2-5/L), SUGG_LVL, MAP_SEED,
CUR_TURN, limits MAX_UNIT/MAX_SPELL/MAX_LEADER/MAX_CITY, PLAYER_1..13 (per-slot races,
must stay in sync with MidPlayer + the header `_playersData` blob), QTY_CITIES, CAMPAIGN.
Name/desc/author parsed but not editable. Multi-part strings use the `writeMultyStringPart`
'_' convention (see createBlankMap.ts).

### addRace (toolsqt D2MapEditor.cpp ~106-217) — "add a faction" transaction
D2Player + D2MapFog (capital-area reveal) + 5×5 race terrain stamp + PlayerBuildings +
PlayerSpells + D2Capital (3 items, guardian + hero) + hero D2Stack (INSIDE capital) +
`updateSubraces()` header blob + ScenarioInfo PLAYER_n. Effort L, all known patterns.

---

## 3. Qt editor feature surface still missing in the web port
Event editor (3-level: event → condition → effect dialogs, reorder/clone, 22+24 typed
forms, object pickers per ref type); events list panel (global + per-object, quest-line
move, clone, order); quest lines editor; variables editor; stack templates editor; event
template LIBRARIES (author/export/import, "apply template to right-clicked object" tool);
scenario settings dialog (texts + level caps); map statistics; loot generator; search tool;
clone-object tool; WFC map generator (we have MarkovJunior instead); encyclopedia.
Popup-message editor includes face picker (`Events-<Icon>` images), sound+music pickers.

---

## 4. Porting design (decided direction)

**Own model first, project on export** (same as the whole editor): `EditorProject` gains an
`events` model that is a SUPERSET of MidEvent:
- Typed zod schemas per condition/effect (tables above) — validation in the editor, not at
  export time; port `checkValid` semantics (all refs resolve) into tier-3 validateMap.
- Editor-only extras that DON'T exist in-game and get compiled away: human labels/notes,
  grouping into quest lines (projected to MidQuestLog ordering + ORDER fields), named
  "scenes" (popup + spawn + enable-chain authored as ONE card → compiled into 2-3 MidEvents
  with auto-generated ENABLE/variable plumbing), event templates with parameter slots
  (superset of the Qt template libraries).
- Export = compile events model → MidEvent/MidScenVariables/MidStackTemplate blocks through
  the existing growable writer (appendBlocks/replaceBlock/deleteBlocks) + 3-tier validation.

**Event overlay on the map** (visualization):
- Locations already render (#71). Add per-event drawing: trigger zones (conditions 2/14/16)
  highlighted; spawn markers (effect 1: template→location); movement ARROWS (effect 10:
  stack→location; effect 5: stack→triggerer); fog/terrain areas (13/22); battle/owner
  markers (4/6/20). Color by player, filter by event/quest-line, hover = event card.
- "Что будет и кто куда идёт": a step-through mode — pick an event (or day N), the overlay
  shows its condition zones + effect arrows; chains follow effect 7 links (graph).

**Suggested order of milestones**
1. **E1 read-only**: parse MidEvent + variables + templates → events panel (list, filter,
   per-object) + the overlay (zones/arrows). Immediately useful for understanding maps. (M)
2. **E2 edit core**: event CRUD + conditions/effects forms (typed pickers reuse our existing
   unit/item/spell/location pickers) + writer (append/replace/delete MidEvent). Start with
   the top-10 most used types (FREQUENCY/ENTER_ZONE/OWN_CITY/KILL_STACK + WIN/POPUP/
   CREATE_STACK/ENABLE_EVENT/MOVE_STACK/GIVE_ITEM). (L)
3. **E3 variables + stack templates** editors (S+M) — unlocks the rest of the types.
4. **E4 scenario setup**: ScenarioInfo texts/limits editor (S-M), diplomacy matrix (S-M),
   full MidPlayer editing (M), addRace transaction (L).
5. **E5 sugar**: scenes/templates compiler, quest-line grouping, step-through simulation.
