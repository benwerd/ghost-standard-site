/**
 * Deterministic record-key (rkey) derivation.
 *
 * atproto rkeys in this collection are TIDs: 13 characters of
 * base32-sortable encoding over a 64-bit value laid out as
 * (microseconds since epoch << 10) | 10-bit clock id.
 *
 * The bridge derives them deterministically from the Ghost post instead of
 * the clock, which is what makes every write path idempotent: a replayed
 * webhook, a test-path rerun, and a reconcile pass all re-derive the same
 * rkey and therefore update the same record rather than duplicating it.
 * Slug renames keep the rkey (it encodes publish time, not the path).
 *
 * Known-answer vectors for this exact algorithm live in tests/tid.test.ts.
 */

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

/**
 * FNV-1a 64-bit hash. Chosen because it's tiny, synchronous (WebCrypto
 * digests are async), and deterministic — cryptographic strength is not
 * needed for clock-id bits or a fallback key.
 */
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
 *
 * The 10 clock-id bits come from a hash of the Ghost post id so that posts
 * sharing a published_at millisecond (bulk imports commonly stamp batches
 * with identical times) still get distinct rkeys. Posts with no parseable
 * published_at fall back to a pure hash of the post id — not time-sortable,
 * but stable and valid.
 */
export function deriveRkey(post: { id: string; published_at?: string | null }): string {
  const clockId = fnv1a64('ghost:' + post.id) & 0x3ffn;
  const ms = post.published_at ? Date.parse(post.published_at) : NaN;
  if (Number.isFinite(ms) && ms >= 0) {
    return encodeTid(((BigInt(ms) * 1000n) << 10n) | clockId);
  }
  return encodeTid(fnv1a64('ghost-id:' + post.id) & 0x7fffffffffffffffn);
}

/** Shape of a valid TID rkey: 13 chars of base32-sortable. */
export const TID_REGEX = /^[2-7a-z]{13}$/;

/**
 * The publication record's rkey. The site.standard.publication lexicon
 * declares `key: tid` (confirmed against the published lexicon schema), so
 * a fixed literal like `self` is rejected by validators.
 *
 * If the KV-stored publication URI already ends in a valid TID, reuse it —
 * setup re-runs must keep updating the same record. Otherwise (first setup,
 * or migrating off a legacy non-TID rkey) mint a TID from `nowMs`.
 *
 * NOTE: after the rkey changes, existing document records still reference
 * the old publication URI in their `site` field — run
 * `POST /_atproto/reconcile?full=1&force=1` to rewrite them.
 */
export function choosePublicationRkey(existingUri: string | null, nowMs: number): string {
  const existing = existingUri?.split('/').pop();
  if (existing && TID_REGEX.test(existing)) return existing;
  const clockId = fnv1a64('site.standard.publication') & 0x3ffn;
  return encodeTid(((BigInt(nowMs) * 1000n) << 10n) | clockId);
}
