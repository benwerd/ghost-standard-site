# Ghost → standard.site Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single Cloudflare Worker that syndicates werd.io (Ghost(Pro)) posts to `site.standard.document` records in `did:plc:77tdak46psveqneyegsdyc7l`, serves the standard.site verification loop, and never degrades the blog.

**Architecture:** One wrangler project with a `fetch` handler (webhook receiver → Cloudflare Queue, `.well-known` endpoint, origin proxy with HTMLRewriter link-tag injection), a queue consumer that writes to the PDS, and a daily reconciliation cron that doubles as archive backfill. State in one KV namespace.

**Tech Stack:** TypeScript, wrangler v4, Cloudflare Queues + KV + HTMLRewriter, `@atproto/api`, vitest + `@cloudflare/vitest-pool-workers`.

**Ground truth established 2026-07-13 (do not re-derive from training data):**
- Ghost signs webhooks `X-Ghost-Signature: sha256=<hex hmac>, t=<ms timestamp>` where hmac = HMAC-SHA256(secret, rawBody + timestamp). Ghost only signs when the webhook has a `secret`, which must be set via the Admin API (the Admin UI has no secret field). Webhook body is `{event: "post.published", post: {current: {...}, previous: {...}}}`.
- Lexicons (from standard.site/docs): see `docs/superpowers/specs/2026-07-13-ghost-standard-site-bridge-design.md`.
- Verification: `GET /.well-known/site.standard.publication` → plain-text AT-URI (authoritative); `<link rel="site.standard.document" href="at://...">` required in post `<head>`; publication link tag is an optional hint.
- Identity: handle `werd.io`, DID `did:plc:77tdak46psveqneyegsdyc7l`, PDS `https://inkcap.us-east.host.bsky.network`.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `.gitignore`, `.dev.vars.example`, `src/env.ts`, `src/ghost/types.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ghost-standard-site",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install @atproto/api
npm install -D wrangler typescript vitest @cloudflare/vitest-pool-workers @cloudflare/workers-types
```
Expected: installs succeed. If npm reports a peer-dependency conflict between `vitest` and `@cloudflare/vitest-pool-workers`, install the vitest version the pool package declares as a peer (check with `npm info @cloudflare/vitest-pool-workers peerDependencies`).

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

- [ ] **Step 4: Create `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "ghost-standard-site",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "routes": [{ "pattern": "werd.io/*", "zone_name": "werd.io" }],
  "kv_namespaces": [
    { "binding": "STATE", "id": "REPLACE_WITH_KV_NAMESPACE_ID" }
  ],
  "queues": {
    "producers": [{ "queue": "ghost-standard-site-events", "binding": "EVENTS" }],
    "consumers": [
      {
        "queue": "ghost-standard-site-events",
        "max_batch_size": 10,
        "max_batch_timeout": 5,
        "max_retries": 5
      }
    ]
  },
  "triggers": { "crons": ["17 6 * * *"] },
  "vars": {
    "ATPROTO_HANDLE": "werd.io",
    "ATPROTO_DID": "did:plc:77tdak46psveqneyegsdyc7l",
    "ATPROTO_PDS_URL": "https://inkcap.us-east.host.bsky.network",
    "GHOST_URL": "https://werd.io"
  }
}
```

- [ ] **Step 5: Create `vitest.config.ts`**

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
```

Note: if the pool rejects the config because of the queue consumer or route entries, override in `vitest.config.ts` via `poolOptions.workers.miniflare` (e.g. provide `kvNamespaces: ['STATE']` and `queueProducers: { EVENTS: { queueName: 'ghost-standard-site-events' } }` directly and drop `wrangler.configPath`). Keep `wrangler.jsonc` itself unchanged.

- [ ] **Step 6: Create `.gitignore`**

```
node_modules/
dist/
.wrangler/
.dev.vars
```

- [ ] **Step 7: Create `.dev.vars.example`**

```
GHOST_WEBHOOK_SECRET=replace-me
ATPROTO_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
GHOST_CONTENT_API_KEY=replace-me
```

- [ ] **Step 8: Create `src/ghost/types.ts`**

```ts
export interface GhostTag {
  id?: string;
  name: string;
  slug?: string;
  visibility?: string; // 'public' | 'internal'
}

export interface GhostPost {
  id: string;
  uuid?: string;
  title?: string;
  slug?: string;
  url?: string;
  status?: string; // 'published' | 'draft' | 'scheduled' | 'sent'
  visibility?: string; // 'public' | 'members' | 'paid' | 'tiers'
  email_only?: boolean;
  custom_excerpt?: string | null;
  excerpt?: string | null;
  feature_image?: string | null;
  published_at?: string | null;
  updated_at?: string | null;
  tags?: GhostTag[];
}

/** Webhook body: {event, post: {current, previous}}. Page events use a `page` key instead. */
export interface GhostWebhookBody {
  event?: string;
  post?: {
    current?: Partial<GhostPost> & { id?: string };
    previous?: Partial<GhostPost> & { id?: string };
  };
  page?: unknown;
}

export interface GhostSettings {
  title?: string;
  description?: string;
  icon?: string | null;
  logo?: string | null;
}
```

- [ ] **Step 9: Create `src/env.ts`**

```ts
import type { GhostPost } from './ghost/types';

export type SyncEvent =
  | { kind: 'upsert'; post: GhostPost }
  | { kind: 'delete'; postId: string };

export interface Env {
  STATE: KVNamespace;
  EVENTS: Queue<SyncEvent>;
  // secrets
  GHOST_WEBHOOK_SECRET: string;
  ATPROTO_APP_PASSWORD: string;
  GHOST_CONTENT_API_KEY: string;
  // vars
  ATPROTO_HANDLE: string;
  ATPROTO_DID: string;
  ATPROTO_PDS_URL: string;
  GHOST_URL: string;
  PUBLICATION_NAME?: string;
}
```

- [ ] **Step 10: Verify typecheck passes and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add -A
git commit -m "chore: scaffold wrangler project with KV, queue, cron config"
```

---

### Task 2: Webhook payload fixture and test env typing

**Files:**
- Create: `tests/fixtures/post-published.json`, `tests/env.d.ts`

- [ ] **Step 1: Create `tests/fixtures/post-published.json`**

```json
{
  "event": "post.published",
  "post": {
    "current": {
      "id": "6543a1b2c3d4e5f6a7b8c9d0",
      "uuid": "0e0c5f95-c1a5-4f75-9c02-2d0d2f4f3a11",
      "title": "Hello Atmosphere",
      "slug": "hello-atmosphere",
      "url": "https://werd.io/hello-atmosphere/",
      "status": "published",
      "visibility": "public",
      "email_only": false,
      "custom_excerpt": "A test post about syndicating to the Atmosphere.",
      "excerpt": "A test post about syndicating to the Atmosphere.",
      "feature_image": "https://werd.io/content/images/2026/07/cover.jpg",
      "published_at": "2026-07-13T10:00:00.000Z",
      "updated_at": "2026-07-13T10:00:00.000Z",
      "tags": [
        { "id": "t1", "name": "atproto", "slug": "atproto", "visibility": "public" },
        { "id": "t2", "name": "#internal", "slug": "hash-internal", "visibility": "internal" }
      ]
    },
    "previous": {}
  }
}
```

- [ ] **Step 2: Create `tests/env.d.ts`**

```ts
import type { Env } from '../src/env';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
```

- [ ] **Step 3: Commit**

```bash
git add tests
git commit -m "test: add Ghost webhook payload fixture and test env typing"
```

---

### Task 3: Ghost signature verification (TDD)

**Files:**
- Create: `tests/signature.test.ts`, `src/ghost/signature.ts`

- [ ] **Step 1: Write the failing test**

`tests/signature.test.ts` — the known-answer vector was generated with node's `crypto.createHmac('sha256','test-secret').update(body + '1705320000000')`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSignatureHeader, verifyGhostSignature, timingSafeEqualStr } from '../src/ghost/signature';

const SECRET = 'test-secret';
const BODY = '{"event":"post.published","post":{"current":{"id":"abc123","title":"Hello"}}}';
const TS = 1705320000000;
const HEADER = `sha256=b7788d1a0a6ea9cceb6dcc74109e839b494dd7919361c2d5135d86679d305e3a, t=${TS}`;

describe('parseSignatureHeader', () => {
  it('parses hash and timestamp', () => {
    expect(parseSignatureHeader(HEADER)).toEqual({
      hash: 'b7788d1a0a6ea9cceb6dcc74109e839b494dd7919361c2d5135d86679d305e3a',
      timestamp: TS,
    });
  });
  it('rejects malformed headers', () => {
    expect(parseSignatureHeader('nope')).toBeNull();
    expect(parseSignatureHeader('sha256=zzzz, t=123')).toBeNull();
    expect(parseSignatureHeader('')).toBeNull();
  });
});

