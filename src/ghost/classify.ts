import type { SyncEvent } from '../env';
import type { GhostPost, GhostWebhookBody } from './types';

/** Only public, published, web-visible posts get records. */
export function isSyndicatable(post: GhostPost): boolean {
  return post.status === 'published' && post.visibility === 'public' && !post.email_only;
}

/**
 * Map a Ghost webhook body to a sync event, or null to ignore.
 * Prefers the top-level `event` field; falls back to payload shape for
 * older Ghost versions that omit it.
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
