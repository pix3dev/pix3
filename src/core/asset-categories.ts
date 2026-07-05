/**
 * Canonical asset-category taxonomy used by the Asset Browser "group by type" view.
 *
 * Other extension lists in the codebase (BundleSizeService.CATEGORY_BY_EXTENSION,
 * AssetsPreviewService, asset-drag-drop.ts) predate this module and are candidates
 * for later adoption; new code should classify assets through `categorizeAssetPath`.
 */

export type AssetCategoryId =
  | 'scenes'
  | 'images'
  | 'models'
  | 'audio'
  | 'animations'
  | 'scripts'
  | 'fonts'
  | 'video'
  | 'data'
  | 'other';

export interface AssetCategoryDefinition {
  readonly id: AssetCategoryId;
  readonly label: string;
  /** IconService icon name (Feather). */
  readonly icon: string;
}

/** Fixed display order for the grouped asset-browser view. */
export const ASSET_CATEGORIES: readonly AssetCategoryDefinition[] = [
  { id: 'scenes', label: 'Scenes', icon: 'film' },
  { id: 'images', label: 'Images', icon: 'image' },
  { id: 'models', label: 'Models', icon: 'box' },
  { id: 'audio', label: 'Audio', icon: 'music' },
  { id: 'animations', label: 'Animations', icon: 'activity' },
  { id: 'scripts', label: 'Scripts', icon: 'code' },
  { id: 'fonts', label: 'Fonts', icon: 'type' },
  { id: 'video', label: 'Video', icon: 'video' },
  { id: 'data', label: 'Data', icon: 'database' },
  { id: 'other', label: 'Other', icon: 'file-text' },
];

export const ASSET_CATEGORY_BY_ID: Readonly<Record<AssetCategoryId, AssetCategoryDefinition>> =
  Object.fromEntries(ASSET_CATEGORIES.map(category => [category.id, category])) as Record<
    AssetCategoryId,
    AssetCategoryDefinition
  >;

const EXTENSIONS_BY_CATEGORY: Readonly<
  Record<Exclude<AssetCategoryId, 'other'>, readonly string[]>
> = {
  scenes: ['pix3scene', 'pix3prefab'],
  images: [
    'png',
    'jpg',
    'jpeg',
    'webp',
    'gif',
    'bmp',
    'svg',
    'ktx2',
    'basis',
    'tif',
    'tiff',
    'avif',
  ],
  models: ['glb', 'gltf', 'fbx', 'obj', 'bin'],
  audio: ['mp3', 'ogg', 'wav', 'm4a', 'aac', 'flac'],
  animations: ['pix3anim'],
  scripts: ['ts', 'js', 'mjs'],
  fonts: ['ttf', 'otf', 'woff', 'woff2'],
  video: ['mp4', 'webm', 'ogv', 'mov', 'm4v'],
  data: ['json', 'yaml', 'yml', 'txt', 'csv', 'xml'],
};

const CATEGORY_BY_EXTENSION: ReadonlyMap<string, AssetCategoryId> = new Map(
  (Object.entries(EXTENSIONS_BY_CATEGORY) as Array<[AssetCategoryId, readonly string[]]>).flatMap(
    ([categoryId, extensions]) => extensions.map(extension => [extension, categoryId] as const)
  )
);

/** Lower-cased extension of a file path without the dot; empty string when absent. */
export function getAssetPathExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return '';
  }
  return name.slice(lastDot + 1).toLowerCase();
}

export function categorizeAssetPath(path: string): AssetCategoryId {
  const extension = getAssetPathExtension(path);
  if (!extension) {
    return 'other';
  }
  return CATEGORY_BY_EXTENSION.get(extension) ?? 'other';
}

/*
 * Expansion keys for the grouped view. Category rows use `cat:<id>`; directory rows
 * use `<id>::<path>` so the same real folder can expand independently under two
 * categories. The key format is shared with ProjectService, which remaps directory
 * keys when files are moved.
 */

const GROUPED_KEY_CATEGORY_PREFIX = 'cat:';
const GROUPED_KEY_DIR_SEPARATOR = '::';

export function groupedCategoryExpansionKey(categoryId: AssetCategoryId): string {
  return `${GROUPED_KEY_CATEGORY_PREFIX}${categoryId}`;
}

export function groupedDirectoryExpansionKey(
  categoryId: AssetCategoryId,
  normalizedPath: string
): string {
  return `${categoryId}${GROUPED_KEY_DIR_SEPARATOR}${normalizedPath}`;
}

export function splitGroupedDirectoryExpansionKey(
  key: string
): { categoryId: AssetCategoryId; path: string } | null {
  const separatorIndex = key.indexOf(GROUPED_KEY_DIR_SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }
  const categoryId = key.slice(0, separatorIndex) as AssetCategoryId;
  if (!(categoryId in ASSET_CATEGORY_BY_ID)) {
    return null;
  }
  return { categoryId, path: key.slice(separatorIndex + GROUPED_KEY_DIR_SEPARATOR.length) };
}
