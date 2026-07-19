/**
 * Shaping the site-level `site.standard.publication` record: the single
 * record that represents the blog itself ("this website exists, here's its
 * name, icon, and URL"). Every per-post document record points back at it
 * via its AT-URI, the way articles point at their masthead.
 *
 * There is exactly one publication record per blog (rkey `self`), created
 * and updated by the /_atproto/setup admin route from Ghost's site settings.
 * Its `url` field is the base every document's `path` is joined onto by
 * consumers, and it's what the /.well-known verification endpoint vouches
 * for, so it must be the canonical https origin with no trailing slash.
 *
 * `showInDiscover: true` opts the publication into discovery feeds in
 * Atmosphere readers (Leaflet, pckt, Offprint, Heron…).
 */
import type { GhostSettings } from '../ghost/types';

/** site.standard.publication: the blog itself, referenced by every document's `site` field. */
export interface PublicationRecord {
  $type: 'site.standard.publication';
  /** Canonical base URL, no trailing slash; joined with document paths by consumers. */
  url: string;
  name: string;
  description?: string;
  /** BlobRef for the site icon (square, ≥256×256 recommended by the lexicon). */
  icon?: unknown;
  preferences?: { showInDiscover?: boolean };
}

/** Conservative truncation well under the lexicon grapheme limits. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Build the publication record from Ghost settings. Name precedence:
 * explicit PUBLICATION_NAME override → Ghost site title → the URL itself.
 * The icon blob is optional; setup passes one only when Ghost's site icon
 * existed and uploaded successfully.
 */
export function shapePublicationRecord(
  settings: GhostSettings,
  ghostUrl: string,
  nameOverride?: string,
  icon?: unknown
): PublicationRecord {
  const url = ghostUrl.replace(/\/+$/, '');
  const record: PublicationRecord = {
    $type: 'site.standard.publication',
    url,
    name: truncate(nameOverride || settings.title || url, 490),
    preferences: { showInDiscover: true },
  };
  if (settings.description) record.description = truncate(settings.description, 2900);
  if (icon) record.icon = icon;
  return record;
}
