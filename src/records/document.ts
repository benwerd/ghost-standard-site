import type { GhostPost } from '../ghost/types';

/** site.standard.document — metadata + excerpt only; canonical content lives at the publication URL. */
export interface DocumentRecord {
  $type: 'site.standard.document';
  site: string;
  title: string;
  publishedAt: string;
  path?: string;
  description?: string;
  tags?: string[];
  updatedAt?: string;
  coverImage?: unknown;
}

export function normalizePath(pathname: string): string {
  let p = pathname.startsWith('/') ? pathname : '/' + pathname;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

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

function publicTags(post: GhostPost): string[] {
  return (post.tags ?? [])
    .filter((t) => (t.visibility ?? 'public') === 'public' && t.name)
    .map((t) => truncate(t.name, 120));
}

function excerptOf(post: GhostPost): string {
  return (post.custom_excerpt || post.excerpt || '').trim();
}

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
 * Hash of the material fields only — the debounce against Ghost firing
 * post.published.edited on every save. updated_at is deliberately excluded.
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
