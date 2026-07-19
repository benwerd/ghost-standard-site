#!/usr/bin/env node
// Sends ONE signed Ghost-style webhook for ONE real post through the Worker —
// the lightest end-to-end test. No Ghost webhook config, no cron, no backfill.
//
//   npm run test-post                                  # syndicate your most recent post, via local wrangler dev
//   npm run test-post -- --slug my-post                # pick a specific post
//   npm run test-post -- --delete                      # remove that post's record again (undo)
//   npm run test-post -- --url https://yourdomain.com/_atproto/ghost-webhook   # against production
//
// Reruns REGENERATE the record in place (same rkey): the request carries
// ?force=1, which tells the Worker to bypass its content-hash debounce.
//
// The post is fetched from your real Ghost Content API, wrapped in the same
// {event, post: {current}} envelope Ghost sends, signed with
// GHOST_WEBHOOK_SECRET exactly like Ghost signs it, and POSTed to the Worker.
// Whatever Worker receives it (local dev or production) will write/delete a
// REAL record on your PDS via its queue consumer.

import crypto from 'node:crypto';
import { readDevVars, DEV_VARS } from './dev-vars.mjs';

const args = process.argv.slice(2);
const doDelete = args.includes('--delete');
// Value following a --flag argument, or undefined if the flag is absent.
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const slug = argValue('--slug');
const target = new URL(argValue('--url') ?? 'http://localhost:8787/_atproto/ghost-webhook');
if (!doDelete) target.searchParams.set('force', '1'); // rerun = regenerate, not 'skipped'

const vars = readDevVars();
for (const key of ['GHOST_URL', 'GHOST_CONTENT_API_KEY', 'GHOST_WEBHOOK_SECRET']) {
  if (!vars[key] || /replace|example\.com|xxxx/i.test(vars[key])) {
    console.error(`${key} in ${DEV_VARS} is missing or still a placeholder.`);
    process.exit(1);
  }
}

// Fetch a real post so the record matches a page that actually exists.
const api = new URL(
  slug ? `/ghost/api/content/posts/slug/${slug}/` : '/ghost/api/content/posts/',
  vars.GHOST_URL
);
api.searchParams.set('key', vars.GHOST_CONTENT_API_KEY);
api.searchParams.set('include', 'tags');
if (!slug) {
  api.searchParams.set('limit', '1');
  api.searchParams.set('order', 'published_at desc');
}
const apiRes = await fetch(api);
if (!apiRes.ok) {
  console.error(`Ghost Content API error ${apiRes.status}: ${await apiRes.text()}`);
  process.exit(1);
}
const post = (await apiRes.json()).posts?.[0];
if (!post) {
  console.error(slug ? `No post found with slug "${slug}".` : 'No posts found.');
  process.exit(1);
}
post.status ??= 'published';

const body = JSON.stringify(
  doDelete
    ? { event: 'post.unpublished', post: { current: { ...post, status: 'draft' } } }
    : { event: 'post.published', post: { current: post } }
);
const ts = Date.now();
const hmac = crypto.createHmac('sha256', vars.GHOST_WEBHOOK_SECRET).update(`${body}${ts}`).digest('hex');

console.error(`${doDelete ? 'Deleting record for' : 'Syndicating'} "${post.title}" (${post.slug})`);
console.error(`→ POST ${target}`);
const res = await fetch(target, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-ghost-signature': `sha256=${hmac}, t=${ts}`,
  },
  body,
});
console.log(res.status, await res.text());
if (res.status === 202) {
  console.error(
    'Queued. The queue consumer processes it within seconds — check `wrangler tail` (prod) ' +
      'or the wrangler dev output (local) for the result.'
  );
}
