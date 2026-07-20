#!/usr/bin/env node
// Queue-outage fallback: create missing document records directly from this
// machine, replicating exactly what the Worker's queue consumer would do.
// Use when the reconcile backfill can't run because Cloudflare Queues isn't
// delivering messages.
//
//   node scripts/local-backfill.mjs            # dry run: list what would be created
//   node scripts/local-backfill.mjs --apply    # create records (3 quota points each)
//
// Parity with the Worker: identical deterministic rkeys, identical record
// shape, identical content hash. After creating records it writes
// kv-bulk.json; push that into the Worker's KV with the printed command so
// link-tag injection and future reconciles know about the new records.
// Idempotent: already-existing records (matched by derived rkey) are
// skipped, so re-running is always safe. Stops cleanly on 429.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { AtpAgent } from '@atproto/api';
import { readDevVars } from './dev-vars.mjs';

const apply = process.argv.includes('--apply');
const vars = readDevVars();
for (const k of ['GHOST_URL', 'GHOST_CONTENT_API_KEY', 'ATPROTO_PDS_URL', 'ATPROTO_HANDLE', 'ATPROTO_DID', 'ATPROTO_APP_PASSWORD']) {
  if (!vars[k] || /replace|example\.com|xxxx/i.test(vars[k])) {
    console.error(`${k} in .dev.vars is missing or still a placeholder.`);
    process.exit(1);
  }
}

// ---- ports of src/atproto/tid.ts and src/records/document.ts (kept in sync by tests there)
const B32 = '234567abcdefghijklmnopqrstuvwxyz';
const encodeTid = (v) => { let s = ''; for (let i = 12; i >= 0; i--) s += B32[Number((v >> BigInt(i * 5)) & 31n)]; return s; };
const fnv1a64 = (str) => { let h = 0xcbf29ce484222325n; for (const c of new TextEncoder().encode(str)) { h ^= BigInt(c); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; } return h; };
const deriveRkey = (post) => {
  const clockId = fnv1a64('ghost:' + post.id) & 0x3ffn;
  const ms = post.published_at ? Date.parse(post.published_at) : NaN;
  if (Number.isFinite(ms) && ms >= 0) return encodeTid(((BigInt(ms) * 1000n) << 10n) | clockId);
  return encodeTid(fnv1a64('ghost-id:' + post.id) & 0x7fffffffffffffffn);
};
const normalizePath = (p) => { let x = p.startsWith('/') ? p : '/' + p; while (x.length > 1 && x.endsWith('/')) x = x.slice(0, -1); return x; };
const postPath = (post) => {
  if (post.url) { try { return normalizePath(new URL(post.url, vars.GHOST_URL).pathname); } catch {} }
  return normalizePath('/' + (post.slug ?? post.id));
};
const truncate = (v, max) => (v.length <= max ? v : v.slice(0, max));
const publicTags = (post) => (post.tags ?? []).filter((t) => (t.visibility ?? 'public') === 'public' && t.name).map((t) => truncate(t.name, 120));
const excerptOf = (post) => (post.custom_excerpt || post.excerpt || '').trim();
const contentHash = (post) => crypto.createHash('sha256').update(JSON.stringify({
  title: post.title ?? '', path: postPath(post), description: excerptOf(post),
  publishedAt: post.published_at ?? null, tags: publicTags(post), featureImage: post.feature_image ?? null,
})).digest('hex');
const shapeRecord = (post, publicationUri, coverImage) => {
  const publishedAt = post.published_at ?? post.updated_at ?? new Date(0).toISOString();
  const record = {
    $type: 'site.standard.document', site: publicationUri, path: postPath(post),
    title: truncate(post.title || 'Untitled', 490), publishedAt: new Date(publishedAt).toISOString(),
  };
  const description = excerptOf(post);
  if (description) record.description = truncate(description, 2900);
  const tags = publicTags(post);
  if (tags.length) record.tags = tags;
  if (post.updated_at && post.updated_at !== post.published_at) record.updatedAt = new Date(post.updated_at).toISOString();
  if (coverImage) record.coverImage = coverImage;
  return record;
};
// ---- end ports

const currentUri = (await (await fetch(new URL('/.well-known/site.standard.publication', vars.GHOST_URL))).text()).trim();
if (!currentUri.startsWith(`at://${vars.ATPROTO_DID}/site.standard.publication/`)) {
  console.error(`Unexpected .well-known response: ${currentUri}`);
  process.exit(1);
}
console.error(`Publication: ${currentUri}`);

