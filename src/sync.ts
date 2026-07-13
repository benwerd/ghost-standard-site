import type { SyncEvent } from './env';
import { deriveRkey } from './atproto/tid';
import { contentHash, shapeDocumentRecord, postPath, type DocumentRecord } from './records/document';
import { getPostState, putPostState, deletePostState } from './state/kv';

/** Thin surface over the PDS so the sync engine is testable without a network. */
export interface PdsWriter {
  putDocument(rkey: string, record: DocumentRecord): Promise<{ uri: string }>;
  deleteDocument(rkey: string): Promise<void>;
  /** Fetch an image and upload it as a blob; undefined on any failure (fail open). */
  fetchImageBlob(url: string): Promise<unknown | undefined>;
}

export interface SyncDeps {
  writer: PdsWriter;
  kv: KVNamespace;
  publicationUri: string;
  ghostUrl: string;
}

export type SyncResult = 'created' | 'updated' | 'skipped' | 'deleted' | 'noop';

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
  if (state && state.contentHash === hash) return 'skipped';

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
