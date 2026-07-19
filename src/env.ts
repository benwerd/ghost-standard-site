/**
 * Shared type definitions for the Worker's environment and its queue traffic.
 * If you're new to the codebase, skim this file first: every message that
 * moves through the system and every configuration value it needs is
 * declared (and explained) here.
 *
 * The Worker moves two kinds of messages through its Cloudflare Queue:
 * post-level sync events (produced by the webhook receiver, consumed by the
 * PDS writer) and reconcile control messages (produced by the admin route,
 * used to run long archive backfills outside of any HTTP request).
 *
 * `Env` mirrors the bindings and configuration declared in
 * wrangler.example.jsonc plus the values supplied via `wrangler secret put`
 * (production) or `.dev.vars` (local dev). See the README's configuration
 * section for where each value comes from.
 */
import type { GhostPost } from './ghost/types';

/**
 * A post-level unit of work for the sync engine.
 *
 * - `upsert`: create or update the post's `site.standard.document` record.
 *   `force` (set only by the signed test path, never by real Ghost webhooks)
 *   bypasses the content-hash debounce so a rerun regenerates the record.
 * - `delete`: remove the record and its KV state; a no-op for unknown posts,
 *   which keeps replays and reconciliation idempotent.
 */
export type SyncEvent =
  | { kind: 'upsert'; post: GhostPost; force?: boolean }
  | { kind: 'delete'; postId: string };

/**
 * Control message: run a reconcile pass in the queue consumer (15-min budget,
 * no client connection to time out) and re-enqueue itself while capped.
 */
export interface ReconcileCommand {
  kind: 'reconcile';
  /** true = archive backfill (`reconcileFull`); false = windowed repair. */
  full: boolean;
  /** PDS writes per batch; defaults to 200 in `reconcile()`, ceiling 1000. */
  maxWrites?: number;
  /** Full mode only: rewrite every record even when unchanged (e.g. after a publication rkey migration). */
  force?: boolean;
  /** Force chains only: resume index from the previous batch's report.nextOffset. */
  offset?: number;
}

/** Everything that can travel through the EVENTS queue. */
export type QueueMessage = SyncEvent | ReconcileCommand;

/**
 * The Worker's environment: bindings (KV, queue) plus configuration.
 * Secrets and vars are indistinguishable at runtime; all arrive as strings
 * on this object.
 */
export interface Env {
  /** KV namespace holding post↔record mappings and the publication AT-URI. */
  STATE: KVNamespace;
  /** Producer side of the sync/reconcile queue. */
  EVENTS: Queue<QueueMessage>;
  // secrets
  /** Shared secret: signs Ghost webhooks and doubles as the admin bearer token. */
  GHOST_WEBHOOK_SECRET: string;
  /** App password for the atproto account (never the main password). */
  ATPROTO_APP_PASSWORD: string;
  /** Ghost Content API key from the custom integration. */
  GHOST_CONTENT_API_KEY: string;
  // vars
  /** atproto handle, without the leading @ (e.g. "werd.io"). */
  ATPROTO_HANDLE: string;
  /** Expected DID; the client refuses to write if the session resolves elsewhere. */
  ATPROTO_DID: string;
  /** The PDS endpoint from the DID document (e.g. https://…host.bsky.network). */
  ATPROTO_PDS_URL: string;
  /** Canonical base URL of the blog, https, no trailing slash. */
  GHOST_URL: string;
  /** Optional override for the publication record's name (defaults to Ghost's site title). */
  PUBLICATION_NAME?: string;
}
