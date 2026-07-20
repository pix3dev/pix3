/**
 * Presentation helpers shared by the Library document and the Library inspector view, so a card
 * and its detail panel always agree on icon, type label, price and publisher. Kept UI-side because
 * these are display concerns (the real manifest is sparse; store/provider metadata is synthesized).
 */

import type { LibraryItem, LibraryItemType } from '@/services/library/library-types';
import type { LibrarySourceConfig } from '@/services/library/library-sources';

/** Feather icon name for an item type. */
export function iconForItemType(type: LibraryItemType): string {
  switch (type) {
    case 'prefab':
      return 'package';
    case 'scene':
      return 'film';
    case 'image':
      return 'image';
    case 'font':
      return 'type';
    case 'audio':
      return 'volume-2';
    case 'shader':
      return 'zap';
    case 'script':
      return 'code';
    case 'material':
      return 'layers';
    default:
      return 'file';
  }
}

/** Capitalized, human type label ("prefab" → "Prefab"). */
export function formatItemType(type: LibraryItemType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Whether a source shows store-style metadata (publisher / price / installs). */
export function isStoreLike(source: LibrarySourceConfig): boolean {
  return source.kind === 'store' || source.kind === 'provider';
}

/** Synthesized price label for a store/provider item (real free content has no price field). */
export function priceLabel(item: LibraryItem, source: LibrarySourceConfig): string {
  if (source.kind === 'provider') {
    return 'CC0';
  }
  const license = item.manifest.license?.toUpperCase();
  return license === 'CC0' ? 'CC0' : 'Free';
}

/** Whether a store/provider price counts as free (drives the accent badge styling). */
export function isFreePrice(price: string): boolean {
  return price === 'Free' || price === 'CC0';
}

/** Synthesized publisher label for a store/provider item. */
export function publisherLabel(item: LibraryItem, source: LibrarySourceConfig): string {
  if (item.manifest.authorId) {
    return item.manifest.authorId;
  }
  return source.kind === 'store' ? 'Pix3 Team' : source.name;
}

/**
 * Number of real bundled files an item carries, excluding a rendered preview thumbnail (which
 * is library-only chrome, not a project asset). This is what the user reads to tell whether a
 * prefab's dependencies (sprites, nested prefabs, scripts) were bundled with it.
 */
export function assetFileCount(item: LibraryItem): number {
  const { files, preview, entry } = item.manifest;
  const isDedicatedPreview = !!preview && preview !== entry && files.includes(preview);
  return isDedicatedPreview ? files.length - 1 : files.length;
}

/** A stable decorative hue (0–360) derived from an item id, for the striped thumbnail tint. */
export function thumbHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** Format an epoch-ms timestamp as a short date, or a dash when unknown (0/undefined). */
export function formatAddedDate(epochMs: number | undefined): string {
  if (!epochMs) {
    return '—';
  }
  try {
    return new Date(epochMs).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '—';
  }
}
