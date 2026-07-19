/**
 * Verification of Ghost's webhook signatures: how we know a request to the
 * webhook endpoint really came from Ghost and not from anyone on the
 * internet who found the URL.
 *
 * Ghost signs each webhook delivery, but ONLY when the webhook was created
 * with a secret, which the Admin UI cannot do (hence scripts/create-webhooks.mjs).
 * The header format, confirmed against Ghost core's webhook-trigger.js:
 *
 *   X-Ghost-Signature: sha256=<hex hmac>, t=<ms timestamp>
 *
 * where the HMAC-SHA256 is computed over `rawBody + timestamp` with the
 * shared secret. The timestamp guards against replay; verification rejects
 * anything outside a ±5-minute window.
 *
 * Everything here is a pure function over WebCrypto, unit-tested with a
 * known-answer vector in tests/signature.test.ts.
 */

const encoder = new TextEncoder();

/** The two components extracted from an X-Ghost-Signature header. */
export interface ParsedSignature {
  /** Lowercased hex HMAC digest. */
  hash: string;
  /** Millisecond epoch timestamp Ghost included in the signed payload. */
  timestamp: number;
}

/**
 * Parse an X-Ghost-Signature header (`sha256=<hex>, t=<ms>`; see Ghost
 * core webhook-trigger.js). Returns null for anything malformed.
 */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  const match = /sha256=([0-9a-f]{64})\s*,\s*t=(\d+)/i.exec(header);
  if (!match) return null;
  return { hash: match[1].toLowerCase(), timestamp: Number(match[2]) };
}

/**
 * Constant-time string comparison: the loop always runs to the end of the
 * string so equality checks don't leak how many leading characters matched.
 * Used for signature digests and the admin bearer token.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Render an ArrayBuffer digest as lowercase hex. */
function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify Ghost's webhook signature: HMAC-SHA256(secret, rawBody + timestamp).
 *
 * Returns false (never throws) for a missing/malformed header, a stale or
 * future timestamp beyond `toleranceMs`, or a digest mismatch. `nowMs` is
 * injected rather than read from the clock so tests can pin it; tolerance
 * defaults to 5 minutes.
 */
export async function verifyGhostSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowMs: number,
  toleranceMs = 5 * 60_000
): Promise<boolean> {
  if (!header || !secret) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(nowMs - parsed.timestamp) > toleranceMs) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody + parsed.timestamp));
  return timingSafeEqualStr(toHex(sig), parsed.hash);
}
