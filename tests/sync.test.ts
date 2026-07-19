// The sync engine end-to-end minus the network: fake PdsWriter, real
// (miniflare) KV. Covers idempotent create/update/skip/force/delete and the
// slug-rename path move.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { processEvent, type PdsWriter } from '../src/sync';
import { getPostState, getPathUri } from '../src/state/kv';
import fixture from './fixtures/post-published.json';
import type { GhostPost } from '../src/ghost/types';

const post = fixture.post.current as GhostPost;
const PUB_URI = 'at://did:plc:x/site.standard.publication/self';

function fakeWriter() {
  const calls = { puts: [] as Array<{ rkey: string; record: any }>, deletes: [] as string[] };
  const writer: PdsWriter = {
    async putDocument(rkey, record) {
      calls.puts.push({ rkey, record });
      return { uri: `at://did:plc:x/site.standard.document/${rkey}` };
    },
    async deleteDocument(rkey) {
      calls.deletes.push(rkey);
    },
    async fetchImageBlob() {
      return { $type: 'blob', ref: { $link: 'bafkreifake' }, mimeType: 'image/jpeg', size: 1 };
    },
  };
  return { writer, calls };
}

function deps(writer: PdsWriter) {
  return { writer, kv: env.STATE, publicationUri: PUB_URI, ghostUrl: 'https://blog.example.org' };
}

beforeEach(async () => {
  const all = await env.STATE.list();
  await Promise.all(all.keys.map((k) => env.STATE.delete(k.name)));
});

describe('processEvent upsert', () => {
  it('creates a record and both KV mappings on first publish', async () => {
    const { writer, calls } = fakeWriter();
    const result = await processEvent({ kind: 'upsert', post }, deps(writer));
    expect(result).toBe('created');
    expect(calls.puts).toHaveLength(1);
    expect(calls.puts[0].rkey).toMatch(/^[2-7a-z]{13}$/);
    expect(calls.puts[0].record.site).toBe(PUB_URI);
    expect(calls.puts[0].record.coverImage).toBeDefined();
    const state = await getPostState(env.STATE, post.id);
    expect(state?.path).toBe('/hello-atmosphere');
    expect(await getPathUri(env.STATE, '/hello-atmosphere')).toBe(state?.atUri);
  });
  it('skips when the content hash is unchanged (save-spam debounce)', async () => {
    const { writer, calls } = fakeWriter();
    await processEvent({ kind: 'upsert', post }, deps(writer));
    const again = await processEvent(
      { kind: 'upsert', post: { ...post, updated_at: '2026-07-13T11:11:11.000Z' } },
      deps(writer)
    );
    expect(again).toBe('skipped');
    expect(calls.puts).toHaveLength(1);
  });
  it('updates in place with the same rkey when material fields change', async () => {
    const { writer, calls } = fakeWriter();
    await processEvent({ kind: 'upsert', post }, deps(writer));
    const result = await processEvent({ kind: 'upsert', post: { ...post, title: 'Renamed' } }, deps(writer));
    expect(result).toBe('updated');
    expect(calls.puts).toHaveLength(2);
    expect(calls.puts[1].rkey).toBe(calls.puts[0].rkey);
  });
  it('moves the path mapping on slug change', async () => {
    const { writer } = fakeWriter();
    await processEvent({ kind: 'upsert', post }, deps(writer));
    await processEvent(
      { kind: 'upsert', post: { ...post, slug: 'renamed', url: 'https://blog.example.org/renamed/' } },
      deps(writer)
    );
    expect(await getPathUri(env.STATE, '/renamed')).not.toBeNull();
    expect(await getPathUri(env.STATE, '/hello-atmosphere')).toBeNull();
  });
  it('force bypasses the hash debounce and regenerates the record in place', async () => {
    const { writer, calls } = fakeWriter();
    await processEvent({ kind: 'upsert', post }, deps(writer));
    const result = await processEvent({ kind: 'upsert', post, force: true }, deps(writer));
    expect(result).toBe('updated');
    expect(calls.puts).toHaveLength(2);
    expect(calls.puts[1].rkey).toBe(calls.puts[0].rkey);
  });
  it('omits coverImage when the blob fetch fails, and still writes the record', async () => {
    const { writer, calls } = fakeWriter();
    writer.fetchImageBlob = async () => undefined;
    const result = await processEvent({ kind: 'upsert', post }, deps(writer));
    expect(result).toBe('created');
    expect(calls.puts[0].record.coverImage).toBeUndefined();
  });
});

describe('processEvent delete', () => {
  it('deletes the record and both KV keys', async () => {
    const { writer, calls } = fakeWriter();
    await processEvent({ kind: 'upsert', post }, deps(writer));
    const result = await processEvent({ kind: 'delete', postId: post.id }, deps(writer));
    expect(result).toBe('deleted');
    expect(calls.deletes).toHaveLength(1);
    expect(await getPostState(env.STATE, post.id)).toBeNull();
    expect(await getPathUri(env.STATE, '/hello-atmosphere')).toBeNull();
  });
  it('is a no-op for unknown posts', async () => {
    const { writer, calls } = fakeWriter();
    const result = await processEvent({ kind: 'delete', postId: 'never-seen' }, deps(writer));
    expect(result).toBe('noop');
    expect(calls.deletes).toHaveLength(0);
  });
});
