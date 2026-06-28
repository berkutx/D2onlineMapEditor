/**
 * Windows-1251 ENCODER (string -> bytes), the exact inverse of the reader's
 * `new TextDecoder("windows-1251")`. The reverse table is built once by decoding
 * every byte 0..255, so it is guaranteed consistent with how we read maps back.
 *
 * Fail-loud: a character with no CP1251 byte throws rather than silently writing a
 * replacement — a corrupt name must never reach a saved `.sg`.
 */

const decoder = new TextDecoder("windows-1251");

/** codepoint -> CP1251 byte. Built from the decoder so encode∘decode is identity. */
const REVERSE: Map<number, number> = (() => {
  const m = new Map<number, number>();
  for (let b = 0; b < 256; b++) {
    const ch = decoder.decode(new Uint8Array([b]));
    const cp = ch.codePointAt(0);
    // 0x98 etc. are undefined in CP1251 -> decode to U+FFFD; don't add (never emit them)
    if (cp !== undefined && cp !== 0xfffd && !m.has(cp)) m.set(cp, b);
  }
  return m;
})();

/** Encode a JS string to Windows-1251 bytes (no NUL, no length prefix). */
export function encodeCp1251(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      out[n++] = cp;
      continue;
    }
    const b = REVERSE.get(cp);
    if (b === undefined) {
      throw new Error(
        `cp1251: cannot encode U+${cp.toString(16).toUpperCase()} (${JSON.stringify(ch)})`,
      );
    }
    out[n++] = b;
  }
  // `for..of` counts code points; for BMP CP1251 text n === s.length, but guard anyway
  return n === out.length ? out : out.subarray(0, n);
}

/** CP1251 byte length of a string (== code-point count for encodable text). */
export function cp1251Length(s: string): number {
  return encodeCp1251(s).length;
}
