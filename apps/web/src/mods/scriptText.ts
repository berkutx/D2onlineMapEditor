/**
 * Script texts for the Scripts screen: fetched once per hash, decoded as UTF-8 or, when
 * that fails, as Windows-1251 (the game's own encoding), and laid out side by side.
 */
import { diffLines, type LineHunk } from "@d2/mod-diff";

const texts = new Map<string, Promise<string>>();

export function decodeScript(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

/** The text of a file by its hash (`url` is used the first time only). */
export function scriptText(sha: string, url: string, fetchFn: (u: string) => Promise<Response> = (u) => fetch(u)): Promise<string> {
  let p = texts.get(sha);
  if (!p) {
    p = fetchFn(url).then(async (res) => {
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return decodeScript(await res.arrayBuffer());
    });
    texts.set(sha, p);
    p.catch(() => texts.delete(sha));
  }
  return p;
}

/** One row of a side-by-side view: A's line and B's line (either may be absent). */
export interface SideRow {
  kind: "same" | "changed" | "removed" | "added" | "gap";
  a?: { no: number; text: string };
  b?: { no: number; text: string };
}

/** Hunks as rows: removed and added runs are paired line by line; a gap row between hunks. */
export function sideBySide(hunks: LineHunk[]): SideRow[] {
  const rows: SideRow[] = [];
  hunks.forEach((h, hi) => {
    if (hi > 0 || h.aStart > 1 || h.bStart > 1) rows.push({ kind: "gap" });
    let i = 0;
    const lines = h.lines;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.kind === "same") {
        rows.push({ kind: "same", a: { no: l.a!, text: l.text }, b: { no: l.b!, text: l.text } });
        i++;
        continue;
      }
      const removed: { no: number; text: string }[] = [];
      const added: { no: number; text: string }[] = [];
      while (i < lines.length && lines[i]!.kind !== "same") {
        const x = lines[i]!;
        if (x.kind === "removed") removed.push({ no: x.a!, text: x.text });
        else added.push({ no: x.b!, text: x.text });
        i++;
      }
      const n = Math.max(removed.length, added.length);
      for (let k = 0; k < n; k++) {
        const a = removed[k];
        const b = added[k];
        rows.push({ kind: a && b ? "changed" : a ? "removed" : "added", ...(a ? { a } : {}), ...(b ? { b } : {}) });
      }
    }
  });
  return rows;
}

/** The side-by-side rows of two texts (either may be empty: a new or a dropped file). */
export function scriptRows(a: string, b: string, context = 3): SideRow[] {
  return sideBySide(diffLines(a, b, context));
}
