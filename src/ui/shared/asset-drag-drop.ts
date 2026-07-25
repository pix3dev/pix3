export const ASSET_RESOURCE_MIME = 'application/x-pix3-asset-resource';
export const ASSET_PATH_MIME = 'application/x-pix3-asset-path';
export const ASSET_RESOURCE_LIST_MIME = 'application/x-pix3-asset-resource-list';
export const ASSET_PATH_LIST_MIME = 'application/x-pix3-asset-path-list';

/**
 * Drag payload used when dragging an entry out of the Sprite Editor's generation
 * history. The blob itself lives in {@link GenerationHistoryService} (IndexedDB); the
 * drag only carries the record id so a drop target can fetch it and offer to save it.
 */
export const GENERATION_DRAG_MIME = 'application/x-pix3-generation';

export interface GenerationDragPayload {
  /** GenerationHistoryService record id. */
  id: string;
  /** Suggested file name (with extension) to pre-fill the save dialog. */
  suggestedName?: string;
}

export const setGenerationDragData = (
  dataTransfer: DataTransfer,
  payload: GenerationDragPayload
): void => {
  dataTransfer.setData(GENERATION_DRAG_MIME, JSON.stringify(payload));
  if (payload.suggestedName) {
    dataTransfer.setData('text/plain', payload.suggestedName);
  }
  dataTransfer.effectAllowed = 'copy';
};

export const hasGenerationDragData = (dataTransfer: DataTransfer | null): boolean => {
  if (!dataTransfer) {
    return false;
  }
  const types = dataTransfer.types ? Array.from(dataTransfer.types) : [];
  return types.includes(GENERATION_DRAG_MIME);
};

export const getGenerationDragData = (
  dataTransfer: DataTransfer | null
): GenerationDragPayload | null => {
  if (!dataTransfer) {
    return null;
  }
  const raw = dataTransfer.getData(GENERATION_DRAG_MIME);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as GenerationDragPayload;
    return typeof parsed?.id === 'string' && parsed.id.length > 0 ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Drag payload used when dragging an Asset Library card into the viewport or scene tree.
 * The bundle itself is resolved by {@link AssetLibraryService}; the drag only carries the
 * item id so a drop target can copy it into the project and insert it.
 */
const LIBRARY_ITEM_DRAG_MIME = 'application/x-pix3-library-item';

export interface LibraryItemDragPayload {
  /** AssetLibraryService item id. */
  itemId: string;
  /** Item display name, used to pre-fill node names / labels. */
  name?: string;
}

export const setLibraryItemDragData = (
  dataTransfer: DataTransfer,
  payload: LibraryItemDragPayload
): void => {
  dataTransfer.setData(LIBRARY_ITEM_DRAG_MIME, JSON.stringify(payload));
  if (payload.name) {
    dataTransfer.setData('text/plain', payload.name);
  }
  dataTransfer.effectAllowed = 'copy';
};

export const hasLibraryItemDragData = (dataTransfer: DataTransfer | null): boolean => {
  if (!dataTransfer) {
    return false;
  }
  const types = dataTransfer.types ? Array.from(dataTransfer.types) : [];
  return types.includes(LIBRARY_ITEM_DRAG_MIME);
};

export const getLibraryItemDragData = (
  dataTransfer: DataTransfer | null
): LibraryItemDragPayload | null => {
  if (!dataTransfer) {
    return null;
  }
  const raw = dataTransfer.getData(LIBRARY_ITEM_DRAG_MIME);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as LibraryItemDragPayload;
    return typeof parsed?.itemId === 'string' && parsed.itemId.length > 0 ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Project-relative source paths carried by an in-editor asset drag, used by the move
 * (drag-into-folder) drop targets. Prefers the multi-path list MIME set by the Assets
 * content pane so a whole multi-selection moves at once, then the single-path MIME, then
 * `text/plain` (an Asset Tree node drag sets only that for folders).
 *
 * Only readable inside a `drop` handler — during `dragover` the drag data store is in
 * protected mode and `getData` returns `''`; use {@link hasAssetDragData} there.
 */
export const getDraggedAssetPaths = (dataTransfer: DataTransfer | null): string[] => {
  if (!dataTransfer) {
    return [];
  }

  const listRaw = dataTransfer.getData(ASSET_PATH_LIST_MIME);
  if (listRaw) {
    try {
      const parsed: unknown = JSON.parse(listRaw);
      if (Array.isArray(parsed)) {
        const paths = parsed.filter(
          (value): value is string => typeof value === 'string' && value.length > 0
        );
        if (paths.length > 0) {
          return paths;
        }
      }
    } catch {
      // Fall through to the single-path forms.
    }
  }

  const single = dataTransfer.getData(ASSET_PATH_MIME);
  if (single) {
    return [single];
  }

  const plain = dataTransfer.getData('text/plain');
  return plain
    ? plain
        .split(/\r?\n/u)
        .map(value => value.trim())
        .filter(value => value.length > 0)
    : [];
};

const IMAGE_EXTENSIONS = new Set([
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

const ANIMATION_EXTENSIONS = new Set(['pix3anim']);
const MODEL_EXTENSIONS = new Set(['glb', 'gltf']);
const PREFAB_EXTENSIONS = new Set(['pix3scene']);

export type SceneCreateAssetKind = 'image' | 'animation' | 'model' | 'prefab';

export const toProjectResourcePath = (path: string): string => {
  const normalizedPath = path
    .replace(/\\+/g, '/')
    .replace(/^(\.?\/)+/, '')
    .replace(/^\/+/, '');

  return normalizedPath.length > 0 ? `res://${normalizedPath}` : 'res://';
};

const normalizeDroppedAssetResourcePath = (raw: string | null | undefined): string | null => {
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

const getAssetExtension = (resourcePath: string): string => {
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
