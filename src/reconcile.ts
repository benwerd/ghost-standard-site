/**
 * The reconcile sweep: the safety net under Ghost's fire-once webhooks, and
 * the archive backfill. Two modes, both idempotent and both capped:
 *
 * WINDOWED (daily cron + plain admin POST): hash-checked upserts for posts
 * updated in the last WINDOW_DAYS (catches missed publish/edit webhooks),
 * plus orphan deletion. Steady-state cost is O(window) + one ids-only
 * archive enumeration — ~55 subrequests regardless of archive size.
 *
 * FULL (?full=1 admin POST, run inside the queue consumer because a batch
 * takes minutes): creates records for posts KV has never seen, skipping
 * known ids with zero per-post reads, plus the same orphan deletion. The
 * queue consumer re-enqueues the command while `capped` is true, so one
 * request backfills an entire archive in chained batches.
 *
 * Orphan deletion can never be windowed: deleted posts simply vanish from
 * the Content API, so "what's missing" requires the full public id set.
 *
 * Politeness: PDS writes are spaced `sleepMs` apart and capped per batch at
 * `maxWrites` (which also keeps a batch inside per-invocation subrequest
 * limits — see limits.subrequests in wrangler.example.jsonc).
 */
import type { Env } from './env';
import type { GhostPost } from './ghost/types';
import { isSyndicatable } from './ghost/classify';
import { fetchAllPosts, fetchAllPostIds, fetchPostsUpdatedSince } from './ghost/content-api';
import { createSession, createPdsWriter } from './atproto/client';
import { getPublicationUri, listPostIds } from './state/kv';
import { processEvent, type SyncDeps } from './sync';

/** Tally of one reconcile pass; stored in KV and returned by the admin route. */
export interface ReconcileReport {
  mode: 'window' | 'full';
  created: number;
  updated: number;
  skipped: number;
  deleted: number;
  /** true = the write cap or a write failure ended the pass early; more work remains. */
  capped: boolean;
  /** Write failures encountered (the pass stops at the first one). */
  errors: number;
  /** When errors occurred: seconds the chain should wait before the next batch. */
  retryAfterS?: number;
  /** Force mode only: where the next chained batch must resume (posts index). */
  nextOffset?: number;
}

/** Knobs shared by both modes. */
export interface ReconcileOptions {
  /** Cap on PDS writes per run so huge backfills fit in one invocation's limits. */
  maxWrites: number;
  /** Politeness delay between PDS writes. */
  sleepMs: number;
}

/** How far back the daily windowed repair looks for missed publish/edit webhooks. */
export const WINDOW_DAYS = 3;

/** Resolve after `ms` (skipped entirely when 0, so tests run instantly). */
const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * How long the chain should back off after a write failure, in seconds.
 *
 * Bluesky-hosted PDSes enforce a write quota of 35,000 points per FIXED
 * 24-hour window (create=3, update=2, delete=1; measured from live 429
 * headers: `ratelimit-policy: 35000;w=86400`). Fixed means all-or-nothing:
 * a drained window stays at zero until one reset instant, then refills
 * entirely — so a large backfill WILL eventually see 429s, and recovery is
 * never gradual. The 429's `ratelimit-reset` epoch header is honored,
 * clamped to [60s, 1h]: the reset can be many hours out, and rather than
 * trusting a far-future value we retry hourly — a wake-up against a
 * still-drained window costs ~3 points, so bounded polling is nearly free
 * and self-corrects the moment the window reopens. Non-429 failures get a
 * conservative 10 minutes.
 *
 * NOTE: this quota is account-wide — shared with the owner's own posting.
 * That's why batches stop at the FIRST 429 instead of hammering on.
 */
export function writeFailureDelay(err: unknown, nowMs: number): number {
  const e = err as { status?: number; headers?: Record<string, string> };
  if (e?.status === 429) {
    const reset = Number(e.headers?.['ratelimit-reset']);
    if (Number.isFinite(reset)) {
      return Math.min(Math.max(Math.ceil(reset - nowMs / 1000), 60), 3600);
    }
  }
  return 600;
}

/**
 * Record a write failure on the report and mark the pass as unfinished.
 * The pass stops at the first failure rather than hammering a rate-limited
 * PDS: everything written so far is safely recorded (idempotent), and the
 * chained next batch picks up from current state after the backoff.
 */
function recordFailure(report: ReconcileReport, err: unknown, context: string): void {
  report.errors++;
  report.capped = true;
  report.retryAfterS = writeFailureDelay(err, Date.now());
  console.error(`reconcile write failed (${context}); pausing batch for ${report.retryAfterS}s`, err);
}

/** Mutable write counter shared between a pass's upsert loop and its orphan sweep. */
interface WriteBudget {
  writes: number;
}

/**
 * Delete KV-known posts that are no longer in `liveIds` (Ghost's current
 * public posts). Shared by both modes; respects the shared write budget.
 */
async function deleteOrphans(
  liveIds: Set<string>,
  deps: SyncDeps,
  opts: ReconcileOptions,
  report: ReconcileReport,
  budget: WriteBudget
): Promise<void> {
  for (const id of await listPostIds(deps.kv)) {
    if (liveIds.has(id)) continue;
    if (budget.writes >= opts.maxWrites) {
      report.capped = true;
      break;
    }
    try {
      if ((await processEvent({ kind: 'delete', postId: id }, deps)) === 'deleted') {
        report.deleted++;
        budget.writes++;
        await sleep(opts.sleepMs);
      }
    } catch (err) {
      recordFailure(report, err, `delete ${id}`);
      break;
    }
  }
}

