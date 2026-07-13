import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Tests run against the tracked example config: bindings and queue
      // names are what matter to miniflare, not account-specific ids, and
      // this keeps `npm test` working on a fresh clone before any copy step.
      wrangler: { configPath: './wrangler.example.jsonc' },
    }),
  ],
});
