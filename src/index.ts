/**
 * Worker entry point. Start reading here.
 *
 * The big picture: this Worker connects a Ghost blog to the AT Protocol
 * network (the one behind Bluesky). Ghost tells us about posts via
 * webhooks; we mirror each public post as a `site.standard.document`
 * record in the blog owner's own data repo, and serve the verification
 * endpoints that let apps trust those records. If terms like DID, PDS,
 * record, or rkey are new to you, the README's two-minute crash course
 * explains them all, and the code will make much more sense afterwards.
 *
 * Cloudflare invokes a Worker through named triggers; this file routes the
 * three we use to the modules that do the work:
 *
 *   fetch:     bridge routes (webhook receiver, well-known verification,
 *               admin setup/reconcile) with everything else proxied to the
 *               Ghost origin via handleProxy
 *   queue:     consumes sync events (PDS writes with retry) and reconcile
 *               control messages (long backfills that self-chain)
 *   scheduled: the daily windowed reconcile (the safety net for Ghost's
 *               fire-once webhooks)
 *
 * Route map (everything under /_atproto/ requires the admin bearer token
 * except the webhook, which authenticates via its HMAC signature):
 *
 *   POST /_atproto/ghost-webhook               verify + enqueue
 *   GET  /.well-known/site.standard.publication publication AT-URI (public)
 *   POST /_atproto/setup                       create/update publication
 *   POST /_atproto/reconcile[?full=1][&force=1][&max=N]  repair (inline) / backfill or migration rewrite (queued)
 *   GET  /_atproto/reconcile                   latest stored report
 *   *                                          proxy to Ghost, inject link tags
 */
import type { Env, QueueMessage, SyncEvent } from './env';
import { handleWebhook } from './handlers/webhook';
import { handleWellKnown } from './handlers/wellknown';
import { handleProxy } from './handlers/proxy';
import { handleSetup, isAuthorizedAdmin } from './handlers/setup';
import { reconcile } from './reconcile';
import { createSession, createPdsWriter } from './atproto/client';
import { getPublicationUri, setLastReconcileReport, getLastReconcileReport } from './state/kv';
import { processEvent, type SyncDeps } from './sync';

