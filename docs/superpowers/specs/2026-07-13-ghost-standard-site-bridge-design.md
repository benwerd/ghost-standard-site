# Ghost → standard.site bridge — design

**Date:** 2026-07-13
**Status:** Approved (spec authored by Ben; clarifying questions resolved 2026-07-13).
**Superseded in part** — see the *Post-implementation revisions* addendum at
the bottom for where the shipped system deliberately diverges from this
document. The README is the accurate operational reference.

## Goal

A single Cloudflare Worker that syndicates werd.io (Ghost(Pro), proxied by
Cloudflare) to AT Protocol using the standard.site lexicons. Every published
post becomes a `site.standard.document` record in Ben's own repo
(`did:plc:77tdak46psveqneyegsdyc7l`, handle `werd.io`, PDS
`inkcap.us-east.host.bsky.network`). The site is one
`site.standard.publication` record. The Worker also serves the verification
loop so posts render as enhanced article cards in Bluesky and are discoverable
in Leaflet, pckt, Offprint, Heron, etc.

## Resolved decisions

- **Queues:** available (Workers Paid plan). Webhook receiver verifies and
  enqueues; a queue consumer writes to the PDS with automatic retry.
- **Route:** `werd.io/*` — the Worker fronts the whole domain and proxies to
  origin.
- **Origin:** Ghost(Pro), CNAMEd through Cloudflare. Proxy via
  `fetch(request)` passthrough.
- **Identity:** handle `werd.io`, DID `did:plc:77tdak46psveqneyegsdyc7l`.
  Session start asserts the resolved DID equals `ATPROTO_DID`; abort loudly on
  mismatch.
- **Content policy:** metadata + excerpt only. No full post bodies; canonical
  content lives at werd.io. Do not set the lexicon `content` union.

## Lexicon shapes (fetched from standard.site/docs on 2026-07-13)

### `site.standard.publication`

Required: `url` (base URL, no trailing slash), `name` (≤500 graphemes).
Optional: `icon` (blob, square ≥256×256, <1MB), `description` (≤3000
graphemes), `basicTheme`, `labels`, `preferences.showInDiscover`.

### `site.standard.document`

Required: `site` (publication AT-URI), `title` (≤500 graphemes),
`publishedAt` (datetime).
Optional: `path` (leading slash; `url + path` = canonical URL), `description`
(≤3000 graphemes), `coverImage` (blob <1MB), `content` (unused here),
`textContent` (plaintext), `tags` (≤128 graphemes each, no `#`),
`bskyPostRef`, `links`, `labels`, `contributors`, `updatedAt` (datetime).

We populate: `site`, `title`, `publishedAt`, `path`, `description` (Ghost
custom excerpt, falling back to auto excerpt), `tags` (public Ghost tags),
`coverImage` (feature image blob when present and <1MB), `updatedAt` on edits.

### Verification

- `GET /.well-known/site.standard.publication` → plain text AT-URI
  (`at://did/site.standard.publication/rkey`). This is the **authoritative**
  publication check.
- Document pages need `<link rel="site.standard.document" href="{at-uri}">`
  in `<head>` (required).
- `<link rel="site.standard.publication" href="{at-uri}">` is an optional
  discovery hint; we inject it too, but the `.well-known` endpoint is what
  verifiers trust.
- Verifiers resolve `site`+`path` to a URL, fetch it, compare AT-URIs. Record
  path, KV `path:` key, and the served page must agree.

## Architecture

One wrangler project (TypeScript, current wrangler conventions):

1. **`fetch` handler**, dispatched by route:
   - `POST /_atproto/ghost-webhook` — verify `X-Ghost-Signature`
     (`sha256={hmac}, t={timestamp}`; HMAC-SHA256 over `rawBody + timestamp`
     with `GHOST_WEBHOOK_SECRET`; timing-safe compare; reject stale
     timestamps). On success, enqueue the event.
   - `GET /.well-known/site.standard.publication` — publication AT-URI as
     `text/plain` from KV.
   - Everything else — proxy to origin. On HTML responses whose path has a
     KV `path:` entry, HTMLRewriter injects both link tags into `<head>`.
     KV miss or any lookup error ⇒ inject nothing, page passes through
     untouched (fail open). No render blocks on anything slower than one KV
     get.
2. **Queue consumer** — processes webhook events, writes to the PDS.
   Queue retries handle transient PDS failures.
3. **Scheduled handler (daily cron)** — reconciliation: page the Ghost
   Content API, diff against KV, create/update/delete records. Doubles as
   archive backfill. ~200ms between PDS writes. Idempotent.

## State (Workers KV, one namespace)

- `post:{ghost_post_id}` → `{ rkey, atUri, contentHash, path, updatedAt }`
- `path:{url_path}` → `{ atUri }`
- `publication` → `{ atUri }`

KV eventual consistency (~60s) is acceptable — a link tag appearing a minute
after publish is fine. If a case emerges where it isn't, flag and propose D1;
don't switch silently.

Slug changes: write the new `path:` key, delete the old one, update the
record's `path` field.

## Event handling

- `post.published` — `putRecord` with deterministic rkey: TID derived from
  `published_at` (clock-id bits zeroed / fixed) so replays and reconciliation
  are idempotent; fall back to a deterministic transform of the Ghost post ID
  if `published_at` is missing. Write both KV mappings.
