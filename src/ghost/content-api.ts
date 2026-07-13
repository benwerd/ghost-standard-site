import type { Env } from '../env';
import type { GhostPost, GhostSettings } from './types';

const PAGE_SIZE = 100;

/** Page through the Content API. Returns only published posts (the Content API never returns drafts). */
export async function fetchAllPosts(env: Env): Promise<GhostPost[]> {
  const posts: GhostPost[] = [];
  let page = 1;
  for (;;) {
    const url = new URL('/ghost/api/content/posts/', env.GHOST_URL);
    url.searchParams.set('key', env.GHOST_CONTENT_API_KEY);
    url.searchParams.set('include', 'tags');
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
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

export async function fetchSettings(env: Env): Promise<GhostSettings> {
  const url = new URL('/ghost/api/content/settings/', env.GHOST_URL);
  url.searchParams.set('key', env.GHOST_CONTENT_API_KEY);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Ghost Content API error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { settings: GhostSettings };
  return data.settings;
}
