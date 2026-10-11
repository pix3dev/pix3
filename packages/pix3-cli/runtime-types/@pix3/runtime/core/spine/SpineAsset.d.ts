import type { ResourceManager } from '../ResourceManager';
import { type SpineModule, type SpineSkeletonData, type SpineTextureAtlas } from './spine-module';
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
export declare function spineAssetKey(request: SpineAssetRequest): string;
/**
 * Resolves an atlas page image name against the atlas file's own directory,
 * mirroring how every Spine runtime resolves pages (`pathPrefix` in their
 * `AssetManager`). Absolute (`res://`) page names are passed through so a
 * hand-edited atlas can point elsewhere.
 */
export declare function resolveSpinePagePath(atlasPath: string, pageName: string): string;
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
export declare function parseSpineAtlasPageNames(atlasText: string): string[];
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
export declare function loadSpineAsset(resources: ResourceManager, request: SpineAssetRequest): Promise<SpineAsset>;
