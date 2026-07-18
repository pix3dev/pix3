import type { Texture } from 'three';
import type { TextureRegion } from './texture-region';

/**
 * Pre-launch texture atlasing (Phase 2). Many small source PNGs are packed into
 * a handful of sheets before a scene starts; every texture consumer is remapped
 * transparently at the {@link AssetLoader.loadTexture} chokepoint to a *view* — a
 * cheap clone of the sheet texture whose `offset`/`repeat` select the packed
 * frame. Source assets, scene YAML, and node code are untouched.
 *
 * This module is the runtime-agnostic contract shared by the editor-side packer
 * (which produces manifests + sheets) and the runtime (which consumes them). The
 * packer itself lives in the editor package — `@pix3/runtime` never packs.
 */

/** One packed frame: where a source texture landed inside a sheet. */
export interface AtlasFrame {
  /** res:// path of the sheet image, or a synthetic `pix3atlas://…` preseed key. */
  sheetPath: string;
  /** Normalized UV subrect inside the sheet (three.js offset/repeat space, origin bottom-left). */
  region: TextureRegion;
  /** Original source pixel size — natural-size logic must use THIS, not the sheet image dims. */
  pixelWidth: number;
  pixelHeight: number;
}

/** Consulted by AssetLoader on every texture load. Pure lookup, no I/O. */
export interface AtlasResolver {
  resolve(resourcePath: string): AtlasFrame | null;
}

/** Synthetic path prefix for atlas sheets pre-seeded into the AssetLoader cache. */
export const ATLAS_SHEET_SCHEME = 'pix3atlas://';

/**
 * Serialized atlas description: stored in the editor cache and shipped as
 * `atlas-manifest.json` in exports. `frames` are keyed by the original res://
 * source path and expressed in *pixel* coordinates (origin top-left, as drawn on
 * the compositing canvas); the runtime converts to UV space when building views.
 */
export interface AtlasManifest {
  formatVersion: 1;
  /** Bump to invalidate every cache when the packing algorithm changes. */
  packerVersion: number;
  contentHash: string;
  textureFiltering: 'linear' | 'nearest';
  sheets: Array<{ id: string; file: string; width: number; height: number }>;
  frames: Record<string, { sheet: string; x: number; y: number; w: number; h: number }>;
  /** Paths deliberately left standalone (oversized, 3D-shared, tiled) — diagnostics only. */
  excluded: string[];
}

/** userData key carrying a view's atlas frame region (its UV subrect in the sheet). */
export const ATLAS_REGION_KEY = 'pix3AtlasRegion';
/** userData key carrying the original source pixel size (for natural-size logic). */
export const ATLAS_SIZE_KEY = 'pix3AtlasSize';

export interface AtlasSourceSize {
  width: number;
  height: number;
}

interface AtlasViewUserData {
  pix3AtlasRegion?: TextureRegion;
  pix3AtlasSize?: AtlasSourceSize;
}

/**
 * The atlas frame region a texture *view* carries, or `null` for a plain
 * (non-atlased) texture. Consumers that write `offset`/`repeat` (Sprite2D crop,
 * AnimatedSprite2D frames) compose their local region against this base so the
 * final UVs land inside the packed frame rather than the whole sheet.
 */
export function baseRegionOf(texture: Texture | null | undefined): TextureRegion | null {
  if (!texture) {
    return null;
  }
  return (texture.userData as AtlasViewUserData).pix3AtlasRegion ?? null;
}

/** The original source pixel size a view carries, or `null` for a plain texture. */
export function atlasSizeOf(texture: Texture | null | undefined): AtlasSourceSize | null {
  if (!texture) {
    return null;
  }
  return (texture.userData as AtlasViewUserData).pix3AtlasSize ?? null;
}

/**
 * Stamp atlas metadata onto a view texture (or a per-node clone of one). Set
 * explicitly rather than relying on `Texture.copy`'s userData handling, which
 * varies across three.js versions.
 */
export function stampAtlasView(texture: Texture, region: TextureRegion, size: AtlasSourceSize): void {
  const userData = texture.userData as AtlasViewUserData;
  userData.pix3AtlasRegion = region;
  userData.pix3AtlasSize = size;
}

/** Copy any atlas metadata from `source` onto `target` (used when cloning views). */
export function copyAtlasMetadata(source: Texture, target: Texture): void {
  const from = source.userData as AtlasViewUserData;
  const to = target.userData as AtlasViewUserData;
  if (from.pix3AtlasRegion) {
    to.pix3AtlasRegion = from.pix3AtlasRegion;
  }
  if (from.pix3AtlasSize) {
    to.pix3AtlasSize = from.pix3AtlasSize;
  }
}

/**
 * Build an {@link AtlasResolver} from a manifest. The manifest stores frames in
 * pixel coordinates (origin top-left, as composited); this converts each to a
 * three.js UV region (origin bottom-left) matching `applyTextureRegionToTexture`.
 * `resolveSheetPath` maps a sheet id to the path {@link AssetLoader.loadTexture}
 * will load it under — a synthetic preseed key in the editor, a real res:// file
 * in exported games — so the same manifest drives both consumers.
 */
export function createAtlasResolver(
  manifest: AtlasManifest,
  resolveSheetPath: (sheetId: string) => string
): AtlasResolver {
  const sheetDims = new Map(manifest.sheets.map(sheet => [sheet.id, sheet]));
  const frames = new Map<string, AtlasFrame>();
  for (const [resourcePath, frame] of Object.entries(manifest.frames)) {
    const sheet = sheetDims.get(frame.sheet);
    if (!sheet) {
      continue;
    }
    const w = sheet.width;
    const h = sheet.height;
    frames.set(resourcePath, {
      sheetPath: resolveSheetPath(frame.sheet),
      region: {
        x: frame.x / w,
        y: 1 - (frame.y + frame.h) / h,
        width: frame.w / w,
        height: frame.h / h,
      },
      pixelWidth: frame.w,
      pixelHeight: frame.h,
    });
  }
  return {
    resolve(resourcePath: string): AtlasFrame | null {
      return frames.get(resourcePath) ?? null;
    },
  };
}
