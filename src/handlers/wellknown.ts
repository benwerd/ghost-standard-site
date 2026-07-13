import type { Env } from '../env';
import { getPublicationUri } from '../state/kv';

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
