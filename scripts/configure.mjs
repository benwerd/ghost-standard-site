#!/usr/bin/env node
// Generates wrangler.jsonc (gitignored) from wrangler.example.jsonc.
//
// The route pattern and zone name are derived from GHOST_URL in .dev.vars —
// the Worker must front the same domain the blog lives on, so there is no
// separate "domain" setting to keep in sync. KV_NAMESPACE_ID comes from
// .dev.vars too. Runs automatically before `npm run dev` and `npm run deploy`.

import fs from 'node:fs';
import { readDevVars, DEV_VARS } from './dev-vars.mjs';

const TEMPLATE = 'wrangler.example.jsonc';
const OUTPUT = 'wrangler.jsonc';

const vars = readDevVars();

if (!vars.GHOST_URL) {
  console.error(`GHOST_URL missing from ${DEV_VARS}.`);
  process.exit(1);
}

let domain;
try {
  domain = new URL(vars.GHOST_URL).hostname;
} catch {
  console.error(`GHOST_URL in ${DEV_VARS} is not a valid URL: ${vars.GHOST_URL}`);
  process.exit(1);
}

const kvId = vars.KV_NAMESPACE_ID ?? '';
if (!kvId) {
  console.warn(
    'KV_NAMESPACE_ID missing from .dev.vars — leaving the placeholder. ' +
      'Create one with `npx wrangler kv namespace create STATE`, add the id, and re-run. ' +
      '(Fine for local dev; deploy will fail until set.)'
  );
}

const rendered = fs
  .readFileSync(TEMPLATE, 'utf8')
  .replaceAll('{{DOMAIN}}', domain)
  .replaceAll('{{KV_NAMESPACE_ID}}', kvId || '{{KV_NAMESPACE_ID}}')
  .replace(
    /^\/\/ Template[^\n]*\n\/\/[^\n]*\n/,
    `// GENERATED from ${TEMPLATE} by scripts/configure.mjs — do not edit directly.\n`
  );

fs.writeFileSync(OUTPUT, rendered);
console.log(`${OUTPUT} generated: domain=${domain} kv=${kvId || '(placeholder)'}`);
