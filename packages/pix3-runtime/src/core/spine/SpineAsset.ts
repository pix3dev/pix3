import { configure2DTexture } from '../configure-2d-texture';
import type { ResourceManager } from '../ResourceManager';
import {
  loadSpineModule,
  type SpineModule,
  type SpineSkeletonData,
  type SpineTextureAtlas,
  type SpineThreeJsTexture,
} from './spine-module';

/** The three files (skeleton + atlas + optional page override) a skeleton needs. */
export interface SpineAssetRequest {
  /** `res://…/hero.json` or `res://…/hero.skel`. */
  skeletonPath: string;
  /** `res://…/hero.atlas`. */
  atlasPath: string;
  /**
   * Optional page-image override. Only honored for single-page atlases — a
   * multi-page atlas always resolves its pages by the names inside the `.atlas`
   * file, relative to the atlas' own directory.
   */
  texturePath?: string | null;
}

/**
 * A loaded, shareable Spine asset: parsed `SkeletonData` plus the atlas whose
 * pages own the GPU textures.
 *
 * `SkeletonData` and the atlas are immutable, per-asset state and are shared by
 * every `SpineSkeleton2D` instance (and the editor's viewport proxy) that
 * references the same files — each *instance* gets its own `Skeleton` and
 * `AnimationState`, which is exactly how Spine is designed to be used.
 */
export interface SpineAsset {
  readonly key: string;
  readonly spine: SpineModule;
  readonly skeletonData: SpineSkeletonData;
  readonly atlas: SpineTextureAtlas;
  /** Resolved `res://` paths of the atlas page images, in page order. */
  readonly pagePaths: readonly string[];
  /** Disposes the atlas pages' GPU textures. Only the owning cache calls this. */
  dispose(): void;
}

/** Cache key for a request — the three paths fully determine the asset. */
export function spineAssetKey(request: SpineAssetRequest): string {
  return `${request.skeletonPath}|${request.atlasPath}|${request.texturePath ?? ''}`;
}

/**
 * Resolves an atlas page image name against the atlas file's own directory,
 * mirroring how every Spine runtime resolves pages (`pathPrefix` in their
 * `AssetManager`). Absolute (`res://`) page names are passed through so a
 * hand-edited atlas can point elsewhere.
 */
export function resolveSpinePagePath(atlasPath: string, pageName: string): string {
  const name = pageName.trim().replace(/^\.\//, '');
  if (/^[a-z]+[a-z0-9+.-]*:\/\//i.test(name) || name.startsWith('/')) {
    return name;
  }

  const separatorIndex = atlasPath.lastIndexOf('/');
  if (separatorIndex < 0) {
    return name;
  }

  return `${atlasPath.slice(0, separatorIndex + 1)}${name}`;
}

const SPINE_PAGE_IMAGE_PATTERN = /\.(png|jpg|jpeg|webp|ktx2|basis|bmp)$/i;

/**
 * Page image names declared inside an `.atlas` file, without parsing the whole
 * atlas (no Spine runtime needed).
 *
 * In the libgdx/Spine atlas format a page header is the first non-empty line, or
 * any line that follows a blank line; the indented `key: value` lines after it
 * are its properties, and un-indented lines elsewhere are region names. Requiring
 * an image extension keeps a region that happens to follow a blank line out.
 *
 * Used by tooling that must know a skeleton's textures without loading it: the
 * export asset collector (page names are invisible to the `res://` scan) and the
 * pre-launch atlas packer (which must never repack a Spine page).
 */
export function parseSpineAtlasPageNames(atlasText: string): string[] {
  const pages: string[] = [];
  let expectPage = true;

  for (const rawLine of atlasText.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) {
      expectPage = true;
      continue;
    }

    if (expectPage) {
      const candidate = rawLine.trim();
      if (SPINE_PAGE_IMAGE_PATTERN.test(candidate)) {
        pages.push(candidate);
      }
      expectPage = false;
    }
  }

  return pages;
}

