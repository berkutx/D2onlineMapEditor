# Credits

## Русский

- **[NevendaarTools](https://bitbucket.org/NevendaarTools/) (Vilgeforc)** — открытые
  инструменты [toolsqt](https://bitbucket.org/NevendaarTools/toolsqt) и
  [d2mapeditorqt](https://bitbucket.org/NevendaarTools/d2mapeditorqt) использовались как
  справочные материалы по формату и поведению редактора:
  - автотайлинг дорог — портирована 16-масочная таблица `MapTileHelper::updateRoad`
    и вариационный сид рельефа;
  - фильтры выбора юнитов (лидер отряда — только герой/вор; гарнизоны без героев);
  - раскладки полей ряда блоков `.sg` сверялись с заголовками `MapUtils/DataBlocks/D2*.h`.
- **[MarkovJunior](https://github.com/mxgmn/MarkovJunior)** (mxgmn) — алгоритм процедурной
  генерации; в `packages/mapgen/vendor` включён его TypeScript-порт
  [MarkovJuniorWeb](https://github.com/Yuu6883/MarkovJuniorWeb) (Yuu6883, MIT).
- **[D2ModdingToolset](https://github.com/VladimirMakeev/D2ModdingToolset)** — сверка
  перечислений событий и категорий предметов.

## English

- **[NevendaarTools](https://bitbucket.org/NevendaarTools/) (Vilgeforc)** — the open-source
  tools [toolsqt](https://bitbucket.org/NevendaarTools/toolsqt) and
  [d2mapeditorqt](https://bitbucket.org/NevendaarTools/d2mapeditorqt) served as reference
  material for the file format and editor behavior:
  - road auto-tiling — the 16-mask table from `MapTileHelper::updateRoad` and the terrain
    variation seed were ported;
  - unit-selection filters (a stack leader must be a hero/thief; garrisons exclude heroes);
  - field layouts of several `.sg` blocks were cross-checked against the
    `MapUtils/DataBlocks/D2*.h` headers.
- **[MarkovJunior](https://github.com/mxgmn/MarkovJunior)** (mxgmn) — the procedural
  generation algorithm; `packages/mapgen/vendor` bundles its TypeScript port,
  [MarkovJuniorWeb](https://github.com/Yuu6883/MarkovJuniorWeb) (Yuu6883, MIT).
- **[D2ModdingToolset](https://github.com/VladimirMakeev/D2ModdingToolset)** — used to
  cross-check event enumerations and item categories.
