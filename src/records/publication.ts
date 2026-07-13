import type { GhostSettings } from '../ghost/types';

export interface PublicationRecord {
  $type: 'site.standard.publication';
  url: string;
  name: string;
  description?: string;
  icon?: unknown;
  preferences?: { showInDiscover?: boolean };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

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
