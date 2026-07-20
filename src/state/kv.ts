/**
 * The Worker's state layer: everything the bridge remembers.
 *
 * Cloudflare KV is a simple key→value store. We use one namespace to
 * remember which Ghost post maps to which AT Protocol record (and back
 * again by URL path, since the page proxy only knows the path of the page
 * it's serving). Lose this data and nothing breaks permanently (a full
 * reconcile rebuilds it), but the mappings are what make everyday
 * operations fast and idempotent. Keys, in both directions:
 *
 *   post:{ghost_post_id} → PostState (rkey, AT-URI, content hash, path)
 *   path:{url_path}      → { atUri }  (the HTMLRewriter lookup; the proxy
 *                          only knows the request path, not the post id)
 *   publication          → { atUri }  (the site-level record's AT-URI)
 *   reconcile:last       → StoredReconcileReport (latest sweep, any mode)
 *
 * KV is eventually consistent (~60s propagation). That's fine here because
 * nothing latency-sensitive depends on propagation: the proxy derives a
 * fresh post's tag on the fly when a path has no entry yet (see
 * handlers/proxy.ts), and everything else tolerates a stale read. If a use
 * ever appears that genuinely needs consistent reads, the deliberate
 * alternative is a D1 migration; don't work around it silently.
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
  /** contentHash() of the material fields at last write; the edit debounce. */
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
 * changed (a slug rename), the stale path: key is deleted so the old URL
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
 * A path's cached lookup result. `atUri: string` means "this page has a
 * record" (inject its tag); `atUri: null` is a cached negative ("we checked,
 * this page is not a post"), which keeps non-post pages from paying the
 * derive-on-miss Content API lookup on every view.
 */
export interface PathEntry {
  atUri: string | null;
}

/**
 * Tri-state path lookup for the proxy: a PathEntry (positive or negative),
 * or null meaning "never checked"; the caller may then derive the answer
 * from the Ghost Content API and cache it.
 */
export async function getPathEntry(kv: KVNamespace, path: string): Promise<PathEntry | null> {
  return kv.get<PathEntry>(PATH_PREFIX + path, 'json');
}

/** Cache a positive path→record mapping (also written by putPostState). */
export async function putPathUri(kv: KVNamespace, path: string, atUri: string): Promise<void> {
  await kv.put(PATH_PREFIX + path, JSON.stringify({ atUri }));
}

/**
 * Cache "this path is not a post" for an hour. Safe even if the path later
 * becomes a post: the sync engine's putPostState overwrites it immediately.
 */
export async function putPathNegative(kv: KVNamespace, path: string): Promise<void> {
  await kv.put(PATH_PREFIX + path, JSON.stringify({ atUri: null }), { expirationTtl: 3600 });
}

/**
 * The document AT-URI for a normalized page path, or null. Convenience over
 * getPathEntry for callers that don't care about the negative/unknown
 * distinction.
 */
export async function getPathUri(kv: KVNamespace, path: string): Promise<string | null> {
  return (await getPathEntry(kv, path))?.atUri ?? null;
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

/**
 * Cached PDS session tokens, so queue batches can resume an existing session
 * instead of doing a fresh app-password login every time. Best-effort: if
 * the cached session is expired or garbage, createSession falls back to a
 * full login and overwrites it.
 */
const SESSION_KEY = 'session';

/** The cached atproto session, or null if none stored yet. */
export async function getSessionData(kv: KVNamespace): Promise<import('@atproto/api').AtpSessionData | null> {
  return kv.get<import('@atproto/api').AtpSessionData>(SESSION_KEY, 'json');
}

/** Store session tokens after a login or refresh. */
export async function putSessionData(kv: KVNamespace, session: import('@atproto/api').AtpSessionData): Promise<void> {
  await kv.put(SESSION_KEY, JSON.stringify(session));
}

/** The publication record's AT-URI: what /.well-known serves and documents reference. Null before setup. */
export async function getPublicationUri(kv: KVNamespace): Promise<string | null> {
  const entry = await kv.get<{ atUri: string }>(PUBLICATION_KEY, 'json');
  return entry?.atUri ?? null;
}

/** Record the publication AT-URI after /_atproto/setup creates/updates the record. */
export async function setPublicationUri(kv: KVNamespace, atUri: string): Promise<void> {
  await kv.put(PUBLICATION_KEY, JSON.stringify({ atUri }));
}
