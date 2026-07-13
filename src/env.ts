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
