import { AtpAgent } from '@atproto/api';
import type { Env } from '../env';
import type { PdsWriter } from '../sync';

export const DOCUMENT_COLLECTION = 'site.standard.document';
export const PUBLICATION_COLLECTION = 'site.standard.publication';
export const PUBLICATION_RKEY = 'self';

const MAX_BLOB_BYTES = 1_000_000; // lexicon: coverImage/icon blobs < 1MB

/** A misconfigured handle must never write to the wrong repo. */
export function assertSessionDid(sessionDid: string | undefined, expected: string): void {
  if (!sessionDid || sessionDid !== expected) {
    throw new Error(
      `FATAL: authenticated session DID (${sessionDid ?? 'none'}) does not match ATPROTO_DID (${expected}); refusing to write`
    );
  }
}

export async function createSession(env: Env): Promise<AtpAgent> {
  const agent = new AtpAgent({ service: env.ATPROTO_PDS_URL });
  await agent.login({ identifier: env.ATPROTO_HANDLE, password: env.ATPROTO_APP_PASSWORD });
  assertSessionDid(agent.session?.did, env.ATPROTO_DID);
  return agent;
}

/** Fetch an image URL and upload it as a blob. Returns undefined on any failure or oversize. */
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

export function createPdsWriter(agent: AtpAgent, env: Env): PdsWriter {
  return {
    async putDocument(rkey, record) {
      // PDS does not host the site.standard lexicons: validate must be false.
      const res = await agent.com.atproto.repo.putRecord({
        repo: env.ATPROTO_DID,
        collection: DOCUMENT_COLLECTION,
        rkey,
        record: record as unknown as Record<string, unknown>,
        validate: false,
      });
      return { uri: res.data.uri };
    },
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
    async fetchImageBlob(url) {
      return uploadImageFromUrl(agent, url);
    },
  };
}
