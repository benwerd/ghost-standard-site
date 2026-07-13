import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { reconcilePosts } from '../src/reconcile';
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
  return { writer, kv: env.STATE, publicationUri: PUB_URI, ghostUrl: 'https://werd.io' };
}

beforeEach(async () => {
  const all = await env.STATE.list();
  await Promise.all(all.keys.map((k) => env.STATE.delete(k.name)));
});

describe('reconcilePosts', () => {
  it('creates missing records and deletes orphans', async () => {
    const { writer, calls } = fakeWriter();
    // seed an orphan that Ghost no longer has
    await processEvent(
      { kind: 'upsert', post: { ...post, id: 'orphan1', slug: 'gone', url: 'https://werd.io/gone/' } },
      deps(writer)
    );
    calls.puts.length = 0;

    const report = await reconcilePosts([post], deps(writer), { maxWrites: 100, sleepMs: 0 });
    expect(report).toMatchObject({ created: 1, deleted: 1, updated: 0, skipped: 0, capped: false });
    expect(await getPostState(env.STATE, post.id)).not.toBeNull();
    expect(await getPostState(env.STATE, 'orphan1')).toBeNull();
  });
  it('is idempotent — a second run makes zero writes', async () => {
    const { writer, calls } = fakeWriter();
    await reconcilePosts([post], deps(writer), { maxWrites: 100, sleepMs: 0 });
    calls.puts.length = 0;
    const report = await reconcilePosts([post], deps(writer), { maxWrites: 100, sleepMs: 0 });
    expect(report).toMatchObject({ created: 0, updated: 0, deleted: 0, skipped: 1 });
    expect(calls.puts).toHaveLength(0);
  });
  it('filters non-public posts and caps writes per run', async () => {
    const { writer } = fakeWriter();
    const many = [
      post,
      { ...post, id: 'p2', slug: 'two', url: 'https://werd.io/two/' },
      { ...post, id: 'p3', slug: 'three', url: 'https://werd.io/three/' },
      { ...post, id: 'members', visibility: 'members' },
    ];
    const report = await reconcilePosts(many, deps(writer), { maxWrites: 2, sleepMs: 0 });
    expect(report.created).toBe(2);
    expect(report.capped).toBe(true);
  });
});
