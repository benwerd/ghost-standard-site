import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getPostState, putPostState, deletePostState, getPathUri,
  getPublicationUri, setPublicationUri, listPostIds, type PostState,
} from '../src/state/kv';

const state: PostState = {
  rkey: '3kizf2hc622ry',
  atUri: 'at://did:plc:x/site.standard.document/3kizf2hc622ry',
  contentHash: 'deadbeef',
  path: '/hello-atmosphere',
  updatedAt: '2026-07-13T10:00:00.000Z',
};

beforeEach(async () => {
  const all = await env.STATE.list();
  await Promise.all(all.keys.map((k) => env.STATE.delete(k.name)));
});

describe('post state', () => {
  it('round-trips post and path keys', async () => {
    await putPostState(env.STATE, 'p1', state);
    expect(await getPostState(env.STATE, 'p1')).toEqual(state);
    expect(await getPathUri(env.STATE, '/hello-atmosphere')).toBe(state.atUri);
  });
  it('moves the path key on slug change', async () => {
    await putPostState(env.STATE, 'p1', state);
    const renamed = { ...state, path: '/renamed' };
    await putPostState(env.STATE, 'p1', renamed, state.path);
    expect(await getPathUri(env.STATE, '/renamed')).toBe(state.atUri);
    expect(await getPathUri(env.STATE, '/hello-atmosphere')).toBeNull();
  });
  it('deletes both keys', async () => {
    await putPostState(env.STATE, 'p1', state);
    await deletePostState(env.STATE, 'p1', state.path);
    expect(await getPostState(env.STATE, 'p1')).toBeNull();
    expect(await getPathUri(env.STATE, '/hello-atmosphere')).toBeNull();
  });
  it('lists post ids', async () => {
    await putPostState(env.STATE, 'p1', state);
    await putPostState(env.STATE, 'p2', { ...state, path: '/two' });
    expect((await listPostIds(env.STATE)).sort()).toEqual(['p1', 'p2']);
  });
});

describe('reconcile report', () => {
  it('round-trips the last report with a timestamp', async () => {
    const { setLastReconcileReport, getLastReconcileReport } = await import('../src/state/kv');
    expect(await getLastReconcileReport(env.STATE)).toBeNull();
    await setLastReconcileReport(env.STATE, { mode: 'full', created: 5 });
    const stored = await getLastReconcileReport(env.STATE);
    expect(stored?.report).toEqual({ mode: 'full', created: 5 });
    expect(stored?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('publication', () => {
  it('round-trips the publication AT-URI', async () => {
    expect(await getPublicationUri(env.STATE)).toBeNull();
    await setPublicationUri(env.STATE, 'at://did:plc:x/site.standard.publication/self');
    expect(await getPublicationUri(env.STATE)).toBe('at://did:plc:x/site.standard.publication/self');
  });
});
