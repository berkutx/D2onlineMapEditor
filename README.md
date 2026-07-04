# d2-web-editor — браузерный редактор карт Disciples II

> ## 🙏 Благодарность
> Этот проект **не был бы возможен без многолетних наработок Vilgeforc** и его открытых
> инструментов **[NevendaarTools](https://bitbucket.org/NevendaarTools/)** —
> [toolsqt](https://bitbucket.org/NevendaarTools/toolsqt) и
> [d2mapeditorqt](https://bitbucket.org/NevendaarTools/d2mapeditorqt).
> Реверс-инжиниринг форматов игры, раскладки блоков `.sg`, алгоритмы редактора — всё это
> опирается на его код как на эталон. Подробный список заимствованного: **[CREDITS.md](CREDITS.md)**.

Веб-порт редактора карт Disciples II: открывает бинарные сценарии `.sg`, рендерит карту
со спрайтами игры (PixiJS), редактирует рельеф/дороги/объекты/отряды/события и
пересохраняет **байт-в-байт совместимые** `.sg`, которые открываются в родном ScenEdit
и в игре. Реалтайм-совместное редактирование, зоны свободной формы, копайлот генерации
рельефа.

**Живая версия:** https://d2mapeditor.online/map

## Стек

- **Клиент:** Vue 3 + Element Plus + Pinia, PixiJS 8 (+`@pixi/tilemap`)
- **Сервер:** Node + Fastify + socket.io (комнаты-редактирования, валидация, экспорт)
- **Пайплайн ассетов:** Python + Pillow/numpy (`.ff`/MQDB → PNG-атласы + манифест)
- Монорепо: pnpm + turbo, TypeScript project references

## Структура

| Путь | Что это |
|---|---|
| `packages/map-schema` | **Contract A**: `MapDocument` (zod) — модель карты |
| `packages/sg-parser` | Читатель/писатель `.sg` (patch-in-place, 3-уровневый валидатор) |
| `packages/map-edit` | Логика редактирования: EditOp-журнал, кисти, зоны, undo |
| `packages/pixi-render` | Рендер-ядро (изометрия, тайловый рельеф, объекты, слои) |
| `packages/socket-contract` | **Contract C**: типизированные socket.io-события + REST |
| `packages/asset-manifest` | **Contract B**: схема атласов/анимаций |
| `packages/mapgen` | Генерация рельефа (vendored [MarkovJunior](https://github.com/mxgmn/MarkovJunior), MIT) |
| `apps/server` | Fastify + socket.io сервер |
| `apps/web` | Vue-оболочка редактора |
| `tools/asset-pipeline` | Python-пайплайн ассетов из файлов игры |

Это **исходники проекта** (workspace-пакеты монорепы), не сторонние модули — сторонние
зависимости ставятся через `pnpm install` и в репозиторий не входят.

## Запуск

```bash
corepack pnpm install
corepack pnpm run build:tsc      # tsc -b по project references
corepack pnpm -r run test        # vitest по пакетам
```

Тесты парсера/редактора используют **карты самой игры как фикстуры**: укажите путь к
установленной Disciples II либо переменной окружения `D2_GAME_DIR`, либо однострочным
файлом `game-dir.local` в корне (см. `game-dir.local.example`; файл в `.gitignore`).
Ассеты (атласы/каталоги) генерируются пайплайном в `public/assets/` (тоже не в гите):

```bash
python tools/asset-pipeline/pipeline.py --game "<D2_GAME_DIR>/Game" --out public/assets --stage 1
```

## Право

Фанатский некоммерческий инструмент. Disciples II — собственность соответствующих
правообладателей; ассеты игры в репозиторий не входят и генерируются локально из вашей
копии игры.
