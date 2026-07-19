#!/usr/bin/env node
// Creates the four Ghost webhooks (signed with GHOST_WEBHOOK_SECRET) via the Admin API.
// The Admin UI cannot set webhook secrets; unsigned webhooks are rejected by the Worker.
//
// Usage:
//   GHOST_ADMIN_API_KEY=<id>:<hexsecret> GHOST_WEBHOOK_SECRET=<secret> \
//     node scripts/create-webhooks.mjs <ADMIN-URL> <TARGET-URL>
//
//   <ADMIN-URL>  where Ghost Admin lives. On Ghost(Pro) this is your *.ghost.io
//                admin domain (the one in your browser's address bar when logged
//                into Ghost Admin, e.g. https://your-site.ghost.io) — the Admin
//                API is NOT served on your custom domain, it 302s there, and a
//                redirected POST turns into a bodyless GET and fails with 404.
//                Self-hosted: same as your site URL.
//   <TARGET-URL> the webhook receiver on your real domain,
//                e.g. https://blog.example.org/_atproto/ghost-webhook
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

// Ghost Admin API keys are '<id>:<hexsecret>'; the id becomes the JWT kid,
// the secret (hex-decoded) signs it. See https://docs.ghost.org/admin-api/#token-authentication
const [id, secret] = adminKey.split(':');
// base64url-encode a JSON value (JWT header/payload segments)
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
      // no accept-version header: Ghost serves the current version, and
      // pinning one gets 406 UPDATE_CLIENT once Ghost moves a major ahead
    },
    body: JSON.stringify({
      webhooks: [{ event, target_url: targetUrl, name: `standard.site ${event}`, secret: webhookSecret }],
    }),
    redirect: 'manual',
  });
  if ([301, 302, 307, 308].includes(res.status)) {
    const location = res.headers.get('location') ?? '(unknown)';
    console.error(
      `${event}: the Admin API redirected (${res.status}) to ${location}\n` +
        `Pass the admin domain as the first argument instead, e.g. ${new URL(location).origin}`
    );
    process.exit(1);
  }
  const body = await res.text();
  console.log(event, res.status, res.ok ? 'ok' : body);
}
