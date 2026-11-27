# @d2/mod-diff

Turns the data of two mods (A, usually the parent, and B) into a difference a modder
recognises: which units, attacks, items, spells, buildings, lords, races, modifiers,
landmarks, leader upgrades, dynamic upgrades, texts and rules changed, and how; what a race
gained or lost; which terrain art changed; which pictures and scripts differ; and every raw
table op behind it.

Pure TypeScript with no Node imports: it runs in the browser. The output is plain JSON-safe
data, so a page can compute it once (about 1–2 s for two full mods) and keep it in a store.

```ts
import { diffMods, diffLines } from "@d2/mod-diff";

const d = diffMods(modA, modB); // ModDiff
d.summary.sections.units;        // { added, changed, removed, artOnly, viaShared, orphans, total }
d.sections.units;                // EntityChange[]
d.races;                         // RaceChange[]
```

Everything below describes `ModDiff` field by field. The examples are from one small diff:
A and B are the same except that in B unit "Squire" has more hit points and other Gimmu rows,
the attack "Strike" both units use is stronger, the text "Archer" reads "Bowman", the race's
guardian is the other unit, a modifier's effect changed, a capital layer was added, some
pictures and a script changed. Long arrays are cut with `…`.

## Inputs

```ts
interface ModData {
  id: string;
  name: string;
  tables: ReadonlyMap<string, DbfTable> | Record<string, DbfTable>;
  capitalDat?: string;
  manifest?: SpriteManifest;
  files?: Record<string, string>;
}
```

| field | what |
|---|---|
| `id`, `name` | Copied to `ModDiff.a` / `ModDiff.b`. |
| `tables` | Table name → `DbfTable` (`@d2/dbf`): every Globals table plus TApp/TAppEdit. Names are matched ignoring case. Node: `tableFiles(root)` + `readTable(path, name)` from `@d2/mod-edit/node`. Browser: `DbfTable.read(bytes, name)`. |
| `capitalDat` | Text of `Imgs/capital.dat` (ASCII; read it as latin1). Optional: without it races have `capital: null`. |
| `manifest` | The mod's sprite manifest (`packages/asset-manifest` 0.2): `spritesheets[]` (`id`, `ff`, `image` = store path `blobs/<xx>/<sha256>.png`, `size`), `frames` (name → `[sheetIndex, x, y, w, h, trimX, trimY, sourceW, sourceH]`), `animations[]` (`id`, `atlas`, `frames`). Optional: without it no frame or animation is compared. |
| `files` | The `files` map of the store's `mods/<id>/mod.json`: logical name → store path `blobs/<xx>/<sha256>.<ext>` (a bare sha256 works too). Icons (`uniticons/`, `itemicons/`, `spellicons/`, `lordicons/`, any `*icons/` folder) and `modscripts/*` are compared by hash. Optional. |

`diffMods(a, b, { redesignThreshold, texts })`:

- `redesignThreshold`: a race whose redesign score reaches it (default 0.5) is flagged
  `redesigned`.
- `texts`: whether the wording of the texts is compared.
  - `"compare"` (the default): a text worded differently is a change like any other.
  - `"skip"`: it is not. A text cell of a text table (Tglobal, TApp, TAppEdit, Tleader,
    TAiMsg, Tplayer) that both mods have and that reads differently is no op, only counted
    in `TableChange.translations`, and no entity shows it under `texts`. A text only one mod
    has is still added or deleted. A list keyed by the whole row (Tleader, TAiMsg) is not
    compared at all: there a reworded row is a delete and an add, and every op is counted.
  - `"auto"`: `"skip"` when the two mods' Tglobal is written in different scripts
    (`ModDiff.texts`), else `"compare"`. For the GOG game, which is in English, and a
    Russian mod: one is a translation of the other, and a diff of every text hides the real
    changes.

## Words used here

