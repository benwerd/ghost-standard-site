import type { Env } from '../env';
import { verifyGhostSignature } from '../ghost/signature';
import { classifyWebhook } from '../ghost/classify';
import type { GhostWebhookBody } from '../ghost/types';

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const valid = await verifyGhostSignature(
    rawBody,
    request.headers.get('x-ghost-signature'),
    env.GHOST_WEBHOOK_SECRET,
    Date.now()
  );
  if (!valid) return new Response('invalid signature', { status: 401 });

  let body: GhostWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response('malformed payload', { status: 400 });
  }

  const event = classifyWebhook(body);
  if (!event) return new Response('ignored', { status: 200 });

  // ?force=1 (signature still required) bypasses the content-hash debounce —
  // used by scripts/send-test-webhook.mjs to regenerate a record on rerun.
  const force = new URL(request.url).searchParams.get('force') === '1';
  await env.EVENTS.send(event.kind === 'upsert' && force ? { ...event, force: true } : event);
  return new Response('queued', { status: 202 });
}
