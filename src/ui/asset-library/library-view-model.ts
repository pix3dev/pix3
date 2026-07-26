/**
 * Presentation helpers shared by the Library document and the Library inspector view, so a card
 * and its detail panel always agree on icon, type label, price and publisher. Kept UI-side because
 * these are display concerns (the real manifest is sparse; store/provider metadata is synthesized).
 */

import type {
  LibraryItem,
  LibraryItemManifest,
  LibraryItemType,
  StoreItemStatus,
} from '@/services/library/library-types';
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

/**
 * Publisher label for a store/provider item. Server-backed store items carry an explicit
 * `publisherName`; pre-store bundles only ever had `authorId`, and the static fallback pack has
 * neither — hence the synthesized default.
 */
export function publisherLabel(item: LibraryItem, source: LibrarySourceConfig): string {
  const { publisherName, authorId } = item.manifest;
  if (publisherName && publisherName.trim()) {
    return publisherName;
  }
  if (authorId) {
    return authorId;
  }
  return source.kind === 'store' ? 'Pix3 Team' : source.name;
}

// ── Curated store status ────────────────────────────────────────────────────
// Card, list row and inspector all read the lifecycle through these, so a draft never looks
// published in one place and unpublished in another.

/** Lifecycle of a store item. A manifest without `status` predates the store ⇒ published. */
export function storeStatus(manifest: LibraryItemManifest): StoreItemStatus {
  return manifest.status ?? 'published';
}

/** Human label for a lifecycle state. */
export function statusLabel(status: StoreItemStatus): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'unlisted':
      return 'Unlisted';
    default:
      return 'Published';
  }
}

/** IconService (Feather) name for a lifecycle state. */
export function statusIcon(status: StoreItemStatus): string {
  switch (status) {
    case 'draft':
      return 'edit-3';
    case 'unlisted':
      return 'eye-off';
    default:
      return 'check-circle';
  }
}

/** Whether a status deserves a chip at all (published is the silent default). */
export function hasStatusChip(status: StoreItemStatus): boolean {
  return status !== 'published';
}

/** Compact download counter: `0`, `942`, `1.2k`, `3.4M`. */
export function formatDownloads(downloads: number | undefined): string {
  const value = typeof downloads === 'number' && Number.isFinite(downloads) ? downloads : 0;
  if (value < 1000) {
    return String(Math.max(0, Math.round(value)));
  }
  const [scaled, suffix] = value < 1_000_000 ? [value / 1000, 'k'] : [value / 1_000_000, 'M'];
  const rounded = Math.round(scaled * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${suffix}`;
}

/**
 * Whether an item passes the browsed category selection.
 *
 * Store items are filed on the hierarchical `categoryPath`, so a top-level rail row shows its
 * subcategories too (`ui` includes `ui/buttons`), and a subcategory chip narrows to exactly one
 * path. User/team items keep the flat `manifest.category`. Kept here so the grid, the list and the
 * counters agree on what "in this category" means.
 */
export function matchesCategorySelection(
  manifest: LibraryItemManifest,
  categoryId: string,
  subcategoryId?: string | null
): boolean {
  if (subcategoryId) {
    return manifest.categoryPath === subcategoryId;
  }
  if (categoryId === 'all') {
    return true;
  }
  const { category, categoryPath } = manifest;
  if (categoryPath) {
    return categoryPath === categoryId || categoryPath.startsWith(`${categoryId}/`);
  }
  return category === categoryId;
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