- **A / B** — the two mods; `a…` fields are A's side, `b…` B's. "Added" means only B has it.
- **Entity** — a thing a modder names: a unit, an attack, a text, … Its **root row** is its
  row in its own table (a unit's Gunits row). Its id is the root row's id, upper-cased
  (`"G000UU0001"`); a leader upgrade's id is `"<BELONGS_TO>:<MODIF_ID>"`, an AI row's
  `"<table>#<CATEGORY>"` (`"GAI_normal#3"`), GVars' `"GVars"`.
- **Owned rows** — rows of other tables that belong to an entity through an owner column
  (a unit's Gimmu rows). Column-keyed ones are `owned` (`RowChange`); whole-row lists
  (GmodifL, GUmodif, Tleader, TAiMsg) are `lists` (`ListChange`).
- **Shared row** — an entity many others use through a link column (an attack, a dynamic
  upgrade, a modifier, a spell of an item). Its change is shown under each user as `shared`.
- **Op** — one `dbf.set` / `dbf.add` / `dbf.delete` of `@d2/mod-edit`'s `diffTable`: what an
  edit journal would need to turn A's table into B's. Every op of a covered table goes to at
  least one entity (`summary.unassignedOps` is 0).
- **Values** — cells as read: C text without trailing spaces, N a number or `null`, L a
  boolean. Ids keep the case the file has (`"x000tg0001"`); entity ids are upper case.
- **Display text** (`aText`, `bText`, `rowTextA`, `name`) — what a link cell shows: the
  linked entity's name, the L* table's TEXT (`"L_HUMAN"`), or the text with its leading style
  tag (`\fNormal;`) removed.
- **Picture identity** — a frame is the same picture when its sheet's blob (sha256) and its
  rectangle are the same. The sheet index is never compared (it shifts between builds).

## ModDiff

| field | type | what |
|---|---|---|
| `version` | `1` | Format version. |
| `a`, `b` | `{ id, name }` | The two mods. |
| `tables` | `TableChange[]` | Every table either mod has, by name; filter on `ops.length` for the ones that differ. |
| `sections` | `Record<SectionId, EntityChange[]>` | Changed entities by section, sorted by id. Keys, in display order: `units`, `attacks`, `items`, `spells`, `buildings`, `lords`, `races`, `modifiers`, `landmarks`, `leaderUpgrades`, `dynamicUpgrades`, `texts`, `rules` (also exported as `SECTIONS`). |
| `races` | `RaceChange[]` | Every Grace race of either mod, changed or not. |
| `capitalOther` | `CapitalSectionChange[]` | capital.dat sections no race matches. |
| `terrain` | `TerrainChange[]` | Every terrain code (Lterrain rows plus water `WA`). |
| `terrainOther` | `PictureChange[]` | IsoTerrn.ff pictures of no terrain code (roads, fog, ...). |
| `pictures` | `PictureDiff` | Every frame, animation and icon change, with counts. |
| `scripts` | `ScriptChange[]` | `modscripts/*` files that differ. |
| `texts` | `{ a, b, skipped }` | The script each mod's Tglobal is mostly written in, `"cyrillic"`, `"latin"` or `null` (no text); `skipped`: the wording was not compared (the `texts` option). |
| `summary` | `DiffSummary` | Counts for a front page. |

## tables: TableChange

```json
{
  "name": "Gimmu", "presence": "both", "coverage": "entities",
  "rowsA": 2, "rowsB": 3,
  "key": { "kind": "columns", "columns": ["UNIT_ID", "IMMUNITY"] },
  "keyColumns": ["UNIT_ID", "IMMUNITY"],
  "counts": { "set": 1, "add": 1, "delete": 0 },
  "schema": { "added": [], "removed": [], "changed": [] },
  "ops": [
    { "op": "dbf.set", "key": ["G000UU0001", 1], "keyText": "[\"G000UU0001\",1]", "field": "IMMUNECAT",
      "was": 2, "value": 3, "owners": [{ "section": "units", "id": "G000UU0001" }] },
    { "op": "dbf.add", "key": ["G000UU0001", 5], "keyText": "[\"G000UU0001\",5]",
      "values": { "UNIT_ID": "G000UU0001", "IMMUNITY": 5, "IMMUNECAT": 2 },
      "owners": [{ "section": "units", "id": "G000UU0001" }] }
  ],
  "skipped": [], "unassigned": 0, "noIdSpellings": 0, "translations": 0
}
```

| field | what |
|---|---|
| `name` | Table name as A spells it (B's for a table only B has). |
| `presence` | `"both"`, `"onlyA"`, `"onlyB"`. A table only one mod has is not compared row by row: it has no ops, and its rows give no entities. |
| `coverage` | `"entities"`: its ops are given to entities (or terrain codes). `"table"`: no entity covers it (L* tables, Gunits_2, unknown tables); show its ops in a raw table view. |
| `rowsA`, `rowsB` | Live rows (deleted rows do not count); `null` for the side without the table. |
| `key` | How rows are named: `{kind:"columns", columns}`, `{kind:"row"}` (the whole row: lists), `{kind:"only"}` (GVars' one row). The registered key of `@d2/mod-edit` (`TABLE_KEYS_V1`), else the declared one. |
| `keyColumns` | The columns the key reads, upper case (every column for `row`). |
| `counts` | Ops by kind. |
| `schema` | Column differences (`@d2/dbf` `SchemaDiff`): `added` (only B has), `removed` (only A has), `changed` (`{name, from, to}` with another type, width or decimals). Each column is `{name, type, length, decimals}`. |
| `ops` | `TableOp[]`, below. `OpRef.index`, `RowChange.ops` and `ListChange.ops` point into this array. |
| `skipped` | Values `diffTable` could not carry: `{key, keyText, field, reason, a?, b?}` (a value too wide for A's column, a key cell that differs only in case). Those on an entity's row also appear in its `fields` as `uncarried: true`. |
| `projected?` | A whole-row table whose columns differ (one mod has GUmodif.MODIF_7) is compared over the columns both have; this lists them. |
| `error?` | `diffTable` refused the table even after the fallbacks; it has no ops. (None on the four known mods.) |
| `unassigned` | Ops of an `"entities"` table no entity took; always 0 unless the entity map misses a case. |
| `noIdSpellings` | Cells that differ only in how they write "no id": empty in one mod, `G000000000` (any case) in the other (`sameEmptyId`). Both name nothing, so they are not ops: such a set is dropped, and so is a deleted row with an added row that reads the same but for such cells (a whole-row key). Сёмга → Сёмга 2 has 9: `GItem.MOD_POTION` of the healing potions. |
| `translations` | Text cells worded differently that were not compared (the `texts` option); 0 when texts are compared. |
| `note?` | How the table was compared when not the plain way, or a remark (Gunits_2: "a copy of Gunits ..."). |

### TableOp

| op | fields |
|---|---|
| `dbf.set` | `key`, `keyText`, `field` (upper case), `was` (A's value), `value` (B's value), `wasText?` / `valueText?` (display texts of a link column), `owners` |
| `dbf.add` | `key`, `keyText`, `values` (B's whole row, columns A lacks included), `owners` |
| `dbf.delete` | `key`, `keyText`, `was` (A's whole row), `owners` |

`key` is the row key (`RowKey`, the key cells, ids upper case); `keyText` is the same as one
string, the identity to group or look rows up by. `owners` are `{section, id}` of the
entities the op was given to (`section: "terrain"` names a terrain code for GTileDBI); empty
for a `"table"` table. A GbuiList op has two owners (the lord and the building).

A changed row of a whole-row table (GmodifL) is a `dbf.delete` of the old row plus a
`dbf.add` of the new one: such rows have no identity apart from their cells.

## sections: EntityChange

```json
{
  "uid": "units:Gunits:G000UU0001",
  "section": "units", "table": "Gunits", "id": "G000UU0001",
  "nameA": "Squire", "nameB": "Squire",
  "status": "changed",
  "fields": [{ "table": "Gunits", "field": "HIT_POINT", "a": 100, "b": 120 }],
  "newColumns": [],
  "owned": [
    { "table": "Gimmu", "key": ["G000UU0001", 1], "keyText": "[\"G000UU0001\",1]", "change": "changed",
      "fields": [{ "table": "Gimmu", "field": "IMMUNECAT", "a": 2, "b": 3 }], "ops": [0],
      "rowA": { "UNIT_ID": "G000UU0001", "IMMUNITY": 1, "IMMUNECAT": 2 },
      "rowB": { "UNIT_ID": "G000UU0001", "IMMUNITY": 1, "IMMUNECAT": 3 } },
    { "table": "Gimmu", "key": ["G000UU0001", 5], "keyText": "[\"G000UU0001\",5]", "change": "added",
      "fields": [], "ops": [1], "rowB": { "UNIT_ID": "G000UU0001", "IMMUNITY": 5, "IMMUNECAT": 2 } }
  ],
  "lists": [], "texts": [], "scripts": [], "children": [],
  "shared": [{ "via": "Gunits.ATTACK_ID", "section": "attacks", "id": "G000AA0001", "name": "Strike", "status": "changed" }],
  "pictures": [],
  "usedBy": [
    { "via": "Grace.GUARDIAN", "section": "races", "id": "G000RR0000", "name": "Empire", "side": "a" },
    { "via": "Grace.SOLDIER_1", "section": "races", "id": "G000RR0000", "name": "Empire", "side": "both" }
  ],
  "group": { "race": "G000RR0000", "level": 1 },
  "groupText": { "race": "Empire" },
  "ops": [{ "table": "Gimmu", "index": 0 }, { "table": "Gimmu", "index": 1 }, { "table": "Gunits", "index": 0 }],
  "rowA": { "UNIT_ID": "G000UU0001", "RACE_ID": "G000RR0000", "NAME_TXT": "X000TG0001", "LEVEL": 1, "HIT_POINT": 100, "ATTACK_ID": "G000AA0001", "ATTACK2_ID": "G000000000" },
  "rowTextA": { "RACE_ID": "Empire", "NAME_TXT": "Squire", "ATTACK_ID": "Strike" },
  "rowB": { "…": "…" },
  "rowTextB": { "…": "…" }
}
```

| field | what |
|---|---|
| `uid` | `"<section>:<table>:<id>"`, unique over the whole diff (a race id is in Grace and a subrace id in GSubRace; a text id may sit in Tglobal and TApp). Use it as the list key. |
| `section` | The section it is listed under. |
| `table` | Its root table (`"Gunits"`, `"GSubRace"`, `"TApp"`, `"GAI_normal"`). |
| `id` | Upper-case id (see Words). |
| `nameA`, `nameB` | Its name in A / in B (`null` on the side without it, or when it has none). Names come from the name column's text (`NAME_TXT`, Gmodif `DESC_TXT`, a modifier with none takes its first GmodifL effect's `DESC` text); a text's name is the text itself. Show `nameB ?? nameA`, and both when they differ. |
| `status` | See Statuses. |
| `orphan?` | `true`: its root row is in neither mod; it exists only because owned rows name it (Gimmu rows of a unit no Gunits row has). |
| `fields` | `FieldChange[]`: cells of its root row that differ (the `dbf.set` ops of the root row, plus `uncarried` values). Empty for added / removed entities: show `rowA` / `rowB` instead. |
| `newColumns` | `FieldChange[]`: non-blank values of columns only one mod's table has (B's new Gunits columns). Not ops, and they do not change the status. |
| `owned` | `RowChange[]`: its rows in column-keyed owned tables that differ. |
| `lists` | `ListChange[]`: its lists in whole-row tables that differ. |
| `texts` | `TextChange[]`: texts it names (in both mods, under the same id) whose wording changed. |
| `scripts` | `ScriptRef[]`: for a modifier, its Lua file (Gmodif.SCRIPT) when that differs. |
| `children` | `LinkedChange[]`: for a lord, its leader upgrades (GleaUpg) that changed. |
| `shared` | `LinkedChange[]`: shared rows it uses (in either mod) that were added, removed or changed. |
| `pictures` | `PictureChange[]`: its frames, animations and icons (names starting with its id: `G000UU0019STOP0`, `uniticons/G000UU0019.png`), and for a building its capital.dat layers and their Capital.ff pictures. |
| `usedBy` | `UsedBy[]`: everything that links to it, in A, B or both. |
| `group` | Values to group or filter a list by; keys by section below. Id values are upper case; `buildings.group.races` is an array of race ids. |
| `groupText` | Display texts of the `group` values that are links (`race: "Empire"`, `category: "L_SOLDIER"`). |
| `ops` | `OpRef[]` `{table, index}`: every op given to it, `tables.find(t => t.name === table).ops[index]`. |
| `rowA`, `rowB` | Its root row in A / B (absent on the side without it). Field names upper case. |
| `rowTextA`, `rowTextB` | Display texts of the link cells of `rowA` / `rowB` that show something. |

### Statuses

| status | when |
|---|---|
| `added` | Only B has its root row. |
| `removed` | Only A has its root row. |
| `changed` | Both have it, and something of its own differs: a cell of its root row, its owned rows or lists, an uncarried value, the wording of a text it names, its script, a leader upgrade of a lord. Also an `art-only` entity that has `shared` changes. |
| `art-only` | Only its pictures differ (`pictures` non-empty, nothing else of its own). |
| `via-shared` | Nothing of its own differs, but a shared row it uses changed (`shared` non-empty). |

An entity not in any of these is not listed. A shared change goes one level only: a unit
shows its attack's change; the attack's own alt attack shows under the attack, not under
the unit. Only own changes (`added`, `removed`, `changed`) travel; `art-only` and
`via-shared` ones do not.

### FieldChange

`{ table, field, a, b, aText?, bText?, uncarried? }`

```json
{ "table": "Grace", "field": "GUARDIAN", "a": "G000UU0001", "b": "G000UU0002", "aText": "Squire", "bText": "Bowman" }
```

`a` / `b` are A's and B's values (`null` when blank or when that side has no such column).
`aText` / `bText` are the display texts when the column is a link. `uncarried: true` marks a
value that is not a table op (see `TableChange.skipped`).

### RowChange (owned rows, terrain tiles)

`{ table, key, keyText, change, fields, rowA?, rowB?, ops }` — one row of an owned
column-keyed table (Gimmu, GimmuC, GLabi, GMabi, Gtransf, GbuiList, GspellR, GcityInf,
Tplayer) or of GTileDBI. `change` is `added` (only `rowB`), `removed` (only `rowA`) or
`changed` (`fields` lists the cells). `ops` are indexes into `tables[table].ops`. Example:
under `owned` above.

### ListChange (whole-row lists)

`{ table, ownerColumn, owner, a, b, removed, added, ops }` — an entity's list in GmodifL
(a modifier's effects), GUmodif (a unit's modifiers), Tleader, TAiMsg. `a` and `b` are the
whole list on each side in file order; `removed` / `added` are the rows only A / only B has.
Show `a` and `b` side by side, marking `removed` and `added`.

```json
{
  "table": "GmodifL", "ownerColumn": "BELONGS_TO", "owner": "G000UM0001",
  "a": [{ "BELONGS_TO": "G000UM0001", "TYPE": 1, "PERCENT": 10, "DESC": "X000TG0007" },
        { "BELONGS_TO": "G000UM0001", "TYPE": 2, "PERCENT": 5, "DESC": "" }],
  "b": [{ "BELONGS_TO": "G000UM0001", "TYPE": 1, "PERCENT": 10, "DESC": "X000TG0007" },
        { "BELONGS_TO": "G000UM0001", "TYPE": 2, "PERCENT": 15, "DESC": "" }],
  "removed": [{ "BELONGS_TO": "G000UM0001", "TYPE": 2, "PERCENT": 5, "DESC": "" }],
  "added": [{ "BELONGS_TO": "G000UM0001", "TYPE": 2, "PERCENT": 15, "DESC": "" }],
  "ops": [0, 1]
}
```

### TextChange

`{ via, id, a, b }` — `via` is the column that names the text (`"Gunits.NAME_TXT"`), `id`
the text id, `a` / `b` the text in A / B (style tag removed). A changed text is listed under
every entity that names it in both mods, and once in `sections.texts` (with all of them in
its `usedBy`).

```json
{ "via": "Gunits.NAME_TXT", "id": "X000TG0002", "a": "Archer", "b": "Bowman" }
```

### LinkedChange (shared, children)

`{ via, section, id, name, status }` — the linked entity and its status; `via` is the link
column (`"Gunits.ATTACK_ID"`, `"GUmodif.MODIF_1"`, `"GleaUpg.BELONGS_TO"`). The entity
itself is in `sections[section]` with the same `id`.

### UsedBy

`{ via, section, id, name, side }` — one link to the entity: from entity `section`/`id`
through column `via`, present in A (`"a"`), B (`"b"`) or both. `section: null` means a row
no entity covers (an L* table row); `id` is then a label like `"LAttR#5"`.

### ScriptRef

`{ path, change }` — the script's logical name and how it changed; details in `scripts`.

### PictureChange

```json
{
  "kind": "frame", "name": "G000UU0002STOP0", "archive": "IsoUnit.ff", "change": "changed",
  "a": { "image": "blobs/11/1111…1111.png", "sha256": "1111…1111", "sheet": "IsoUnit-0",
         "rect": [0, 0, 10, 10, 0, 0, 10, 10], "sheetSize": [512, 512] },
  "b": { "image": "blobs/33/3333…3333.png", "sha256": "3333…3333", "sheet": "IsoUnit-1",
         "rect": [0, 0, 10, 10, 0, 0, 10, 10], "sheetSize": [256, 256] }
}
```

| field | what |
|---|---|
| `kind` | `frame` (a manifest frame), `animation` (a manifest animation), `icon` (a file of an `*icons/` folder), `capital-layer` (a capital.dat layer). |
| `name` | Frame or animation name, the icon's logical file name (`"uniticons/G000UU0002.png"`), or `"<SECTION>/LAYER_<z>"` for a layer. |
| `archive` | The sheet's archive (`"IsoUnit.ff"`), the icon folder (`"uniticons"`), `"capital.dat"`; `null` when the sheet names none. |
| `change` | `added`, `removed`, `changed`. |
| `a`, `b` | `PictureSide` of each side that has it. |

`PictureSide` fields, each present when known:

| field | what |
|---|---|
| `image` | The sheet image (frames) or the file (icons): a store path, load it from the store. |
| `sha256` | Its blob hash. |
| `sheet` | Sheet id. |
| `rect` | `[x, y, w, h, trimX, trimY, sourceW, sourceH]` of the frame on the sheet: crop `x, y, w, h` from `image`, draw it at `trimX, trimY` in a `sourceW × sourceH` box. |
| `sheetSize` | `[w, h]` of the sheet. |
| `frames` | Animations: the frame names, in order (look each up in `pictures.changes` or the manifest). |
| `layer` | Capital layers: the `CapitalLayer`. |

A frame counts as changed when its blob or rectangle differs; the pixels may still be equal
when a mod only rebuilt the sheet. An animation is changed when any of its frames is, or the
frame list differs.

### Sections: where entities come from

| section | root table, id column | name | owned rows / lists | `group` keys |
|---|---|---|---|---|
| `units` | Gunits `UNIT_ID` | `NAME_TXT` | Gimmu, GimmuC, GLabi, GMabi (`owned`); GUmodif (`lists`) | `race`, `subrace`, `level`, `category`, `branch`, `leaderCategory`, `small` |
| `attacks` | Gattacks `ATT_ID` | `NAME_TXT` | Gtransf (`owned`, by ATTACK_ID) | `source`, `class`, `reach` |
| `items` | GItem `ITEM_ID` | `NAME_TXT` | — | `category` |
| `spells` | Gspells `SPELL_ID` | `NAME_TXT` | GspellR (`owned`, by SPELL_ID) | `category`, `level` |
| `buildings` | Gbuild `BUILD_ID` | `NAME_TXT` | GbuiList (`owned`, by BUILD_ID) | `category`, `branch`, `level`, `races` (ids of the races whose lords' GbuiList has it) |
| `lords` | Glord `LORD_ID` | `NAME_TXT` | GbuiList, GspellR (`owned`, by LORD_ID); leader upgrades as `children` | `race`, `category` |
| `races` | Grace `RACE_ID` and GSubRace `RACE_ID` | `NAME_TXT` | GcityInf, Tplayer (`owned`); Tleader, TAiMsg (`lists`) | Grace: `raceType`, `playable`, `kind: "race"`; GSubRace: `subraceType`, `kind: "subrace"` |
| `modifiers` | Gmodif `MODIF_ID` | `DESC_TXT`, else the first effect's `DESC` | GmodifL (`lists`, by BELONGS_TO); its script as `scripts` | `source` |
| `landmarks` | GLmark `LMARK_ID` | `NAME_TXT` | — | `category`, `mountain` |
| `leaderUpgrades` | GleaUpg `BELONGS_TO` + `MODIF_ID` | `NAME_TXT` | — | `lord`, `minLevel`, `modifier`, `race` (the lord's) |
| `dynamicUpgrades` | GDynUpgr `UPGRADE_ID` | — | — | — |
| `texts` | Tglobal, TApp, TAppEdit `TXT_ID` | the text | — | `table`, `kind` (the id's two-letter code: `TG`, `TA`) |
| `rules` | GVars (one row, id `GVars`), every GAI* table (id `<table>#<CATEGORY>`), Gaction `ACTION_ID` | `NAME_TXT` | — | `kind` (`vars`, `ai`, `thief-action`), `table`; AI: `aiCategory`; Gaction: `category` |

Shared links (a change of the target shows under the row's owner in `shared`):
Gunits `ATTACK_ID`, `ATTACK2_ID`, `DYN_UPG1`, `DYN_UPG2`; Gattacks `ALT_ATTACK`, `WARD<n>`;
GItem `MOD_EQUIP`, `MOD_POTION`, `SPELL_ID`, `ATTACK_ID`; Gspells `MODIF_ID`, `WARD<n>`;
GleaUpg `MODIF_ID`; Grace `PROTECTION`; GcityInf `PROTECTION`; GUmodif `MODIF_<n>`.

Ids are classified by their two-letter type code (`classifyId`): UU unit, AA attack, IG item,
SS spell, BB building, MG landmark, UM modifier, LR lord, RR race, BR subrace, DU dynamic
upgrade, NA thief action, TG / TA text.

## races: RaceChange

```json
{
  "id": "G000RR0000", "nameA": "Empire", "nameB": "Empire", "presence": "both", "status": "changed",
  "raceType": 0, "lrace": "L_HUMAN", "capitalSection": "HUMAN", "code": "HU",
  "slots": [
    { "slot": "GUARDIAN", "a": "G000UU0001", "b": "G000UU0002", "changed": true, "aText": "Squire", "bText": "Bowman" },
    { "slot": "NOBLE", "a": null, "b": null, "changed": false },
    "…"
  ],
  "units": { "countA": 2, "countB": 2, "added": [], "removed": [],
             "changed": [{ "section": "units", "id": "G000UU0001", "name": "Squire", "status": "changed" }, "…"] },
  "buildings": { "countA": 0, "countB": 0, "added": [], "removed": [], "changed": [] },
  "lords": { "countA": 0, "countB": 0, "added": [], "removed": [], "changed": [] },
  "owned": [], "lists": [],
  "capital": {
    "name": "HUMAN", "presence": "both", "layersA": 2, "layersB": 3,
    "layers": [{ "key": "G000BB0001|TEMPLE1A", "build": "G000BB0001", "picture": "TEMPLE1A", "change": "added",
                 "b": { "z": "110", "build": "G000BB0001", "picture": "TEMPLE1A", "values": ["5", "5", "20", "20"], "rect": [5, 5, 20, 20] } }],
    "buildings": [{ "build": "G000BB0001", "nameA": "Temple", "nameB": "Temple", "added": 1, "removed": 0, "changed": 0, "layers": ["…"] }],
    "infoAdded": [], "infoRemoved": []
  },
  "pictures": [],
  "redesign": { "score": 0.106, "redesigned": false, "parts": { "units": 0, "buildings": 0, "capital": 0.5, "slots": 0.059 } }
}
```

| field | what |
|---|---|
| `id`, `nameA`, `nameB`, `presence` | The Grace row, its name on each side, and which mods have it (`both`, `onlyA`, `onlyB`). |
| `status` | Its entity's status in `sections.races` (Grace row, GcityInf, Tplayer, Tleader, TAiMsg, texts), or `null` when its own rows did not change. A race can still have changed members or capital with `status: null`. |
| `raceType` | Grace `RACE_TYPE`. |
| `lrace` | Lrace TEXT of that type (`"L_DWARF"`). |
| `capitalSection` | The capital.dat section the race reads: `lrace` without `L_` (`"DWARF"`). |
| `code` | The two-letter code (`"DW"`) when Lterrain has it; it ties the race to its terrain and its code-named pictures. |
| `slots` | `SlotChange[]` for GUARDIAN, NOBLE, LEADER_1..4, SOLDIER_1..n (n = 7 or what either side has), SCOUT, REGEN_H, INCOME, PROTECTION, in that order: `{slot, a, b, aText?, bText?, changed}`. |
| `units` | `RaceMembers` of Gunits rows with this RACE_ID. |
| `buildings` | `RaceMembers` of the buildings in the GbuiList of the race's lords. |
| `lords` | `RaceMembers` of Glord rows with this RACE_ID. |
| `owned`, `lists` | The race entity's `owned` and `lists` (GcityInf, Tplayer / Tleader, TAiMsg). |
| `capital` | `CapitalSectionChange` of `capitalSection`, or `null` (no capital.dat, or no such section). |
| `pictures` | Pictures of the race: its own (names starting with its id) and those named by its code (`G000FT0000<code>…` capital and city frames, `LORD<code>`, `CAP<code>`, `CITY<code>`, `UPGRADE<code>`, `FACE_<code>_`), plus Capital.ff pictures its capital.dat section draws. |
| `redesign` | `{ score, redesigned, parts }`, below. |

`RaceMembers`: `{ countA, countB, added, removed, changed, copies }`. `added` / `removed` are
`EntityRef` (`{section, id, name}`) of members only B / only A has; `changed` are members both
have whose entity is in the diff, with its `status`. `copies` are the members of `added` that
are not new content: a unit whose `uniticons/<id>.png` has the same bytes as the picture of a
unit of A (`of`) — what a mod that only renumbers its units leaves behind. Empty for
buildings and lords (the store has no pictures of their own to compare).

**Redesign score** (0..1): how much of the race in B is new. What B cut is not new content:
it is in `removed` and does not raise the score.

| part | value |
|---|---|
| `units` | `(added − copies) / countB` of `units` |
| `buildings` | the same of `buildings` |
| `capital` | added or changed layers / `layersB` |
| `slots` | changed slots / all slots |

`score = 0.35·units + 0.35·buildings + 0.2·capital + 0.1·slots`, rounded to 3 decimals;
`redesigned = score >= redesignThreshold` (0.5). From semga to nazar-legacy the scores are
Empire 0.07, Clans 0.69, Legions 0.695, Undead 0.702, Neutrals 0.096, Elves 0.099: the
three races Nazar rebuilt are flagged. Checked by hand on Clans: of Nazar's 111 Clans units,
34 are Сёмга's (same ids, same pictures) and 77 are new; 75 of those 77 have pictures no unit
of Сёмга has, even compared pixel by pixel (2 reuse a Сёмга picture and are `copies`).

### CapitalSectionChange

| field | what |
|---|---|
| `name` | Section name (`"HUMAN"`). |
| `presence` | `both`, `onlyA`, `onlyB`. |
| `layersA`, `layersB` | Number of `LAYER_` lines on each side. |
| `layers` | `CapitalLayerChange[]`: `{key, build, picture, change, a?, b?}`. A layer is identified by its building and picture (`key` `"<build>|<PICTURE>"`, a second layer of the same pair `"…#2"`); it is `changed` when its depth or values differ. `build` is `null` for layers no building owns (backgrounds, animations). |
| `buildings` | The layer changes grouped by building: `{build, nameA, nameB, added, removed, changed, layers}`; `build: ""` holds the layers of no building. |
| `infoAdded`, `infoRemoved` | Buildings the `LAYERINFO_` list names only in B / only in A. |

`CapitalLayer`: `{ z, build, picture, values, rect }` — `z` the depth as written after
`LAYER_` (`"110"`), `build` the building id or `null`, `picture` the Capital.ff picture
(upper case), `values` every value after the picture, `rect` the last four numbers
`[x0, y0, x1, y1]` (`-1` = none) or `null`.

## terrain: TerrainChange

```json
{
  "code": "HU", "id": 1, "name": "L_HU",
  "pictures": {
    "forests": [{ "kind": "frame", "name": "HUF0002", "archive": "IsoTerrn.ff", "change": "added", "b": { "…": "…" } }],
    "mountains": [], "ground": [], "borders": []
  },
  "counts": { "forestsA": 1, "forestsB": 2, "mountainsA": 0, "mountainsB": 0 },
  "tiles": [{ "table": "GTileDBI", "key": ["HU", "PL", 0], "keyText": "[\"HU\",\"PL\",0]", "change": "changed",
              "fields": [{ "table": "GTileDBI", "field": "QTY", "a": 4, "b": 6 }], "ops": [0], "rowA": { "…": "…" }, "rowB": { "…": "…" } }]
}
```

The game has six terrains and water; a mod's "new terrain" is new art for one of them.

| field | what |
|---|---|
| `code` | `HU`, `UN`, `HE`, `DW`, `NE`, `EL`, … from Lterrain TEXT (`L_HU`), plus `WA` (water). |
| `id`, `name` | The Lterrain ID and TEXT (`null` for water). |
| `pictures` | Picture changes of the code by kind: `forests` (`<code>F####`), `mountains` (`MOM<code>…`), `ground` (`<code>_nn`, the store's composed tiles `T<terrainId>_…`, water `TW_…`), `borders` (`<code>_xx_yy`, composed `E_<terrainId>_…`, water `WF_…`). |
| `counts` | Forest and mountain frames of the code in each mod's manifest. |
| `tiles` | `RowChange[]` of GTileDBI rows of the code. |

`terrainOther` lists IsoTerrn.ff picture changes that match no code.

## pictures: PictureDiff

| field | what |
|---|---|
| `frames`, `animations`, `icons` | `Counts` `{same, added, removed, changed}`. |
| `byArchive` | Archive (or icon folder) → `{added, removed, changed}`; key `""` for none. |
| `changes` | Every `PictureChange` of frames, animations and icons, by archive, kind, name. Capital layers are not here (they are in `races[].capital` and on buildings). |

## scripts: ScriptChange

```json
{
  "path": "modscripts/drawing/x.lua", "change": "changed",
  "a": "6666…6666", "b": "7777…7777",
  "modifiers": [{ "section": "modifiers", "id": "G000UM0002", "name": "Mod two" }]
}
```

`path` is the logical file name, `a` / `b` the sha256 of each side, `modifiers` the
modifiers whose Gmodif.SCRIPT names the file (`SCRIPT` is relative to `modscripts/`). To show
the text, load each mod's `files[path]` from the store and call `diffLines`.

### diffLines(a, b, context = 3): LineHunk[]

A line diff (Myers, linear memory) in hunks with `context` unchanged lines around each change.
Equal texts give `[]`; `context = Infinity` gives one hunk with every line.

```json
diffLines("a\nb\nc\n", "a\nB\nc\nd\n", 1) =
[{ "aStart": 1, "aCount": 3, "bStart": 1, "bCount": 4,
   "lines": [{ "kind": "same", "text": "a", "a": 1, "b": 1 },
             { "kind": "removed", "text": "b", "a": 2 },
             { "kind": "added", "text": "B", "b": 2 },
             { "kind": "same", "text": "c", "a": 3, "b": 3 },
             { "kind": "added", "text": "d", "b": 4 }] }]
```

`LineHunk`: `aStart` / `bStart` are 1-based first lines (with no lines of a side, the line the
hunk comes before), `aCount` / `bCount` the lines of each side, `lines` the `DiffLine`s
`{kind: "same" | "removed" | "added", text, a?, b?}` with their 1-based line numbers.
`lineEdits(a, b)` gives every line without hunks; `splitLines(text)` splits on any line break.

## summary: DiffSummary

```json
{
  "sections": { "units": { "added": 0, "changed": 2, "removed": 0, "artOnly": 0, "viaShared": 0, "orphans": 0, "total": 2 }, "…": "…" },
  "tables": { "compared": 13, "differ": 8, "onlyA": [], "onlyB": [], "ops": 10, "set": 7, "add": 2, "delete": 1, "skipped": 0, "refused": [], "noIdSpellings": 0, "translations": 0 },
  "assignedOps": 9, "tableOnlyOps": 1, "unassignedOps": 0,
  "pictures": { "frames": { "same": 0, "added": 1, "removed": 0, "changed": 2 }, "animations": { "…": "…" }, "icons": { "…": "…" } },
  "scripts": { "added": 1, "changed": 1, "removed": 0 },
  "races": { "changed": ["G000RR0000"], "redesigned": [] },
  "terrain": { "changed": ["HU"] }
}
```

| field | what |
|---|---|
| `sections` | `SectionCounts` per section: entities by status, `orphans`, `total` (the length of `sections[s]`). |
| `tables.compared` | Tables both mods have. |
| `tables.differ` | Tables with at least one op. |
| `tables.onlyA`, `tables.onlyB` | Names of tables only one mod has. |
| `tables.ops`, `set`, `add`, `delete` | Op totals. |
| `tables.skipped` | Total `skipped` values. |
| `tables.refused` | Tables with an `error`. |
| `tables.noIdSpellings` | Total `noIdSpellings` cells (not ops). |
| `tables.translations` | Total `translations` cells (not ops). |
| `assignedOps` | Ops given to an entity or a terrain code. |
| `tableOnlyOps` | Ops of `"table"` tables. `assignedOps + tableOnlyOps + unassignedOps = tables.ops`. |
| `unassignedOps` | Ops of `"entities"` tables no entity took; 0. |
| `pictures` | The three `Counts` of `pictures`. |
| `scripts` | Script changes by kind. |
| `races.changed` | Races with an own change, new or lost units or buildings, capital layer changes or slot changes. |
| `races.redesigned` | Races flagged `redesigned`. |
| `terrain.changed` | Codes with tile or picture changes. |

## Other exports

| export | what |
|---|---|
| `diffLines`, `lineEdits`, `splitLines` | Line diff (above). |
| `parseCapitalDat(text)` | capital.dat → `CapitalSection[]` `{name, infos: {n, flag, build}[], layers: CapitalLayer[], other: Record<string, string>}`. |
| `diffCapital(a?, b?, names?)`, `diffCapitalSection(a?, b?, names?)` | capital.dat difference by section; `names` gives building names per side. |
| `diffPictures(a, b)` | `PictureDiff` of two `ModData`. |
| `pictureOwnerId(change)` | The entity id a picture's name starts with, or `undefined`. |
| `shaOf(pathOrHash)` | The sha256 in a store path, lower case, or `null`. |
| `classifyId(id)`, `ID_KINDS` | An id's kind by its two-letter code: `{code, section, table, column}`. |
| `normId(v)`, `isNoId(v)`, `stripStyle(text)` | An id as the game compares it; true for blank / `G000000000`; a text without its leading style tag. |
| `linkOf(table, column)` | Where a column points: `{target: {kind: "entity", section} \| {kind: "lookup", table} \| {kind: "text"} \| {kind: "script"}, shared}`, or `undefined`. |
| `rootOf(table)`, `ROOTS`, `OWNED`, `coveredTable(table)` | The entity map: root tables, owned tables, whether a table's ops go to entities. |
| `SECTIONS` | Section ids in display order. |

## Limits

- A table only one mod has is listed, not compared: its rows give no entities.
- Gunits_2 (a copy of Gunits in some mods) is compared as a plain table; its links are not
  followed, since whether the game reads it is not known.
- A changed blob only says the source picture changed; the pixels may be equal. A sheet
  shared by many frames (a terrain atlas) changes every frame on it when one changes.
- A race is tied to its capital.dat section through Lrace TEXT (`L_DWARF` → `[DWARF]`).
- Texts are compared by id: a text moved to a new id shows as the old one removed and the
  new one added, and the entity that names it shows the changed `NAME_TXT` cell.
