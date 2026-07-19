/**
 * Turns raw Ghost webhook payloads into sync events: the "what does this
 * webhook actually mean for us?" step between receiving a delivery and
 * doing any work.
 *
 * This is the single place where syndication policy lives: only public,
 * published, web-visible posts get `site.standard.document` records. Pages,
 * drafts, members-only posts, and email-only newsletters never do. And a
 * published post that *loses* eligibility (unpublished, deleted, or edited
 * to a non-public visibility) produces a delete event so its record gets
 * cleaned up.
 *
 * Ghost quirk this absorbs: `post.published.edited` fires on every save of a
 * published post. Classification passes those through as upserts; the actual
 * debounce happens later via the content hash in the sync engine.
 */
import type { SyncEvent } from '../env';
import type { GhostPost, GhostWebhookBody } from './types';

/**
 * The syndication policy predicate: only public, published, web-visible
 * posts get records. Used by both webhook classification and reconcile.
 */
export function isSyndicatable(post: GhostPost): boolean {
  return post.status === 'published' && post.visibility === 'public' && !post.email_only;
}

/**
 * Map a Ghost webhook body to a sync event, or null to ignore entirely
 * (pages, tag/member/site events, bodies with no post id).
 *
 * Prefers the top-level `event` field; falls back to payload shape for
 * older Ghost versions that omit it. Anything with a post id that isn't a
 * syndicatable upsert becomes a delete, which is safe because the sync
 * engine treats deletes for unknown posts as a no-op.
 */
export function classifyWebhook(body: GhostWebhookBody): SyncEvent | null {
  if (!body.post) return null; // pages, tags, members, site.changed…
  const current = body.post.current;
  const previous = body.post.previous;
  const postId = current?.id || previous?.id;
  if (!postId) return null;

  if (body.event === 'post.unpublished' || body.event === 'post.deleted') {
    return { kind: 'delete', postId };
  }

  if (current?.id && isSyndicatable(current as GhostPost)) {
    return { kind: 'upsert', post: current as GhostPost };
  }
  // A post we may have synced is no longer public/published: clean up.
  // processEvent treats deletes for unknown posts as a no-op.
  return { kind: 'delete', postId };
}
