import { describe, it, expect } from 'vitest';
import { shapePublicationRecord } from '../src/records/publication';
import { isAuthorizedAdmin } from '../src/handlers/setup';
import type { Env } from '../src/env';

describe('shapePublicationRecord', () => {
  it('shapes the record from Ghost settings', () => {
    const record = shapePublicationRecord(
      { title: 'Werd I/O', description: 'An open blog' },
      'https://blog.example.org/'
    );
    expect(record).toEqual({
      $type: 'site.standard.publication',
      url: 'https://blog.example.org',
      name: 'Werd I/O',
      description: 'An open blog',
      preferences: { showInDiscover: true },
    });
  });
  it('applies the PUBLICATION_NAME override and optional icon', () => {
    const icon = { $type: 'blob', ref: { $link: 'bafkreifake' }, mimeType: 'image/png', size: 9 };
    const record = shapePublicationRecord({ title: 'Ignored' }, 'https://blog.example.org', 'Override', icon);
    expect(record.name).toBe('Override');
    expect(record.icon).toBe(icon);
  });
});

describe('isAuthorizedAdmin', () => {
  const env = { GHOST_WEBHOOK_SECRET: 'admin-secret' } as Env;
  it('accepts the bearer secret', () => {
    const req = new Request('https://blog.example.org/_atproto/setup', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(isAuthorizedAdmin(req, env)).toBe(true);
  });
  it('rejects wrong or missing tokens', () => {
    const wrong = new Request('https://blog.example.org/_atproto/setup', {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
    });
    expect(isAuthorizedAdmin(wrong, env)).toBe(false);
    expect(isAuthorizedAdmin(new Request('https://blog.example.org/_atproto/setup', { method: 'POST' }), env)).toBe(false);
  });
});
