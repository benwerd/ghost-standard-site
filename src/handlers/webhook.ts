/**
 * POST /_atproto/ghost-webhook — the receiver Ghost delivers to.
 *
 * Responsibilities are deliberately minimal so the response is fast (Ghost
 * counts anything non-2xx, including timeouts, as a delivery failure and
 * never retries): verify the HMAC signature over the raw body, classify the
 * payload into a sync event, enqueue it, done. All PDS work happens later
 * in the queue consumer, which retries on failure.
 *
 * Status codes are meaningful to Ghost's failure accounting:
 * - 401: signature invalid/missing (unsigned webhooks are always rejected)
 * - 400: signed but unparseable body
 * - 200: valid but intentionally ignored (pages, drafts, member events…)
 * - 202: event queued
 */
import type { Env } from '../env';
import { verifyGhostSignature } from '../ghost/signature';
import { classifyWebhook } from '../ghost/classify';
import type { GhostWebhookBody } from '../ghost/types';

/**
 * Verify, classify, and enqueue one webhook delivery. The signature is
 * checked against the raw body text before any JSON parsing — the HMAC is
 * over the exact bytes Ghost sent.
 *
 * `?force=1` (signature still required) bypasses the content-hash debounce
 * downstream; only scripts/send-test-webhook.mjs sets it, so reruns of the
 * test path regenerate the record instead of reporting 'skipped'.
 */
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

  const force = new URL(request.url).searchParams.get('force') === '1';
  await env.EVENTS.send(event.kind === 'upsert' && force ? { ...event, force: true } : event);
  return new Response('queued', { status: 202 });
}
