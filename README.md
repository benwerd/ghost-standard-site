# ghost-standard-site

Syndicates a Ghost blog to AT Protocol using the
[standard.site](https://standard.site) lexicons. Every public published post
becomes a `site.standard.document` record in your own atproto repo, under
your own DID; the site is one `site.standard.publication` record. A
Cloudflare Worker routed in front of your domain:

- receives Ghost webhooks (`POST /_atproto/ghost-webhook`, HMAC-verified) and
  enqueues them on a Cloudflare Queue;
- a queue consumer writes records to your PDS with automatic retry;
- proxies all other traffic to the Ghost origin, injecting
  `<link rel="site.standard.document">` (and the publication hint tag) into
  post pages via HTMLRewriter;
- serves `GET /.well-known/site.standard.publication` (the authoritative
  publication verification endpoint);
- runs a daily reconciliation cron that diffs the Ghost Content API against
  KV and repairs drift — which doubles as the archive backfill.

**Content policy:** metadata + excerpt only. The canonical content lives at
your blog; full post bodies are never syndicated.

**Configuration policy:** no identities, domains, or auth material are
committed to this repo. Everything lives in `.dev.vars` (gitignored) locally
and `wrangler secret put` in production. `wrangler.jsonc` is gitignored and
**generated** — `scripts/configure.mjs` renders it from
`wrangler.example.jsonc`, deriving the route pattern and zone name from
`GHOST_URL` (the Worker necessarily fronts the same domain the blog lives
on) and taking the KV namespace id from `.dev.vars`. It runs automatically
before `npm run dev` and `npm run deploy`; you never edit wrangler.jsonc by
hand.

## Configuration reference

| Name | Kind | Description |
|---|---|---|
| `GHOST_WEBHOOK_SECRET` | secret | Long random string; signs Ghost webhooks and doubles as the admin bearer token |
| `ATPROTO_APP_PASSWORD` | secret | App password for your atproto account |
| `GHOST_CONTENT_API_KEY` | secret | From your Ghost custom integration |
| `ATPROTO_HANDLE` | config | e.g. `yourdomain.com` |
| `ATPROTO_DID` | config | Your DID; the Worker refuses to write if the session resolves to anything else |
| `ATPROTO_PDS_URL` | config | Your PDS endpoint (find it in your DID document, e.g. via plc.directory) |
| `GHOST_URL` | config | Canonical base URL of the blog, no trailing slash |
| `PUBLICATION_NAME` | config, optional | Overrides the publication name pulled from Ghost settings |
| `KV_NAMESPACE_ID` | deploy-time only | Consumed by `scripts/configure.mjs`, never seen by the Worker |

In production set the runtime values (everything except `KV_NAMESPACE_ID`)
with `npx wrangler secret put <NAME>` so nothing lands in tracked files.

## Setup

1. `npm install`
2. `cp .dev.vars.example .dev.vars` and fill everything in. Your blog's
   domain (from `GHOST_URL`) must be a Cloudflare zone on your account,
   orange-clouded.
3. `npx wrangler kv namespace create STATE` → put the id in `.dev.vars` as
   `KV_NAMESPACE_ID` (then `npm run configure`, or let dev/deploy do it).
4. `npx wrangler queues create ghost-standard-site-events`
5. Set all runtime secrets and config values:
   ```bash
   for n in GHOST_WEBHOOK_SECRET ATPROTO_APP_PASSWORD GHOST_CONTENT_API_KEY \
            ATPROTO_HANDLE ATPROTO_DID ATPROTO_PDS_URL GHOST_URL; do
     npx wrangler secret put $n
   done
   ```
6. `npm run deploy` (regenerates `wrangler.jsonc`, then `wrangler deploy`)
7. Create the publication record:
   ```bash
   curl -X POST https://yourdomain.com/_atproto/setup -H "Authorization: Bearer $GHOST_WEBHOOK_SECRET"
   ```
   Confirm: `curl https://yourdomain.com/.well-known/site.standard.publication`
   returns the AT-URI. (Ghost's site icon becomes the publication icon — make
   sure it's square and ≥256×256 in Ghost settings, then re-run setup if you
   change it.)
8. Create the webhooks. The Ghost Admin UI can't set webhook secrets, and
   Ghost only signs requests when a secret exists, so use the Admin API:
   ```bash
   GHOST_ADMIN_API_KEY=... GHOST_WEBHOOK_SECRET=... \
     node scripts/create-webhooks.mjs https://yourdomain.com https://yourdomain.com/_atproto/ghost-webhook
   ```
9. Backfill the archive — repeat until the response shows `"capped": false`
   (each run writes at most 200 records, ~200ms apart, to be polite to the
   PDS):
   ```bash
   curl -X POST https://yourdomain.com/_atproto/reconcile -H "Authorization: Bearer $GHOST_WEBHOOK_SECRET"
   ```

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values (gitignored)
npm run dev                       # generates wrangler.jsonc, proxies localhost:8787 → GHOST_URL
npm test                          # vitest in workerd via @cloudflare/vitest-pool-workers
npm run typecheck
```

## Manual end-to-end verification (definition of done)

1. Publish a test post in Ghost.
2. The record exists (find the rkey in the Worker's queue-consumer logs, or
   read KV key `post:{ghost_post_id}`):
   ```bash
   curl "$ATPROTO_PDS_URL/xrpc/com.atproto.repo.getRecord?repo=$ATPROTO_DID&collection=site.standard.document&rkey=<rkey>"
   ```
   Also browsable at `https://pdsls.dev/at/<your-did>/site.standard.document`.
3. `curl -s https://yourdomain.com/<slug>/ | grep site.standard` shows both
   link tags. (KV is eventually consistent — allow up to a minute after
   publish.)
4. Post the URL in Bluesky; the link should render as an enhanced article
   card. Records have passed third-party validators while silently failing
   Bluesky's crawler — **the Bluesky card is the real test.**
5. Check the post appears in Leaflet / pckt / Offprint / Heron discovery.

## Operational notes

- **Everything fails open.** KV miss → no tags, page untouched; PDS down →
  queue retries (5×, then the daily cron repairs); any error in injection
  lookup → origin response passes through. The blog never degrades.
- Record writes use `validate: false` because the PDS doesn't host the
  site.standard lexicons; server-side validation would reject them otherwise.
- KV is eventually consistent (~60s): a link tag may appear up to a minute
  after publish. Acceptable by design; if that ever stops being acceptable,
  the flagged alternative is D1, not a silent workaround.
- Ghost fires `post.published.edited` on *every* save of a published post; a
  SHA-256 hash over material fields (title, path, excerpt, publish date,
  tags, feature image) debounces actual PDS writes.
- rkeys are deterministic TIDs derived from `published_at` plus 10 bits of
  post-id hash (collision-safe for bulk imports sharing a timestamp), so
  webhook replays and reconciliation are idempotent. Slug changes keep the
  same record (same rkey) and update its `path` + both KV mappings.
- The Worker asserts at session start that the authenticated DID equals
  `ATPROTO_DID` and refuses to write otherwise.
- Non-public posts (drafts, members-only, email-only, pages) never get
  records; a published post edited to non-public visibility gets its record
  deleted.
