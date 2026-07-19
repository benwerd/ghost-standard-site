// Webhook classification and the syndication policy: what becomes an upsert,
// what becomes a delete, and what is ignored entirely.
import { describe, it, expect } from 'vitest';
import { classifyWebhook, isSyndicatable } from '../src/ghost/classify';
import fixture from './fixtures/post-published.json';
import type { GhostWebhookBody, GhostPost } from '../src/ghost/types';

const body = fixture as GhostWebhookBody;
const post = fixture.post.current as GhostPost;

describe('isSyndicatable', () => {
  it('accepts public published posts', () => {
    expect(isSyndicatable(post)).toBe(true);
  });
  it('rejects drafts, members-only, and email-only posts', () => {
    expect(isSyndicatable({ ...post, status: 'draft' })).toBe(false);
    expect(isSyndicatable({ ...post, visibility: 'members' })).toBe(false);
    expect(isSyndicatable({ ...post, email_only: true })).toBe(false);
    expect(isSyndicatable({ ...post, status: 'sent' })).toBe(false);
  });
});

describe('classifyWebhook', () => {
  it('classifies post.published as upsert', () => {
    expect(classifyWebhook(body)).toEqual({ kind: 'upsert', post });
  });
  it('classifies post.published.edited as upsert', () => {
    expect(classifyWebhook({ ...body, event: 'post.published.edited' })).toEqual({ kind: 'upsert', post });
  });
  it('classifies post.unpublished and post.deleted as delete', () => {
    expect(classifyWebhook({ event: 'post.unpublished', post: { current: { ...post, status: 'draft' } } }))
      .toEqual({ kind: 'delete', postId: post.id });
    expect(classifyWebhook({ event: 'post.deleted', post: { current: {}, previous: { id: post.id } } }))
      .toEqual({ kind: 'delete', postId: post.id });
  });
  it('turns a published post edited to non-public visibility into a delete', () => {
    expect(classifyWebhook({ event: 'post.published.edited', post: { current: { ...post, visibility: 'members' } } }))
      .toEqual({ kind: 'delete', postId: post.id });
  });
  it('ignores page events and empty bodies', () => {
    expect(classifyWebhook({ event: 'page.published', page: {} })).toBeNull();
    expect(classifyWebhook({})).toBeNull();
  });
  it('infers from payload shape when the event field is missing', () => {
    expect(classifyWebhook({ post: { current: post } })).toEqual({ kind: 'upsert', post });
    expect(classifyWebhook({ post: { current: {}, previous: { id: 'gone1' } } }))
      .toEqual({ kind: 'delete', postId: 'gone1' });
  });
});
