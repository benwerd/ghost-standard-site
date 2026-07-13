import type { Env } from './env';
import type { GhostPost } from './ghost/types';
import { isSyndicatable } from './ghost/classify';
import { fetchAllPosts } from './ghost/content-api';
import { createSession, createPdsWriter } from './atproto/client';
import { getPublicationUri, listPostIds } from './state/kv';
import { processEvent, type SyncDeps } from './sync';

export interface ReconcileReport {
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

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Diff the given Ghost posts against KV and repair. Pure of network fetching for testability. */
export async function reconcilePosts(
  allPosts: GhostPost[],
  deps: SyncDeps,
  opts: ReconcileOptions
): Promise<ReconcileReport> {
  const report: ReconcileReport = { created: 0, updated: 0, skipped: 0, deleted: 0, capped: false };
  const posts = allPosts.filter(isSyndicatable);
  let writes = 0;

  for (const post of posts) {
    if (writes >= opts.maxWrites) {
      report.capped = true;
      break;
    }
    const result = await processEvent({ kind: 'upsert', post }, deps);
    if (result === 'skipped') {
      report.skipped++;
    } else if (result === 'created' || result === 'updated') {
      report[result]++;
      writes++;
      await sleep(opts.sleepMs);
    }
  }

  const ghostIds = new Set(posts.map((p) => p.id));
  for (const id of await listPostIds(deps.kv)) {
    if (ghostIds.has(id)) continue;
    if (writes >= opts.maxWrites) {
      report.capped = true;
      break;
    }
    const result = await processEvent({ kind: 'delete', postId: id }, deps);
    if (result === 'deleted') {
      report.deleted++;
      writes++;
      await sleep(opts.sleepMs);
    }
  }
  return report;
}

/** Entry point for the cron trigger and the manual admin route. */
export async function reconcile(env: Env, maxWrites = 200): Promise<ReconcileReport> {
  const publicationUri = await getPublicationUri(env.STATE);
  if (!publicationUri) {
    throw new Error('publication record not set up; POST /_atproto/setup first');
  }
  const posts = await fetchAllPosts(env);
  const agent = await createSession(env);
  const deps: SyncDeps = {
    writer: createPdsWriter(agent, env),
    kv: env.STATE,
    publicationUri,
    ghostUrl: env.GHOST_URL,
  };
  const report = await reconcilePosts(posts, deps, { maxWrites, sleepMs: 200 });
  console.log('reconcile complete', JSON.stringify(report));
  return report;
}
