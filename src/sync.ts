/**
 * The sync engine: the one place that turns a SyncEvent into PDS writes and
 * KV state changes. Both consumers of events — the queue consumer (webhook
 * path) and the reconcile sweep — funnel through processEvent, so
 * idempotency and the edit debounce are enforced identically everywhere.
 *
 * Network access is abstracted behind `PdsWriter`, so the whole engine is
 * unit-tested against the real (miniflare) KV with a fake writer and no
 * network at all.
 */
import type { SyncEvent } from './env';
import { deriveRkey } from './atproto/tid';
import { contentHash, shapeDocumentRecord, postPath, type DocumentRecord } from './records/document';
import { getPostState, putPostState, deletePostState } from './state/kv';

/** Thin surface over the PDS so the sync engine is testable without a network. */
export interface PdsWriter {
  /** Create or replace the document record at rkey; returns its AT-URI. */
  putDocument(rkey: string, record: DocumentRecord): Promise<{ uri: string }>;
  /** Delete the document record at rkey; already-gone must count as success. */
  deleteDocument(rkey: string): Promise<void>;
  /** Fetch an image and upload it as a blob; undefined on any failure (fail open). */
  fetchImageBlob(url: string): Promise<unknown | undefined>;
}

/** Everything processEvent needs, bundled so call sites stay uniform. */
export interface SyncDeps {
  writer: PdsWriter;
  kv: KVNamespace;
  /** AT-URI of the publication record, referenced by every document's `site`. */
  publicationUri: string;
  /** Canonical blog base URL, for path derivation. */
  ghostUrl: string;
}

/**
 * What processEvent did:
 * - created/updated — a record was written (first time / in place)
 * - skipped — upsert whose material fields were unchanged (debounce)
 * - deleted — record and state removed
 * - noop — delete for a post that was never synced
 */
export type SyncResult = 'created' | 'updated' | 'skipped' | 'deleted' | 'noop';

/**
 * Apply one sync event. Idempotent by construction:
 *
 * - Deletes for unknown posts are no-ops, so replays are harmless.
 * - Upserts reuse the stored rkey when one exists and re-derive the same
 *   deterministic rkey when one doesn't, so no path ever duplicates a record.
 * - Upserts whose content hash matches the stored hash return 'skipped'
 *   without touching the PDS (Ghost fires post.published.edited on every
 *   save) — unless the event carries `force`, the signed test path's
 *   regenerate-on-rerun escape hatch.
 *
 * On a slug rename, the record keeps its rkey, gets a new `path`, and the
 * old KV path mapping is cleaned up (via putPostState's oldPath).
 */
export async function processEvent(event: SyncEvent, deps: SyncDeps): Promise<SyncResult> {
  if (event.kind === 'delete') {
    const state = await getPostState(deps.kv, event.postId);
    if (!state) return 'noop';
    await deps.writer.deleteDocument(state.rkey);
    await deletePostState(deps.kv, event.postId, state.path);
    return 'deleted';
  }

  const post = event.post;
  const state = await getPostState(deps.kv, post.id);
  const hash = await contentHash(post, deps.ghostUrl);
  if (!event.force && state && state.contentHash === hash) return 'skipped';

  const rkey = state?.rkey ?? deriveRkey(post);
  let coverImage: unknown | undefined;
  if (post.feature_image) coverImage = await deps.writer.fetchImageBlob(post.feature_image);
  const record = shapeDocumentRecord(post, deps.publicationUri, deps.ghostUrl, coverImage);
  const { uri } = await deps.writer.putDocument(rkey, record);
  await putPostState(
    deps.kv,
    post.id,
    {
      rkey,
      atUri: uri,
      contentHash: hash,
      path: postPath(post, deps.ghostUrl),
      updatedAt: post.updated_at ?? post.published_at ?? '',
    },
    state?.path
  );
  return state ? 'updated' : 'created';
}
