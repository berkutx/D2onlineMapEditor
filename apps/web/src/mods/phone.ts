/**
 * Whether the compare page is on a phone-wide screen. The CSS of the page switches at the
 * same width (`@media (max-width: 760px)`); this flag is for what CSS cannot change, such as
 * the columns of a table or the size of the card drawer.
 */
import { nextTick, ref, watch, type Ref } from "vue";

export const PHONE_QUERY = "(max-width: 760px)";

let phone: Ref<boolean> | null = null;

/** One flag for the whole page, following the window's width (always false without a window). */
export function usePhone(): Ref<boolean> {
  if (phone) return phone;
  const mq = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null;
  const flag = ref(!!mq?.matches);
  mq?.addEventListener?.("change", (e) => (flag.value = e.matches));
  phone = flag;
  return flag;
}

/**
 * A list with its open item below it (on a phone, where they do not stand side by side):
 * when `key` names another item, scroll the returned element (the item's panel) into sight.
 */
export function useShowOnPhone(key: () => string | null | undefined): Ref<HTMLElement | null> {
  const el = ref<HTMLElement | null>(null);
  const isPhone = usePhone();
  watch(key, (k) => {
    if (!k || !isPhone.value) return;
    // at once: a smooth scroll is skipped by some embedded browsers
    void nextTick(() => el.value?.scrollIntoView({ block: "start" }));
  });
  return el;
}