/** True when the skeleton file is Spine's binary export rather than JSON. */
function isBinarySkeleton(skeletonPath: string): boolean {
  return skeletonPath.trim().toLowerCase().endsWith('.skel');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads and parses one Spine asset. Callers should go through
 * `AssetLoader.loadSpineAsset`, which adds caching and in-flight de-duplication.
 *
 * Page images are decoded straight to `ImageBitmap`s and handed to spine's
 * `ThreeJsTexture`, which creates the three.js texture it needs. This bypasses
 * `AssetLoader.loadTexture` on purpose: a page must stay a standalone,
 * full-[0,1]-UV texture — the pre-launch atlas packer would otherwise hand back a
 * view onto a packed sheet and every UV in the `.atlas` file would be wrong.
 */
export async function loadSpineAsset(
  resources: ResourceManager,
  request: SpineAssetRequest
): Promise<SpineAsset> {
  const spine = await loadSpineModule();
  const { skeletonPath, atlasPath } = request;

  const atlasText = await resources.readText(atlasPath);
  let atlas: SpineTextureAtlas;
  try {
    atlas = new spine.TextureAtlas(atlasText);
  } catch (error) {
    throw new Error(`[Spine] Failed to parse atlas ${atlasPath}: ${describeError(error)}`);
  }

  const pagePaths: string[] = [];
  const ownedTextures: SpineThreeJsTexture[] = [];
  const singlePageOverride =
    atlas.pages.length === 1 && request.texturePath ? request.texturePath : null;

  try {
    for (const page of atlas.pages) {
      const pagePath = singlePageOverride ?? resolveSpinePagePath(atlasPath, page.name);
      pagePaths.push(pagePath);

      const blob = await resources.readBlob(pagePath);
      const bitmap = await createImageBitmap(blob);
      const pageTexture = new spine.ThreeJsTexture(bitmap, page.pma);
      ownedTextures.push(pageTexture);

      // setTexture applies the atlas' own filter/wrap settings, so our 2D
      // overrides have to land AFTER it: mipmaps must stay off (see
      // configure2DTexture) even when the atlas asks for a mipmap filter.
      page.setTexture(pageTexture);
      configure2DTexture(pageTexture.texture);
    }
  } catch (error) {
    for (const texture of ownedTextures) {
      texture.dispose();
    }
    throw new Error(`[Spine] Failed to load atlas pages for ${atlasPath}: ${describeError(error)}`);
  }

  let skeletonData: SpineSkeletonData;
  try {
    const attachmentLoader = new spine.AtlasAttachmentLoader(atlas);
    if (isBinarySkeleton(skeletonPath)) {
      const blob = await resources.readBlob(skeletonPath);
      const buffer = await blob.arrayBuffer();
      skeletonData = new spine.SkeletonBinary(attachmentLoader).readSkeletonData(
        new Uint8Array(buffer)
      );
    } else {
      const json = await resources.readText(skeletonPath);
      skeletonData = new spine.SkeletonJson(attachmentLoader).readSkeletonData(json);
    }
  } catch (error) {
    for (const texture of ownedTextures) {
      texture.dispose();
    }
    // A version mismatch between the export and the installed runtime lands
    // here, so name both files and point at the likely cause.
    throw new Error(
      `[Spine] Failed to read skeleton ${skeletonPath} (atlas ${atlasPath}): ` +
        `${describeError(error)}. Check that the skeleton was exported from a Spine ` +
        'version matching the installed @esotericsoftware/spine-threejs release.'
    );
  }

  // The skeleton loaders' `scale` stays at 1: it bakes into the shared
  // SkeletonData, so per-instance sizing must come from the node transform
  // instead (otherwise every distinct scale would need its own parse + cache).
  return {
    key: spineAssetKey(request),
    spine,
    skeletonData,
    atlas,
    pagePaths,
    dispose: () => {
      atlas.dispose();
    },
  };
}
