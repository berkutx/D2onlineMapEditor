import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import "element-plus/dist/index.css";

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
