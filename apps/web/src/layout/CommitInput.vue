<script setup lang="ts">
/**
 * A free-text input that commits ONCE on change (blur / Enter), not on every keystroke.
 *
 * Typing updates only a LOCAL draft — no `update:modelValue`, so no doc mutation, no objectsRev
 * cascade (roles/links scan, object-layer rebuild, auto-validate) and no undo entry per character.
 * On a big scenario (thousands of objects / hundreds of events) editing a name/description used to
 * fire the whole recompute PER CHARACTER and freeze the GUI; now it's one commit per field.
 *
 * Drop-in for a free-text `<el-input :model-value @update:model-value>`: same contract, so swapping
 * the tag is the only change. Extra attrs (type, autosize, size, placeholder, maxlength, rows,
 * disabled, resize…) fall through to the inner el-input.
 */
import { ref, watch } from "vue";
import { ElInput } from "element-plus";

const props = defineProps<{ modelValue?: string | null }>();
const emit = defineEmits<{ (e: "update:modelValue", v: string): void }>();

const draft = ref(props.modelValue ?? "");
// external edit (another user/undo/field switch) re-syncs the draft; while THIS input is being
// typed into, `modelValue` doesn't change (we don't emit until blur), so this doesn't clobber.
watch(() => props.modelValue, (v) => { draft.value = v ?? ""; });

function commit(): void {
  const v = draft.value ?? "";
  if (v !== (props.modelValue ?? "")) emit("update:modelValue", v);
}
</script>

<template>
  <el-input v-model="draft" @change="commit" />
</template>
