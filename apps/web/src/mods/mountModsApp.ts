/**
 * The compare page as its own application: its own Pinia, none of the map editor's stores.
 * bootstrap.ts imports this lazily when the address has `?mods`.
 */
import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import { elementLocale } from "../i18n";
import ModsApp from "./ModsApp.vue";

export function mountModsApp(selector: string): void {
  const app = createApp(ModsApp);
  app.use(createPinia());
  app.use(ElementPlus, { locale: elementLocale() });
  for (const [name, component] of Object.entries(ElementPlusIconsVue)) app.component(name, component);
  app.mount(selector);
}