describe('verifyGhostSignature', () => {
  it('accepts a valid signature within tolerance', async () => {
    expect(await verifyGhostSignature(BODY, HEADER, SECRET, TS + 60_000)).toBe(true);
  });
  it('rejects a tampered body', async () => {
    expect(await verifyGhostSignature(BODY + 'x', HEADER, SECRET, TS + 60_000)).toBe(false);
  });
  it('rejects the wrong secret', async () => {
    expect(await verifyGhostSignature(BODY, HEADER, 'wrong', TS + 60_000)).toBe(false);
  });
  it('rejects a stale timestamp', async () => {
    expect(await verifyGhostSignature(BODY, HEADER, SECRET, TS + 10 * 60_000)).toBe(false);
  });
  it('rejects a missing header', async () => {
    expect(await verifyGhostSignature(BODY, null, SECRET, TS)).toBe(false);
  });
});

describe('timingSafeEqualStr', () => {
  it('compares strings', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/signature.test.ts`
Expected: FAIL — cannot resolve `../src/ghost/signature`.

- [ ] **Step 3: Write `src/ghost/signature.ts`**

```ts
const encoder = new TextEncoder();

export interface ParsedSignature {
  hash: string;
  timestamp: number;
}

/** Ghost emits: `sha256=<hex>, t=<ms>` (see Ghost core webhook-trigger.js). */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  const match = /sha256=([0-9a-f]{64})\s*,\s*t=(\d+)/i.exec(header);
  if (!match) return null;
  return { hash: match[1].toLowerCase(), timestamp: Number(match[2]) };
}

/** Constant-time string comparison. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify Ghost's webhook signature: HMAC-SHA256(secret, rawBody + timestamp).
 * `nowMs` is injected for testability; tolerance defaults to 5 minutes.
 */
export async function verifyGhostSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowMs: number,
  toleranceMs = 5 * 60_000
): Promise<boolean> {
  if (!header || !secret) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(nowMs - parsed.timestamp) > toleranceMs) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody + parsed.timestamp));
  return timingSafeEqualStr(toHex(sig), parsed.hash);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/signature.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/ghost/signature.ts tests/signature.test.ts
git commit -m "feat: Ghost webhook HMAC signature verification"
```

---

### Task 4: Deterministic rkey derivation (TDD)

**Files:**
- Create: `tests/tid.test.ts`, `src/atproto/tid.ts`

- [ ] **Step 1: Write the failing test**

`tests/tid.test.ts` — known-answer vectors precomputed with the same algorithm in node:

```ts
import { describe, it, expect } from 'vitest';
import { deriveRkey, encodeTid } from '../src/atproto/tid';

describe('deriveRkey', () => {
  it('derives a TID from published_at with clock-id bits from the post id', () => {
    const rkey = deriveRkey({ id: 'abc123', published_at: '2024-01-15T12:00:00.000Z' });
    expect(rkey).toBe('3kizf2hc622ry');
  });
  it('is deterministic', () => {
    const a = deriveRkey({ id: 'abc123', published_at: '2024-01-15T12:00:00.000Z' });
    const b = deriveRkey({ id: 'abc123', published_at: '2024-01-15T12:00:00.000Z' });
    expect(a).toBe(b);
  });
  it('differs for different posts with an identical published_at (bulk imports)', () => {
    const a = deriveRkey({ id: 'abc123', published_at: '2024-01-15T12:00:00.000Z' });
    const b = deriveRkey({ id: 'xyz789', published_at: '2024-01-15T12:00:00.000Z' });
    expect(b).toBe('3kizf2hc622u7');
    expect(a).not.toBe(b);
  });
  it('falls back to a hash of the Ghost post id without published_at', () => {
    expect(deriveRkey({ id: 'abc123' })).toBe('7qbgbbm4wfs62');
    expect(deriveRkey({ id: 'abc123', published_at: 'not a date' })).toBe('7qbgbbm4wfs62');
  });
  it('produces valid 13-char base32-sortable rkeys that order by time', () => {
    const earlier = deriveRkey({ id: 'a', published_at: '2020-01-01T00:00:00.000Z' });
    const later = deriveRkey({ id: 'a', published_at: '2025-01-01T00:00:00.000Z' });
    for (const rkey of [earlier, later]) expect(rkey).toMatch(/^[2-7a-z]{13}$/);
    expect(later > earlier).toBe(true);
  });
});

