import {
  ASSET_PATH_LIST_MIME,
  ASSET_PATH_MIME,
  ASSET_RESOURCE_LIST_MIME,
  ASSET_RESOURCE_MIME,
  FRAME_REORDER_MIME,
} from '@/ui/shared/asset-drag-drop';

import { hasSupportedImageExtension } from './animation-document-controller';

/**
 * Reading a texture drop aimed at an animation document. Pure `DataTransfer`
 * parsing, kept out of the components because both sides of the frame-strip
 * boundary need the exact same answers: the frame cards decide whether a drop
 * inserts frames *before* them, while the editor shell around them decides
 * whether to show its append-frames overlay at all.
 */

/**
 * Normalize one dropped value into a `res://` image path, or `null` when it is not
 * an image we can reference (a foreign URL scheme, a non-image extension, …).
 */
export function normalizeDroppedTextureResource(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }

  if (value.startsWith('res://') || value.startsWith('http://') || value.startsWith('https://')) {
    return hasSupportedImageExtension(value) ? value : null;
  }

  if (value.includes('://')) {
    return null;
  }

  const normalized = value.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\\+/g, '/');
  const resourcePath = `res://${normalized}`;
  return hasSupportedImageExtension(resourcePath) ? resourcePath : null;
}

function parseDroppedTextureResources(rawValue: string): string[] | null {
  if (!rawValue.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }

    const texturePaths = parsed
      .map(value => (typeof value === 'string' ? normalizeDroppedTextureResource(value) : null))
      .filter((value): value is string => Boolean(value));

    return texturePaths.length > 0 ? texturePaths : null;
  } catch {
    return null;
  }
}

function getDroppedTextureResource(transfer: DataTransfer): string | null {
  return (
    normalizeDroppedTextureResource(transfer.getData(ASSET_RESOURCE_MIME)) ??
    normalizeDroppedTextureResource(transfer.getData(ASSET_PATH_MIME)) ??
    normalizeDroppedTextureResource(transfer.getData('text/uri-list')) ??
    normalizeDroppedTextureResource(transfer.getData('text/plain'))
  );
}

/** Every image resource carried by a drop, honouring the Assets panel's multi-drag payload. */
export function getDroppedTextureResources(transfer: DataTransfer | null): string[] {
  if (!transfer) {
    return [];
  }

  const parsedResources =
    parseDroppedTextureResources(transfer.getData(ASSET_RESOURCE_LIST_MIME)) ??
    parseDroppedTextureResources(transfer.getData(ASSET_PATH_LIST_MIME));
  if (parsedResources && parsedResources.length > 0) {
    return parsedResources;
  }

  const singleResource = getDroppedTextureResource(transfer);
  return singleResource ? [singleResource] : [];
}

/** Image files dragged in from the OS (as opposed to project assets, which arrive as paths). */
export function getDroppedImageFiles(transfer: DataTransfer | null): File[] {
  const files = Array.from(transfer?.files ?? []);
  return files.filter(
    file => file.type.startsWith('image/') || hasSupportedImageExtension(file.name)
  );
}

/**
 * Whether a drag *might* carry a texture. `dragover`/`dragenter` can only see the
 * MIME list (the data store is protected), so this is deliberately permissive —
 * except for frame reorders, which must never light up a texture-drop affordance.
 */
export function isPotentialTextureDrag(transfer: DataTransfer | null): boolean {
  if (!transfer) {
    return false;
  }

  const types = new Set(Array.from(transfer.types));
  if (types.has(FRAME_REORDER_MIME)) {
    return false;
  }

  return (
    types.has('Files') ||
    types.has(ASSET_RESOURCE_LIST_MIME) ||
    types.has(ASSET_PATH_LIST_MIME) ||
    types.has(ASSET_RESOURCE_MIME) ||
    types.has(ASSET_PATH_MIME) ||
    types.has('text/uri-list') ||
    types.has('text/plain')
  );
}
