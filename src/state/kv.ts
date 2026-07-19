/**
 * The Worker's state layer — everything the bridge remembers.
 *
 * Cloudflare KV is a simple key→value store. We use one namespace to
 * remember which Ghost post maps to which AT Protocol record (and back
 * again by URL path, since the page proxy only knows the path of the page
 * it's serving). Lose this data and nothing breaks permanently — a full
 * reconcile rebuilds it — but the mappings are what make everyday
 * operations fast and idempotent. Keys, in both directions:
 *
 *   post:{ghost_post_id} → PostState (rkey, AT-URI, content hash, path)
 *   path:{url_path}      → { atUri }  (the HTMLRewriter lookup — the proxy
 *                          only knows the request path, not the post id)
 *   publication          → { atUri }  (the site-level record's AT-URI)
 *   reconcile:last       → StoredReconcileReport (latest sweep, any mode)
 *
 * KV is eventually consistent (~60s propagation), which is an accepted
 * tradeoff: a link tag appearing up to a minute after publish is fine. If
 * that ever stops being acceptable, the deliberate alternative is a D1
 * migration (see the README's operational notes); don't work around it
 * silently.
 *
 * Paths stored here are always in `normalizePath` form (leading slash, no
 * trailing slash), matching what the record shaper writes and the proxy
 * looks up.
 */

const POST_PREFIX = 'post:';
const PATH_PREFIX = 'path:';
const PUBLICATION_KEY = 'publication';
const RECONCILE_REPORT_KEY = 'reconcile:last';

/** Everything the bridge remembers about a synced post. */
export interface PostState {
  /** Deterministic TID the record lives at (stable across edits and renames). */
  rkey: string;
  /** Full AT-URI of the document record. */
  atUri: string;
  /** contentHash() of the material fields at last write — the edit debounce. */
  contentHash: string;
  /** Normalized path at last write; used to clean up the path: key on renames. */
  path: string;
  /** Ghost's updated_at (or published_at) at last write; informational. */
  updatedAt: string;
}

/** Look up a post's sync state by Ghost post id; null if never synced. */
export async function getPostState(kv: KVNamespace, postId: string): Promise<PostState | null> {
  return kv.get<PostState>(POST_PREFIX + postId, 'json');
}

/**
 * Write both mappings for a post (id → state, path → AT-URI). When the path
 * changed — a slug rename — the stale path: key is deleted so the old URL
 * stops advertising a link tag.
 */
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

/** Remove both of a post's mappings (used after deleting its record). */
export async function deletePostState(kv: KVNamespace, postId: string, path?: string): Promise<void> {
  await kv.delete(POST_PREFIX + postId);
  if (path) await kv.delete(PATH_PREFIX + path);
}

/**
 * The document AT-URI for a normalized page path, or null. This is the
 * proxy's hot-path lookup: null (or any error, handled by the caller) means
 * "inject nothing, pass the page through untouched".
 */
export async function getPathUri(kv: KVNamespace, path: string): Promise<string | null> {
  const entry = await kv.get<{ atUri: string }>(PATH_PREFIX + path, 'json');
  return entry?.atUri ?? null;
}

/**
 * Every synced post's Ghost id, walking KV list pagination (1000 keys per
 * page). Used by reconcile's orphan sweep; ~6 list operations per 5,000
 * posts, so cheap even on large archives.
 */
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

/** A reconcile report plus when it finished, for the GET /_atproto/reconcile poll. */
export interface StoredReconcileReport {
  /** ISO 8601 completion time. */
  at: string;
  /** The ReconcileReport, stored untyped to avoid a state→reconcile import cycle. */
  report: unknown;
}

/** Store the latest reconcile report (any mode: windowed, backfill batch, cron). */
export async function setLastReconcileReport(kv: KVNamespace, report: unknown): Promise<void> {
  await kv.put(RECONCILE_REPORT_KEY, JSON.stringify({ at: new Date().toISOString(), report }));
}

/** The most recent reconcile report, or null if none has completed yet. */
export async function getLastReconcileReport(kv: KVNamespace): Promise<StoredReconcileReport | null> {
  return kv.get<StoredReconcileReport>(RECONCILE_REPORT_KEY, 'json');
}

/** The publication record's AT-URI — what /.well-known serves and documents reference. Null before setup. */
export async function getPublicationUri(kv: KVNamespace): Promise<string | null> {
  const entry = await kv.get<{ atUri: string }>(PUBLICATION_KEY, 'json');
  return entry?.atUri ?? null;
}

/** Record the publication AT-URI after /_atproto/setup creates/updates the record. */
export async function setPublicationUri(kv: KVNamespace, atUri: string): Promise<void> {
  await kv.put(PUBLICATION_KEY, JSON.stringify({ atUri }));
}
