# ghost-standard-site

Syndicates [werd.io](https://werd.io) (Ghost) to AT Protocol using the
[standard.site](https://standard.site) lexicons. Every public published post
becomes a `site.standard.document` record in Ben's own repo
(`did:plc:77tdak46psveqneyegsdyc7l`); the site is one
`site.standard.publication` record. A Cloudflare Worker on `werd.io/*`:

- receives Ghost webhooks (`POST /_atproto/ghost-webhook`, HMAC-verified) and
  enqueues them on a Cloudflare Queue;
- a queue consumer writes records to the PDS with automatic retry;
- proxies all other traffic to the Ghost origin, injecting
  `<link rel="site.standard.document">` (and the publication hint tag) into
  post pages via HTMLRewriter;
- serves `GET /.well-known/site.standard.publication` (the authoritative
  publication verification endpoint);
- runs a daily reconciliation cron that diffs the Ghost Content API against
  KV and repairs drift — which doubles as the archive backfill.

**Content policy:** metadata + excerpt only. The canonical content lives at
werd.io; full post bodies are never syndicated.

## Setup

1. `npm install`
2. `npx wrangler kv namespace create STATE` → paste the id into
   `wrangler.jsonc` (replacing `REPLACE_WITH_KV_NAMESPACE_ID`)
3. `npx wrangler queues create ghost-standard-site-events`
4. Secrets:
   ```bash
   npx wrangler secret put GHOST_WEBHOOK_SECRET     # invent a long random string
   npx wrangler secret put ATPROTO_APP_PASSWORD     # app password for werd.io (bsky.app → Settings → App Passwords)
   npx wrangler secret put GHOST_CONTENT_API_KEY    # Ghost Admin → Integrations → custom integration → Content API key
   ```
5. `npx wrangler deploy`
6. Create the publication record:
   ```bash
   curl -X POST https://werd.io/_atproto/setup -H "Authorization: Bearer $GHOST_WEBHOOK_SECRET"
   ```
   Confirm: `curl https://werd.io/.well-known/site.standard.publication`
   returns the AT-URI. (Ghost's site icon becomes the publication icon — make
   sure it's square and ≥256×256 in Ghost settings, then re-run setup if you
   change it.)
7. Create the webhooks. The Ghost Admin UI can't set webhook secrets, and
   Ghost only signs requests when a secret exists, so use the Admin API:
   ```bash
   GHOST_ADMIN_API_KEY=... GHOST_WEBHOOK_SECRET=... \
     node scripts/create-webhooks.mjs https://werd.io https://werd.io/_atproto/ghost-webhook
   ```
8. Backfill the archive — repeat until the response shows `"capped": false`
   (each run writes at most 200 records, ~200ms apart, to be polite to the
   PDS):
   ```bash
   curl -X POST https://werd.io/_atproto/reconcile -H "Authorization: Bearer $GHOST_WEBHOOK_SECRET"
   ```

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values as needed
npm run dev                       # proxies localhost:8787 → GHOST_URL
npm test                          # vitest in workerd via @cloudflare/vitest-pool-workers
npm run typecheck
```

## Manual end-to-end verification (definition of done)

1. Publish a test post in Ghost.
2. The record exists (find the rkey in the Worker's queue-consumer logs, or
   read KV key `post:{ghost_post_id}`):
   ```bash
   curl "https://inkcap.us-east.host.bsky.network/xrpc/com.atproto.repo.getRecord?repo=did:plc:77tdak46psveqneyegsdyc7l&collection=site.standard.document&rkey=<rkey>"
   ```
   Also browsable at
   <https://pdsls.dev/at/did:plc:77tdak46psveqneyegsdyc7l/site.standard.document>.
3. `curl -s https://werd.io/<slug>/ | grep site.standard` shows both link
   tags. (KV is eventually consistent — allow up to a minute after publish.)
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
