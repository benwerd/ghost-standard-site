const encoder = new TextEncoder();

export interface ParsedSignature {
  hash: string;
  timestamp: number;
}

/** Ghost emits: `sha256=<hex>, t=<ms>` (see Ghost core webhook-trigger.js). */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  const match = /sha256=([0-9a-f]{64})\s*,\s*t=(\d+)/i.exec(header);
  if (!match) return null;
  return { hash: match[1].toLowerCase(), timestamp: Number(match[2]) };
}

/** Constant-time string comparison. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify Ghost's webhook signature: HMAC-SHA256(secret, rawBody + timestamp).
 * `nowMs` is injected for testability; tolerance defaults to 5 minutes.
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
