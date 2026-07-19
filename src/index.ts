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

      // Full mode (archive backfill) runs for many minutes — far past what an
      // HTTP request can hold open — so it runs in the queue consumer and
      // re-enqueues itself until the archive is done. Poll with GET.
      if (url.searchParams.get('full') === '1') {
        // &force=1 rewrites every record even if unchanged — the migration
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
        });
        await setLastReconcileReport(env.STATE, report);
        if (report.capped) {
          // more archive left: chain the next batch
          await env.EVENTS.send(message.body, { delaySeconds: 5 });
        }
        console.log('reconcile batch done', JSON.stringify(report));
        message.ack();
      } catch (err) {
        console.error('reconcile batch failed', err);
        message.retry({ delaySeconds: 120 });
      }
    }

    if (postMessages.length === 0) return;

    const publicationUri = await getPublicationUri(env.STATE);
    if (!publicationUri) {
      console.error('queue: publication record not set up; retrying later');
      for (const message of postMessages) message.retry({ delaySeconds: 300 });
      return;
    }
    const agent = await createSession(env);
    const deps: SyncDeps = {
      writer: createPdsWriter(agent, env),
      kv: env.STATE,
      publicationUri,
      ghostUrl: env.GHOST_URL,
    };
    for (const message of postMessages) {
      try {
        const result = await processEvent(message.body as SyncEvent, deps);
        console.log('queue event', message.body.kind, result);
        message.ack();
      } catch (err) {
        console.error('queue event failed', err);
        message.retry({ delaySeconds: 60 });
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      reconcile(env)
        .then((report) => setLastReconcileReport(env.STATE, report))
        .catch((err) => console.error('scheduled reconcile failed', err))
    );
  },
} satisfies ExportedHandler<Env, QueueMessage>;
