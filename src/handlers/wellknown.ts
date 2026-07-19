/**
 * GET /.well-known/site.standard.publication: the website's half of the
 * verification handshake (the README crash course explains why both the
 * site and the records must vouch for each other). This is the
 * authoritative publication verification endpoint defined by standard.site.
 *
 * Verifiers (Bluesky's crawler, Atmosphere readers) resolve a publication
 * record's `url`, fetch this path on that domain, and compare the returned
 * AT-URI against the record they hold. A match proves the DID controls the
 * domain. The `<link rel="site.standard.publication">` tag the proxy injects
 * is only a discovery hint; this endpoint is what's trusted.
 */
import type { Env } from '../env';
import { getPublicationUri } from '../state/kv';

/**
 * Serve the publication record's AT-URI as plain text. 404 until
 * /_atproto/setup has created the publication; 503 (rather than a broken
 * 200) if KV itself fails, so verifiers treat it as transient.
 */
export async function handleWellKnown(env: Env): Promise<Response> {
  try {
    const uri = await getPublicationUri(env.STATE);
    if (!uri) return new Response('not found', { status: 404 });
    return new Response(uri, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    });
  } catch {
    return new Response('temporarily unavailable', { status: 503 });
  }
}
