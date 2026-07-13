import type { Env } from '../env';
import type { GhostPost, GhostSettings } from './types';

const PAGE_SIZE = 100;

// Everything the record shaper and content hash need — deliberately NOT the
// post html, which would mean downloading the whole archive's bodies on every
// reconcile. (Verified on Ghost 6: `fields` and `include=tags` combine fine.)
const LEAN_FIELDS =
  'id,slug,url,title,custom_excerpt,excerpt,feature_image,published_at,updated_at,visibility,email_only';

async function fetchPaged(env: Env, params: Record<string, string>): Promise<GhostPost[]> {
  const posts: GhostPost[] = [];
  let page = 1;
  for (;;) {
    const url = new URL('/ghost/api/content/posts/', env.GHOST_URL);
    url.searchParams.set('key', env.GHOST_CONTENT_API_KEY);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // no accept-version pin: Ghost serves the current version when omitted;
    // a pinned older major gets 406 UPDATE_CLIENT (seen on Ghost 6)
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
  // The Content API omits `status`; everything it returns is published.
  return posts.map((p) => ({ ...p, status: p.status ?? 'published' }));
}

/** Full archive with the lean field set. Used by the backfill (`reconcile full`). */
export async function fetchAllPosts(env: Env): Promise<GhostPost[]> {
  return fetchPaged(env, { include: 'tags', fields: LEAN_FIELDS });
}

/** Posts edited or published in the last `days` days — the windowed repair set. */
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
 * Every public post's id (~4KB per 100 posts) — cheap at any archive size.
 * Drives orphan deletion, which can never be windowed: deleted posts simply
 * vanish from the API, so "what's missing" needs the full id set.
 */
export async function fetchAllPostIds(env: Env): Promise<Set<string>> {
  const posts = await fetchPaged(env, { fields: 'id', filter: 'visibility:public' });
  return new Set(posts.map((p) => p.id));
}

export async function fetchSettings(env: Env): Promise<GhostSettings> {
  const url = new URL('/ghost/api/content/settings/', env.GHOST_URL);
  url.searchParams.set('key', env.GHOST_CONTENT_API_KEY);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Ghost Content API error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { settings: GhostSettings };
  return data.settings;
}
