import type { Env } from '../env';
import { timingSafeEqualStr } from '../ghost/signature';
import { fetchSettings } from '../ghost/content-api';
import { shapePublicationRecord } from '../records/publication';
import {
  createSession, uploadImageFromUrl, PUBLICATION_COLLECTION, PUBLICATION_RKEY,
} from '../atproto/client';
import { setPublicationUri } from '../state/kv';

export function isAuthorizedAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get('authorization') ?? '';
  return timingSafeEqualStr(auth, `Bearer ${env.GHOST_WEBHOOK_SECRET}`);
}

/**
 * One-off (idempotent) publication setup: pulls name/description/icon from
 * Ghost settings and upserts the site.standard.publication record at rkey
 * `self`. Protected by the webhook secret as a bearer token.
 */
export async function handleSetup(request: Request, env: Env): Promise<Response> {
  if (!isAuthorizedAdmin(request, env)) return new Response('unauthorized', { status: 401 });
  try {
    const settings = await fetchSettings(env);
    const agent = await createSession(env);
    const iconUrl = settings.icon || settings.logo;
    const icon = iconUrl ? await uploadImageFromUrl(agent, iconUrl) : undefined;
    const record = shapePublicationRecord(settings, env.GHOST_URL, env.PUBLICATION_NAME, icon);
    const res = await agent.com.atproto.repo.putRecord({
      repo: env.ATPROTO_DID,
      collection: PUBLICATION_COLLECTION,
      rkey: PUBLICATION_RKEY,
      record: record as unknown as Record<string, unknown>,
      validate: false,
    });
    await setPublicationUri(env.STATE, res.data.uri);
    return Response.json({ uri: res.data.uri, record });
  } catch (err) {
    console.error('setup failed', err);
    return new Response(`setup failed: ${(err as Error).message}`, { status: 500 });
  }
}
