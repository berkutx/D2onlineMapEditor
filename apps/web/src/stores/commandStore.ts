/**
 * A way to ask for a MENU COMMAND from anywhere in the interface — the command bar runs
 * «экспорт» or «сетка» without knowing how the menu does it. The ids are the menu's own
 * (`file:open`, `view:grid`, `edit:undo` … see `onSelect` in TopMenuBar.vue, which owns the
 * actions and listens here); a request carries a nonce so the same command can be asked twice.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

export const useCommandStore = defineStore("command", () => {
  const request = ref<{ id: string; nonce: number } | null>(null);
  let seq = 0;

  /** Ask the menu to run the command `id`. */
  function run(id: string): void {
    request.value = { id, nonce: ++seq };
  }

  return { request, run };
});
