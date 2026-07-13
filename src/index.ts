import type { Env, SyncEvent } from './env';
import { handleWebhook } from './handlers/webhook';
import { handleWellKnown } from './handlers/wellknown';
import { handleProxy } from './handlers/proxy';
import { handleSetup, isAuthorizedAdmin } from './handlers/setup';
import { reconcile } from './reconcile';
import { createSession, createPdsWriter } from './atproto/client';
import { getPublicationUri } from './state/kv';
import { processEvent, type SyncDeps } from './sync';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/_atproto/ghost-webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }
    if (pathname === '/.well-known/site.standard.publication') {
      return handleWellKnown(env);
    }
    if (pathname === '/_atproto/setup' && request.method === 'POST') {
      return handleSetup(request, env);
    }
    if (pathname === '/_atproto/reconcile' && request.method === 'POST') {
      if (!isAuthorizedAdmin(request, env)) return new Response('unauthorized', { status: 401 });
      try {
        const report = await reconcile(env);
        return Response.json(report);
      } catch (err) {
        return new Response(`reconcile failed: ${(err as Error).message}`, { status: 500 });
      }
    }
    return handleProxy(request, env);
  },

  async queue(batch: MessageBatch<SyncEvent>, env: Env): Promise<void> {
    const publicationUri = await getPublicationUri(env.STATE);
    if (!publicationUri) {
      console.error('queue: publication record not set up; retrying batch later');
      batch.retryAll({ delaySeconds: 300 });
      return;
    }
    const agent = await createSession(env);
    const deps: SyncDeps = {
      writer: createPdsWriter(agent, env),
      kv: env.STATE,
      publicationUri,
      ghostUrl: env.GHOST_URL,
    };
    for (const message of batch.messages) {
      try {
        const result = await processEvent(message.body, deps);
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
      reconcile(env).catch((err) => console.error('scheduled reconcile failed', err))
    );
  },
} satisfies ExportedHandler<Env, SyncEvent>;
