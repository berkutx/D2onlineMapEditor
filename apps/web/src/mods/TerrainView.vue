<script setup lang="ts">
/**
 * Terrain by code: the forests, mountains, ground tiles and borders each mod draws for it,
 * changed and new ones side by side, and the GTileDBI rows that count the variants.
 */
import { computed, ref } from "vue";
import type { Change, PictureChange, TerrainChange } from "@d2/mod-diff";
import { tr } from "../i18n";
import { useCompareStore } from "./compareStore";
import { CHANGE_LABEL, TERRAIN_CODES, TERRAIN_KINDS } from "./labels";
import PicturePair from "./PicturePair.vue";
import OwnedRows from "./OwnedRows.vue";
import CountChips from "./CountChips.vue";

const store = useCompareStore();
const changes = ref<Change[]>(["added", "changed", "removed"]);
const SHOWN = 60;
const expanded = ref<Record<string, boolean>>({});

const terrains = computed(() => (store.diff?.terrain ?? []).filter((t) => store.diff!.summary.terrain.changed.includes(t.code)));
const unchanged = computed(() => (store.diff?.terrain ?? []).filter((t) => !store.diff!.summary.terrain.changed.includes(t.code)));
const other = computed(() => (store.diff?.terrainOther ?? []).filter((p) => changes.value.includes(p.change)));

function pics(t: TerrainChange, kind: (typeof TERRAIN_KINDS)[number]["id"]): PictureChange[] {
  return t.pictures[kind].filter((p) => changes.value.includes(p.change));
}
function count(list: PictureChange[], c: Change): number {
  return list.filter((p) => p.change === c).length;
}
function key(t: TerrainChange, kind: string): string {
  return `${t.code}:${kind}`;
}
</script>

<template>
  <div>
    <h1 class="title">{{ tr("Ландшафт") }}</h1>
    <p class="dim lead">{{ tr("Земель в игре шесть и вода; новый ландшафт мода — это новые картинки для существующего кода земли.") }}</p>
    <div class="mods-toolbar">
      <el-checkbox-group v-model="changes" size="small">
        <el-checkbox-button value="added">{{ CHANGE_LABEL.added }}</el-checkbox-button>
        <el-checkbox-button value="changed">{{ CHANGE_LABEL.changed }}</el-checkbox-button>
        <el-checkbox-button value="removed">{{ CHANGE_LABEL.removed }}</el-checkbox-button>
      </el-checkbox-group>
    </div>

    <el-empty v-if="!terrains.length && !other.length" :description="tr('Картинки ландшафта и таблица GTileDBI у модов одинаковы.')" />

    <div v-for="t in terrains" :key="t.code" class="mods-block">
      <h2 class="mods-section-title">
        {{ TERRAIN_CODES[t.code] ?? t.code }} <span class="mono dim">{{ t.code }}</span><span v-if="t.name && t.name !== t.code" class="mono dim">&nbsp;· {{ t.name }}</span>
      </h2>
      <div class="counts">
        <span>{{ tr("Леса") }}: {{ t.counts.forestsA }} → <b>{{ t.counts.forestsB }}</b></span>
        <span v-if="t.counts.mountainsA || t.counts.mountainsB">{{ tr("Горы") }}: {{ t.counts.mountainsA }} → <b>{{ t.counts.mountainsB }}</b></span>
      </div>
      <template v-for="k in TERRAIN_KINDS" :key="k.id">
        <div v-if="t.pictures[k.id].length" class="kind">
          <h3 class="kind-title">
            {{ k.label }}
            <CountChips :added="count(t.pictures[k.id], 'added')" :changed="count(t.pictures[k.id], 'changed')" :removed="count(t.pictures[k.id], 'removed')" />
          </h3>
          <div class="mods-gallery dense">
            <PicturePair v-for="p in expanded[key(t, k.id)] ? pics(t, k.id) : pics(t, k.id).slice(0, SHOWN)" :key="`${p.name}:${p.change}`" :change="p" :size="72" />
          </div>
          <el-button v-if="pics(t, k.id).length > SHOWN && !expanded[key(t, k.id)]" text size="small" @click="expanded[key(t, k.id)] = true">
            {{ tr("Показать все ({n})", { n: pics(t, k.id).length }) }}
          </el-button>
        </div>
      </template>
      <div v-if="t.tiles.length" class="kind">
        <h3 class="kind-title">{{ tr("Варианты тайлов") }} <span class="mono dim">GTileDBI</span></h3>
        <OwnedRows :rows="t.tiles" />
      </div>
    </div>

    <div v-if="other.length" class="mods-block">
      <h2 class="mods-section-title">{{ tr("Без кода земли") }} <span class="dim">{{ tr("дороги, туман, общие горы") }}</span></h2>
      <div class="mods-gallery dense">
        <PicturePair v-for="p in expanded.other ? other : other.slice(0, SHOWN)" :key="`${p.name}:${p.change}`" :change="p" :size="72" />
      </div>
      <el-button v-if="other.length > SHOWN && !expanded.other" text size="small" @click="expanded.other = true">{{ tr("Показать все ({n})", { n: other.length }) }}</el-button>
    </div>

    <p v-if="unchanged.length" class="dim">
      {{ tr("Без изменений:") }} {{ unchanged.map((t) => `${TERRAIN_CODES[t.code] ?? t.code} (${t.code})`).join(", ") }}
    </p>
  </div>
</template>

<style scoped>
.title {
  font-size: 20px;
  font-weight: 650;
  margin: 2px 0 4px;
}
.lead {
  margin: 0 0 10px;
}
.counts {
  display: flex;
  gap: 18px;
  margin-bottom: 10px;
}
.kind {
  margin-bottom: 14px;
}
.dense {
  grid-auto-flow: row dense;
}
.kind-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 8px;
}
</style>