export default {
  /**
   * HTTP dispatch. Bridge routes are matched exactly; anything else falls
   * through to the fail-open origin proxy, so an unrecognized path can
   * never break the blog.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/_atproto/ghost-webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }
    if (pathname === '/.well-known/site.standard.publication') {
      return handleWellKnown(env);
    }
    if (pathname === '/_atproto/setup' && request.method === 'POST') {
      return handleSetup(request, env);
    }
    if (pathname === '/_atproto/reconcile') {
      if (!isAuthorizedAdmin(request, env)) return new Response('unauthorized', { status: 401 });

      // GET: latest report from any mode (windowed, backfill batch, cron)
      if (request.method === 'GET') {
        const last = await getLastReconcileReport(env.STATE);
        return last ? Response.json(last) : new Response('no reconcile has completed yet', { status: 404 });
      }
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

      const max = Number(url.searchParams.get('max'));
      const maxWrites = Number.isFinite(max) && max > 0 ? Math.min(max, 1000) : undefined;

      // Full mode (archive backfill) runs for many minutes, far past what an
      // HTTP request can hold open, so it runs in the queue consumer and
      // re-enqueues itself until the archive is done. Poll with GET.
      if (url.searchParams.get('full') === '1') {
        // &force=1 rewrites every record even if unchanged: the migration
        // path after e.g. a publication rkey change.
        const force = url.searchParams.get('force') === '1';
        await env.EVENTS.send({ kind: 'reconcile', full: true, maxWrites, force });
        return Response.json(
          {
            status: 'queued',
            note: 'backfill runs in the background and chains batches until "capped" is false; poll GET /_atproto/reconcile for the latest report, or watch `wrangler tail`',
          },
          { status: 202 }
        );
      }

      // Windowed mode is ~a minute at most; run it inline for immediate feedback.
      try {
        const report = await reconcile(env, { maxWrites });
        await setLastReconcileReport(env.STATE, report);
        return Response.json(report);
      } catch (err) {
        return new Response(`reconcile failed: ${(err as Error).message}`, { status: 500 });
      }
    }
    return handleProxy(request, env);
  },

  /**
   * Queue consumer. Handles two message families:
   *
   * Reconcile commands run a full pass each; a capped pass re-enqueues the
   * same command (with a short delay) so the backfill chains itself to
   * completion. Failures retry after 2 minutes, which is safe because every pass
   * is idempotent.
   *
   * Sync events share one PDS session per batch. Each message acks or
   * retries independently: one failing post doesn't block the rest. No
   * event is ever allowed to die to the queue's max_retries: near the
   * ceiling, a fresh copy is re-enqueued instead (idempotent, so safe),
   * and the daily cron remains the backstop of last resort.
   */
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    const postMessages: Message<QueueMessage>[] = [];

    for (const message of batch.messages) {
      if (message.body.kind !== 'reconcile') {
        postMessages.push(message);
        continue;
      }
      try {
        const report = await reconcile(env, {
          full: message.body.full,
          maxWrites: message.body.maxWrites,
          force: message.body.force,
          offset: message.body.offset,
        });
        await setLastReconcileReport(env.STATE, report);
        if (report.capped) {
          // More archive left: chain the next batch. After a write failure
          // (PDS rate limit etc.) the report carries the backoff to honor.
          // Force chains resume at nextOffset; without it they'd rewrite
          // the same posts forever (see reconcileFull).
          await env.EVENTS.send(
            { ...message.body, offset: report.nextOffset ?? message.body.offset },
            { delaySeconds: report.retryAfterS ?? 5 }
          );
        }
        console.log('reconcile batch done', JSON.stringify(report));
        message.ack();
      } catch (err) {
        // Setup-phase failure (Ghost API, PDS login…). Never let max_retries
        // silently kill the chain: near the retry ceiling, re-enqueue a
        // fresh copy (resets the attempt counter) and ack this one. Safe
        // because every pass is idempotent; visible via logs and the report.
        console.error('reconcile batch failed', err);
        if (message.attempts >= 4) {
          console.error('reconcile batch near retry limit; re-enqueueing a fresh chain link in 10min');
          await env.EVENTS.send(message.body, { delaySeconds: 600 });
          message.ack();
        } else {
          message.retry({ delaySeconds: 120 });
        }
      }
    }

    if (postMessages.length === 0) return;

    // A sync event must never be silently dropped: Ghost fires each webhook
    // exactly once, so losing the queue message loses the post until the
    // nightly cron notices. Near the queue's retry ceiling we re-enqueue a
    // fresh copy (which resets the attempt counter) instead of letting
    // max_retries discard the message, which is safe because processEvent is
    // idempotent. Added after the 2026-07-24 incident, where a transient
    // session failure burned all five retries and two confirmed-delivered
    // webhooks vanished.
    const retryOrResurrect = async (message: Message<QueueMessage>, delaySeconds: number) => {
      if (message.attempts >= 4) {
        console.error('post event near retry limit; re-enqueueing a fresh copy in 10min');
        await env.EVENTS.send(message.body, { delaySeconds: 600 });
        message.ack();
      } else {
        message.retry({ delaySeconds });
      }
    };

    // Setup-phase failures (PDS login, publication not yet configured, KV
    // trouble) affect every message equally; defer them all rather than
    // throwing, which would spend one of each message's five queue retries.
    let deps: SyncDeps;
    try {
      const publicationUri = await getPublicationUri(env.STATE);
      if (!publicationUri) {
        throw new Error('publication record not set up; POST /_atproto/setup first');
      }
      deps = {
        writer: createPdsWriter(await createSession(env), env),
        kv: env.STATE,
        publicationUri,
        ghostUrl: env.GHOST_URL,
      };
    } catch (err) {
      console.error('queue setup failed; deferring post events', err);
      for (const message of postMessages) await retryOrResurrect(message, 120);
      return;
    }

    for (const message of postMessages) {
      try {
        const result = await processEvent(message.body as SyncEvent, deps);
        console.log('queue event', message.body.kind, result);
        message.ack();
      } catch (err) {
        console.error('queue event failed', err);
        await retryOrResurrect(message, 60);
      }
    }
  },

  /**
   * Daily cron: the windowed reconcile. Deliberately NOT the archive
   * backfill; full sweeps only happen on explicit operator request. The
   * report is stored for GET /_atproto/reconcile; failures are logged and
   * left for the next day's run (or a manual pass).
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      reconcile(env)
        .then((report) => setLastReconcileReport(env.STATE, report))
        .catch((err) => console.error('scheduled reconcile failed', err))
    );
  },
} satisfies ExportedHandler<Env, QueueMessage>;
