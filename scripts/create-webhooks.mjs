#!/usr/bin/env node
// Creates the four Ghost webhooks (signed with GHOST_WEBHOOK_SECRET) via the Admin API.
// The Admin UI cannot set webhook secrets; unsigned webhooks are rejected by the Worker.
//
// Usage:
//   GHOST_ADMIN_API_KEY=<id>:<hexsecret> GHOST_WEBHOOK_SECRET=<secret> \
//     node scripts/create-webhooks.mjs https://blog.example.org https://blog.example.org/_atproto/ghost-webhook
//
// GHOST_ADMIN_API_KEY comes from the same custom integration as the Content API key
// (Ghost Admin → Settings → Advanced → Integrations → your integration → Admin API key).

import crypto from 'node:crypto';

const [ghostUrl, targetUrl] = process.argv.slice(2);
const adminKey = process.env.GHOST_ADMIN_API_KEY;
const webhookSecret = process.env.GHOST_WEBHOOK_SECRET;
if (!ghostUrl || !targetUrl || !adminKey || !webhookSecret) {
  console.error('Missing args or env. See usage comment at the top of this script.');
  process.exit(1);
}

const [id, secret] = adminKey.split(':');
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = b64url({ alg: 'HS256', typ: 'JWT', kid: id });
const payload = b64url({ iat: now, exp: now + 300, aud: '/admin/' });
const signature = crypto
  .createHmac('sha256', Buffer.from(secret, 'hex'))
  .update(`${header}.${payload}`)
  .digest('base64url');
const token = `${header}.${payload}.${signature}`;

const events = ['post.published', 'post.published.edited', 'post.unpublished', 'post.deleted'];
for (const event of events) {
  const res = await fetch(new URL('/ghost/api/admin/webhooks/', ghostUrl), {
    method: 'POST',
    headers: {
      authorization: `Ghost ${token}`,
      'content-type': 'application/json',
      'accept-version': 'v5.0',
    },
    body: JSON.stringify({
      webhooks: [{ event, target_url: targetUrl, name: `standard.site ${event}`, secret: webhookSecret }],
    }),
  });
  const body = await res.text();
  console.log(event, res.status, res.ok ? 'ok' : body);
}
