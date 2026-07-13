import { describe, it, expect } from 'vitest';
import { parseSignatureHeader, verifyGhostSignature, timingSafeEqualStr } from '../src/ghost/signature';

const SECRET = 'test-secret';
const BODY = '{"event":"post.published","post":{"current":{"id":"abc123","title":"Hello"}}}';
const TS = 1705320000000;
const HEADER = `sha256=b7788d1a0a6ea9cceb6dcc74109e839b494dd7919361c2d5135d86679d305e3a, t=${TS}`;

describe('parseSignatureHeader', () => {
  it('parses hash and timestamp', () => {
    expect(parseSignatureHeader(HEADER)).toEqual({
      hash: 'b7788d1a0a6ea9cceb6dcc74109e839b494dd7919361c2d5135d86679d305e3a',
      timestamp: TS,
    });
  });
  it('rejects malformed headers', () => {
    expect(parseSignatureHeader('nope')).toBeNull();
    expect(parseSignatureHeader('sha256=zzzz, t=123')).toBeNull();
    expect(parseSignatureHeader('')).toBeNull();
  });
});

describe('verifyGhostSignature', () => {
  it('accepts a valid signature within tolerance', async () => {
    expect(await verifyGhostSignature(BODY, HEADER, SECRET, TS + 60_000)).toBe(true);
  });
  it('rejects a tampered body', async () => {
    expect(await verifyGhostSignature(BODY + 'x', HEADER, SECRET, TS + 60_000)).toBe(false);
  });
  it('rejects the wrong secret', async () => {
    expect(await verifyGhostSignature(BODY, HEADER, 'wrong', TS + 60_000)).toBe(false);
  });
  it('rejects a stale timestamp', async () => {
    expect(await verifyGhostSignature(BODY, HEADER, SECRET, TS + 10 * 60_000)).toBe(false);
  });
  it('rejects a missing header', async () => {
    expect(await verifyGhostSignature(BODY, null, SECRET, TS)).toBe(false);
  });
});

describe('timingSafeEqualStr', () => {
  it('compares strings', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
  });
});
