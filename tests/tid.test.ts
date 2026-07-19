// Pins the deterministic rkey algorithm with precomputed vectors so any
// change to TID derivation (which would orphan every existing record) fails loudly.
import { describe, it, expect } from 'vitest';
import { deriveRkey, encodeTid, choosePublicationRkey } from '../src/atproto/tid';

describe('deriveRkey', () => {
  it('derives a TID from published_at with clock-id bits from the post id', () => {
    const rkey = deriveRkey({ id: 'abc123', published_at: '2024-01-15T12:00:00.000Z' });
    expect(rkey).toBe('3kizf2hc622ry');
  });
  it('is deterministic', () => {
    const a = deriveRkey({ id: 'abc123', published_at: '2024-01-15T12:00:00.000Z' });
    const b = deriveRkey({ id: 'abc123', published_at: '2024-01-15T12:00:00.000Z' });
    expect(a).toBe(b);
  });
  it('differs for different posts with an identical published_at (bulk imports)', () => {
    const a = deriveRkey({ id: 'abc123', published_at: '2024-01-15T12:00:00.000Z' });
    const b = deriveRkey({ id: 'xyz789', published_at: '2024-01-15T12:00:00.000Z' });
    expect(b).toBe('3kizf2hc622u7');
    expect(a).not.toBe(b);
  });
  it('falls back to a hash of the Ghost post id without published_at', () => {
    expect(deriveRkey({ id: 'abc123' })).toBe('7qbgbbm4wfs62');
    expect(deriveRkey({ id: 'abc123', published_at: 'not a date' })).toBe('7qbgbbm4wfs62');
  });
  it('produces valid 13-char base32-sortable rkeys that order by time', () => {
    const earlier = deriveRkey({ id: 'a', published_at: '2020-01-01T00:00:00.000Z' });
    const later = deriveRkey({ id: 'a', published_at: '2025-01-01T00:00:00.000Z' });
    for (const rkey of [earlier, later]) expect(rkey).toMatch(/^[2-7a-z]{13}$/);
    expect(later > earlier).toBe(true);
  });
});

describe('encodeTid', () => {
  it('encodes zero as all-2s', () => {
    expect(encodeTid(0n)).toBe('2222222222222');
  });
});

describe('choosePublicationRkey', () => {
  const NOW = Date.parse('2026-07-13T12:00:00.000Z');

  it('mints a valid TID when no publication exists yet', () => {
    expect(choosePublicationRkey(null, NOW)).toMatch(/^[2-7a-z]{13}$/);
  });
  it('replaces a legacy non-TID rkey (the lexicon requires key: tid)', () => {
    const rkey = choosePublicationRkey('at://did:plc:x/site.standard.publication/self', NOW);
    expect(rkey).not.toBe('self');
    expect(rkey).toMatch(/^[2-7a-z]{13}$/);
  });
  it('reuses an existing valid TID rkey so setup re-runs stay idempotent', () => {
    const uri = 'at://did:plc:x/site.standard.publication/3kizf2hc622ry';
    expect(choosePublicationRkey(uri, NOW)).toBe('3kizf2hc622ry');
  });
  it('is deterministic for a given mint time', () => {
    expect(choosePublicationRkey(null, NOW)).toBe(choosePublicationRkey(null, NOW));
  });
});
