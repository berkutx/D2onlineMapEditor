/**
 * spriteStore — resolves an object sprite KEY (e.g. "G000RU0000005") to the atlas page
 * + frame rect so the UI can CSS-crop a thumbnail (same trick as DecorThumb, but the rect
 * is read live from the manifest index + per-page meta JSONs instead of a precomputed table).
 *
 * A key's sheet is taken from manifest.index[key] (a key can live in iso-still / iso-cmon /
 * iso-anim); we lazily fetch that sheet's page metas, cache the frame rects, and expose a
 * synchronous frameOf(key) for components to read reactively after ensureKeys().
 */
import { defineStore } from "pinia";
import { ref } from "vue";

export interface SpriteRect {
  page: string; // atlas page image filename, e.g. "iso-still-0.png"
  x: number; y: number; w: number; h: number; // frame rect on the page
  sw: number; sh: number; // untrimmed source size (for centering)
}

interface ManifestLite {
  index: Record<string, { sheet: string; frame: string }>;
  spritesheets: { id: string; image: string; meta: string }[];
}

export const useSpriteStore = defineStore("sprite", () => {
  const frames = ref<Record<string, SpriteRect>>({});
  let manifestP: Promise<ManifestLite> | null = null;
  const pageMetaP = new Map<string, Promise<void>>();

  function manifest(): Promise<ManifestLite> {
    if (!manifestP) {
      manifestP = fetch("/assets/manifest.json", { cache: "force-cache" }).then((r) => {
        if (!r.ok) throw new Error(`manifest.json ${r.status}`);
        return r.json() as Promise<ManifestLite>;
      });
    }
    return manifestP;
  }

  function loadPageMeta(metaFile: string, pageImage: string): Promise<void> {
    let p = pageMetaP.get(metaFile);
    if (!p) {
      p = fetch(`/assets/${metaFile}`, { cache: "force-cache" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${metaFile} ${r.status}`))))
        .then((meta: { frames?: Record<string, { frame: { x: number; y: number; w: number; h: number }; sourceSize: { w: number; h: number } }> }) => {
          const add: Record<string, SpriteRect> = {};
          for (const [fk, fv] of Object.entries(meta.frames ?? {})) {
            add[fk] = { page: pageImage, x: fv.frame.x, y: fv.frame.y, w: fv.frame.w, h: fv.frame.h, sw: fv.sourceSize.w, sh: fv.sourceSize.h };
          }
          frames.value = { ...frames.value, ...add };
        })
        .catch(() => { /* a missing page meta just leaves those keys unresolved (placeholder) */ });
      pageMetaP.set(metaFile, p);
    }
    return p;
  }

  /** Ensure the atlas pages backing these sprite keys are resolved (idempotent). */
  async function ensureKeys(keys: readonly string[]): Promise<void> {
    const m = await manifest();
    const metas = new Map<string, string>(); // meta file -> page image
    for (const k of keys) {
      const e = m.index[k];
      if (!e) continue;
      for (const s of m.spritesheets) {
        if (s.id === e.sheet || s.id.startsWith(`${e.sheet}-`)) metas.set(s.meta, s.image);
      }
    }
    await Promise.all([...metas].map(([meta, img]) => loadPageMeta(meta, img)));
  }

  function frameOf(key: string | null | undefined): SpriteRect | undefined {
    return key ? frames.value[key] : undefined;
  }

  return { frames, ensureKeys, frameOf };
});
