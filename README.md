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

## Configuration: where every value comes from

`.dev.vars` (gitignored) is the single source of truth: fill it in once and
the same values drive local dev, `wrangler.jsonc` generation
(`npm run configure`), and production secrets (`npm run push-secrets`).

Work through the values in this order — some depend on earlier ones.

### `GHOST_URL`

The canonical base URL of your blog: scheme + domain, **https, no trailing
slash, no path**.

- Looks like: `https://yourdomain.com`
- It must be the domain readers actually see (the one proxied through
  Cloudflare), not Ghost(Pro)'s internal `*.ghost.io` address. If you're
  unsure, it's whatever is set as your site URL in Ghost Admin → Settings →
  General → Site domain.
- Everything else keys off this: the Worker's route and zone are derived
  from its hostname, and it becomes the publication record's `url`.

### `GHOST_WEBHOOK_SECRET`

**You invent this one.** It's a shared secret you generate yourself; it is
not issued by Ghost or Cloudflare and exists nowhere until you create it.

Generate it:

```bash
openssl rand -hex 32
```

- Looks like: 64 hex characters, e.g. `9f2c…a41d`
- It's used in two places, which must match: `scripts/create-webhooks.mjs`
  registers it with Ghost so Ghost signs webhook deliveries with it, and the
  Worker verifies those signatures against it. It also doubles as the bearer
  token for the admin routes (`/_atproto/setup`, `/_atproto/reconcile`).
- Treat it like a password: anyone who has it can trigger your admin routes.

### `GHOST_CONTENT_API_KEY`

Issued by Ghost when you create a **custom integration**:

1. Ghost Admin → Settings → Advanced → Integrations
2. **Add custom integration**, name it e.g. `standard.site bridge`, Create
3. The integration page now shows two keys. Copy the **Content API key**.

- Looks like: 26 hex characters, e.g. `22444f78447824223cefc48062`
- The same integration page also shows an **Admin API key**
  (`<id>:<secret>` — two hex strings joined by a colon). You don't put that
  in `.dev.vars`; you'll pass it as the `GHOST_ADMIN_API_KEY` environment
  variable when you run `scripts/create-webhooks.mjs` in setup step 8. Keep
  the page open.

### `ATPROTO_HANDLE`

Your AT Protocol (Bluesky) handle, **without the leading `@`**.

- Looks like: `yourname.bsky.social`, or your custom domain (e.g.
  `yourdomain.com`) if you've set that as your handle
- It's exactly what appears on your Bluesky profile after the `@`. The
  records land in this account's repo, so make sure it's the identity you
  want your posts published under.

### `ATPROTO_DID`

Your account's permanent decentralized identifier. Don't type it from
memory — resolve it from your handle:

```bash
curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=YOUR_HANDLE"
```

- Returns: `{"did":"did:plc:abc123…"}` — the value starting `did:plc:` (or
  `did:web:`) is what goes in `.dev.vars`, e.g. `did:plc:77tdak46psveqneyegsdyc7l`
- You can also see it at `https://bsky.app/profile/YOUR_HANDLE` → ⋯ menu →
  "Copy DID", or by opening the curl URL in a browser.
- This is a safety net, not just metadata: at every session start the Worker
  compares the DID it actually authenticated as against this value and
  refuses to write if they differ, so a typo'd handle can never publish into
  the wrong repo.

### `ATPROTO_PDS_URL`

The server that hosts your repo (your PDS). It's recorded in your DID
document — look it up using the DID from the previous step:

```bash
curl "https://plc.directory/YOUR_DID"
```

In the JSON response, find the `service` entry with `"id": "#atproto_pds"`
and copy its `serviceEndpoint`:

- Looks like: `https://inkcap.us-east.host.bsky.network` (Bluesky-hosted
  accounts get a `*.host.bsky.network` mushroom-named server) or your own
  server's URL if you self-host your PDS
