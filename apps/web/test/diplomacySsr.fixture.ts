// Keep component and SSR injection tokens in the same Vite module graph.
export { default as DiplomacyComponent } from '../src/layout/DiplomacyEditor.vue';
export { useEditStore } from '../src/stores/editStore';
export { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';