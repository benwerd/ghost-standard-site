import type { Env } from './env';
import type { GhostPost } from './ghost/types';
import { isSyndicatable } from './ghost/classify';
import { fetchAllPosts, fetchAllPostIds, fetchPostsUpdatedSince } from './ghost/content-api';
import { createSession, createPdsWriter } from './atproto/client';
import { getPublicationUri, listPostIds } from './state/kv';
import { processEvent, type SyncDeps } from './sync';

export interface ReconcileReport {
  mode: 'window' | 'full';
  created: number;
  updated: number;
  skipped: number;
  deleted: number;
  capped: boolean;
}

export interface ReconcileOptions {
  /** Cap on PDS writes per run so huge backfills fit in one invocation's limits. */
  maxWrites: number;
  /** Politeness delay between PDS writes. */
  sleepMs: number;
}

/** How far back the daily windowed repair looks for missed publish/edit webhooks. */
export const WINDOW_DAYS = 3;

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

interface WriteBudget {
  writes: number;
}

/** Delete KV-known posts that are no longer public in Ghost. Shared by both modes. */
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
    if ((await processEvent({ kind: 'delete', postId: id }, deps)) === 'deleted') {
      report.deleted++;
      budget.writes++;
      await sleep(opts.sleepMs);
    }
  }
}

/**
 * Daily repair: hash-checked upserts for posts updated in the window (catches
 * missed publish/edit webhooks), plus orphan deletion against the full public
 * id set (deletions can't be windowed — deleted posts vanish from the API).
 * Cost is O(window) + one ids-only enumeration, regardless of archive size.
 */
export async function reconcileWindow(
  recentPosts: GhostPost[],
  allPublicIds: Set<string>,
  deps: SyncDeps,
  opts: ReconcileOptions
): Promise<ReconcileReport> {
  const report: ReconcileReport = { mode: 'window', created: 0, updated: 0, skipped: 0, deleted: 0, capped: false };
  const budget: WriteBudget = { writes: 0 };

  for (const post of recentPosts) {
    if (budget.writes >= opts.maxWrites) {
      report.capped = true;
      break;
    }
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
  }

  await deleteOrphans(allPublicIds, deps, opts, report, budget);
  return report;
}

/**
 * Backfill / deep repair: create records for posts KV has never seen, skipping
 * already-synced posts by id alone (zero KV reads for them — content drift on
 * synced posts is the windowed path's job), then orphan deletion.
 *
 * With `force`, known posts are NOT skipped: every record is rewritten in
 * place (same rkey) with a forced upsert. This is the migration tool for
 * changes that live outside the content hash — e.g. after the publication
 * rkey changes, every document's `site` reference must be rewritten.
 */
export async function reconcileFull(
  allPosts: GhostPost[],
  deps: SyncDeps,
  opts: ReconcileOptions,
  force = false
): Promise<ReconcileReport> {
  const report: ReconcileReport = { mode: 'full', created: 0, updated: 0, skipped: 0, deleted: 0, capped: false };
  const budget: WriteBudget = { writes: 0 };
  const known = new Set(await listPostIds(deps.kv));
  const posts = allPosts.filter(isSyndicatable);

  for (const post of posts) {
    if (!force && known.has(post.id)) {
      report.skipped++;
      continue;
    }
    if (budget.writes >= opts.maxWrites) {
      report.capped = true;
      break;
    }
    const result = await processEvent({ kind: 'upsert', post, force }, deps);
    if (result === 'skipped') {
      report.skipped++;
    } else {
      if (result === 'created') report.created++;
      else if (result === 'updated') report.updated++;
      budget.writes++;
      await sleep(opts.sleepMs);
    }
  }

  await deleteOrphans(new Set(posts.map((p) => p.id)), deps, opts, report, budget);
  return report;
}

/** Entry point for the cron trigger (windowed) and the admin route (windowed, or ?full=1[&force=1]). */
export async function reconcile(
  env: Env,
  opts: { full?: boolean; maxWrites?: number; force?: boolean } = {}
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
    ? await reconcileFull(await fetchAllPosts(env), deps, runOpts, opts.force ?? false)
    : await reconcileWindow(
        await fetchPostsUpdatedSince(env, WINDOW_DAYS),
        await fetchAllPostIds(env),
        deps,
        runOpts
      );
  console.log('reconcile complete', JSON.stringify(report));
  return report;
}
