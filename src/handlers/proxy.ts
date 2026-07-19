/**
 * The catch-all: every request that isn't one of the bridge's own routes —
 * which is to say, all of the blog's actual reader traffic — flows through
 * here on its way to Ghost. We pass it along unchanged, with one exception:
 * post pages get the standard.site verification `<link>` tags slipped into
 * their <head> (the page's half of the verification handshake).
 *
 * Prime directive — never degrade the blog. Every branch fails open: a KV
 * miss, a KV error, a non-HTML response, or a non-200 all return the origin
 * response untouched (byte-identical). Only a successful GET/HEAD HTML page
 * whose path has a KV mapping gets rewritten, and even then HTMLRewriter
 * streams the transform without buffering the page.
 *
 * Ghost's redirects (e.g. /slug → /slug/) pass through to the browser
 * unfollowed (`redirect: 'manual'`), preserving origin behavior exactly.
 */
import type { Env } from '../env';
import { normalizePath } from '../records/document';
import { getPathUri, getPublicationUri } from '../state/kv';

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
 * Proxy everything to origin. Only successful GET/HEAD HTML responses whose
 * path has a KV entry get link tags injected; every other response — and any
 * KV failure — passes through untouched (fail open, never degrade the blog).
 *
 * The path lookup uses the same normalizePath as record shaping, which is
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
    [docUri, pubUri] = await Promise.all([
      getPathUri(env.STATE, path),
      getPublicationUri(env.STATE),
    ]);
  } catch {
    return originResponse;
  }
  if (!docUri) return originResponse;
  return injectLinkTags(originResponse, docUri, pubUri);
}
