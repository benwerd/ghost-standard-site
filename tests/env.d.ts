import type { Env as WorkerEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    // Merged into the type of `env` from `cloudflare:test`.
    interface Env extends WorkerEnv {}
  }
}

export {};
