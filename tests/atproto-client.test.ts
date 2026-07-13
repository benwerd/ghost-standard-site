import { describe, it, expect } from 'vitest';
import { assertSessionDid } from '../src/atproto/client';

describe('assertSessionDid', () => {
  it('passes when the session DID matches config', () => {
    expect(() => assertSessionDid('did:plc:abc', 'did:plc:abc')).not.toThrow();
  });
  it('throws loudly on mismatch', () => {
    expect(() => assertSessionDid('did:plc:other', 'did:plc:abc')).toThrow(/refusing to write/i);
  });
  it('throws when the session has no DID', () => {
    expect(() => assertSessionDid(undefined, 'did:plc:abc')).toThrow(/refusing to write/i);
  });
});
