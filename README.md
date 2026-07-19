# ghost-standard-site

Publish on your [Ghost](https://ghost.org) blog; show up everywhere on the
open social web.

This is a Cloudflare Worker that connects a Ghost blog to the
[AT Protocol](https://atproto.com) — the network behind Bluesky — using the
[standard.site](https://standard.site) publishing format. Once it's running,
every post you publish automatically becomes part of your identity on that
network: links to your posts render as rich article cards on Bluesky, and
long-form readers like Leaflet, pckt, Offprint, and Heron can discover and
display your writing. You keep publishing in Ghost exactly as you always
have; this Worker quietly handles the rest.

**You don't need to know anything about AT Protocol to use this.** The next
section teaches you the five concepts that matter, in about two minutes.

## A two-minute AT Protocol crash course

Skip this if you already know what a PDS is. Otherwise, here's everything
this README assumes, in plain words:

- **The Atmosphere** is the network of apps built on AT Protocol. Bluesky is
  the famous one, but there are many others — including the long-form
  reading apps this bridge makes your blog visible to.
- **Your repo** is your personal, public data store on that network. When
  you post on Bluesky, the post is saved as a little JSON document — a
  **record** — in *your* repo, not in some company's database. Records are
  organized into **collections** (think: folders named by type, like
  `app.bsky.feed.post`), and each record has a key called an **rkey**
  (think: filename). Every record has a permanent address called an
  **AT-URI**, which looks like `at://<who>/<collection>/<rkey>`.
- **Your DID** is your permanent account ID (an ugly string like
  `did:plc:abc123…`), and your **handle** is the friendly name that points
  at it (like `yourdomain.com`). Handles can change; DIDs never do.
- **Your PDS** ("personal data server") is the server that physically hosts
  your repo. If you signed up through Bluesky, they run one for you — you
  can find its address but you never really have to think about it.
- **Lexicons** are shared schemas — agreements about what a record of a
  given type should contain, so every app can read every other app's
  records. **standard.site** is a set of lexicons for publishing: a
  `site.standard.publication` record describes a website (yours!), and a
  `site.standard.document` record describes one article on it.

Put together: this Worker writes one `site.standard.publication` record
("this is my blog") plus one `site.standard.document` record per post
("here's an article on it") into **your own repo, under your own DID**.
Your writing becomes part of your identity on the network — not a copy
held by some third-party bridge account.

One more idea and you're fully equipped — **verification**. Anyone could
write a record *claiming* to be yourdomain.com, so apps check both
directions before believing it:

1. Your website vouches for the records: a well-known URL
   (`/.well-known/site.standard.publication`) returns your publication's
   AT-URI, and each post's page carries a `<link>` tag pointing at its
   record.
2. The records point back at your website (the publication stores your
   URL; each document stores its path).

When both sides agree, apps know the DID really controls the domain — and
that's what unlocks the rich article cards. This Worker serves both halves
of that loop for you.

## What the Worker actually does

It sits in front of your domain (via a Cloudflare route) and wears four
hats:

- **Webhook receiver** — when you publish, edit, or delete a post, Ghost
  calls `POST /_atproto/ghost-webhook`. The Worker checks the request is
  really from Ghost (HMAC signature), then queues the work.
- **Record writer** — a queue consumer picks up those events and creates,
  updates, or deletes the matching record in your repo, with automatic
  retries if your PDS hiccups.
- **Verification server** — it answers
  `GET /.well-known/site.standard.publication`, and it proxies all your
  normal blog traffic to Ghost, slipping the verification `<link>` tags
  into post pages on the way through. Everything else about your pages
  passes through byte-for-byte untouched.
- **Nightly janitor** — a daily cron compares Ghost against what's been
  synced and repairs any drift (posts updated in the last 3 days, plus
  cleanup of records whose posts are gone). The full-archive backfill is a
  separate command you run on purpose — the cron never does it behind your
  back.

**Content policy:** records carry metadata plus your excerpt — never full
post bodies. The canonical home of your writing is your blog; the records
point readers there.

**Configuration policy:** no identities, domains, or secrets are committed
to this repo, ever. Everything lives in `.dev.vars` (gitignored) locally and
in Worker secrets in production. Even `wrangler.jsonc` is gitignored and
**generated**: `scripts/configure.mjs` renders it from
`wrangler.example.jsonc`, deriving the route from your `GHOST_URL` and the
KV namespace id from `.dev.vars`. It runs automatically before
`npm run dev` and `npm run deploy` — you never edit wrangler.jsonc by hand.

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

Your account's permanent ID (see the crash course above). Don't type it
from memory — resolve it from your handle:

```bash
curl "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=YOUR_HANDLE"
```

- Returns: `{"did":"did:plc:abc123…"}` — the value starting `did:plc:` (or
  `did:web:`) is what goes in `.dev.vars`
- You can also see it at `https://bsky.app/profile/YOUR_HANDLE` → ⋯ menu →
  "Copy DID", or by opening the curl URL in a browser.
- This is a safety net, not just metadata: at every session start the Worker
  compares the DID it actually authenticated as against this value and
  refuses to write if they differ, so a typo'd handle can never publish into
  the wrong repo.

### `ATPROTO_PDS_URL`

The server that hosts your repo (see the crash course). It's recorded in
your DID document — look it up using the DID from the previous step:

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
can prove the whole pipeline on one post before creating webhooks or running
the archive backfill.

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
7. Create the publication record — the "this is my blog" record everything
   else hangs off:
   ```bash
   curl -X POST https://yourdomain.com/_atproto/setup -H "Authorization: Bearer $GHOST_WEBHOOK_SECRET"
   ```
   Confirm: `curl https://yourdomain.com/.well-known/site.standard.publication`
   returns the AT-URI. (Ghost's site icon becomes the publication icon — make
   sure it's square and ≥256×256 in Ghost settings, then re-run setup if you
   change it. Setup is safe to re-run any time; it updates the same record.)
8. Create the webhooks. A Ghost quirk to know about: the Admin UI can't set
   webhook secrets, and Ghost only *signs* its deliveries when a secret
   exists — so webhooks have to be created through Ghost's Admin API, which
   this script does for you. The first argument is your **admin domain**:
   on Ghost(Pro) that's the `*.ghost.io` address in your browser when
   you're logged into Ghost Admin (the Admin API isn't served on your
   custom domain); self-hosted, it's the same as your site URL. The second
   argument — where webhooks get delivered — stays on your real domain:
   ```bash
   GHOST_ADMIN_API_KEY=... GHOST_WEBHOOK_SECRET=... \
     node scripts/create-webhooks.mjs https://your-site.ghost.io https://yourdomain.com/_atproto/ghost-webhook
   ```
9. Backfill the archive — one command, runs in the background:
   ```bash
   curl -X POST "https://yourdomain.com/_atproto/reconcile?full=1&max=1000" -H "Authorization: Bearer $GHOST_WEBHOOK_SECRET"
   ```
   This returns `202 queued` immediately. The backfill runs in the queue
   consumer (a multi-minute job can't live inside an HTTP request), writing
   up to `max` records per batch ~200ms apart and automatically chaining the
   next batch until the whole archive is done. Watch progress with
   `npx wrangler tail`, or poll the latest batch report:
   ```bash
   curl "https://yourdomain.com/_atproto/reconcile" -H "Authorization: Bearer $GHOST_WEBHOOK_SECRET"
   ```
   The backfill is finished when that report shows `"capped": false`.
   Read **Write quotas** below before you run this — the backfill knows how
   to pace itself, but it's worth understanding what it's pacing against.
   (A plain `POST` without `?full=1` runs the windowed repair — same as the
   daily cron — synchronously and returns its report directly.)

## Write quotas (please read before backfilling)

Your PDS limits how much an account can write, and — this is the important
part — **that budget is shared between this bridge and everything else you
do as that account, including posting on Bluesky yourself.**

The numbers, measured directly against a Bluesky-hosted PDS (from 429
response headers, 2026-07): **35,000 write-points per fixed 24-hour window**
(`ratelimit-policy: 35000;w=86400`) — a create costs 3 points, an update 2,
a delete 1 — plus a separate 3,000-requests-per-5-minutes bucket. The daily
window is **fixed, not rolling**: when it's drained you stay at zero until
the single reset instant, then the full 35,000 returns at once. There is no
gradual recovery.

What this means in practice:

- A one-pass backfill of a 5,000-post archive costs ~15,000 points — half a
  day's budget — so it completes within one or two windows.
- The backfill handles all of this automatically: batches that hit a 429
  stop early, record `errors`/`retryAfterS` in the report, and the chain
  retries on that schedule (hourly at worst; a wake-up against a
  still-drained window costs ~3 points, so the waiting is nearly free).
- But if a backfill *does* drain the window, **you** are blocked from
  posting too, until the reset. Plan a big backfill for a day you weren't
  going to live-post much.
- To check your current quota without spending anything: attempt a 1-point
  write and read the `ratelimit-*` headers off the 429 (rejected writes
  cost nothing); `ratelimit-reset` is the epoch second when the window
  reopens.
- A genuinely stalled chain (rare) looks like: no new report from GET for
  well over an hour *and* `wrangler tail` silent. Re-POSTing the same
  command is always safe — every operation here is idempotent, meaning
  running it twice can't create duplicates.

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

> **About the cron:** the daily reconcile cron only repairs the recent
> window — it never touches the archive, so a normal deploy is safe even
> mid-testing. `NO_CRON=1 npm run deploy` remains available if you want
> zero scheduled activity while experimenting (before the publication is
> set up, a cron run just logs an error and exits).

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
to fetch your real pages. Do setup steps 1–6 (`NO_CRON=1 npm run deploy` if
you'd rather have no scheduled activity yet — the cron is harmless either
way, see the callout above). Then create the publication and push the same
single post through the deployed Worker:

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

1. `npm run deploy` (with the cron, if you'd disabled it)
2. Setup step 8 (`scripts/create-webhooks.mjs`) so real publishes flow
3. Setup step 9 (`/_atproto/reconcile?full=1&max=1000`, one request,
   self-chaining) to backfill the archive — the daily cron only repairs the
   recent window, so the backfill is an explicit step, not something the
   cron does behind your back

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values (gitignored)
npm run dev                       # generates wrangler.jsonc, proxies localhost:8787 → GHOST_URL
npm test                          # vitest in workerd via @cloudflare/vitest-pool-workers
npm run typecheck
```

Tests need no configuration at all — they run against the tracked
`wrangler.example.jsonc`, so `git clone` + `npm install` + `npm test` works
on a machine that's never seen your values.

## Manual end-to-end verification (definition of done)

1. Publish a test post in Ghost.
2. The record exists (find the rkey in the Worker's queue-consumer logs, or
   read KV key `post:{ghost_post_id}`):
   ```bash
   curl "$ATPROTO_PDS_URL/xrpc/com.atproto.repo.getRecord?repo=$ATPROTO_DID&collection=site.standard.document&rkey=<rkey>"
   ```
   Also browsable at `https://pdsls.dev/at/<your-did>/site.standard.document`
   — pdsls.dev is a handy web viewer for anyone's repo.
3. `curl -s https://yourdomain.com/<slug>/ | grep site.standard` shows both
   link tags. (KV is eventually consistent — allow up to a minute after
   publish.)
4. Post the URL in Bluesky; the link should render as an enhanced article
   card. Records have passed third-party validators while silently failing
   Bluesky's crawler — **the Bluesky card is the real test.**
5. Check the post appears in Leaflet / pckt / Offprint / Heron discovery.

## How it behaves day to day

Things you'd otherwise learn the hard way, collected:

- **Everything fails open — the blog can never be degraded.** A missing KV
  entry means a page renders without link tags (not broken); a PDS outage
  means the queue retries (5×) and the daily cron repairs whatever's left;
  any error during tag injection passes the original page through
  untouched.
- **Edits are debounced.** Ghost fires its "edited" webhook on *every* save
  of a published post, even when nothing meaningful changed. The Worker
  hashes the fields that actually appear in the record (title, path,
  excerpt, publish date, tags, feature image) and skips the write when the
  hash matches — so autosave spam never touches your PDS.
- **Everything is idempotent.** Record keys (rkeys) are derived
  deterministically from each post's publish time plus a hash of its Ghost
  id — the same post always maps to the same record, so webhook replays,
  reruns, and reconciliation can never create duplicates. Renaming a slug
  keeps the same record and updates its path. (The id-hash bits exist
  because bulk-imported posts often share the same timestamp.)
- **Only public, published posts get records.** Drafts, members-only,
  email-only newsletters, and pages are ignored; a published post edited to
  non-public gets its record deleted.
- **Deleting a post deletes its record** (both the webhook path and the
  janitor handle this). Downstream apps drop it as the deletion propagates
  through the network — like deleting a Bluesky post, it's propagation,
  not instant erasure everywhere.
- **The reconcile sweep has two modes, both cheap at any archive size.**
  The daily cron runs *windowed* mode: it re-checks posts updated in the
  last 3 days (catching any webhook Ghost dropped — Ghost fires webhooks
  once, best-effort, no retries) plus orphan deletion, comparing your full
  KV state against an ids-only listing of all public posts. *Full* mode
  (`?full=1`) is the explicit backfill: it creates records for posts never
  seen before, skipping known ones instantly. Neither downloads post HTML.
- **`&force=1` is the sledgehammer** — full mode that rewrites *every*
  record in place, for migrations where something outside the content hash
  changed. Force chains resume via an internal offset so each record is
  written exactly once per chain — but a full force pass still costs
  ~2 points × every record (a third of the daily quota on a 5,000-post
  archive). **When only the `site` reference needs fixing, prefer
  `scripts/rewrite-site-refs.mjs`**: it runs locally, finds just the
  records referencing an outdated publication URI, and rewrites only those
  (dry-run by default, `--apply` to write, stops politely on 429, safe to
  re-run).
- **Kill switch for a runaway or unwanted reconcile chain:**
  `npx wrangler queues purge ghost-standard-site-events`. The chain lives
  as a delayed queue message, so purging ends it immediately. Side effect:
  any in-flight webhook events are dropped too — the daily cron repairs
  those automatically (or run a plain reconcile POST sooner).
- **The publication's rkey is a TID** (a timestamp-based id — the standard
  record-key format on the network), minted at first setup and reused on
  every re-run. The site.standard lexicons require `key: tid` for both
  record types; a fixed name like `self` fails validation. If setup finds a
  legacy non-TID rkey, it migrates automatically — new record, old one
  deleted — and its response tells you to run the force reconcile so
  existing documents point at the new publication.
- **Record writes use `validate: false`.** Your PDS only schema-validates
  record types it hosts lexicons for, and it doesn't host standard.site's —
  without this flag it would reject the writes outright.
- **KV is eventually consistent (~60s)** — a link tag may appear up to a
  minute after publish, which is fine for this use. Heads-up if you
  auto-post links to Bluesky (e.g. via Zapier): the card is generated when
  the link is first fetched, so give the tag a head start with a ~5-minute
  delay step, or the card renders plain from cache.
- **A wrong handle can't hurt you.** At every session start the Worker
  compares the DID it actually logged in as against `ATPROTO_DID` and
  refuses to write on mismatch — a typo'd handle can never publish into
  someone else's repo.
