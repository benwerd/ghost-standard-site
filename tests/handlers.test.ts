// HTTP surface: webhook receiver (signature gate, enqueue, force flag),
// well-known verification endpoint, origin request rewriting, and HTMLRewriter
// link-tag injection.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleWebhook } from '../src/handlers/webhook';
import { handleWellKnown } from '../src/handlers/wellknown';
import { buildOriginRequest, injectLinkTags } from '../src/handlers/proxy';
import { setPublicationUri } from '../src/state/kv';
import fixture from './fixtures/post-published.json';
import type { Env, SyncEvent } from '../src/env';

const SECRET = 'test-secret';

async function signedHeader(body: string, secret: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body + ts));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}, t=${ts}`;
}

function webhookEnv(sent: SyncEvent[]): Env {
  return {
    ...env,
    GHOST_WEBHOOK_SECRET: SECRET,
    EVENTS: { send: async (m: SyncEvent) => void sent.push(m) } as unknown as Queue<SyncEvent>,
  };
}

beforeEach(async () => {
  const all = await env.STATE.list();
  await Promise.all(all.keys.map((k) => env.STATE.delete(k.name)));
});

describe('handleWebhook', () => {
  const body = JSON.stringify(fixture);

  it('enqueues a valid signed event and returns 202', async () => {
    const sent: SyncEvent[] = [];
    const request = new Request('https://blog.example.org/_atproto/ghost-webhook', {
      method: 'POST',
      body,
      headers: { 'x-ghost-signature': await signedHeader(body, SECRET, Date.now()) },
    });
    const res = await handleWebhook(request, webhookEnv(sent));
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('upsert');
  });
  it('marks the event force when ?force=1 is set on a signed request', async () => {
    const sent: SyncEvent[] = [];
    const request = new Request('https://blog.example.org/_atproto/ghost-webhook?force=1', {
      method: 'POST',
      body,
      headers: { 'x-ghost-signature': await signedHeader(body, SECRET, Date.now()) },
    });
    const res = await handleWebhook(request, webhookEnv(sent));
    expect(res.status).toBe(202);
    expect(sent[0]).toMatchObject({ kind: 'upsert', force: true });
  });
  it('rejects a bad signature with 401 and enqueues nothing', async () => {
    const sent: SyncEvent[] = [];
    const request = new Request('https://blog.example.org/_atproto/ghost-webhook', {
      method: 'POST',
      body,
      headers: { 'x-ghost-signature': await signedHeader(body + 'tamper', SECRET, Date.now()) },
    });
    const res = await handleWebhook(request, webhookEnv(sent));
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });
  it('acks ignorable events with 200 without enqueueing', async () => {
    const sent: SyncEvent[] = [];
    const ignorable = JSON.stringify({ event: 'page.published', page: {} });
    const request = new Request('https://blog.example.org/_atproto/ghost-webhook', {
      method: 'POST',
      body: ignorable,
      headers: { 'x-ghost-signature': await signedHeader(ignorable, SECRET, Date.now()) },
    });
    const res = await handleWebhook(request, webhookEnv(sent));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});

describe('handleWellKnown', () => {
  it('returns the publication AT-URI as text/plain', async () => {
    await setPublicationUri(env.STATE, 'at://did:plc:x/site.standard.publication/self');
    const res = await handleWellKnown(env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('at://did:plc:x/site.standard.publication/self');
  });
  it('404s when no publication record exists yet', async () => {
    const res = await handleWellKnown(env);
    expect(res.status).toBe(404);
  });
});

describe('buildOriginRequest', () => {
  it('rewrites the host to the Ghost origin, preserving path and query', () => {
    const req = buildOriginRequest(
      new Request('http://localhost:8787/hello-atmosphere/?x=1'),
      'https://blog.example.org'
    );
    expect(req.url).toBe('https://blog.example.org/hello-atmosphere/?x=1');
  });
});

describe('injectLinkTags', () => {
  const DOC = 'at://did:plc:x/site.standard.document/3kizf2hc622ry';
  const PUB = 'at://did:plc:x/site.standard.publication/self';

  it('injects both link tags into head', async () => {
    const page = new Response('<html><head><title>t</title></head><body>b</body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const html = await injectLinkTags(page, DOC, PUB).text();
    expect(html).toContain(`<link rel="site.standard.document" href="${DOC}">`);
    expect(html).toContain(`<link rel="site.standard.publication" href="${PUB}">`);
    expect(html).toContain('<title>t</title>');
  });
  it('injects only the document tag when the publication URI is unknown', async () => {
    const page = new Response('<html><head></head><body></body></html>', {
      headers: { 'content-type': 'text/html' },
    });
    const html = await injectLinkTags(page, DOC, null).text();
    expect(html).toContain('site.standard.document');
    expect(html).not.toContain('site.standard.publication');
  });
});
