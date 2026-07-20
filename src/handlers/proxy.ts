/**
 * The catch-all: every request that isn't one of the bridge's own routes
 * (which is to say, all of the blog's actual reader traffic) flows through
 * here on its way to Ghost. We pass it along unchanged, with one exception:
 * post pages get the standard.site verification `<link>` tags slipped into
 * their <head> (the page's half of the verification handshake).
 *
 * Prime directive: never degrade the blog. Every branch fails open: a KV
 * miss, a lookup error, a non-HTML response, or a non-200 all return the
 * origin response untouched (byte-identical). Only a successful GET/HEAD
 * HTML page known to be a post gets rewritten, and even then HTMLRewriter
 * streams the transform without buffering the page.
 *
 * How a page is known to be a post, in two layers, fast path first:
 * 1. KV has a cached answer for the path (positive: the record's AT-URI;
 *    negative: "not a post", cached so non-post pages don't pay layer 2 on
 *    every view).
 * 2. Derive-on-miss: for a never-seen path, ask the Ghost Content API for a
 *    post with that slug and compute the record's AT-URI directly (the
 *    rkey is deterministic and the DID is config), so no KV propagation is
 *    needed. This is what makes a brand-new post's tag correct on the very
 *    first page view, seconds after publish, instead of waiting up to a
 *    minute for KV to settle. The answer is written back to KV either way.
 *
 * Ghost's redirects (e.g. /slug → /slug/) pass through to the browser
 * unfollowed (`redirect: 'manual'`), preserving origin behavior exactly.
 */
import type { Env } from '../env';
import type { GhostPost } from '../ghost/types';
import { normalizePath, postPath } from '../records/document';
import { deriveRkey } from '../atproto/tid';
import { isSyndicatable } from '../ghost/classify';
import { fetchPostBySlug } from '../ghost/content-api';
import { getPathEntry, putPathUri, putPathNegative, getPublicationUri } from '../state/kv';

/**
 * Point the incoming request at the Ghost origin. In production on the
 * configured domain's route this resolves to a same-zone subrequest that
 * goes straight to origin (it does not re-trigger this Worker); in
 * `wrangler dev` it retargets localhost URLs at GHOST_URL.
 */
export function buildOriginRequest(request: Request, ghostUrl: string): Request {
  const url = new URL(request.url);
  const ghost = new URL(ghostUrl);
  url.protocol = ghost.protocol;
  url.hostname = ghost.hostname;
  url.port = ghost.port;
  return new Request(url.toString(), request);
}

/** Escape a value for use inside a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Append the standard.site link tags to the page's <head> via streaming
 * HTMLRewriter: the required document tag, plus the publication hint tag
 * when the publication URI is known.
 */
export function injectLinkTags(response: Response, docUri: string, pubUri: string | null): Response {
  let tags = `<link rel="site.standard.document" href="${escapeAttr(docUri)}">`;
  if (pubUri) tags += `<link rel="site.standard.publication" href="${escapeAttr(pubUri)}">`;
  return new HTMLRewriter()
    .on('head', {
      element(el) {
        el.append(tags, { html: true });
      },
    })
    .transform(response);
}

/**
 * The pure core of derive-on-miss: the record AT-URI for a post, but only
 * if the post is syndicatable AND its canonical path is exactly the path
 * being served. The path check is what stops tag pages, previews, or other
 * URLs that merely *contain* a slug from being tagged as the post itself.
 */
export function docUriForPost(
  post: GhostPost,
  did: string,
  ghostUrl: string,
  requestedPath: string
): string | null {
  if (!isSyndicatable(post)) return null;
  if (postPath(post, ghostUrl) !== requestedPath) return null;
  return `at://${did}/site.standard.document/${deriveRkey(post)}`;
}

/**
 * Layer 2: never-seen path. Ask Ghost whether the last path segment is a
 * post slug, derive the AT-URI if so, and cache the answer (positive or
 * negative) so this lookup happens at most once per path per hour. Any
 * failure returns null and caches nothing: fail open, try again next view.
 */
async function resolveOnMiss(path: string, env: Env): Promise<string | null> {
  const slug = path.split('/').filter(Boolean).pop();
  if (!slug) return null; // the root path is never a post
  try {
    const post = await fetchPostBySlug(env, slug);
    const uri = post ? docUriForPost(post, env.ATPROTO_DID, env.GHOST_URL, path) : null;
    if (uri) await putPathUri(env.STATE, path, uri);
    else await putPathNegative(env.STATE, path);
    return uri;
  } catch {
    return null;
  }
}

/**
 * Proxy everything to origin; inject link tags on pages known (or freshly
 * discovered) to be posts. Everything else, and any lookup failure, passes
 * through untouched.
 *
 * The path handling uses the same normalizePath as record shaping, which is
 * what guarantees the injected tag matches the record's `path` field.
 */
export async function handleProxy(request: Request, env: Env): Promise<Response> {
  const originResponse = await fetch(buildOriginRequest(request, env.GHOST_URL), {
    redirect: 'manual',
  });
  if (request.method !== 'GET' && request.method !== 'HEAD') return originResponse;
  if (originResponse.status !== 200) return originResponse;
  const contentType = originResponse.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) return originResponse;

  let docUri: string | null = null;
  let pubUri: string | null = null;
  try {
    const path = normalizePath(new URL(request.url).pathname);
    const [entry, publication] = await Promise.all([
      getPathEntry(env.STATE, path),
      getPublicationUri(env.STATE),
    ]);
    pubUri = publication;
    docUri = entry ? entry.atUri : await resolveOnMiss(path, env);
  } catch {
    return originResponse;
  }
  if (!docUri) return originResponse;
  return injectLinkTags(originResponse, docUri, pubUri);
}
