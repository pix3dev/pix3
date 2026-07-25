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
  | 'locales'
  | 'data'
  | 'other';

export interface AssetCategoryDefinition {
  readonly id: AssetCategoryId;
  readonly label: string;
  /** IconService icon name (Feather). */
  readonly icon: string;
  /**
   * Folder new assets of this category are created in — a single segment at the
   * **project root** (the flat layout every project template ships — see the README
   * under `src/templates/projects/<id>/files/`). `null` = no canonical home, so the
   * author's path is left alone.
   */
  readonly folder: string | null;
}

/** Fixed display order for the grouped asset-browser view. */
export const ASSET_CATEGORIES: readonly AssetCategoryDefinition[] = [
  { id: 'scenes', label: 'Scenes', icon: 'film', folder: 'scenes' },
  { id: 'images', label: 'Images', icon: 'image', folder: 'sprites' },
  { id: 'models', label: 'Models', icon: 'box', folder: 'models' },
  { id: 'audio', label: 'Audio', icon: 'music', folder: 'audio' },
  { id: 'animations', label: 'Animations', icon: 'activity', folder: 'animations' },
  { id: 'scripts', label: 'Scripts', icon: 'code', folder: 'scripts' },
  { id: 'fonts', label: 'Fonts', icon: 'type', folder: 'fonts' },
  { id: 'video', label: 'Video', icon: 'video', folder: 'video' },
  { id: 'locales', label: 'Locales', icon: 'globe', folder: 'locales' },
  { id: 'data', label: 'Data', icon: 'database', folder: 'data' },
  { id: 'other', label: 'Other', icon: 'file-text', folder: null },
];

export const ASSET_CATEGORY_BY_ID: Readonly<Record<AssetCategoryId, AssetCategoryDefinition>> =
  Object.fromEntries(ASSET_CATEGORIES.map(category => [category.id, category])) as Record<
    AssetCategoryId,
    AssetCategoryDefinition
  >;

const EXTENSIONS_BY_CATEGORY: Readonly<
  Record<Exclude<AssetCategoryId, 'other' | 'locales'>, readonly string[]>
> = {
  scenes: ['pix3scene'],
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
  // Spine exports live with the animations: `.atlas`/`.skel` belong to a
  // SpineSkeleton2D, and its `.json` skeleton stays under `data` (a JSON file is
  // not necessarily Spine).
  animations: ['pix3anim', 'atlas', 'skel'],
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

/** Locale tables live in a `locales/` directory (see §6.17 in the spec). */
const LOCALES_SEGMENT_RE = /(^|[\\/])locales[\\/]/i;

export function categorizeAssetPath(path: string): AssetCategoryId {
  const extension = getAssetPathExtension(path);
  if (!extension) {
    return 'other';
  }
  // Path-based: locale tables are JSON, but they get their own category so the
  // grouped view doesn't bury them in generic data files.
  if (extension === 'json' && LOCALES_SEGMENT_RE.test(path)) {
    return 'locales';
  }
  return CATEGORY_BY_EXTENSION.get(extension) ?? 'other';
}

/** Spine exports keep the whole export together instead of splitting by extension. */
const FOLDER_BY_EXTENSION: Readonly<Record<string, string>> = {
  atlas: 'spine',
  skel: 'spine',
};

/**
 * Canonical root folder a *new* asset of this kind belongs in, or `null` when there is
 * no obvious home. Projects use a flat layout — one folder per asset type at the project
 * root (`sprites/`, `models/`, `audio/`, `spine/`, …), never nested under `assets/`.
 */
export function defaultAssetFolder(pathOrName: string): string | null {
  const extension = getAssetPathExtension(pathOrName);
  return (
    FOLDER_BY_EXTENSION[extension] ?? ASSET_CATEGORY_BY_ID[categorizeAssetPath(pathOrName)].folder
  );
}

/**
 * Ensures a path for a newly created asset lives inside a type folder: a bare file name
 * (`car.png`) is prefixed with its category folder (`sprites/car.png`), while a name that
 * already carries a folder is returned untouched — the author's placement wins. Only for
 * assets being *created*; never re-point a path that already exists on disk.
 */
export function ensureAssetTypeFolder(pathOrName: string): string {
  const normalized = pathOrName.replace(/\\+/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (normalized.includes('/')) {
    return normalized;
  }
  const folder = defaultAssetFolder(normalized);
  return folder ? `${folder}/${normalized}` : normalized;
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