- For `did:web:` identities, fetch
  `https://YOUR_DOMAIN/.well-known/did.json` instead and read the same field.
- If this is wrong, logins fail or get bounced — the app password below is
  checked by this server.

### `ATPROTO_APP_PASSWORD`

A limited-purpose password for this integration — **never your main Bluesky
password**. Issued in the Bluesky app:

1. bsky.app → Settings → Privacy and security → App passwords
2. **Add App Password**, name it e.g. `ghost-standard-site`, Next
3. Copy the generated password immediately — Bluesky only shows it once.
   Leave "Allow access to your direct messages" unchecked; this integration
   doesn't need it.

- Looks like: four groups of four, e.g. `abcd-efgh-ijkl-mnop`
- If you lose it, don't hunt for it: revoke it and create a new one, then
  update `.dev.vars` and re-run `npm run push-secrets`.

### `PUBLICATION_NAME` (optional)

Leave it commented out and the publication record's name is pulled from
Ghost Admin → Settings → General → Title at setup time. Set it only if you
want the Atmosphere-facing name to differ from the blog's title.

### `KV_NAMESPACE_ID`

Issued by Cloudflare when you create the namespace (setup step 3):

```bash
npx wrangler kv namespace create STATE
```

The command prints a config snippet containing an `id`:

```
{ "kv_namespaces": [ { "binding": "STATE", "id": "e29b263ab50e42ce9b637fa8370175e8" } ] }
```

- Copy just the 32-hex `id` value into `.dev.vars`.
- This is deploy-time plumbing consumed by `scripts/configure.mjs` when it
  generates `wrangler.jsonc`; it is deliberately **not** pushed to the
  Worker by `push-secrets` and is not a secret in any meaningful sense.

### `GHOST_ADMIN_API_KEY` (not in `.dev.vars`)

Used once, as a shell environment variable, when running
`scripts/create-webhooks.mjs` (setup step 8). It's the **Admin API key**
from the same custom integration page as `GHOST_CONTENT_API_KEY`.

- Looks like: `<24-hex id>:<64-hex secret>`, colon included, e.g.
  `5c73def…:a91b44…`
- It grants full admin access to your Ghost site, which is why it stays out
  of `.dev.vars` and out of the Worker entirely — the webhook-creation
  script is the only thing that needs it, and only for one run.

## Setup

Cautious first run? See **Trying it with a single post first** below — you
can prove the whole pipeline on one post before creating webhooks or letting
the backfill cron loose.

