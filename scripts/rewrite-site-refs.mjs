#!/usr/bin/env node
// One-off migration helper: rewrite document records whose `site` still
// references an OLD publication URI (e.g. the legacy /self rkey) to the
// current one, directly from this machine — surgical, no full-archive
// force reconcile needed.
//
//   node scripts/rewrite-site-refs.mjs            # dry run: list what would change
//   node scripts/rewrite-site-refs.mjs --apply    # actually rewrite (2 quota points per record)
//
// The current publication URI is read from the live /.well-known endpoint
// (the authoritative source). Only records whose `site` points at THIS
// account's site.standard.publication collection are touched — foreign or
// pre-bridge records with other `site` values are listed but left alone.
// Writes are spaced 400ms apart; if the PDS returns 429 (rate limit), the
// script stops and tells you when to re-run — already-rewritten records are
// skipped on the next run, so re-running is always safe.

import { AtpAgent } from '@atproto/api';
import { readDevVars } from './dev-vars.mjs';

const apply = process.argv.includes('--apply');
const vars = readDevVars();
for (const k of ['GHOST_URL', 'ATPROTO_PDS_URL', 'ATPROTO_HANDLE', 'ATPROTO_DID', 'ATPROTO_APP_PASSWORD']) {
  if (!vars[k] || /replace|example\.com|xxxx/i.test(vars[k])) {
    console.error(`${k} in .dev.vars is missing or still a placeholder.`);
    process.exit(1);
  }
}

const wellKnown = new URL('/.well-known/site.standard.publication', vars.GHOST_URL);
const currentUri = (await (await fetch(wellKnown)).text()).trim();
if (!currentUri.startsWith(`at://${vars.ATPROTO_DID}/site.standard.publication/`)) {
  console.error(`Unexpected .well-known response: ${currentUri}`);
  process.exit(1);
}
console.error(`Current publication URI: ${currentUri}`);

const agent = new AtpAgent({ service: vars.ATPROTO_PDS_URL });
await agent.login({ identifier: vars.ATPROTO_HANDLE, password: vars.ATPROTO_APP_PASSWORD });
if (agent.session?.did !== vars.ATPROTO_DID) {
  console.error(`FATAL: session DID ${agent.session?.did} != ATPROTO_DID; refusing to write`);
  process.exit(1);
}

// Collect every document record, then partition by site reference.
const stale = [];
let cursor, total = 0, foreign = 0;
do {
  const res = await agent.com.atproto.repo.listRecords({
    repo: vars.ATPROTO_DID,
    collection: 'site.standard.document',
    limit: 100,
    cursor,
  });
  for (const rec of res.data.records) {
    total++;
    const site = rec.value.site ?? '';
    if (site === currentUri) continue;
    if (site.startsWith(`at://${vars.ATPROTO_DID}/site.standard.publication/`)) {
      stale.push(rec);
    } else {
      foreign++;
      console.error(`  leaving foreign/pre-bridge record alone: ${rec.uri} (site: ${site || '(none)'})`);
    }
  }
  cursor = res.data.cursor;
} while (cursor);
console.error(`${total} records total; ${stale.length} stale site refs to rewrite; ${foreign} foreign left alone`);

if (!apply) {
  for (const rec of stale.slice(0, 10)) console.error(`  would rewrite: ${rec.uri} (${rec.value.path ?? ''})`);
  if (stale.length > 10) console.error(`  … and ${stale.length - 10} more`);
  console.error('Dry run — re-run with --apply to write.');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let done = 0;
for (const rec of stale) {
  const rkey = rec.uri.split('/').pop();
  try {
    await agent.com.atproto.repo.putRecord({
      repo: vars.ATPROTO_DID,
      collection: 'site.standard.document',
      rkey,
      record: { ...rec.value, site: currentUri },
      validate: false,
    });
    done++;
    console.error(`rewrote ${done}/${stale.length}: ${rec.value.path ?? rkey}`);
    await sleep(400);
  } catch (err) {
    if (err?.status === 429) {
      const reset = Number(err?.headers?.['ratelimit-reset']);
      const when = Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : 'later';
      console.error(`Rate limited after ${done} rewrites. Re-run with --apply after ${when} — already-rewritten records are skipped automatically.`);
      process.exit(2);
    }
    throw err;
  }
}
console.error(`Done: ${done} records rewritten to ${currentUri}`);
