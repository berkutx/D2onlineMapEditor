/**
 * Opaque scenario ids. We never expose raw filesystem paths on the public API;
 * instead each scenario gets a stable id = base32(sha1(realpath)).
 *
 * The id is deterministic for a given realpath, so the web client can bookmark
 * `/api/maps/:id` and it keeps resolving as long as the file stays put.
 */

import { createHash } from "node:crypto";

/** RFC 4648 base32 alphabet (no padding), lowercased for tidy URLs. */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Compute the opaque id for a real (canonical) filesystem path. */
export function idForPath(realPath: string): string {
  const sha1 = createHash("sha1").update(realPath, "utf8").digest();
  return base32(sha1);
}