// All syndicatable Ghost posts (lean fields, like the Worker fetches).
const posts = [];
for (let page = 1; ; page++) {
  const url = new URL('/ghost/api/content/posts/', vars.GHOST_URL);
  url.searchParams.set('key', vars.GHOST_CONTENT_API_KEY);
  url.searchParams.set('include', 'tags');
  url.searchParams.set('fields', 'id,slug,url,title,custom_excerpt,excerpt,feature_image,published_at,updated_at,visibility,email_only');
  url.searchParams.set('limit', '100');
  url.searchParams.set('page', String(page));
  const res = await fetch(url);
  if (!res.ok) { console.error(`Ghost Content API error ${res.status}`); process.exit(1); }
  const data = await res.json();
  posts.push(...data.posts);
  if (page >= (data.meta?.pagination?.pages ?? page)) break;
}
const syndicatable = posts.filter((p) => (p.visibility ?? 'public') === 'public' && !p.email_only);
console.error(`Ghost: ${posts.length} posts, ${syndicatable.length} syndicatable`);

const agent = new AtpAgent({ service: vars.ATPROTO_PDS_URL });
await agent.login({ identifier: vars.ATPROTO_HANDLE, password: vars.ATPROTO_APP_PASSWORD });
if (agent.session?.did !== vars.ATPROTO_DID) {
  console.error('FATAL: session DID mismatch; refusing to write');
  process.exit(1);
}

// Existing record rkeys, to skip what's already synced.
const existing = new Set();
let cursor;
do {
  const res = await agent.com.atproto.repo.listRecords({
    repo: vars.ATPROTO_DID, collection: 'site.standard.document', limit: 100, cursor,
  });
  for (const rec of res.data.records) existing.add(rec.uri.split('/').pop());
  cursor = res.data.cursor;
} while (cursor);
console.error(`PDS: ${existing.size} existing records`);

const missing = syndicatable.filter((p) => !existing.has(deriveRkey(p)));
console.error(`Missing: ${missing.length} posts need records`);

if (!apply) {
  for (const p of missing.slice(0, 10)) console.error(`  would create: ${postPath(p)} (${p.title?.slice(0, 50)})`);
  if (missing.length > 10) console.error(`  … and ${missing.length - 10} more`);
  console.error('Dry run. Re-run with --apply to create.');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kvEntries = [];
let done = 0;
for (const post of missing) {
  const rkey = deriveRkey(post);
  let coverImage;
  if (post.feature_image) {
    try {
      const img = await fetch(post.feature_image);
      if (img.ok) {
        const bytes = new Uint8Array(await img.arrayBuffer());
        if (bytes.byteLength > 0 && bytes.byteLength < 1_000_000) {
          const up = await agent.uploadBlob(bytes, { encoding: img.headers.get('content-type') ?? 'image/jpeg' });
          coverImage = up.data.blob;
        }
      }
    } catch {} // cover images are never worth failing a record over
  }
  try {
    const record = shapeRecord(post, currentUri, coverImage);
    const res = await agent.com.atproto.repo.putRecord({
      repo: vars.ATPROTO_DID, collection: 'site.standard.document', rkey, record, validate: false,
    });
    const path = postPath(post);
    kvEntries.push({ key: `post:${post.id}`, value: JSON.stringify({ rkey, atUri: res.data.uri, contentHash: contentHash(post), path, updatedAt: post.updated_at ?? post.published_at ?? '' }) });
    kvEntries.push({ key: `path:${path}`, value: JSON.stringify({ atUri: res.data.uri }) });
    done++;
    console.error(`created ${done}/${missing.length}: ${path}`);
    await sleep(300);
  } catch (err) {
    if (err?.status === 429) {
      const reset = Number(err?.headers?.['ratelimit-reset']);
      const when = Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : 'later';
      console.error(`Rate limited after ${done}. Re-run with --apply after ${when}; created records are skipped automatically.`);
      break;
    }
    throw err;
  }
}
fs.writeFileSync('kv-bulk.json', JSON.stringify(kvEntries, null, 1));
console.error(`Done: ${done} records created. Wrote kv-bulk.json (${kvEntries.length} KV entries).`);
console.error('Now push the KV mappings so the Worker knows about them:');
console.error('  npx wrangler kv bulk put kv-bulk.json --namespace-id <STATE-namespace-id> --remote');
