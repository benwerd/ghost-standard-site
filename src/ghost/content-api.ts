/**
 * Read-side client for the Ghost Content API: Ghost's public, read-only
 * API for published content (as opposed to the Admin API, which can change
 * things and which this Worker deliberately never holds keys for). Used by
 * the reconcile sweep and the publication setup route; the webhook path
 * never calls this, since webhook payloads already carry the post.
 *
 * Design constraints baked in here:
 * - Lean fields only, never post HTML: reconcile enumerates the whole
 *   archive, and bodies would mean tens of MB per sweep for nothing.
 * - No `accept-version` header: Ghost serves its current version when the
 *   header is omitted, while a pinned older major gets 406 UPDATE_CLIENT
 *   (bitten by this on Ghost 6).
 * - Ghost(Pro) 302-redirects Content API calls from the custom domain to
 *   the *.ghost.io admin domain; that's fine for these GETs because fetch
 *   follows redirects by default.
 */
import type { Env } from '../env';
import type { GhostPost, GhostSettings } from './types';

/** Posts per Content API page; 100 is Ghost's maximum. */
const PAGE_SIZE = 100;

// Everything the record shaper and content hash need, deliberately NOT the
// post html, which would mean downloading the whole archive's bodies on every
// reconcile. (Verified on Ghost 6: `fields` and `include=tags` combine fine.)
const LEAN_FIELDS =
  'id,slug,url,title,custom_excerpt,excerpt,feature_image,published_at,updated_at,visibility,email_only';

/**
 * Walk every page of a posts query and return the concatenated results.
 * `params` are merged into each page request (filter, fields, include…).
 * The Content API omits `status`, so it's defaulted to 'published', which
 * is accurate, since the Content API never returns drafts.
 */
async function fetchPaged(env: Env, params: Record<string, string>): Promise<GhostPost[]> {
  const posts: GhostPost[] = [];
  let page = 1;
  for (;;) {
    const url = new URL('/ghost/api/content/posts/', env.GHOST_URL);
    url.searchParams.set('key', env.GHOST_CONTENT_API_KEY);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Ghost Content API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      posts: GhostPost[];
      meta?: { pagination?: { pages?: number } };
    };
    posts.push(...data.posts);
    const pages = data.meta?.pagination?.pages ?? page;
    if (page >= pages) break;
    page++;
  }
  return posts.map((p) => ({ ...p, status: p.status ?? 'published' }));
}

/** Full archive with the lean field set. Used by the backfill (`reconcile full`). */
export async function fetchAllPosts(env: Env): Promise<GhostPost[]> {
  return fetchPaged(env, { include: 'tags', fields: LEAN_FIELDS });
}

/**
 * Posts edited or published in the last `days` days: the windowed repair
 * set. Keyed on `updated_at` (not `published_at`) so a dropped edit-webhook
 * on an old post is still repaired.
 */
export async function fetchPostsUpdatedSince(env: Env, days: number): Promise<GhostPost[]> {
  const stamp = new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  return fetchPaged(env, {
    include: 'tags',
    fields: LEAN_FIELDS,
    filter: `updated_at:>'${stamp}'`,
  });
}

/**
 * Every public post's id (~4KB per 100 posts), cheap at any archive size.
 * Drives orphan deletion, which can never be windowed: deleted posts simply
 * vanish from the API, so "what's missing" needs the full id set.
 */
export async function fetchAllPostIds(env: Env): Promise<Set<string>> {
  const posts = await fetchPaged(env, { fields: 'id', filter: 'visibility:public' });
  return new Set(posts.map((p) => p.id));
}

/** Site title/description/icon, used once by /_atproto/setup to shape the publication record. */
export async function fetchSettings(env: Env): Promise<GhostSettings> {
  const url = new URL('/ghost/api/content/settings/', env.GHOST_URL);
  url.searchParams.set('key', env.GHOST_CONTENT_API_KEY);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Ghost Content API error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { settings: GhostSettings };
  return data.settings;
}