describe('encodeTid', () => {
  it('encodes zero as all-2s', () => {
    expect(encodeTid(0n)).toBe('2222222222222');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tid.test.ts`
Expected: FAIL — cannot resolve `../src/atproto/tid`.

- [ ] **Step 3: Write `src/atproto/tid.ts`**

```ts
/** base32-sortable alphabet used by atproto TIDs. */
const B32 = '234567abcdefghijklmnopqrstuvwxyz';

/** Encode a 64-bit value as a 13-character base32-sortable string (5 bits per char, top bit unused). */
export function encodeTid(value: bigint): string {
  let out = '';
  for (let i = 12; i >= 0; i--) {
    out += B32[Number((value >> BigInt(i * 5)) & 31n)];
  }
  return out;
}

function fnv1a64(input: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

/**
 * Deterministic rkey for a Ghost post. TID layout: (microseconds << 10) | clockId.
 * The 10 clock-id bits come from a hash of the Ghost post id so that posts sharing
 * a published_at millisecond (bulk imports) still get distinct rkeys. Replays and
 * reconciliation always re-derive the same rkey.
 */
export function deriveRkey(post: { id: string; published_at?: string | null }): string {
  const clockId = fnv1a64('ghost:' + post.id) & 0x3ffn;
  const ms = post.published_at ? Date.parse(post.published_at) : NaN;
  if (Number.isFinite(ms) && ms >= 0) {
    return encodeTid(((BigInt(ms) * 1000n) << 10n) | clockId);
  }
  return encodeTid(fnv1a64('ghost-id:' + post.id) & 0x7fffffffffffffffn);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tid.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/atproto/tid.ts tests/tid.test.ts
git commit -m "feat: deterministic TID rkey derivation from Ghost post metadata"
```

---

### Task 5: Record shaping and content hashing (TDD)

**Files:**
- Create: `tests/document.test.ts`, `src/records/document.ts`

- [ ] **Step 1: Write the failing test**

`tests/document.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizePath, postPath, shapeDocumentRecord, contentHash } from '../src/records/document';
import fixture from './fixtures/post-published.json';
import type { GhostPost } from '../src/ghost/types';

const post = fixture.post.current as GhostPost;
const PUB_URI = 'at://did:plc:77tdak46psveqneyegsdyc7l/site.standard.publication/self';
const GHOST_URL = 'https://werd.io';

describe('normalizePath', () => {
  it('ensures leading slash and strips trailing slashes', () => {
    expect(normalizePath('/hello-atmosphere/')).toBe('/hello-atmosphere');
    expect(normalizePath('hello')).toBe('/hello');
    expect(normalizePath('/')).toBe('/');
  });
});

describe('postPath', () => {
  it('derives the path from the post url', () => {
    expect(postPath(post, GHOST_URL)).toBe('/hello-atmosphere');
  });
  it('falls back to the slug when url is missing', () => {
    expect(postPath({ id: 'x', slug: 'my-slug' }, GHOST_URL)).toBe('/my-slug');
  });
});

describe('shapeDocumentRecord', () => {
  it('shapes a metadata-plus-excerpt record (no full body)', () => {
    const record = shapeDocumentRecord(post, PUB_URI, GHOST_URL);
    expect(record).toEqual({
      $type: 'site.standard.document',
      site: PUB_URI,
      path: '/hello-atmosphere',
      title: 'Hello Atmosphere',
      description: 'A test post about syndicating to the Atmosphere.',
      tags: ['atproto'],
      publishedAt: '2026-07-13T10:00:00.000Z',
    });
    expect(record).not.toHaveProperty('content');
    expect(record).not.toHaveProperty('textContent');
  });
  it('filters internal tags', () => {
    const record = shapeDocumentRecord(post, PUB_URI, GHOST_URL);
    expect(record.tags).not.toContain('#internal');
  });
  it('sets updatedAt only when it differs from publishedAt', () => {
    const edited = { ...post, updated_at: '2026-07-14T09:00:00.000Z' };
    expect(shapeDocumentRecord(edited, PUB_URI, GHOST_URL).updatedAt).toBe('2026-07-14T09:00:00.000Z');
    expect(shapeDocumentRecord(post, PUB_URI, GHOST_URL).updatedAt).toBeUndefined();
  });
  it('attaches a coverImage blob when provided', () => {
    const blob = { $type: 'blob', ref: { $link: 'bafkreifake' }, mimeType: 'image/jpeg', size: 123 };
    expect(shapeDocumentRecord(post, PUB_URI, GHOST_URL, blob).coverImage).toBe(blob);
  });
});

describe('contentHash', () => {
  it('is stable for identical material fields', async () => {
    expect(await contentHash(post, GHOST_URL)).toBe(await contentHash({ ...post }, GHOST_URL));
  });
  it('ignores immaterial changes (e.g. updated_at save-spam)', async () => {
    const saved = { ...post, updated_at: '2026-07-13T10:05:00.000Z' };
    expect(await contentHash(saved, GHOST_URL)).toBe(await contentHash(post, GHOST_URL));
  });
  it('changes when title, path, excerpt, tags, or feature image change', async () => {
    const base = await contentHash(post, GHOST_URL);
    expect(await contentHash({ ...post, title: 'New' }, GHOST_URL)).not.toBe(base);
    expect(await contentHash({ ...post, url: 'https://werd.io/renamed/' }, GHOST_URL)).not.toBe(base);
    expect(await contentHash({ ...post, custom_excerpt: 'New excerpt' }, GHOST_URL)).not.toBe(base);
    expect(await contentHash({ ...post, tags: [] }, GHOST_URL)).not.toBe(base);
    expect(await contentHash({ ...post, feature_image: null }, GHOST_URL)).not.toBe(base);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/document.test.ts`
Expected: FAIL — cannot resolve `../src/records/document`.

- [ ] **Step 3: Write `src/records/document.ts`**

```ts
import type { GhostPost } from '../ghost/types';

/** site.standard.document — metadata + excerpt only; canonical content lives at the publication URL. */
export interface DocumentRecord {
  $type: 'site.standard.document';
  site: string;
  title: string;
  publishedAt: string;
  path?: string;
  description?: string;
  tags?: string[];
  updatedAt?: string;
  coverImage?: unknown;
}

export function normalizePath(pathname: string): string {
  let p = pathname.startsWith('/') ? pathname : '/' + pathname;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export function postPath(post: Pick<GhostPost, 'id' | 'url' | 'slug'>, ghostUrl: string): string {
  if (post.url) {
    try {
      return normalizePath(new URL(post.url, ghostUrl).pathname);
    } catch {
      // fall through to slug
    }
  }
  return normalizePath('/' + (post.slug ?? post.id));
}

/** Conservative truncation well under the lexicon grapheme limits. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function publicTags(post: GhostPost): string[] {
  return (post.tags ?? [])
    .filter((t) => (t.visibility ?? 'public') === 'public' && t.name)
    .map((t) => truncate(t.name, 120));
}

function excerptOf(post: GhostPost): string {
  return (post.custom_excerpt || post.excerpt || '').trim();
}

export function shapeDocumentRecord(
  post: GhostPost,
  publicationUri: string,
  ghostUrl: string,
  coverImage?: unknown
): DocumentRecord {
  const publishedAt = post.published_at ?? post.updated_at ?? new Date(0).toISOString();
  const record: DocumentRecord = {
    $type: 'site.standard.document',
    site: publicationUri,
    path: postPath(post, ghostUrl),
    title: truncate(post.title || 'Untitled', 490),
    publishedAt: new Date(publishedAt).toISOString(),
  };
  const description = excerptOf(post);
  if (description) record.description = truncate(description, 2900);
  const tags = publicTags(post);
  if (tags.length) record.tags = tags;
  if (post.updated_at && post.updated_at !== post.published_at) {
    record.updatedAt = new Date(post.updated_at).toISOString();
  }
  if (coverImage) record.coverImage = coverImage;
  return record;
}

/**
 * Hash of the material fields only — the debounce against Ghost firing
 * post.published.edited on every save. updated_at is deliberately excluded.
 */
export async function contentHash(post: GhostPost, ghostUrl: string): Promise<string> {
  const material = {
    title: post.title ?? '',
    path: postPath(post, ghostUrl),
    description: excerptOf(post),
    publishedAt: post.published_at ?? null,
    tags: publicTags(post),
    featureImage: post.feature_image ?? null,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(material));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/document.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/records/document.ts tests/document.test.ts
git commit -m "feat: site.standard.document record shaping and material-field content hash"
```

---

### Task 6: Webhook event classification (TDD)

**Files:**
- Create: `tests/classify.test.ts`, `src/ghost/classify.ts`

- [ ] **Step 1: Write the failing test**

`tests/classify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyWebhook, isSyndicatable } from '../src/ghost/classify';
import fixture from './fixtures/post-published.json';
import type { GhostWebhookBody, GhostPost } from '../src/ghost/types';

const body = fixture as GhostWebhookBody;
const post = fixture.post.current as GhostPost;

describe('isSyndicatable', () => {
  it('accepts public published posts', () => {
    expect(isSyndicatable(post)).toBe(true);
  });
  it('rejects drafts, members-only, and email-only posts', () => {
    expect(isSyndicatable({ ...post, status: 'draft' })).toBe(false);
    expect(isSyndicatable({ ...post, visibility: 'members' })).toBe(false);
    expect(isSyndicatable({ ...post, email_only: true })).toBe(false);
    expect(isSyndicatable({ ...post, status: 'sent' })).toBe(false);
  });
});

describe('classifyWebhook', () => {
  it('classifies post.published as upsert', () => {
    expect(classifyWebhook(body)).toEqual({ kind: 'upsert', post });
  });
  it('classifies post.published.edited as upsert', () => {
    expect(classifyWebhook({ ...body, event: 'post.published.edited' })).toEqual({ kind: 'upsert', post });
  });
  it('classifies post.unpublished and post.deleted as delete', () => {
    expect(classifyWebhook({ event: 'post.unpublished', post: { current: { ...post, status: 'draft' } } }))
      .toEqual({ kind: 'delete', postId: post.id });
    expect(classifyWebhook({ event: 'post.deleted', post: { current: {}, previous: { id: post.id } } }))
      .toEqual({ kind: 'delete', postId: post.id });
  });
  it('turns a published post edited to non-public visibility into a delete', () => {
    expect(classifyWebhook({ event: 'post.published.edited', post: { current: { ...post, visibility: 'members' } } }))
      .toEqual({ kind: 'delete', postId: post.id });
  });
  it('ignores page events and empty bodies', () => {
    expect(classifyWebhook({ event: 'page.published', page: {} })).toBeNull();
    expect(classifyWebhook({})).toBeNull();
  });
  it('infers from payload shape when the event field is missing', () => {
    expect(classifyWebhook({ post: { current: post } })).toEqual({ kind: 'upsert', post });
    expect(classifyWebhook({ post: { current: {}, previous: { id: 'gone1' } } }))
      .toEqual({ kind: 'delete', postId: 'gone1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/classify.test.ts`
Expected: FAIL — cannot resolve `../src/ghost/classify`.

- [ ] **Step 3: Write `src/ghost/classify.ts`**

```ts
import type { SyncEvent } from '../env';
import type { GhostPost, GhostWebhookBody } from './types';

/** Only public, published, web-visible posts get records. */
export function isSyndicatable(post: GhostPost): boolean {
  return post.status === 'published' && post.visibility === 'public' && !post.email_only;
}

/**
 * Map a Ghost webhook body to a sync event, or null to ignore.
 * Prefers the top-level `event` field; falls back to payload shape for
 * older Ghost versions that omit it.
 */
export function classifyWebhook(body: GhostWebhookBody): SyncEvent | null {
  if (!body.post) return null; // pages, tags, members, site.changed…
  const current = body.post.current;
  const previous = body.post.previous;
  const postId = current?.id || previous?.id;
  if (!postId) return null;

  if (body.event === 'post.unpublished' || body.event === 'post.deleted') {
    return { kind: 'delete', postId };
  }

  if (current?.id && isSyndicatable(current as GhostPost)) {
    return { kind: 'upsert', post: current as GhostPost };
  }
  // A post we may have synced is no longer public/published: clean up.
  // processEvent treats deletes for unknown posts as a no-op.
  return { kind: 'delete', postId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/classify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ghost/classify.ts tests/classify.test.ts
git commit -m "feat: classify Ghost webhook payloads into sync events"
```

---

### Task 7: KV state helpers (TDD)

**Files:**
- Create: `tests/kv.test.ts`, `src/state/kv.ts`

- [ ] **Step 1: Write the failing test**

`tests/kv.test.ts` (uses the real miniflare-backed KV from `cloudflare:test`):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getPostState, putPostState, deletePostState, getPathUri,
  getPublicationUri, setPublicationUri, listPostIds, type PostState,
} from '../src/state/kv';

const state: PostState = {
  rkey: '3kizf2hc622ry',
  atUri: 'at://did:plc:x/site.standard.document/3kizf2hc622ry',
  contentHash: 'deadbeef',
  path: '/hello-atmosphere',
  updatedAt: '2026-07-13T10:00:00.000Z',
};

beforeEach(async () => {
  const all = await env.STATE.list();
  await Promise.all(all.keys.map((k) => env.STATE.delete(k.name)));
});

describe('post state', () => {
  it('round-trips post and path keys', async () => {
    await putPostState(env.STATE, 'p1', state);
    expect(await getPostState(env.STATE, 'p1')).toEqual(state);
    expect(await getPathUri(env.STATE, '/hello-atmosphere')).toBe(state.atUri);
  });
  it('moves the path key on slug change', async () => {
    await putPostState(env.STATE, 'p1', state);
    const renamed = { ...state, path: '/renamed' };
    await putPostState(env.STATE, 'p1', renamed, state.path);
    expect(await getPathUri(env.STATE, '/renamed')).toBe(state.atUri);
    expect(await getPathUri(env.STATE, '/hello-atmosphere')).toBeNull();
  });
  it('deletes both keys', async () => {
    await putPostState(env.STATE, 'p1', state);
    await deletePostState(env.STATE, 'p1', state.path);
    expect(await getPostState(env.STATE, 'p1')).toBeNull();
    expect(await getPathUri(env.STATE, '/hello-atmosphere')).toBeNull();
  });
  it('lists post ids', async () => {
    await putPostState(env.STATE, 'p1', state);
    await putPostState(env.STATE, 'p2', { ...state, path: '/two' });
    expect((await listPostIds(env.STATE)).sort()).toEqual(['p1', 'p2']);
  });
});

describe('publication', () => {
  it('round-trips the publication AT-URI', async () => {
    expect(await getPublicationUri(env.STATE)).toBeNull();
    await setPublicationUri(env.STATE, 'at://did:plc:x/site.standard.publication/self');
    expect(await getPublicationUri(env.STATE)).toBe('at://did:plc:x/site.standard.publication/self');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/kv.test.ts`
Expected: FAIL — cannot resolve `../src/state/kv`.

- [ ] **Step 3: Write `src/state/kv.ts`**

```ts
const POST_PREFIX = 'post:';
const PATH_PREFIX = 'path:';
const PUBLICATION_KEY = 'publication';

export interface PostState {
  rkey: string;
  atUri: string;
  contentHash: string;
  path: string;
  updatedAt: string;
}

export async function getPostState(kv: KVNamespace, postId: string): Promise<PostState | null> {
  return kv.get<PostState>(POST_PREFIX + postId, 'json');
}

/** Writes both mappings; when the path changed, removes the stale path key. */
export async function putPostState(
  kv: KVNamespace,
  postId: string,
  state: PostState,
  oldPath?: string
): Promise<void> {
  await kv.put(POST_PREFIX + postId, JSON.stringify(state));
  await kv.put(PATH_PREFIX + state.path, JSON.stringify({ atUri: state.atUri }));
  if (oldPath && oldPath !== state.path) await kv.delete(PATH_PREFIX + oldPath);
}

export async function deletePostState(kv: KVNamespace, postId: string, path?: string): Promise<void> {
  await kv.delete(POST_PREFIX + postId);
  if (path) await kv.delete(PATH_PREFIX + path);
}

export async function getPathUri(kv: KVNamespace, path: string): Promise<string | null> {
  const entry = await kv.get<{ atUri: string }>(PATH_PREFIX + path, 'json');
  return entry?.atUri ?? null;
}

export async function listPostIds(kv: KVNamespace): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: POST_PREFIX, cursor });
    ids.push(...page.keys.map((k) => k.name.slice(POST_PREFIX.length)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return ids;
}

export async function getPublicationUri(kv: KVNamespace): Promise<string | null> {
  const entry = await kv.get<{ atUri: string }>(PUBLICATION_KEY, 'json');
  return entry?.atUri ?? null;
}

export async function setPublicationUri(kv: KVNamespace, atUri: string): Promise<void> {
  await kv.put(PUBLICATION_KEY, JSON.stringify({ atUri }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/kv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/kv.ts tests/kv.test.ts
git commit -m "feat: KV state helpers for post, path, and publication mappings"
```

---

### Task 8: Sync engine — processEvent (TDD)

**Files:**
- Create: `tests/sync.test.ts`, `src/sync.ts`

- [ ] **Step 1: Write the failing test**

`tests/sync.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { processEvent, type PdsWriter } from '../src/sync';
import { getPostState, getPathUri } from '../src/state/kv';
import fixture from './fixtures/post-published.json';
import type { GhostPost } from '../src/ghost/types';

const post = fixture.post.current as GhostPost;
const PUB_URI = 'at://did:plc:x/site.standard.publication/self';

function fakeWriter() {
  const calls = { puts: [] as Array<{ rkey: string; record: any }>, deletes: [] as string[] };
  const writer: PdsWriter = {
    async putDocument(rkey, record) {
      calls.puts.push({ rkey, record });
      return { uri: `at://did:plc:x/site.standard.document/${rkey}` };
    },
    async deleteDocument(rkey) {
      calls.deletes.push(rkey);
    },
    async fetchImageBlob() {
      return { $type: 'blob', ref: { $link: 'bafkreifake' }, mimeType: 'image/jpeg', size: 1 };
    },
  };
  return { writer, calls };
}

function deps(writer: PdsWriter) {
  return { writer, kv: env.STATE, publicationUri: PUB_URI, ghostUrl: 'https://werd.io' };
}

beforeEach(async () => {
  const all = await env.STATE.list();
  await Promise.all(all.keys.map((k) => env.STATE.delete(k.name)));
});

describe('processEvent upsert', () => {
  it('creates a record and both KV mappings on first publish', async () => {
    const { writer, calls } = fakeWriter();
    const result = await processEvent({ kind: 'upsert', post }, deps(writer));
    expect(result).toBe('created');
    expect(calls.puts).toHaveLength(1);
    expect(calls.puts[0].rkey).toMatch(/^[2-7a-z]{13}$/);
    expect(calls.puts[0].record.site).toBe(PUB_URI);
    expect(calls.puts[0].record.coverImage).toBeDefined();
    const state = await getPostState(env.STATE, post.id);
    expect(state?.path).toBe('/hello-atmosphere');
    expect(await getPathUri(env.STATE, '/hello-atmosphere')).toBe(state?.atUri);
  });
  it('skips when the content hash is unchanged (save-spam debounce)', async () => {
    const { writer, calls } = fakeWriter();
    await processEvent({ kind: 'upsert', post }, deps(writer));
    const again = await processEvent(
      { kind: 'upsert', post: { ...post, updated_at: '2026-07-13T11:11:11.000Z' } },
      deps(writer)
    );
    expect(again).toBe('skipped');
    expect(calls.puts).toHaveLength(1);
  });
  it('updates in place with the same rkey when material fields change', async () => {
    const { writer, calls } = fakeWriter();
    await processEvent({ kind: 'upsert', post }, deps(writer));
    const result = await processEvent({ kind: 'upsert', post: { ...post, title: 'Renamed' } }, deps(writer));
    expect(result).toBe('updated');
    expect(calls.puts).toHaveLength(2);
    expect(calls.puts[1].rkey).toBe(calls.puts[0].rkey);
  });
  it('moves the path mapping on slug change', async () => {
    const { writer } = fakeWriter();
    await processEvent({ kind: 'upsert', post }, deps(writer));
    await processEvent(
      { kind: 'upsert', post: { ...post, slug: 'renamed', url: 'https://werd.io/renamed/' } },
      deps(writer)
    );
    expect(await getPathUri(env.STATE, '/renamed')).not.toBeNull();
    expect(await getPathUri(env.STATE, '/hello-atmosphere')).toBeNull();
  });
  it('omits coverImage when the blob fetch fails, and still writes the record', async () => {
    const { writer, calls } = fakeWriter();
    writer.fetchImageBlob = async () => undefined;
    const result = await processEvent({ kind: 'upsert', post }, deps(writer));
    expect(result).toBe('created');
    expect(calls.puts[0].record.coverImage).toBeUndefined();
  });
});

describe('processEvent delete', () => {
  it('deletes the record and both KV keys', async () => {
    const { writer, calls } = fakeWriter();
    await processEvent({ kind: 'upsert', post }, deps(writer));
    const result = await processEvent({ kind: 'delete', postId: post.id }, deps(writer));
    expect(result).toBe('deleted');
    expect(calls.deletes).toHaveLength(1);
    expect(await getPostState(env.STATE, post.id)).toBeNull();
    expect(await getPathUri(env.STATE, '/hello-atmosphere')).toBeNull();
  });
  it('is a no-op for unknown posts', async () => {
    const { writer, calls } = fakeWriter();
    const result = await processEvent({ kind: 'delete', postId: 'never-seen' }, deps(writer));
    expect(result).toBe('noop');
    expect(calls.deletes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync.test.ts`
Expected: FAIL — cannot resolve `../src/sync`.

- [ ] **Step 3: Write `src/sync.ts`**

```ts
import type { SyncEvent } from './env';
import { deriveRkey } from './atproto/tid';
import { contentHash, shapeDocumentRecord, postPath, type DocumentRecord } from './records/document';
import { getPostState, putPostState, deletePostState } from './state/kv';

/** Thin surface over the PDS so the sync engine is testable without a network. */
export interface PdsWriter {
  putDocument(rkey: string, record: DocumentRecord): Promise<{ uri: string }>;
  deleteDocument(rkey: string): Promise<void>;
  /** Fetch an image and upload it as a blob; undefined on any failure (fail open). */
  fetchImageBlob(url: string): Promise<unknown | undefined>;
}

export interface SyncDeps {
  writer: PdsWriter;
  kv: KVNamespace;
  publicationUri: string;
  ghostUrl: string;
}

export type SyncResult = 'created' | 'updated' | 'skipped' | 'deleted' | 'noop';

export async function processEvent(event: SyncEvent, deps: SyncDeps): Promise<SyncResult> {
  if (event.kind === 'delete') {
    const state = await getPostState(deps.kv, event.postId);
    if (!state) return 'noop';
    await deps.writer.deleteDocument(state.rkey);
    await deletePostState(deps.kv, event.postId, state.path);
    return 'deleted';
  }

  const post = event.post;
  const state = await getPostState(deps.kv, post.id);
  const hash = await contentHash(post, deps.ghostUrl);
  if (state && state.contentHash === hash) return 'skipped';

  const rkey = state?.rkey ?? deriveRkey(post);
  let coverImage: unknown | undefined;
  if (post.feature_image) coverImage = await deps.writer.fetchImageBlob(post.feature_image);
  const record = shapeDocumentRecord(post, deps.publicationUri, deps.ghostUrl, coverImage);
  const { uri } = await deps.writer.putDocument(rkey, record);
  await putPostState(
    deps.kv,
    post.id,
    {
      rkey,
      atUri: uri,
      contentHash: hash,
      path: postPath(post, deps.ghostUrl),
      updatedAt: post.updated_at ?? post.published_at ?? '',
    },
    state?.path
  );
  return state ? 'updated' : 'created';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync.ts tests/sync.test.ts
git commit -m "feat: idempotent sync engine with content-hash debounce"
```

---

### Task 9: AT Protocol client wrapper

**Files:**
- Create: `tests/atproto-client.test.ts`, `src/atproto/client.ts`

- [ ] **Step 1: Write the failing test**

`tests/atproto-client.test.ts` (the session itself needs a network; unit-test the DID safety assertion, which is the part that must never regress):

```ts
import { describe, it, expect } from 'vitest';
import { assertSessionDid } from '../src/atproto/client';

describe('assertSessionDid', () => {
  it('passes when the session DID matches config', () => {
    expect(() => assertSessionDid('did:plc:abc', 'did:plc:abc')).not.toThrow();
  });
  it('throws loudly on mismatch', () => {
    expect(() => assertSessionDid('did:plc:other', 'did:plc:abc')).toThrow(/refusing to write/i);
  });
  it('throws when the session has no DID', () => {
    expect(() => assertSessionDid(undefined, 'did:plc:abc')).toThrow(/refusing to write/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/atproto-client.test.ts`
Expected: FAIL — cannot resolve `../src/atproto/client`.

- [ ] **Step 3: Write `src/atproto/client.ts`**

```ts
import { AtpAgent } from '@atproto/api';
import type { Env } from '../env';
import type { PdsWriter } from '../sync';

export const DOCUMENT_COLLECTION = 'site.standard.document';
export const PUBLICATION_COLLECTION = 'site.standard.publication';
export const PUBLICATION_RKEY = 'self';

const MAX_BLOB_BYTES = 1_000_000; // lexicon: coverImage/icon blobs < 1MB

/** A misconfigured handle must never write to the wrong repo. */
export function assertSessionDid(sessionDid: string | undefined, expected: string): void {
  if (!sessionDid || sessionDid !== expected) {
    throw new Error(
      `FATAL: authenticated session DID (${sessionDid ?? 'none'}) does not match ATPROTO_DID (${expected}); refusing to write`
    );
  }
}

export async function createSession(env: Env): Promise<AtpAgent> {
  const agent = new AtpAgent({ service: env.ATPROTO_PDS_URL });
  await agent.login({ identifier: env.ATPROTO_HANDLE, password: env.ATPROTO_APP_PASSWORD });
  assertSessionDid(agent.session?.did, env.ATPROTO_DID);
  return agent;
}

/** Fetch an image URL and upload it as a blob. Returns undefined on any failure or oversize. */
export async function uploadImageFromUrl(agent: AtpAgent, url: string): Promise<unknown | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength >= MAX_BLOB_BYTES) return undefined;
    const uploaded = await agent.uploadBlob(bytes, {
      encoding: res.headers.get('content-type') ?? 'image/jpeg',
    });
    return uploaded.data.blob;
  } catch {
    return undefined;
  }
}

export function createPdsWriter(agent: AtpAgent, env: Env): PdsWriter {
  return {
    async putDocument(rkey, record) {
      // PDS does not host the site.standard lexicons: validate must be false.
      const res = await agent.com.atproto.repo.putRecord({
        repo: env.ATPROTO_DID,
        collection: DOCUMENT_COLLECTION,
        rkey,
        record: record as unknown as Record<string, unknown>,
        validate: false,
      });
      return { uri: res.data.uri };
    },
    async deleteDocument(rkey) {
      try {
        await agent.com.atproto.repo.deleteRecord({
          repo: env.ATPROTO_DID,
          collection: DOCUMENT_COLLECTION,
          rkey,
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 400 && status !== 404) throw err; // already gone is fine
      }
    },
    async fetchImageBlob(url) {
      return uploadImageFromUrl(agent, url);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/atproto-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/atproto/client.ts tests/atproto-client.test.ts
git commit -m "feat: atproto client wrapper with DID safety assertion and validate:false writes"
```

---

### Task 10: fetch handlers — webhook, well-known, proxy injection (TDD)

**Files:**
- Create: `tests/handlers.test.ts`, `src/handlers/webhook.ts`, `src/handlers/wellknown.ts`, `src/handlers/proxy.ts`

- [ ] **Step 1: Write the failing test**

`tests/handlers.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleWebhook } from '../src/handlers/webhook';
import { handleWellKnown } from '../src/handlers/wellknown';
import { buildOriginRequest, injectLinkTags } from '../src/handlers/proxy';
import { setPublicationUri } from '../src/state/kv';
import fixture from './fixtures/post-published.json';
import type { Env, SyncEvent } from '../src/env';

const SECRET = 'test-secret';

async function signedHeader(body: string, secret: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body + ts));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}, t=${ts}`;
}

function webhookEnv(sent: SyncEvent[]): Env {
  return {
    ...env,
    GHOST_WEBHOOK_SECRET: SECRET,
    EVENTS: { send: async (m: SyncEvent) => void sent.push(m) } as unknown as Queue<SyncEvent>,
  };
}

beforeEach(async () => {
  const all = await env.STATE.list();
  await Promise.all(all.keys.map((k) => env.STATE.delete(k.name)));
});

describe('handleWebhook', () => {
  const body = JSON.stringify(fixture);

  it('enqueues a valid signed event and returns 202', async () => {
    const sent: SyncEvent[] = [];
    const request = new Request('https://werd.io/_atproto/ghost-webhook', {
      method: 'POST',
      body,
      headers: { 'x-ghost-signature': await signedHeader(body, SECRET, Date.now()) },
    });
    const res = await handleWebhook(request, webhookEnv(sent));
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('upsert');
  });
  it('rejects a bad signature with 401 and enqueues nothing', async () => {
    const sent: SyncEvent[] = [];
    const request = new Request('https://werd.io/_atproto/ghost-webhook', {
      method: 'POST',
      body,
      headers: { 'x-ghost-signature': await signedHeader(body + 'tamper', SECRET, Date.now()) },
    });
    const res = await handleWebhook(request, webhookEnv(sent));
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });
  it('acks ignorable events with 200 without enqueueing', async () => {
    const sent: SyncEvent[] = [];
    const ignorable = JSON.stringify({ event: 'page.published', page: {} });
    const request = new Request('https://werd.io/_atproto/ghost-webhook', {
      method: 'POST',
      body: ignorable,
      headers: { 'x-ghost-signature': await signedHeader(ignorable, SECRET, Date.now()) },
    });
    const res = await handleWebhook(request, webhookEnv(sent));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});

describe('handleWellKnown', () => {
  it('returns the publication AT-URI as text/plain', async () => {
    await setPublicationUri(env.STATE, 'at://did:plc:x/site.standard.publication/self');
    const res = await handleWellKnown(env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('at://did:plc:x/site.standard.publication/self');
  });
  it('404s when no publication record exists yet', async () => {
    const res = await handleWellKnown(env);
    expect(res.status).toBe(404);
  });
});

describe('buildOriginRequest', () => {
  it('rewrites the host to the Ghost origin, preserving path and query', () => {
    const req = buildOriginRequest(
      new Request('http://localhost:8787/hello-atmosphere/?x=1'),
      'https://werd.io'
    );
    expect(req.url).toBe('https://werd.io/hello-atmosphere/?x=1');
  });
});

describe('injectLinkTags', () => {
  const DOC = 'at://did:plc:x/site.standard.document/3kizf2hc622ry';
  const PUB = 'at://did:plc:x/site.standard.publication/self';

  it('injects both link tags into head', async () => {
    const page = new Response('<html><head><title>t</title></head><body>b</body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const html = await injectLinkTags(page, DOC, PUB).text();
    expect(html).toContain(`<link rel="site.standard.document" href="${DOC}">`);
    expect(html).toContain(`<link rel="site.standard.publication" href="${PUB}">`);
    expect(html).toContain('<title>t</title>');
  });
  it('injects only the document tag when the publication URI is unknown', async () => {
    const page = new Response('<html><head></head><body></body></html>', {
      headers: { 'content-type': 'text/html' },
    });
    const html = await injectLinkTags(page, DOC, null).text();
    expect(html).toContain('site.standard.document');
    expect(html).not.toContain('site.standard.publication');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handlers.test.ts`
Expected: FAIL — cannot resolve the handler modules.

- [ ] **Step 3: Write `src/handlers/webhook.ts`**

```ts
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

  await env.EVENTS.send(event);
  return new Response('queued', { status: 202 });
}
```

- [ ] **Step 4: Write `src/handlers/wellknown.ts`**

```ts
import type { Env } from '../env';
import { getPublicationUri } from '../state/kv';

export async function handleWellKnown(env: Env): Promise<Response> {
  try {
    const uri = await getPublicationUri(env.STATE);
    if (!uri) return new Response('not found', { status: 404 });
    return new Response(uri, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    });
  } catch {
    return new Response('temporarily unavailable', { status: 503 });
  }
}
```

- [ ] **Step 5: Write `src/handlers/proxy.ts`**

```ts
import type { Env } from '../env';
import { normalizePath } from '../records/document';
import { getPathUri, getPublicationUri } from '../state/kv';

/**
 * Point the incoming request at the Ghost origin. In production on the
 * werd.io/* route this resolves to a same-zone subrequest that goes straight
 * to origin; in `wrangler dev` it retargets localhost URLs at GHOST_URL.
 */
export function buildOriginRequest(request: Request, ghostUrl: string): Request {
  const url = new URL(request.url);
  const ghost = new URL(ghostUrl);
  url.protocol = ghost.protocol;
  url.hostname = ghost.hostname;
  url.port = ghost.port;
  return new Request(url.toString(), request);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function injectLinkTags(response: Response, docUri: string, pubUri: string | null): Response {
  let tags = `<link rel="site.standard.document" href="${escapeAttr(docUri)}">`;
  if (pubUri) tags += `<link rel="site.standard.publication" href="${escapeAttr(pubUri)}">`;
  return new HTMLRewriter()
    .on('head', {
      element(el) {
        el.append(tags, { html: true });
      },
    })
    .transform(response);
}

/**
 * Proxy everything to origin. Only successful GET/HEAD HTML responses whose
 * path has a KV entry get link tags injected; every other response — and any
 * KV failure — passes through untouched (fail open, never degrade the blog).
 */
export async function handleProxy(request: Request, env: Env): Promise<Response> {
  const originResponse = await fetch(buildOriginRequest(request, env.GHOST_URL), {
    redirect: 'manual',
  });
  if (request.method !== 'GET' && request.method !== 'HEAD') return originResponse;
  if (originResponse.status !== 200) return originResponse;
  const contentType = originResponse.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) return originResponse;

  let docUri: string | null = null;
  let pubUri: string | null = null;
  try {
    const path = normalizePath(new URL(request.url).pathname);
    [docUri, pubUri] = await Promise.all([
      getPathUri(env.STATE, path),
      getPublicationUri(env.STATE),
    ]);
  } catch {
    return originResponse;
  }
  if (!docUri) return originResponse;
  return injectLinkTags(originResponse, docUri, pubUri);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/handlers.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/handlers tests/handlers.test.ts
git commit -m "feat: webhook receiver, well-known endpoint, and fail-open proxy injection"
```

---

### Task 11: Publication setup route

**Files:**
- Create: `tests/publication.test.ts`, `src/records/publication.ts`, `src/ghost/content-api.ts`, `src/handlers/setup.ts`

- [ ] **Step 1: Write the failing test**

`tests/publication.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shapePublicationRecord } from '../src/records/publication';
import { isAuthorizedAdmin } from '../src/handlers/setup';
import type { Env } from '../src/env';

describe('shapePublicationRecord', () => {
  it('shapes the record from Ghost settings', () => {
    const record = shapePublicationRecord(
      { title: 'Werd I/O', description: 'An open blog' },
      'https://werd.io/'
    );
    expect(record).toEqual({
      $type: 'site.standard.publication',
      url: 'https://werd.io',
      name: 'Werd I/O',
      description: 'An open blog',
      preferences: { showInDiscover: true },
    });
  });
  it('applies the PUBLICATION_NAME override and optional icon', () => {
    const icon = { $type: 'blob', ref: { $link: 'bafkreifake' }, mimeType: 'image/png', size: 9 };
    const record = shapePublicationRecord({ title: 'Ignored' }, 'https://werd.io', 'Override', icon);
    expect(record.name).toBe('Override');
    expect(record.icon).toBe(icon);
  });
});

describe('isAuthorizedAdmin', () => {
  const env = { GHOST_WEBHOOK_SECRET: 'admin-secret' } as Env;
  it('accepts the bearer secret', () => {
    const req = new Request('https://werd.io/_atproto/setup', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(isAuthorizedAdmin(req, env)).toBe(true);
  });
  it('rejects wrong or missing tokens', () => {
    const wrong = new Request('https://werd.io/_atproto/setup', {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
    });
    expect(isAuthorizedAdmin(wrong, env)).toBe(false);
    expect(isAuthorizedAdmin(new Request('https://werd.io/_atproto/setup', { method: 'POST' }), env)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/publication.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Write `src/records/publication.ts`**

```ts
import type { GhostSettings } from '../ghost/types';

export interface PublicationRecord {
  $type: 'site.standard.publication';
  url: string;
  name: string;
  description?: string;
  icon?: unknown;
  preferences?: { showInDiscover?: boolean };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function shapePublicationRecord(
  settings: GhostSettings,
  ghostUrl: string,
  nameOverride?: string,
  icon?: unknown
): PublicationRecord {
  const url = ghostUrl.replace(/\/+$/, '');
  const record: PublicationRecord = {
    $type: 'site.standard.publication',
    url,
    name: truncate(nameOverride || settings.title || url, 490),
    preferences: { showInDiscover: true },
  };
  if (settings.description) record.description = truncate(settings.description, 2900);
  if (icon) record.icon = icon;
  return record;
}
```

- [ ] **Step 4: Write `src/ghost/content-api.ts`**

```ts
import type { Env } from '../env';
import type { GhostPost, GhostSettings } from './types';

const PAGE_SIZE = 100;

/** Page through the Content API. Returns only published posts (the Content API never returns drafts). */
export async function fetchAllPosts(env: Env): Promise<GhostPost[]> {
  const posts: GhostPost[] = [];
  let page = 1;
  for (;;) {
    const url = new URL('/ghost/api/content/posts/', env.GHOST_URL);
    url.searchParams.set('key', env.GHOST_CONTENT_API_KEY);
    url.searchParams.set('include', 'tags');
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    const res = await fetch(url.toString(), { headers: { 'accept-version': 'v5.0' } });
    if (!res.ok) throw new Error(`Ghost Content API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      posts: GhostPost[];
      meta?: { pagination?: { pages?: number } };
    };
    posts.push(...data.posts);
    const pages = data.meta?.pagination?.pages ?? page;
    if (page >= pages) break;
    page++;
  }
  // The Content API omits `status`; everything it returns is published.
  return posts.map((p) => ({ ...p, status: p.status ?? 'published' }));
}

export async function fetchSettings(env: Env): Promise<GhostSettings> {
  const url = new URL('/ghost/api/content/settings/', env.GHOST_URL);
  url.searchParams.set('key', env.GHOST_CONTENT_API_KEY);
  const res = await fetch(url.toString(), { headers: { 'accept-version': 'v5.0' } });
  if (!res.ok) throw new Error(`Ghost Content API error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { settings: GhostSettings };
  return data.settings;
}
```

- [ ] **Step 5: Write `src/handlers/setup.ts`**

```ts
import type { Env } from '../env';
import { timingSafeEqualStr } from '../ghost/signature';
import { fetchSettings } from '../ghost/content-api';
import { shapePublicationRecord } from '../records/publication';
import {
  createSession, uploadImageFromUrl, PUBLICATION_COLLECTION, PUBLICATION_RKEY,
} from '../atproto/client';
import { setPublicationUri } from '../state/kv';

export function isAuthorizedAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get('authorization') ?? '';
  return timingSafeEqualStr(auth, `Bearer ${env.GHOST_WEBHOOK_SECRET}`);
}

/**
 * One-off (idempotent) publication setup: pulls name/description/icon from
 * Ghost settings and upserts the site.standard.publication record at rkey
 * `self`. Protected by the webhook secret as a bearer token.
 */
export async function handleSetup(request: Request, env: Env): Promise<Response> {
  if (!isAuthorizedAdmin(request, env)) return new Response('unauthorized', { status: 401 });
  try {
    const settings = await fetchSettings(env);
    const agent = await createSession(env);
    const iconUrl = settings.icon || settings.logo;
    const icon = iconUrl ? await uploadImageFromUrl(agent, iconUrl) : undefined;
    const record = shapePublicationRecord(settings, env.GHOST_URL, env.PUBLICATION_NAME, icon);
    const res = await agent.com.atproto.repo.putRecord({
      repo: env.ATPROTO_DID,
      collection: PUBLICATION_COLLECTION,
      rkey: PUBLICATION_RKEY,
      record: record as unknown as Record<string, unknown>,
      validate: false,
    });
    await setPublicationUri(env.STATE, res.data.uri);
    return Response.json({ uri: res.data.uri, record });
  } catch (err) {
    console.error('setup failed', err);
    return new Response(`setup failed: ${(err as Error).message}`, { status: 500 });
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/publication.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/records/publication.ts src/ghost/content-api.ts src/handlers/setup.ts tests/publication.test.ts
git commit -m "feat: publication record setup route fed by Ghost settings"
```

---

### Task 12: Reconciliation sweep

**Files:**
- Create: `tests/reconcile.test.ts`, `src/reconcile.ts`

- [ ] **Step 1: Write the failing test**

`tests/reconcile.test.ts` (exercises diff logic with injected posts and a fake writer — network-fetching is composed in at the entry point):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { reconcilePosts } from '../src/reconcile';
import { processEvent, type PdsWriter } from '../src/sync';
import { getPostState } from '../src/state/kv';
import fixture from './fixtures/post-published.json';
import type { GhostPost } from '../src/ghost/types';

const post = fixture.post.current as GhostPost;
const PUB_URI = 'at://did:plc:x/site.standard.publication/self';

function fakeWriter() {
  const calls = { puts: [] as string[], deletes: [] as string[] };
  const writer: PdsWriter = {
    async putDocument(rkey) {
      calls.puts.push(rkey);
      return { uri: `at://did:plc:x/site.standard.document/${rkey}` };
    },
    async deleteDocument(rkey) {
      calls.deletes.push(rkey);
    },
    async fetchImageBlob() {
      return undefined;
    },
  };
  return { writer, calls };
}

function deps(writer: PdsWriter) {
  return { writer, kv: env.STATE, publicationUri: PUB_URI, ghostUrl: 'https://werd.io' };
}

beforeEach(async () => {
  const all = await env.STATE.list();
  await Promise.all(all.keys.map((k) => env.STATE.delete(k.name)));
});

describe('reconcilePosts', () => {
  it('creates missing records and deletes orphans', async () => {
    const { writer, calls } = fakeWriter();
    // seed an orphan that Ghost no longer has
    await processEvent({ kind: 'upsert', post: { ...post, id: 'orphan1', slug: 'gone', url: 'https://werd.io/gone/' } }, deps(writer));
    calls.puts.length = 0;

    const report = await reconcilePosts([post], deps(writer), { maxWrites: 100, sleepMs: 0 });
    expect(report).toMatchObject({ created: 1, deleted: 1, updated: 0, skipped: 0, capped: false });
    expect(await getPostState(env.STATE, post.id)).not.toBeNull();
    expect(await getPostState(env.STATE, 'orphan1')).toBeNull();
  });
  it('is idempotent — a second run makes zero writes', async () => {
    const { writer, calls } = fakeWriter();
    await reconcilePosts([post], deps(writer), { maxWrites: 100, sleepMs: 0 });
    calls.puts.length = 0;
    const report = await reconcilePosts([post], deps(writer), { maxWrites: 100, sleepMs: 0 });
    expect(report).toMatchObject({ created: 0, updated: 0, deleted: 0, skipped: 1 });
    expect(calls.puts).toHaveLength(0);
  });
  it('filters non-public posts and caps writes per run', async () => {
    const { writer } = fakeWriter();
    const many = [
      post,
      { ...post, id: 'p2', slug: 'two', url: 'https://werd.io/two/' },
      { ...post, id: 'p3', slug: 'three', url: 'https://werd.io/three/' },
      { ...post, id: 'members', visibility: 'members' },
    ];
    const report = await reconcilePosts(many, deps(writer), { maxWrites: 2, sleepMs: 0 });
    expect(report.created).toBe(2);
    expect(report.capped).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reconcile.test.ts`
Expected: FAIL — cannot resolve `../src/reconcile`.

- [ ] **Step 3: Write `src/reconcile.ts`**

```ts
import type { Env } from './env';
import type { GhostPost } from './ghost/types';
import { isSyndicatable } from './ghost/classify';
import { fetchAllPosts } from './ghost/content-api';
import { createSession, createPdsWriter } from './atproto/client';
import { getPublicationUri, listPostIds } from './state/kv';
import { processEvent, type SyncDeps } from './sync';

export interface ReconcileReport {
  created: number;
  updated: number;
  skipped: number;
  deleted: number;
  capped: boolean;
}

export interface ReconcileOptions {
  /** Cap on PDS writes per run so huge backfills fit in one invocation's limits. */
  maxWrites: number;
  /** Politeness delay between PDS writes. */
  sleepMs: number;
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Diff the given Ghost posts against KV and repair. Pure of network fetching for testability. */
export async function reconcilePosts(
  allPosts: GhostPost[],
  deps: SyncDeps,
  opts: ReconcileOptions
): Promise<ReconcileReport> {
  const report: ReconcileReport = { created: 0, updated: 0, skipped: 0, deleted: 0, capped: false };
  const posts = allPosts.filter(isSyndicatable);
  let writes = 0;

  for (const post of posts) {
    if (writes >= opts.maxWrites) {
      report.capped = true;
      break;
    }
    const result = await processEvent({ kind: 'upsert', post }, deps);
    if (result === 'skipped') {
      report.skipped++;
    } else if (result === 'created' || result === 'updated') {
      report[result]++;
      writes++;
      await sleep(opts.sleepMs);
    }
  }

  const ghostIds = new Set(posts.map((p) => p.id));
  for (const id of await listPostIds(deps.kv)) {
    if (ghostIds.has(id)) continue;
    if (writes >= opts.maxWrites) {
      report.capped = true;
      break;
    }
    const result = await processEvent({ kind: 'delete', postId: id }, deps);
    if (result === 'deleted') {
      report.deleted++;
      writes++;
      await sleep(opts.sleepMs);
    }
  }
  return report;
}

/** Entry point for the cron trigger and the manual admin route. */
export async function reconcile(env: Env, maxWrites = 200): Promise<ReconcileReport> {
  const publicationUri = await getPublicationUri(env.STATE);
  if (!publicationUri) {
    throw new Error('publication record not set up; POST /_atproto/setup first');
  }
  const posts = await fetchAllPosts(env);
  const agent = await createSession(env);
  const deps: SyncDeps = {
    writer: createPdsWriter(agent, env),
    kv: env.STATE,
    publicationUri,
    ghostUrl: env.GHOST_URL,
  };
  const report = await reconcilePosts(posts, deps, { maxWrites, sleepMs: 200 });
  console.log('reconcile complete', JSON.stringify(report));
  return report;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reconcile.ts tests/reconcile.test.ts
git commit -m "feat: idempotent reconciliation sweep with write cap and PDS politeness delay"
```

---

### Task 13: Worker entry point wiring

**Files:**
- Create: `src/index.ts`
- Modify: none

- [ ] **Step 1: Write `src/index.ts`**

```ts
import type { Env, SyncEvent } from './env';
import { handleWebhook } from './handlers/webhook';
import { handleWellKnown } from './handlers/wellknown';
import { handleProxy } from './handlers/proxy';
import { handleSetup, isAuthorizedAdmin } from './handlers/setup';
import { reconcile } from './reconcile';
import { createSession, createPdsWriter } from './atproto/client';
import { getPublicationUri } from './state/kv';
import { processEvent, type SyncDeps } from './sync';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/_atproto/ghost-webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }
    if (pathname === '/.well-known/site.standard.publication') {
      return handleWellKnown(env);
    }
    if (pathname === '/_atproto/setup' && request.method === 'POST') {
      return handleSetup(request, env);
    }
    if (pathname === '/_atproto/reconcile' && request.method === 'POST') {
      if (!isAuthorizedAdmin(request, env)) return new Response('unauthorized', { status: 401 });
      try {
        const report = await reconcile(env);
        return Response.json(report);
      } catch (err) {
        return new Response(`reconcile failed: ${(err as Error).message}`, { status: 500 });
      }
    }
    return handleProxy(request, env);
  },

  async queue(batch: MessageBatch<SyncEvent>, env: Env): Promise<void> {
    const publicationUri = await getPublicationUri(env.STATE);
    if (!publicationUri) {
      console.error('queue: publication record not set up; retrying batch later');
      batch.retryAll({ delaySeconds: 300 });
      return;
    }
    const agent = await createSession(env);
    const deps: SyncDeps = {
      writer: createPdsWriter(agent, env),
      kv: env.STATE,
      publicationUri,
      ghostUrl: env.GHOST_URL,
    };
    for (const message of batch.messages) {
      try {
        const result = await processEvent(message.body, deps);
        console.log('queue event', message.body.kind, result);
        message.ack();
      } catch (err) {
        console.error('queue event failed', err);
        message.retry({ delaySeconds: 60 });
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      reconcile(env).catch((err) => console.error('scheduled reconcile failed', err))
    );
  },
} satisfies ExportedHandler<Env, SyncEvent>;
```

- [ ] **Step 2: Run full test suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 3: Smoke-test with wrangler dev**

Run:
```bash
cp .dev.vars.example .dev.vars   # placeholders are fine for the proxy/well-known smoke
npx wrangler dev --port 8787 &
sleep 8
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/                       # expect 200 (proxied Ghost homepage)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/.well-known/site.standard.publication  # expect 404 (no publication yet)
kill %1
```
Expected: homepage 200 through the proxy; well-known 404 before setup. (`wrangler dev` will warn about the placeholder KV id — if it refuses to start, run `npx wrangler kv namespace create STATE` first and paste the real id into `wrangler.jsonc`; that id is needed before deploy anyway.)

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire fetch/queue/scheduled handlers in Worker entry point"
```

---

### Task 14: Webhook creation script, README, deploy checklist

**Files:**
- Create: `scripts/create-webhooks.mjs`, `README.md`

- [ ] **Step 1: Write `scripts/create-webhooks.mjs`**

Ghost's Admin UI cannot set a webhook secret, and Ghost only signs requests when a secret exists — so webhooks must be created via the Admin API. This script does that with no dependencies:

```js
#!/usr/bin/env node
// Creates the four Ghost webhooks (signed with GHOST_WEBHOOK_SECRET) via the Admin API.
// The Admin UI cannot set webhook secrets; unsigned webhooks are rejected by the Worker.
//
// Usage:
//   GHOST_ADMIN_API_KEY=<id>:<hexsecret> GHOST_WEBHOOK_SECRET=<secret> \
//     node scripts/create-webhooks.mjs https://werd.io https://werd.io/_atproto/ghost-webhook
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
```

- [ ] **Step 2: Write `README.md`**

Content requirements (write it out fully, roughly as below):

```markdown
# ghost-standard-site

Syndicates werd.io (Ghost) to AT Protocol using the standard.site lexicons.
Every public published post becomes a `site.standard.document` record in
Ben's own repo (`did:plc:77tdak46psveqneyegsdyc7l`); the site is one
`site.standard.publication` record. A Cloudflare Worker on `werd.io/*`
receives Ghost webhooks, writes records via a Queue consumer, injects
verification `<link>` tags into post pages, serves
`/.well-known/site.standard.publication`, and runs a daily reconciliation
cron that doubles as archive backfill.

Content policy: metadata + excerpt only. The canonical content lives at
werd.io.

## Setup

1. `npm install`
2. `npx wrangler kv namespace create STATE` → paste the id into `wrangler.jsonc`
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
   (Ghost's site icon becomes the publication icon — make sure it's square and ≥256×256 in Ghost settings.)
7. Create the webhooks (the Admin UI can't set secrets; Ghost only signs when a secret is set):
   ```bash
   GHOST_ADMIN_API_KEY=... GHOST_WEBHOOK_SECRET=... \
     node scripts/create-webhooks.mjs https://werd.io https://werd.io/_atproto/ghost-webhook
   ```
8. Backfill the archive (repeat until `"capped": false` — each run writes at most 200 records, ~200ms apart, to be polite to the PDS):
   ```bash
   curl -X POST https://werd.io/_atproto/reconcile -H "Authorization: Bearer $GHOST_WEBHOOK_SECRET"
   ```

## Manual end-to-end verification (definition of done)

1. Publish a test post in Ghost.
2. Record exists (rkey from the Worker logs or KV `post:{id}`):
   ```bash
   curl "https://inkcap.us-east.host.bsky.network/xrpc/com.atproto.repo.getRecord?repo=did:plc:77tdak46psveqneyegsdyc7l&collection=site.standard.document&rkey=<rkey>"
   ```
   Also browsable at https://pdsls.dev/at/did:plc:77tdak46psveqneyegsdyc7l/site.standard.document
3. `curl -s https://werd.io/<slug>/ | grep site.standard` shows both link tags.
4. Post the URL in Bluesky; the link should render as an enhanced article card.
   (Records have passed third-party validators while failing Bluesky's crawler —
   the Bluesky card is the real test.)
5. Check the post appears in Leaflet/pckt/Offprint/Heron discovery.

## Operational notes

- Everything fails open: KV miss → no tags, page untouched; PDS down → queue
  retries (5×) and the daily cron repairs; the blog never degrades.
- Record writes use `validate: false` because the PDS doesn't host the
  site.standard lexicons.
- KV is eventually consistent (~60s): a link tag may appear up to a minute
  after publish. Acceptable by design.
- `post.published.edited` fires on every save; a content hash over material
  fields (title, path, excerpt, publish date, tags, feature image) debounces
  actual writes.
- rkeys are deterministic TIDs derived from `published_at` + post-id hash, so
  webhook replays and reconciliation are idempotent.
- The Worker asserts at session start that the authenticated DID equals
  `ATPROTO_DID` and refuses to write otherwise.
```

- [ ] **Step 3: Run full suite one last time**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 4: Commit**

```bash
git add scripts/create-webhooks.mjs README.md
git commit -m "docs: README with setup, backfill, and end-to-end verification; webhook creation script"
```

---

### Task 15: Deployment (requires Ben's credentials — stop and hand off if unavailable)

These steps need real secrets and Cloudflare account access. If credentials are not available in the session, stop here and report; everything before this point is complete and tested.

- [ ] `npx wrangler kv namespace create STATE` and update `wrangler.jsonc` with the real id; `npx wrangler queues create ghost-standard-site-events`
- [ ] Set the three secrets via `wrangler secret put`
- [ ] `npx wrangler deploy`
- [ ] Run setup route; verify `.well-known` output
- [ ] Run `scripts/create-webhooks.mjs`
- [ ] Run reconcile repeatedly until `capped: false` (archive backfill)
- [ ] Execute the README manual verification: getRecord, link tags on a post page, Bluesky card test
