import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { reconcileWindow, reconcileFull } from '../src/reconcile';
import { processEvent, type PdsWriter } from '../src/sync';
import { getPostState } from '../src/state/kv';
import fixture from './fixtures/post-published.json';
import type { GhostPost } from '../src/ghost/types';

const post = fixture.post.current as GhostPost;
const PUB_URI = 'at://did:plc:x/site.standard.publication/self';

function fakeWriter() {
  const calls = { puts: [] as string[], deletes: [] as string[] };
  const writer: PdsWriter = {
    async putDocument(rkey) {
      calls.puts.push(rkey);
      return { uri: `at://did:plc:x/site.standard.document/${rkey}` };
    },
    async deleteDocument(rkey) {
      calls.deletes.push(rkey);
    },
    async fetchImageBlob() {
      return undefined;
    },
  };
  return { writer, calls };
}

function deps(writer: PdsWriter) {
  return { writer, kv: env.STATE, publicationUri: PUB_URI, ghostUrl: 'https://blog.example.org' };
}

const OPTS = { maxWrites: 100, sleepMs: 0 };

beforeEach(async () => {
  const all = await env.STATE.list();
  await Promise.all(all.keys.map((k) => env.STATE.delete(k.name)));
});

describe('reconcileWindow', () => {
  it('creates recently-updated posts that are missing', async () => {
    const { writer, calls } = fakeWriter();
    const report = await reconcileWindow([post], new Set([post.id]), deps(writer), OPTS);
    expect(report).toMatchObject({ mode: 'window', created: 1, deleted: 0, capped: false });
    expect(calls.puts).toHaveLength(1);
    expect(await getPostState(env.STATE, post.id)).not.toBeNull();
  });
  it('skips unchanged posts on a second run', async () => {
    const { writer, calls } = fakeWriter();
    await reconcileWindow([post], new Set([post.id]), deps(writer), OPTS);
    calls.puts.length = 0;
    const report = await reconcileWindow([post], new Set([post.id]), deps(writer), OPTS);
    expect(report).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(calls.puts).toHaveLength(0);
  });
  it('deletes orphans missing from the full Ghost id set, even outside the window', async () => {
    const { writer } = fakeWriter();
    await processEvent(
      { kind: 'upsert', post: { ...post, id: 'orphan1', slug: 'gone', url: 'https://blog.example.org/gone/' } },
      deps(writer)
    );
    const report = await reconcileWindow([], new Set(['some-other-live-post']), deps(writer), OPTS);
    expect(report.deleted).toBe(1);
    expect(await getPostState(env.STATE, 'orphan1')).toBeNull();
  });
  it('removes the record when a post in the window flipped to non-public', async () => {
    const { writer, calls } = fakeWriter();
    await reconcileWindow([post], new Set([post.id]), deps(writer), OPTS);
    const flipped = { ...post, visibility: 'members' };
    const report = await reconcileWindow([flipped], new Set([post.id]), deps(writer), OPTS);
    expect(report.deleted).toBe(1);
    expect(calls.deletes).toHaveLength(1);
    expect(await getPostState(env.STATE, post.id)).toBeNull();
  });
});

describe('reconcileFull', () => {
  const many = [
    post,
    { ...post, id: 'p2', slug: 'two', url: 'https://blog.example.org/two/' },
    { ...post, id: 'p3', slug: 'three', url: 'https://blog.example.org/three/' },
    { ...post, id: 'members', visibility: 'members' },
  ];

  it('creates missing records, filters non-public, and caps writes', async () => {
    const { writer } = fakeWriter();
    const report = await reconcileFull(many, deps(writer), { maxWrites: 2, sleepMs: 0 });
    expect(report).toMatchObject({ mode: 'full', created: 2, capped: true });
  });
  it('skips already-synced posts by id without touching the PDS, and is idempotent', async () => {
    const { writer, calls } = fakeWriter();
    await reconcileFull(many, deps(writer), OPTS);
    calls.puts.length = 0;
    const report = await reconcileFull(many, deps(writer), OPTS);
    expect(report).toMatchObject({ created: 0, updated: 0, skipped: 3, deleted: 0, capped: false });
    expect(calls.puts).toHaveLength(0);
  });
  it('deletes orphans no longer present in Ghost', async () => {
    const { writer } = fakeWriter();
    await processEvent(
      { kind: 'upsert', post: { ...post, id: 'orphan1', slug: 'gone', url: 'https://blog.example.org/gone/' } },
      deps(writer)
    );
    const report = await reconcileFull([post], deps(writer), OPTS);
    expect(report).toMatchObject({ created: 1, deleted: 1 });
    expect(await getPostState(env.STATE, 'orphan1')).toBeNull();
    expect(await getPostState(env.STATE, post.id)).not.toBeNull();
  });
});
