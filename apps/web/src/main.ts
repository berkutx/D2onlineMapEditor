import { createApp } from "vue";
import { createPinia, setActivePinia } from "pinia";
import ElementPlus from "element-plus";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import "element-plus/dist/index.css";
// Opt-in dark chrome (toggled via html.dark in viewStore). The light theme is
// the default; these CSS vars only apply once <html> gets the `dark` class.
import "element-plus/theme-chalk/dark/css-vars.css";

import App from "./App.vue";
import "./style.css";
import { useItemStore } from "./stores/itemStore";
import { useUnitStore } from "./stores/unitStore";
import { useSpellStore } from "./stores/spellStore";

const app = createApp(App);

const pinia = createPinia();
app.use(pinia);
setActivePinia(pinia); // so the catalog preload below can use stores outside a component
app.use(ElementPlus);

// Register every Element Plus icon globally (the menu uses <Check>, etc.).
for (const [name, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, component);
}

app.mount("#app");

// Preload the item / unit / spell catalogs as first-class resources at startup, so the
// object inspector + pickers are instant (no "Загрузка каталога…" flash on first open).
// load() is idempotent, so the existing lazy call sites become instant cache hits.
void useItemStore().load();
void useUnitStore().load();
void useSpellStore().load();
