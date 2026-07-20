/**
 * The Worker's connection to the AT Protocol network.
 *
 * All writes go to the blog owner's PDS, the server that hosts their
 * personal data repo (README crash course has the fuller picture). We log
 * in with their handle + an app password, exactly like a mobile client
 * would, and then create/update/delete records in their repo.
 *
 * Wraps @atproto/api behind two seams:
 * - `createSession` authenticates with handle + app password and enforces
 *   the DID safety assertion before anything can write.
 * - `createPdsWriter` adapts the agent to the narrow `PdsWriter` interface
 *   the sync engine consumes, so everything above this file is testable
 *   with a fake and never touches the network in tests.
 *
 * Every record write uses `validate: false` because the PDS does not host
 * the site.standard lexicons, so server-side schema validation would reject
 * the records otherwise.
 */
import { AtpAgent } from '@atproto/api';
import type { Env } from '../env';
import type { PdsWriter } from '../sync';
import { getSessionData, putSessionData } from '../state/kv';

/** Collection NSID for per-post document records. */
export const DOCUMENT_COLLECTION = 'site.standard.document';
/** Collection NSID for the site-level publication record. */
export const PUBLICATION_COLLECTION = 'site.standard.publication';
// (The publication's rkey is not a constant: the lexicon requires `key: tid`,
// so it's minted at first setup; see choosePublicationRkey in atproto/tid.ts.)

/** Lexicon constraint: coverImage/icon blobs must be under 1MB. */
const MAX_BLOB_BYTES = 1_000_000;

/**
 * A misconfigured handle must never write to the wrong repo: called at
 * session start with the DID the PDS actually authenticated, this throws
 * unless it matches the configured ATPROTO_DID exactly.
 */
export function assertSessionDid(sessionDid: string | undefined, expected: string): void {
  if (!sessionDid || sessionDid !== expected) {
    throw new Error(
      `FATAL: authenticated session DID (${sessionDid ?? 'none'}) does not match ATPROTO_DID (${expected}); refusing to write`
    );
  }
}

/**
 * Return an authenticated agent, after the DID assertion passes.
 *
 * Prefers resuming the KV-cached session over a fresh app-password login:
 * that shaves a round-trip of latency per invocation and, more importantly,
 * stays clear of the PDS's separate createSession rate limits (which fresh
 * logins consume and resumed sessions don't). The cache is best-effort in
 * both directions: an expired or invalid cached session falls back to a
 * full login, and token refreshes are written back via persistSession so
 * the next invocation picks them up.
 */
export async function createSession(env: Env): Promise<AtpAgent> {
  const agent = new AtpAgent({
    service: env.ATPROTO_PDS_URL,
    persistSession: (_evt, session) => {
      // fire-and-forget: worst case the write is lost and the next
      // invocation falls back to a fresh login
      if (session) void putSessionData(env.STATE, session).catch(() => {});
    },
  });

  const cached = await getSessionData(env.STATE).catch(() => null);
  if (cached) {
    try {
      await agent.resumeSession(cached);
      assertSessionDid(agent.session?.did, env.ATPROTO_DID);
      return agent;
    } catch (err) {
      // Don't swallow the safety check: a DID mismatch means misconfiguration,
      // not a stale token, and a fresh login would only "fix" it silently.
      if (err instanceof Error && /refusing to write/.test(err.message)) throw err;
      // otherwise: expired/invalid cache, so fall through to a full login
    }
  }

  await agent.login({ identifier: env.ATPROTO_HANDLE, password: env.ATPROTO_APP_PASSWORD });
  assertSessionDid(agent.session?.did, env.ATPROTO_DID);
  if (agent.session) await putSessionData(env.STATE, agent.session).catch(() => {});
  return agent;
}

/**
 * Fetch an image URL and upload it as a blob, returning the BlobRef to embed
 * in a record. Returns undefined on any failure (missing image, non-2xx,
 * empty body, or over the 1MB lexicon cap), because a cover image is never
 * worth failing a record write over (fail open).
 */
export async function uploadImageFromUrl(agent: AtpAgent, url: string): Promise<unknown | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength >= MAX_BLOB_BYTES) return undefined;
    const uploaded = await agent.uploadBlob(bytes, {
      encoding: res.headers.get('content-type') ?? 'image/jpeg',
    });
    return uploaded.data.blob;
  } catch {
    return undefined;
  }
}

/**
 * Adapt an authenticated agent to the `PdsWriter` interface the sync engine
 * uses. All writes target the configured DID's repo with `validate: false`
 * (the PDS doesn't host the site.standard lexicons).
 */
export function createPdsWriter(agent: AtpAgent, env: Env): PdsWriter {
  return {
    /** Create or replace the document record at `rkey` in the configured repo. */
    async putDocument(rkey, record) {
      const res = await agent.com.atproto.repo.putRecord({
        repo: env.ATPROTO_DID,
        collection: DOCUMENT_COLLECTION,
        rkey,
        record: record as unknown as Record<string, unknown>,
        validate: false,
      });
      return { uri: res.data.uri };
    },
    /** Delete the document record at `rkey`; an already-gone record is success. */
    async deleteDocument(rkey) {
      try {
        await agent.com.atproto.repo.deleteRecord({
          repo: env.ATPROTO_DID,
          collection: DOCUMENT_COLLECTION,
          rkey,
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 400 && status !== 404) throw err; // already gone is fine
      }
    },
    /** See uploadImageFromUrl: undefined on any failure, never throws. */
    async fetchImageBlob(url) {
      return uploadImageFromUrl(agent, url);
    },
  };
}
