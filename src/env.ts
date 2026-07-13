import type { GhostPost } from './ghost/types';

export type SyncEvent =
  | { kind: 'upsert'; post: GhostPost; force?: boolean }
  | { kind: 'delete'; postId: string };

/** Control message: run a reconcile pass in the queue consumer (15-min budget,
 * no client connection to time out) and re-enqueue itself while capped. */
export interface ReconcileCommand {
  kind: 'reconcile';
  full: boolean;
  maxWrites?: number;
}

export type QueueMessage = SyncEvent | ReconcileCommand;

export interface Env {
  STATE: KVNamespace;
  EVENTS: Queue<QueueMessage>;
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
