/**
 * Line diff for showing two versions of a text (a Lua script) side by side: Myers' O(ND)
 * algorithm, split at the middle snake so memory stays linear in the file size.
 */

export interface DiffLine {
  kind: "same" | "removed" | "added";
  text: string;
  /** 1-based line in A (same, removed). */
  a?: number;
  /** 1-based line in B (same, added). */
  b?: number;
}

export interface LineHunk {
  /** 1-based first A line of the hunk; with no A lines, the A line it comes before. */
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
  lines: DiffLine[];
}

/** Lines of a text; a final line break does not start another line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** For each line of A, the line of B it is kept as, or -1 (a longest common subsequence). */
function matchLines(a: Int32Array, b: Int32Array): Int32Array {
  const match = new Int32Array(a.length).fill(-1);
  const stack: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (stack.length) {
    let [aLo, aHi, bLo, bHi] = stack.pop()!;
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) match[aLo++] = bLo++;
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) match[--aHi] = --bHi;
    if (aLo === aHi || bLo === bHi) continue;
    const split = bisect(a, b, aLo, aHi, bLo, bHi);
    if (!split) continue; // nothing in common
    const [x, y] = split;
    stack.push([x, aHi, y, bHi], [aLo, x, bLo, y]);
  }
  return match;
}

/** The middle snake's end of the shortest edit path over the ranges, as absolute indexes. */
function bisect(a: Int32Array, b: Int32Array, aLo: number, aHi: number, bLo: number, bHi: number): [number, number] | undefined {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD;
  const len = 2 * maxD + 2;
  const v1 = new Int32Array(len).fill(-1);
  const v2 = new Int32Array(len).fill(-1);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1o = off + k1;
      let x1 = k1 === -d || (k1 !== d && v1[k1o - 1]! < v1[k1o + 1]!) ? v1[k1o + 1]! : v1[k1o - 1]! + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
        x1++;
        y1++;
      }
      v1[k1o] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2o = off + delta - k1;
        if (k2o >= 0 && k2o < len && v2[k2o] !== -1 && x1 >= n - v2[k2o]!) return [aLo + x1, bLo + y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2o = off + k2;
      let x2 = k2 === -d || (k2 !== d && v2[k2o - 1]! < v2[k2o + 1]!) ? v2[k2o + 1]! : v2[k2o - 1]! + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aHi - x2 - 1] === b[bHi - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[k2o] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1o = off + delta - k2;
        if (k1o >= 0 && k1o < len && v1[k1o] !== -1) {
          const x1 = v1[k1o]!;
          const y1 = off + x1 - k1o;
          if (x1 >= n - x2) return [aLo + x1, bLo + y1];
        }
      }
    }
  }
  return undefined;
}

/** Every line of A and B in order, kept, removed or added. */
export function lineEdits(a: string, b: string): DiffLine[] {
  const la = splitLines(a);
  const lb = splitLines(b);
  const ids = new Map<string, number>();
  const code = (s: string) => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, (v = ids.size));
    return v;
  };
  const ca = Int32Array.from(la, code);
  const cb = Int32Array.from(lb, code);
  const match = matchLines(ca, cb);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < la.length || j < lb.length) {
    if (i < la.length && match[i] === j) {
      out.push({ kind: "same", text: la[i]!, a: i + 1, b: j + 1 });
      i++;
      j++;
    } else if (i < la.length && match[i] === -1) {
      out.push({ kind: "removed", text: la[i]!, a: i + 1 });
      i++;
    } else {
      out.push({ kind: "added", text: lb[j]!, b: j + 1 });
      j++;
    }
  }
  return out;
}

/**
 * The changes from A to B as hunks with `context` unchanged lines around each (default 3).
 * Equal texts give no hunks; context = Infinity gives one hunk with every line.
 */
export function diffLines(a: string, b: string, context = 3): LineHunk[] {
  const lines = lineEdits(a, b);
  const changed: number[] = [];
  lines.forEach((l, k) => {
    if (l.kind !== "same") changed.push(k);
  });
  if (!changed.length) return [];
  const ctx = Math.max(0, context);
  const ranges: [number, number][] = [];
  for (const k of changed) {
    const lo = Math.max(0, k - ctx);
    const hi = Math.min(lines.length - 1, k + ctx);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }
  // A and B lines before each position, for the start of a hunk with no lines of one side
  const aBefore = new Int32Array(lines.length + 1);
  const bBefore = new Int32Array(lines.length + 1);
  lines.forEach((l, k) => {
    aBefore[k + 1] = aBefore[k]! + (l.kind !== "added" ? 1 : 0);
    bBefore[k + 1] = bBefore[k]! + (l.kind !== "removed" ? 1 : 0);
  });
  return ranges.map(([lo, hi]) => ({
    aStart: aBefore[lo]! + 1,
    aCount: aBefore[hi + 1]! - aBefore[lo]!,
    bStart: bBefore[lo]! + 1,
    bCount: bBefore[hi + 1]! - bBefore[lo]!,
    lines: lines.slice(lo, hi + 1),
  }));
}