/**
 * Daily repair: hash-checked upserts for posts updated in the window (catches
 * missed publish/edit webhooks), plus orphan deletion against the full public
 * id set. Cost is O(window) + one ids-only enumeration, regardless of
 * archive size.
 */
export async function reconcileWindow(
  recentPosts: GhostPost[],
  allPublicIds: Set<string>,
  deps: SyncDeps,
  opts: ReconcileOptions
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    mode: 'window', created: 0, updated: 0, skipped: 0, deleted: 0, capped: false, errors: 0,
  };
  const budget: WriteBudget = { writes: 0 };

  for (const post of recentPosts) {
    if (budget.writes >= opts.maxWrites) {
      report.capped = true;
      break;
    }
    try {
      // A post edited to non-public inside the window gets its record removed.
      const result = isSyndicatable(post)
        ? await processEvent({ kind: 'upsert', post }, deps)
        : await processEvent({ kind: 'delete', postId: post.id }, deps);
      if (result === 'skipped' || result === 'noop') {
        report.skipped++;
      } else {
        if (result === 'created') report.created++;
        else if (result === 'updated') report.updated++;
        else report.deleted++;
        budget.writes++;
        await sleep(opts.sleepMs);
      }
    } catch (err) {
      recordFailure(report, err, `window upsert ${post.id}`);
      break;
    }
  }

  if (report.errors === 0) await deleteOrphans(allPublicIds, deps, opts, report, budget);
  return report;
}

/**
 * Backfill / deep repair: create records for posts KV has never seen,
 * skipping already-synced posts by id alone (zero KV reads for them —
 * content drift on synced posts is the windowed path's job), then orphan
 * deletion. Returns `capped: true` while more of the archive remains, which
 * is the queue consumer's signal to chain another batch.
 *
 * With `force`, known posts are NOT skipped: every record is rewritten in
 * place (same rkey) with a forced upsert. This is the migration tool for
 * changes that live outside the content hash — e.g. after the publication
 * rkey changes, every document's `site` reference must be rewritten.
 *
 * Force mode MUST resume via `offset` (posts already handled by earlier
 * batches in this chain): unlike normal full mode, force has no
 * skip-known-ids to make progress inherent, so without the offset every
 * chained batch would rewrite the same first `maxWrites` posts forever —
 * burning the account's PDS write quota in a loop (this happened). A capped
 * force report carries `nextOffset` for the chain to pass back in.
 */
export async function reconcileFull(
  allPosts: GhostPost[],
  deps: SyncDeps,
  opts: ReconcileOptions,
  force = false,
  offset = 0
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    mode: 'full', created: 0, updated: 0, skipped: 0, deleted: 0, capped: false, errors: 0,
  };
  const budget: WriteBudget = { writes: 0 };
  const known = new Set(await listPostIds(deps.kv));
  const posts = allPosts.filter(isSyndicatable);
  // Only force mode consumes the offset; normal mode's skip-known already
  // guarantees forward progress across batches.
  const startAt = force ? Math.min(offset, posts.length) : 0;
  let processed = startAt;

  for (const post of posts.slice(startAt)) {
    if (!force && known.has(post.id)) {
      report.skipped++;
      processed++;
      continue;
    }
    if (budget.writes >= opts.maxWrites) {
      report.capped = true;
      if (force) report.nextOffset = processed;
      break;
    }
    try {
      const result = await processEvent({ kind: 'upsert', post, force }, deps);
      if (result === 'skipped') {
        report.skipped++;
      } else {
        if (result === 'created') report.created++;
        else if (result === 'updated') report.updated++;
        budget.writes++;
        await sleep(opts.sleepMs);
      }
      processed++;
    } catch (err) {
      recordFailure(report, err, `full upsert ${post.id}`);
      // resume AT the failed post next batch — it hasn't been written
      if (force) report.nextOffset = processed;
      break;
    }
  }

  if (report.errors === 0) await deleteOrphans(new Set(posts.map((p) => p.id)), deps, opts, report, budget);
  return report;
}

/**
 * Entry point used by the cron trigger (windowed), the admin route
 * (windowed, or `?full=1[&force=1]`), and queued backfill batches. Fetches
 * the inputs for the requested mode, builds the live SyncDeps (PDS session
 * with DID assertion), runs the pass, and logs the report.
 *
 * Throws if the publication record hasn't been set up yet — documents
 * can't reference a publication that doesn't exist.
 */
export async function reconcile(
  env: Env,
  opts: { full?: boolean; maxWrites?: number; force?: boolean; offset?: number } = {}
): Promise<ReconcileReport> {
  const publicationUri = await getPublicationUri(env.STATE);
  if (!publicationUri) {
    throw new Error('publication record not set up; POST /_atproto/setup first');
  }
  const agent = await createSession(env);
  const deps: SyncDeps = {
    writer: createPdsWriter(agent, env),
    kv: env.STATE,
    publicationUri,
    ghostUrl: env.GHOST_URL,
  };
  const runOpts: ReconcileOptions = { maxWrites: opts.maxWrites ?? 200, sleepMs: 200 };

  const report = opts.full
    ? await reconcileFull(await fetchAllPosts(env), deps, runOpts, opts.force ?? false, opts.offset ?? 0)
    : await reconcileWindow(
        await fetchPostsUpdatedSince(env, WINDOW_DAYS),
        await fetchAllPostIds(env),
        deps,
        runOpts
      );
  console.log('reconcile complete', JSON.stringify(report));
  return report;
}
