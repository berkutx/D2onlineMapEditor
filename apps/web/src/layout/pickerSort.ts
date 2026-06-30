/**
 * Shared sort model for the catalog pickers (item / unit / spell). Each picker declares a small
 * set of SortKeys over its own entry type; the group header (PickerSortHeader.vue) renders them
 * and `sortBy` applies the active key + direction within each subcategory group. One template,
 * reused by every picker — adding a new pickable type only needs its own SortKey list.
 */
export interface SortKey<T> {
  key: string; // stable id
  label: string; // short header label (e.g. "HP", "ур.", "цена", "А-Я")
  get: (e: T) => number | string; // the value to sort on
  desc?: boolean; // default direction when this key is first selected (numeric stats → high→low)
}

/** Sort a copy of `items` by the given key + direction (1 = asc, -1 = desc). Numbers compare
 *  numerically, strings via ru locale. A stable tiebreak isn't needed (input is pre-grouped). */
export function sortBy<T>(items: T[], k: SortKey<T> | undefined, dir: 1 | -1): T[] {
  if (!k) return items;
  const out = [...items];
  out.sort((a, b) => {
    const va = k.get(a);
    const vb = k.get(b);
    const c =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb), "ru");
    return c * dir;
  });
  return out;
}

/** Next (key, dir) when a sort label is clicked: toggle direction if it's already active, else
 *  switch to it using its default direction. */
export function nextSort<T>(
  keys: SortKey<T>[],
  cur: { key: string; dir: 1 | -1 },
  clicked: string,
): { key: string; dir: 1 | -1 } {
  if (cur.key === clicked) return { key: clicked, dir: cur.dir === 1 ? -1 : 1 };
  const k = keys.find((x) => x.key === clicked);
  return { key: clicked, dir: k?.desc ? -1 : 1 };
}