- `post.published.edited` — content hash over material fields (title,
  slug/path, custom excerpt, publish date, tags, feature image). Unchanged ⇒
  no-op (debounces Ghost's save-spam). Changed ⇒ `putRecord` same rkey,
  update KV, set `updatedAt`.
- `post.unpublished` / `post.deleted` — `deleteRecord`, remove both KV keys.
- Ignore pages, drafts, email-only posts. Only public, published posts.

## AT Protocol client

- `@atproto/api` (fetch-based, Workers-compatible), handle + app password
  from secrets.
- DID assertion at session start (see above).
- All writes `validate: false` (PDS doesn't host these lexicons).
- Publication record created/updated by a protected admin route
  (`POST /_atproto/setup`, bearer-authed with the webhook secret), pulling
  name/description from the Ghost Content API settings endpoint and uploading
  the site icon via `uploadBlob`.

## Configuration

Secrets: `GHOST_WEBHOOK_SECRET`, `ATPROTO_APP_PASSWORD`,
`GHOST_CONTENT_API_KEY`.
Vars: `ATPROTO_HANDLE`, `ATPROTO_DID`, `ATPROTO_PDS_URL`, `GHOST_URL`,
`PUBLICATION_NAME` (optional override).
`.dev.vars.example` ships with placeholders.

## Testing / definition of done

1. Unit-tested pure functions: signature verification, content hashing, rkey
   derivation, record shaping from a Ghost payload fixture.
2. `wrangler dev` + captured Ghost webhook payload fixture.
3. `/.well-known/site.standard.publication` returns the AT-URI, correct
   content type.
4. Post pages served through the Worker contain both link tags; non-post
   pages are byte-identical to origin output.
5. End-to-end: publish a test post → record visible via
   `com.atproto.repo.getRecord` and a PDS browser → a Bluesky post linking to
   it renders as an enhanced article card. Manual step documented in README.
6. Reconciliation cron backfills the archive exactly once; idempotent on
   re-run.

## Non-goals

- No full-body syndication.
- No external databases or additional services; single deployable Worker.
- No degradation of the blog under any failure mode.

## Post-implementation revisions (addendum, kept current)

The sections above are the original approved design. During implementation,
deployment, and the first weeks of operation, the following deliberate
revisions superseded parts of it. The README documents the current behavior
authoritatively; this list explains what changed and why.

1. **Configuration is env-only and `wrangler.jsonc` is generated.** No
   identities, domains, or auth material are committed anywhere.
   `scripts/configure.mjs` renders the gitignored `wrangler.jsonc` from
   `wrangler.example.jsonc`, deriving the route/zone from `GHOST_URL`;
   `scripts/secrets-json.mjs` + `wrangler secret bulk` push all runtime
   values from `.dev.vars` (the single source of truth).
2. **Publication rkey is a TID, not `self`.** Both site.standard lexicons
   declare `key: tid` (confirmed from the published lexicon schema records —
   the docs pages don't mention it). The rkey is minted at first setup,
   reused via KV, and setup auto-migrates legacy rkeys; a
   `?full=1&force=1` reconcile rewrites every document's `site` reference
   afterwards.
3. **Reconcile is windowed, not a daily full sweep.** The cron repairs posts
   with `updated_at` in the last 3 days plus orphan deletion against an
   ids-only enumeration (deletions can't be windowed). Cost is O(window)
   regardless of archive size — the original daily full sweep exceeded
   per-invocation operation limits at ~5,000 posts. The archive backfill is
   an explicit `?full=1` mode that skips KV-known ids with zero per-post
   reads; the cron never backfills.
4. **The backfill runs in the queue consumer and self-chains.** A batch
   takes minutes (write cap + 200ms politeness spacing), which no HTTP
   request survives (hit as a real 502); the admin route enqueues a control
   message, capped batches re-enqueue themselves, and every pass stores its
   report in KV for `GET /_atproto/reconcile`. `limits.subrequests: 10000`
   in the wrangler config accommodates batch cost.
5. **Content API calls are lean and version-unpinned.** No post HTML is ever
   downloaded (`fields` + `include=tags` verified to combine on Ghost 6);
   the `accept-version` header is omitted entirely — Ghost 6 rejects clients
   pinned to older majors with 406 UPDATE_CLIENT.
6. **Ghost(Pro) operational learnings.** The Admin API is only served on the
   `*.ghost.io` admin domain (a redirected POST becomes a bodyless GET →
   404), so `scripts/create-webhooks.mjs` takes the admin domain as its
   first argument. Webhook secrets can only be set via the Admin API, never
   the Admin UI.
7. **Single-post test path.** `npm run test-post` sends one signed
   Ghost-shaped webhook for a real post through the full pipeline and
   regenerates it on rerun via a signed `?force=1` (real webhooks never
   carry force, so the save-spam debounce is untouched); `--delete` undoes
   it. `NO_CRON=1` deploys exist for zero-scheduled-activity testing.
8. **CI.** Every PR runs typecheck, the full vitest-in-workerd suite against
   the tracked example config (no secrets needed), and syntax checks over
   the deploy scripts.