1. `npm install`
2. `cp .dev.vars.example .dev.vars` and fill everything in — the
   [configuration section above](#configuration-where-every-value-comes-from)
   walks through where each value comes from, one by one. Your blog's domain
   (from `GHOST_URL`) must be a Cloudflare zone on your account,
   orange-clouded.
3. `npx wrangler kv namespace create STATE` → put the id in `.dev.vars` as
   `KV_NAMESPACE_ID` (then `npm run configure`, or let dev/deploy do it).
4. `npx wrangler queues create ghost-standard-site-events`
5. Push the runtime values from `.dev.vars` to the Worker:
   ```bash
   npm run push-secrets
   ```
   This reads the same `.dev.vars` you filled in at step 2 and uploads
   everything the Worker needs (except `KV_NAMESPACE_ID`, which only
   `configure` uses) as secrets in one call. It refuses to run while any
   value still looks like a placeholder. Re-run it whenever `.dev.vars`
   changes.
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
   Ghost only signs requests when a secret exists, so use the Admin API.
   The first argument is your **admin domain**: on Ghost(Pro) that's the
   `*.ghost.io` address in your browser when you're logged into Ghost Admin
   (the Admin API isn't served on the custom domain); self-hosted, it's the
   same as your site URL. The second argument — where webhooks get
   delivered — stays on your real domain:
   ```bash
   GHOST_ADMIN_API_KEY=... GHOST_WEBHOOK_SECRET=... \
     node scripts/create-webhooks.mjs https://your-site.ghost.io https://yourdomain.com/_atproto/ghost-webhook
   ```
9. Backfill the archive — repeat until the response shows `"capped": false`
   (each run writes at most 200 records, ~200ms apart, to be polite to the
   PDS):
   ```bash
   curl -X POST https://yourdomain.com/_atproto/reconcile -H "Authorization: Bearer $GHOST_WEBHOOK_SECRET"
   ```

## Trying it with a single post first

You don't need Ghost webhooks, the cron, or a backfill to prove the pipeline
works:

```bash
npm run test-post
```

This fetches **your most recent post** from the Content API, wraps it in the
exact envelope Ghost sends, signs it with your webhook secret, and POSTs it
to the Worker — so a single record flows through the entire real path
(signature check → queue → PDS write → KV → link tags). **Rerunning it
regenerates the record in place** (same rkey; it bypasses the content-hash
debounce via a signed `?force=1`), so you can tweak and rerun freely.
`-- --slug <slug>` picks a different post; `-- --delete` removes the record
again. Fully reversible.

> **Why the cron matters here:** a normal deploy registers the daily
> reconcile cron, and once the publication record exists that cron will
> start backfilling your **entire archive** (200 posts/day). Deploy with
> `NO_CRON=1` until you've opted into that.

### Stage 1: entirely local (nothing deployed)

```bash
# .dev.vars filled in with real values (see Configuration above)
npm run dev                                   # Worker + local queue on :8787

# in another terminal:
SECRET=$(grep '^GHOST_WEBHOOK_SECRET=' .dev.vars | cut -d= -f2-)
curl -X POST http://localhost:8787/_atproto/setup -H "Authorization: Bearer $SECRET"
npm run test-post                             # syndicate your most recent post
```

Notes on what's real vs. local here: KV and the queue are local simulations,
but the **PDS writes are real** — setup creates your actual publication
record and the webhook creates one actual document record (that's the point;
document records must reference a real publication). Verify:

```bash
# the record exists in your repo (rkey appears in the wrangler dev output):
curl "$ATPROTO_PDS_URL/xrpc/com.atproto.repo.getRecord?repo=$ATPROTO_DID&collection=site.standard.document&rkey=<rkey>"
# link tags are injected on the proxied page:
curl -s http://localhost:8787/<slug>/ | grep site.standard
# rerun — regenerates the record in place, dev log shows "updated" with the same rkey:
npm run test-post
```

(Real Ghost webhooks don't carry `force`, so the save-spam debounce still
applies in normal operation — the dev log shows "skipped" only for those.)

Undo at any time: `npm run test-post -- --delete` (removes the document
record and KV entries; the publication record can stay — it's inert on its
own).

### Stage 2: production, still just one post

This is the only way to test the Bluesky card, since Bluesky's crawler has
to fetch your real pages. Do setup steps 1–6 but deploy with the cron off:

```bash
NO_CRON=1 npm run deploy
```

Then create the publication and push the same single post through the
deployed Worker:

```bash
curl -X POST https://yourdomain.com/_atproto/setup -H "Authorization: Bearer $SECRET"
curl https://yourdomain.com/.well-known/site.standard.publication
npm run test-post -- --url https://yourdomain.com/_atproto/ghost-webhook
npx wrangler tail   # watch the queue consumer log the write
```

Give KV up to a minute, then check `curl -s https://yourdomain.com/<slug>/ |
grep site.standard`, and post the URL on Bluesky — the enhanced article card
is the definitive pass. Rerun the same command as often as you like while
iterating; it regenerates the same record. Undo with
`npm run test-post -- --delete --url …`.

### When you're confident

1. `npm run deploy` (re-enables the cron)
2. Setup step 8 (`scripts/create-webhooks.mjs`) so real publishes flow
3. Setup step 9 (repeated `/_atproto/reconcile`) to backfill the archive —
   or just let the daily cron chip away at it at 200 posts/day

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
