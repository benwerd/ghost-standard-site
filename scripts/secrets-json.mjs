#!/usr/bin/env node
// Emits the Worker's runtime configuration from .dev.vars as JSON on stdout,
// for piping into `wrangler secret bulk` (see `npm run push-secrets`).
// .dev.vars is the single source of truth: fill it in once and the same
// values drive local dev, wrangler.jsonc generation, and production secrets.
//
// Refuses to run if any required value is missing or still looks like a
// placeholder from .dev.vars.example. KV_NAMESPACE_ID is deploy-time config
// consumed by configure.mjs, so it is deliberately not pushed to the Worker.

import { readDevVars, DEV_VARS } from './dev-vars.mjs';

const REQUIRED = [
  'GHOST_WEBHOOK_SECRET',
  'ATPROTO_APP_PASSWORD',
  'GHOST_CONTENT_API_KEY',
  'ATPROTO_HANDLE',
  'ATPROTO_DID',
  'ATPROTO_PDS_URL',
  'GHOST_URL',
];
const OPTIONAL = ['PUBLICATION_NAME'];
const PLACEHOLDER = /replace|example\.com|xxxx/i;

const vars = readDevVars();

const missing = REQUIRED.filter((k) => !vars[k]);
const placeholders = REQUIRED.filter((k) => vars[k] && PLACEHOLDER.test(vars[k]));
if (missing.length || placeholders.length) {
  if (missing.length) console.error(`Missing from ${DEV_VARS}: ${missing.join(', ')}`);
  if (placeholders.length) {
    console.error(`Still placeholder values in ${DEV_VARS}: ${placeholders.join(', ')}`);
  }
  console.error('Fill in real values before pushing secrets.');
  process.exit(1);
}

const keys = [...REQUIRED, ...OPTIONAL.filter((k) => vars[k])];
process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((k) => [k, vars[k]])), null, 2));
console.error(`Pushing: ${keys.join(', ')}`);
