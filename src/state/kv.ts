const POST_PREFIX = 'post:';
const PATH_PREFIX = 'path:';
const PUBLICATION_KEY = 'publication';

export interface PostState {
  rkey: string;
  atUri: string;
  contentHash: string;
  path: string;
  updatedAt: string;
}

export async function getPostState(kv: KVNamespace, postId: string): Promise<PostState | null> {
  return kv.get<PostState>(POST_PREFIX + postId, 'json');
}

/** Writes both mappings; when the path changed, removes the stale path key. */
export async function putPostState(
  kv: KVNamespace,
  postId: string,
  state: PostState,
  oldPath?: string
): Promise<void> {
  await kv.put(POST_PREFIX + postId, JSON.stringify(state));
  await kv.put(PATH_PREFIX + state.path, JSON.stringify({ atUri: state.atUri }));
  if (oldPath && oldPath !== state.path) await kv.delete(PATH_PREFIX + oldPath);
}

export async function deletePostState(kv: KVNamespace, postId: string, path?: string): Promise<void> {
  await kv.delete(POST_PREFIX + postId);
  if (path) await kv.delete(PATH_PREFIX + path);
}

export async function getPathUri(kv: KVNamespace, path: string): Promise<string | null> {
  const entry = await kv.get<{ atUri: string }>(PATH_PREFIX + path, 'json');
  return entry?.atUri ?? null;
}

export async function listPostIds(kv: KVNamespace): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: POST_PREFIX, cursor });
    ids.push(...page.keys.map((k) => k.name.slice(POST_PREFIX.length)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return ids;
}

const RECONCILE_REPORT_KEY = 'reconcile:last';

export interface StoredReconcileReport {
  at: string;
  report: unknown;
}

export async function setLastReconcileReport(kv: KVNamespace, report: unknown): Promise<void> {
  await kv.put(RECONCILE_REPORT_KEY, JSON.stringify({ at: new Date().toISOString(), report }));
}

export async function getLastReconcileReport(kv: KVNamespace): Promise<StoredReconcileReport | null> {
  return kv.get<StoredReconcileReport>(RECONCILE_REPORT_KEY, 'json');
}

export async function getPublicationUri(kv: KVNamespace): Promise<string | null> {
  const entry = await kv.get<{ atUri: string }>(PUBLICATION_KEY, 'json');
  return entry?.atUri ?? null;
}

export async function setPublicationUri(kv: KVNamespace, atUri: string): Promise<void> {
  await kv.put(PUBLICATION_KEY, JSON.stringify({ atUri }));
}
