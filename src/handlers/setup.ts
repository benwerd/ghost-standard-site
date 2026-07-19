import type { Env } from '../env';
import { timingSafeEqualStr } from '../ghost/signature';
import { fetchSettings } from '../ghost/content-api';
import { shapePublicationRecord } from '../records/publication';
import { createSession, uploadImageFromUrl, PUBLICATION_COLLECTION } from '../atproto/client';
import { choosePublicationRkey } from '../atproto/tid';
import { getPublicationUri, setPublicationUri } from '../state/kv';

export function isAuthorizedAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get('authorization') ?? '';
  return timingSafeEqualStr(auth, `Bearer ${env.GHOST_WEBHOOK_SECRET}`);
}

/**
 * One-off (idempotent) publication setup: pulls name/description/icon from
 * Ghost settings and upserts the site.standard.publication record. The rkey
 * is a TID (the lexicon requires `key: tid`) minted on first setup and
 * reused from KV on every re-run.
 *
 * If a previous setup left the record at a different rkey (e.g. the legacy
 * non-TID `self`), the old record is deleted after the new one is written —
 * and existing documents still referencing the old URI need a
 * `POST /_atproto/reconcile?full=1&force=1` to be rewritten.
 */
export async function handleSetup(request: Request, env: Env): Promise<Response> {
  if (!isAuthorizedAdmin(request, env)) return new Response('unauthorized', { status: 401 });
  try {
    const settings = await fetchSettings(env);
    const agent = await createSession(env);
    const iconUrl = settings.icon || settings.logo;
    const icon = iconUrl ? await uploadImageFromUrl(agent, iconUrl) : undefined;
    const record = shapePublicationRecord(settings, env.GHOST_URL, env.PUBLICATION_NAME, icon);

    const existingUri = await getPublicationUri(env.STATE);
    const rkey = choosePublicationRkey(existingUri, Date.now());
    const res = await agent.com.atproto.repo.putRecord({
      repo: env.ATPROTO_DID,
      collection: PUBLICATION_COLLECTION,
      rkey,
      record: record as unknown as Record<string, unknown>,
      validate: false,
    });
    await setPublicationUri(env.STATE, res.data.uri);

    // Migrating off a legacy rkey: remove the superseded record (best effort).
    const oldRkey = existingUri?.split('/').pop();
    let migratedFrom: string | undefined;
    if (oldRkey && oldRkey !== rkey) {
      try {
        await agent.com.atproto.repo.deleteRecord({
          repo: env.ATPROTO_DID,
          collection: PUBLICATION_COLLECTION,
          rkey: oldRkey,
        });
        migratedFrom = oldRkey;
      } catch (err) {
        console.error(`failed to delete superseded publication record at rkey ${oldRkey}`, err);
      }
    }

    return Response.json({
      uri: res.data.uri,
      record,
      ...(migratedFrom && {
        migratedFrom,
        note: 'publication rkey changed: run POST /_atproto/reconcile?full=1&force=1 to rewrite every document record’s site reference',
      }),
    });
  } catch (err) {
    console.error('setup failed', err);
    return new Response(`setup failed: ${(err as Error).message}`, { status: 500 });
  }
}
