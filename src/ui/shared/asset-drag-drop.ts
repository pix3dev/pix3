export const ASSET_RESOURCE_MIME = 'application/x-pix3-asset-resource';
export const ASSET_PATH_MIME = 'application/x-pix3-asset-path';
export const ASSET_RESOURCE_LIST_MIME = 'application/x-pix3-asset-resource-list';
export const ASSET_PATH_LIST_MIME = 'application/x-pix3-asset-path-list';

export const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'tif',
  'tiff',
  'avif',
]);

export const ANIMATION_EXTENSIONS = new Set(['pix3anim']);
export const MODEL_EXTENSIONS = new Set(['glb', 'gltf']);
export const PREFAB_EXTENSIONS = new Set(['pix3scene']);

export type SceneCreateAssetKind = 'image' | 'animation' | 'model' | 'prefab';

export const toProjectResourcePath = (path: string): string => {
  const normalizedPath = path
    .replace(/\\+/g, '/')
    .replace(/^(\.?\/)+/, '')
    .replace(/^\/+/, '');

  return normalizedPath.length > 0 ? `res://${normalizedPath}` : 'res://';
};

export const normalizeDroppedAssetResourcePath = (
  raw: string | null | undefined
): string | null => {
  if (!raw) {
    return null;
  }

  const firstLine = raw
    .split(/\r?\n/u)
    .map(value => value.trim())
    .find(value => value.length > 0);

  if (!firstLine) {
    return null;
  }

  const normalized = firstLine.replace(/\\/g, '/');
  return normalized.startsWith('res://') ? normalized : `res://${normalized.replace(/^\/+/, '')}`;
};

export const getDroppedAssetResourcePath = (dataTransfer: DataTransfer | null): string | null => {
  if (!dataTransfer) {
    return null;
  }

  return (
    normalizeDroppedAssetResourcePath(dataTransfer.getData(ASSET_RESOURCE_MIME)) ??
    normalizeDroppedAssetResourcePath(dataTransfer.getData(ASSET_PATH_MIME)) ??
    normalizeDroppedAssetResourcePath(dataTransfer.getData('text/uri-list')) ??
    normalizeDroppedAssetResourcePath(dataTransfer.getData('text/plain'))
  );
};

export const hasAssetDragData = (dataTransfer: DataTransfer | null): boolean => {
  if (!dataTransfer) {
    return false;
  }

  const rawTypes = dataTransfer.types;
  const types = rawTypes ? Array.from(rawTypes) : [];
  return (
    types.includes(ASSET_RESOURCE_LIST_MIME) ||
    types.includes(ASSET_PATH_LIST_MIME) ||
    types.includes(ASSET_RESOURCE_MIME) ||
    types.includes(ASSET_PATH_MIME) ||
    types.includes('text/uri-list')
  );
};

export const getAssetExtension = (resourcePath: string): string => {
  const normalized = resourcePath.toLowerCase().split('?')[0].split('#')[0];
  return normalized.includes('.') ? (normalized.split('.').pop() ?? '') : '';
};

export const classifySceneCreateAssetResource = (
  resourcePath: string
): SceneCreateAssetKind | null => {
  const extension = getAssetExtension(resourcePath);

  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }

  if (ANIMATION_EXTENSIONS.has(extension)) {
    return 'animation';
  }

  if (MODEL_EXTENSIONS.has(extension)) {
    return 'model';
  }

  if (PREFAB_EXTENSIONS.has(extension)) {
    return 'prefab';
  }

  return null;
};

export const deriveAssetNodeName = (resourcePath: string, fallback: string): string => {
  const normalized = resourcePath.replace(/\\/g, '/');
  const fileName = normalized.split('/').pop() ?? fallback;
  const dotIndex = fileName.lastIndexOf('.');

  if (dotIndex <= 0) {
    return fileName || fallback;
  }

  return fileName.slice(0, dotIndex) || fallback;
};
