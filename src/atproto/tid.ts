/** base32-sortable alphabet used by atproto TIDs. */
const B32 = '234567abcdefghijklmnopqrstuvwxyz';

/** Encode a 64-bit value as a 13-character base32-sortable string (5 bits per char, top bit unused). */
export function encodeTid(value: bigint): string {
  let out = '';
  for (let i = 12; i >= 0; i--) {
    out += B32[Number((value >> BigInt(i * 5)) & 31n)];
  }
  return out;
}

function fnv1a64(input: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

/**
 * Deterministic rkey for a Ghost post. TID layout: (microseconds << 10) | clockId.
 * The 10 clock-id bits come from a hash of the Ghost post id so that posts sharing
 * a published_at millisecond (bulk imports) still get distinct rkeys. Replays and
 * reconciliation always re-derive the same rkey.
 */
export function deriveRkey(post: { id: string; published_at?: string | null }): string {
  const clockId = fnv1a64('ghost:' + post.id) & 0x3ffn;
  const ms = post.published_at ? Date.parse(post.published_at) : NaN;
  if (Number.isFinite(ms) && ms >= 0) {
    return encodeTid(((BigInt(ms) * 1000n) << 10n) | clockId);
  }
  return encodeTid(fnv1a64('ghost-id:' + post.id) & 0x7fffffffffffffffn);
}
