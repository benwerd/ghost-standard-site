// site.standard.document shaping (field-by-field against the webhook fixture)
// and the material-fields content hash that debounces Ghost's save-spam.
import { describe, it, expect } from 'vitest';
import { normalizePath, postPath, shapeDocumentRecord, contentHash } from '../src/records/document';
import fixture from './fixtures/post-published.json';
import type { GhostPost } from '../src/ghost/types';

const post = fixture.post.current as GhostPost;
const PUB_URI = 'at://did:plc:exampleuser0000000000000/site.standard.publication/self';
const GHOST_URL = 'https://blog.example.org';

describe('normalizePath', () => {
  it('ensures leading slash and strips trailing slashes', () => {
    expect(normalizePath('/hello-atmosphere/')).toBe('/hello-atmosphere');
    expect(normalizePath('hello')).toBe('/hello');
    expect(normalizePath('/')).toBe('/');
  });
});

describe('postPath', () => {
  it('derives the path from the post url', () => {
    expect(postPath(post, GHOST_URL)).toBe('/hello-atmosphere');
  });
  it('falls back to the slug when url is missing', () => {
    expect(postPath({ id: 'x', slug: 'my-slug' }, GHOST_URL)).toBe('/my-slug');
  });
});

describe('shapeDocumentRecord', () => {
  it('shapes a metadata-plus-excerpt record (no full body)', () => {
    const record = shapeDocumentRecord(post, PUB_URI, GHOST_URL);
    expect(record).toEqual({
      $type: 'site.standard.document',
      site: PUB_URI,
      path: '/hello-atmosphere',
      title: 'Hello Atmosphere',
      description: 'A test post about syndicating to the Atmosphere.',
      tags: ['atproto'],
      publishedAt: '2026-07-13T10:00:00.000Z',
    });
    expect(record).not.toHaveProperty('content');
    expect(record).not.toHaveProperty('textContent');
  });
  it('filters internal tags', () => {
    const record = shapeDocumentRecord(post, PUB_URI, GHOST_URL);
    expect(record.tags).not.toContain('#internal');
  });
  it('sets updatedAt only when it differs from publishedAt', () => {
    const edited = { ...post, updated_at: '2026-07-14T09:00:00.000Z' };
    expect(shapeDocumentRecord(edited, PUB_URI, GHOST_URL).updatedAt).toBe('2026-07-14T09:00:00.000Z');
    expect(shapeDocumentRecord(post, PUB_URI, GHOST_URL).updatedAt).toBeUndefined();
  });
  it('attaches a coverImage blob when provided', () => {
    const blob = { $type: 'blob', ref: { $link: 'bafkreifake' }, mimeType: 'image/jpeg', size: 123 };
    expect(shapeDocumentRecord(post, PUB_URI, GHOST_URL, blob).coverImage).toBe(blob);
  });
});

describe('contentHash', () => {
  it('is stable for identical material fields', async () => {
    expect(await contentHash(post, GHOST_URL)).toBe(await contentHash({ ...post }, GHOST_URL));
  });
  it('ignores immaterial changes (e.g. updated_at save-spam)', async () => {
    const saved = { ...post, updated_at: '2026-07-13T10:05:00.000Z' };
    expect(await contentHash(saved, GHOST_URL)).toBe(await contentHash(post, GHOST_URL));
  });
  it('changes when title, path, excerpt, tags, or feature image change', async () => {
    const base = await contentHash(post, GHOST_URL);
    expect(await contentHash({ ...post, title: 'New' }, GHOST_URL)).not.toBe(base);
    expect(await contentHash({ ...post, url: 'https://blog.example.org/renamed/' }, GHOST_URL)).not.toBe(base);
    expect(await contentHash({ ...post, custom_excerpt: 'New excerpt' }, GHOST_URL)).not.toBe(base);
    expect(await contentHash({ ...post, tags: [] }, GHOST_URL)).not.toBe(base);
    expect(await contentHash({ ...post, feature_image: null }, GHOST_URL)).not.toBe(base);
  });
});
