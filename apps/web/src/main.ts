import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import "element-plus/dist/index.css";
// Opt-in dark chrome (toggled via html.dark in viewStore). The light theme is
// the default; these CSS vars only apply once <html> gets the `dark` class.
import "element-plus/theme-chalk/dark/css-vars.css";

import App from "./App.vue";
import "./style.css";

const app = createApp(App);

app.use(createPinia());
app.use(ElementPlus);

// Register every Element Plus icon globally (the menu uses <Check>, etc.).
for (const [name, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, component);
}

app.mount("#app");
