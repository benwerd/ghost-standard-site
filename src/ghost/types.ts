/**
 * Minimal typings for the Ghost objects this Worker touches.
 *
 * These are deliberately partial: Ghost posts carry dozens of fields, but the
 * bridge only reads the metadata needed for record shaping, content hashing,
 * and syndication policy (status/visibility/email_only). Everything else is
 * ignored, which also keeps the queue messages small.
 *
 * Two Ghost APIs produce these shapes:
 * - Webhook payloads (Admin-flavored, full field set) → `GhostWebhookBody`
 * - Content API responses (lean `fields` selection, no `status`) → `GhostPost`
 */

/** A Ghost tag as attached to a post. Internal tags (visibility "internal", names starting with #) are never syndicated. */
export interface GhostTag {
  id?: string;
  name: string;
  slug?: string;
  visibility?: string; // 'public' | 'internal'
}

/**
 * A Ghost post, as seen in webhook payloads and Content API responses.
 * All fields except `id` are optional because the two sources differ (the
 * Content API omits `status`, for example) and webhook `previous` objects
 * are partial diffs.
 */
export interface GhostPost {
  id: string;
  uuid?: string;
  title?: string;
  slug?: string;
  /** Absolute canonical URL of the post on the blog. */
  url?: string;
  status?: string; // 'published' | 'draft' | 'scheduled' | 'sent'
  visibility?: string; // 'public' | 'members' | 'paid' | 'tiers'
  /** true for email-only newsletter posts, which have no public page. */
  email_only?: boolean;
  /** Author-written excerpt; preferred over the auto-generated one. */
  custom_excerpt?: string | null;
  /** Auto-generated excerpt derived from the post body. */
  excerpt?: string | null;
  feature_image?: string | null;
  published_at?: string | null;
  updated_at?: string | null;
  tags?: GhostTag[];
}

/**
 * Webhook body: {event, post: {current, previous}}. Page events use a `page`
 * key instead, which is how the classifier tells them apart. The top-level
 * `event` field is present on current Ghost versions; older ones omit it,
 * so classification falls back to payload shape.
 */
export interface GhostWebhookBody {
  event?: string;
  post?: {
    current?: Partial<GhostPost> & { id?: string };
    previous?: Partial<GhostPost> & { id?: string };
  };
  page?: unknown;
}

/** The subset of Ghost site settings used to shape the publication record. */
export interface GhostSettings {
  title?: string;
  description?: string;
  /** Square site icon; becomes the publication's icon blob when present. */
  icon?: string | null;
  /** Fallback if no icon is set. */
  logo?: string | null;
}
