/**
 * CP866 (DOS Cyrillic) — the code page of the text in the game's tables (Tglobal, TApp,
 * Sinfo, …), unlike the Windows-1251 of the .sg scenarios.
 *
 * Every one of the 256 byte values decodes to its own character, so text read with
 * {@link decodeCp866} always encodes back to the same bytes. The decoder is the platform's
 * (`ibm866` of the Encoding standard, in browsers and Node alike); the encoder is the
 * decoder's table turned around.
 */

const DECODER = new TextDecoder("ibm866");

/** byte -> character, for all 256 bytes. */
const CHARS: readonly string[] = Array.from(DECODER.decode(Uint8Array.from({ length: 256 }, (_, i) => i)));

/** character -> byte. */
const BYTES: ReadonlyMap<string, number> = new Map(CHARS.map((c, i) => [c, i]));

export function decodeCp866(bytes: Uint8Array): string {
  return DECODER.decode(bytes);
}

/** The first character of `text` CP866 has no byte for, or `undefined` when it has all. */
export function unencodableCp866(text: string): string | undefined {
  for (const c of text) if (!BYTES.has(c)) return c;
  return undefined;
}

/** Encode text to CP866. Throws a RangeError naming the first character it cannot write. */
export function encodeCp866(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  let n = 0;
  for (const c of text) {
    const b = BYTES.get(c);
    if (b === undefined) {
      throw new RangeError(`CP866 has no byte for ${JSON.stringify(c)} (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`);
    }
    out[n++] = b;
  }
  return out.subarray(0, n);
}
