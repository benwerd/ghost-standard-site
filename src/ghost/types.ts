export interface GhostTag {
  id?: string;
  name: string;
  slug?: string;
  visibility?: string; // 'public' | 'internal'
}

export interface GhostPost {
  id: string;
  uuid?: string;
  title?: string;
  slug?: string;
  url?: string;
  status?: string; // 'published' | 'draft' | 'scheduled' | 'sent'
  visibility?: string; // 'public' | 'members' | 'paid' | 'tiers'
  email_only?: boolean;
  custom_excerpt?: string | null;
  excerpt?: string | null;
  feature_image?: string | null;
  published_at?: string | null;
  updated_at?: string | null;
  tags?: GhostTag[];
}

/** Webhook body: {event, post: {current, previous}}. Page events use a `page` key instead. */
export interface GhostWebhookBody {
  event?: string;
  post?: {
    current?: Partial<GhostPost> & { id?: string };
    previous?: Partial<GhostPost> & { id?: string };
  };
  page?: unknown;
}

export interface GhostSettings {
  title?: string;
  description?: string;
  icon?: string | null;
  logo?: string | null;
}
