import { normalizeAnimationResource, type AnimationResource } from '@pix3/runtime';

export function normalizeAnimationAssetPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/');
  const withScheme = trimmed.startsWith('res://')
    ? trimmed
    : `res://${trimmed.replace(/^\/+/, '')}`;

  if (withScheme.endsWith('.pix3anim')) {
    return withScheme;
  }

  const normalizedRelativePath = withScheme
    .replace(/^res:\/\//i, '')
    .replace(/^templ:\/\//i, '')
    .replace(/^collab:\/\//i, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const pathSegments = normalizedRelativePath.split('/').filter(Boolean);
  const stem = pathSegments[pathSegments.length - 1] ?? 'animation';

  return `res://${normalizedRelativePath}/${stem}.pix3anim`;
}

export function deriveAnimationAssetStem(resourcePath: string): string {
  const normalizedPath = normalizeAnimationAssetPath(resourcePath)
    .replace(/^res:\/\//i, '')
    .replace(/^templ:\/\//i, '')
    .replace(/^collab:\/\//i, '')
    .replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter(Boolean);
  const fileName = segments[segments.length - 1] ?? 'animation.pix3anim';
  return fileName.replace(/\.pix3anim$/i, '') || 'animation';
}

export function getAnimationAssetDirectory(resourcePath: string): string {
  const normalizedPath = normalizeAnimationAssetPath(resourcePath);
  const lastSlashIndex = normalizedPath.lastIndexOf('/');
  if (lastSlashIndex <= 'res://'.length) {
    return 'res://';
  }

  return normalizedPath.slice(0, lastSlashIndex);
}

/**
 * Turn a clip name into a filename-safe prefix. Empty/degenerate names collapse to `frame`, which
 * reproduces the historical `frame_0001.png` naming for callers that have no clip context.
 */
export function sanitizeFrameFilePrefix(clipName: string | undefined): string {
  const sanitized = (clipName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return sanitized || 'frame';
}

export interface AnimationFrameResourcePathOptions {
  /**
   * Clip the frame belongs to. Frames are named `<clip>_<nnnn>.<ext>` so two clips sliced into the
   * same sprite folder cannot overwrite each other's files. Omit for the legacy `frame_<nnnn>` name.
   */
  clipName?: string;
  extension?: string;
}

export function buildAnimationFrameResourcePath(
  resourcePath: string,
  frameNumber: number,
  options: AnimationFrameResourcePathOptions = {}
): string {
  const frameSuffix = String(Math.max(1, Math.floor(frameNumber))).padStart(4, '0');
  const prefix = sanitizeFrameFilePrefix(options.clipName);
  const extension = options.extension ?? 'png';
  return `${getAnimationAssetDirectory(resourcePath)}/${prefix}_${frameSuffix}.${extension}`;
}

/**
 * The **managed sprite folder** convention: one folder holds one sprite — its single `.pix3anim`
 * and every frame PNG it references. `sprites/character/character.pix3anim` +
 * `sprites/character/idle_0001.png`. The editor creates and names those files so the happy flow
 * never asks the user for a path, and the Asset Browser can collapse the folder into one item.
 *
 * Nothing enforces it: a `.pix3anim` may reference any path. Unmanaged layouts keep working, they
 * just don't collapse in the navigator and skip convention-dependent bulk tools.
 */
export function buildManagedSpriteAssetPath(imageResourcePath: string): string {
  const normalized = imageResourcePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^res:\/\//i, '')
    .replace(/^\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  const fileName = segments.pop() ?? 'sprite';
  const stem = fileName.replace(/\.[^./]+$/, '') || 'sprite';
  const directory = segments.join('/');

  return normalizeAnimationAssetPath(directory ? `${directory}/${stem}` : stem);
}

/**
 * True when `resource`'s frames all live in the same folder as `assetPath` — the structural
 * predicate behind navigator grouping and the managed-folder bulk tools (§8.2). Cheap: it reads
 * only the already-parsed resource, never the filesystem.
 */
export function isManagedSpriteFolder(
  assetPath: string,
  frameTexturePaths: readonly string[]
): boolean {
  const directory = getAnimationAssetDirectory(assetPath);
  const resolvedFrames = frameTexturePaths.map(path => path.trim()).filter(Boolean);
  if (resolvedFrames.length === 0) {
    return false;
  }

  return resolvedFrames.every(framePath => {
    const normalized = framePath.replace(/\\/g, '/');
    const withScheme = normalized.startsWith('res://')
      ? normalized
      : `res://${normalized.replace(/^\/+/, '')}`;
    const lastSlashIndex = withScheme.lastIndexOf('/');
    const frameDirectory =
      lastSlashIndex <= 'res://'.length ? 'res://' : withScheme.slice(0, lastSlashIndex);
    return frameDirectory === directory;
  });
}

export function deriveAnimationDocumentId(resourcePath: string): string {
  const normalizedPath = normalizeAnimationAssetPath(resourcePath)
    .replace(/^res:\/\//i, '')
    .replace(/^templ:\/\//i, '')
    .replace(/^collab:\/\//i, '')
    .replace(/\.[^./]+$/i, '');

  const normalizedId = normalizedPath
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  return normalizedId || 'animation';
}

export function createDefaultAnimationResource(
  texturePath: string,
  initialClipName = 'idle'
): AnimationResource {
  const normalizedTexturePath = texturePath.trim();

  return normalizeAnimationResource({
    version: '1.0.0',
    texturePath: '',
    clips: [
      {
        name: initialClipName,
        fps: 12,
        loop: true,
        playbackMode: 'normal',
        frames: normalizedTexturePath
          ? [
              {
                textureIndex: 0,
                offset: { x: 0, y: 0 },
                repeat: { x: 1, y: 1 },
                durationMultiplier: 1,
                anchor: { x: 0.5, y: 0.5 },
                texturePath: normalizedTexturePath,
                boundingBox: { x: 0, y: 0, width: 0, height: 0 },
                collisionPolygon: [],
              },
            ]
          : [],
      },
    ],
  });
}

export function parseAnimationResourceText(source: string): AnimationResource {
  return normalizeAnimationResource(JSON.parse(source));
}

export function serializeAnimationResource(resource: AnimationResource): string {
  const normalized = normalizeAnimationResource(resource);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function getAssetParentDirectory(resourcePath: string): string {
  const normalized = resourcePath.replace(/^res:\/\//, '').replace(/\\/g, '/');
  const lastSlashIndex = normalized.lastIndexOf('/');
  if (lastSlashIndex <= 0) {
    return '.';
  }

  return normalized.slice(0, lastSlashIndex);
}
