/**
 * Shaping Ghost posts into `site.standard.document` records, plus the
 * content hash that debounces Ghost's save-spam.
 *
 * A "record" is the little JSON document that lives in the blog owner's
 * AT Protocol repo; `site.standard.document` is the lexicon (shared
 * schema) for "an article on a website". This file is where a Ghost post
 * gets translated into that shape — nothing here talks to the network,
 * which is what makes it easy to test field by field.
 *
 * Content policy (deliberate): metadata + excerpt only. The canonical
 * content lives at the blog — records carry no post body, so the lexicon's
 * `content`/`textContent` fields are never set.
 *
 * URL model: the record stores `site` (the publication's AT-URI) and `path`.
 * Consumers resolve the publication, read its `url`, and join it with the
 * path to get the canonical URL — so paths here must exactly match what the
 * proxy layer looks up in KV when injecting link tags. `normalizePath` is
 * that single shared normalization.
 *
 * Field limits come from the lexicon (fetched from standard.site/docs,
 * 2026-07-13): title ≤500 graphemes, description ≤3000, tags ≤128 each.
 * Truncation targets sit safely below those.
 */
import type { GhostPost } from '../ghost/types';

/** site.standard.document — metadata + excerpt only; canonical content lives at the publication URL. */
export interface DocumentRecord {
  $type: 'site.standard.document';
  /** AT-URI of the publication record this document belongs to. */
  site: string;
  title: string;
  /** ISO 8601 publish time. */
  publishedAt: string;
  /** Leading-slash path; publication.url + path = canonical URL. */
  path?: string;
  /** Plain-text excerpt (custom excerpt preferred, auto excerpt fallback). */
  description?: string;
  /** Public Ghost tag names, no leading #. */
  tags?: string[];
  /** ISO 8601 last-edit time; only set when it differs from publishedAt. */
  updatedAt?: string;
  /** BlobRef for the feature image, when one was uploadable. */
  coverImage?: unknown;
}

/**
 * Canonical path form used everywhere paths are compared: leading slash,
 * no trailing slash (except the root). Both the record's `path` field and
 * the proxy's KV lookups go through this, which is what keeps them in
 * agreement.
 */
export function normalizePath(pathname: string): string {
  let p = pathname.startsWith('/') ? pathname : '/' + pathname;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * A post's canonical path: derived from Ghost's absolute post URL when
 * present (authoritative — it reflects routing config), falling back to the
 * slug, then the id. Always normalized.
 */
export function postPath(post: Pick<GhostPost, 'id' | 'url' | 'slug'>, ghostUrl: string): string {
  if (post.url) {
    try {
      return normalizePath(new URL(post.url, ghostUrl).pathname);
    } catch {
      // fall through to slug
    }
  }
  return normalizePath('/' + (post.slug ?? post.id));
}

/** Conservative truncation well under the lexicon grapheme limits. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Public tag names only — internal tags (visibility "internal") are Ghost bookkeeping, never syndicated. */
function publicTags(post: GhostPost): string[] {
  return (post.tags ?? [])
    .filter((t) => (t.visibility ?? 'public') === 'public' && t.name)
    .map((t) => truncate(t.name, 120));
}

/** The excerpt to syndicate: the author-written custom excerpt wins over Ghost's auto-generated one. */
function excerptOf(post: GhostPost): string {
  return (post.custom_excerpt || post.excerpt || '').trim();
}

/**
 * Build the document record for a post. Pure — given the same post,
 * publication URI, and (optional) cover-image blob, it always produces the
 * same record, which the record-shaping tests pin down field by field.
 */
export function shapeDocumentRecord(
  post: GhostPost,
  publicationUri: string,
  ghostUrl: string,
  coverImage?: unknown
): DocumentRecord {
  const publishedAt = post.published_at ?? post.updated_at ?? new Date(0).toISOString();
  const record: DocumentRecord = {
    $type: 'site.standard.document',
    site: publicationUri,
    path: postPath(post, ghostUrl),
    title: truncate(post.title || 'Untitled', 490),
    publishedAt: new Date(publishedAt).toISOString(),
  };
  const description = excerptOf(post);
  if (description) record.description = truncate(description, 2900);
  const tags = publicTags(post);
  if (tags.length) record.tags = tags;
  if (post.updated_at && post.updated_at !== post.published_at) {
    record.updatedAt = new Date(post.updated_at).toISOString();
  }
  if (coverImage) record.coverImage = coverImage;
  return record;
}

/**
 * SHA-256 over the material fields only — the debounce against Ghost firing
 * post.published.edited on every save. `updated_at` is deliberately
 * excluded: it changes on every save whether or not anything the record
 * carries has changed. If this hash matches the stored one, the sync engine
 * skips the PDS write entirely.
 */
export async function contentHash(post: GhostPost, ghostUrl: string): Promise<string> {
  const material = {
    title: post.title ?? '',
    path: postPath(post, ghostUrl),
    description: excerptOf(post),
    publishedAt: post.published_at ?? null,
    tags: publicTags(post),
    featureImage: post.feature_image ?? null,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(material));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
