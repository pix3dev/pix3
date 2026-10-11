import { ResourceManager } from './ResourceManager';
import { NodeBase } from '../nodes/NodeBase';
import { BufferGeometry, Material, Texture } from 'three';
import { AudioService } from './AudioService';
import { type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { type AnimationResource } from './AnimationResource';
import { type AtlasResolver } from './atlas-frame-map';
import { type SpineAsset, type SpineAssetRequest } from './spine/SpineAsset';
/** Options for {@link AssetLoader.loadTexture}. */
export interface LoadTextureOptions {
    /**
     * Consult the atlas resolver (default true). Pass `false` for consumers that
     * must always receive the raw, standalone texture — 3D materials (which keep
     * mipmaps) and 9-slice / tiled sprites (whose geometry assumes full-[0,1] UVs).
     * Defense in depth: the packer already excludes any path such a node references.
     */
    atlas?: boolean;
}
export interface AssetLoaderResult {
    node: NodeBase;
}
export interface InstancingModelAsset {
    geometry: BufferGeometry;
    material: Material | Material[];
    scene: GLTF['scene'];
}
export interface LoadedAudioMetadata {
    readonly resourcePath: string;
    readonly sizeBytes: number;
}
/**
 * AssetLoader is responsible for loading asset files from various URLs
 * and converting them to concrete NodeBase instances in the scene tree.
 *
 * Supported formats:
 * - .glb / .gltf → MeshInstance
 * - .png / .jpg / .jpeg / .webp → used by Sprite2D
 * - .mp3 / .ogg / .wav → AudioBuffer
 */
export declare class AssetLoader {
    private readonly resources;
    private readonly audioService?;
    private textureLoader;
    private readonly textureCache;
    private readonly textureLoadInFlight;
    private readonly animationResourceCache;
    private readonly animationResourceLoadInFlight;
    private readonly audioLoadInFlight;
    private readonly audioMetadataCache;
    private readonly spineAssetCache;
    private readonly spineAssetLoadInFlight;
    private atlasResolver;
    constructor(resources: ResourceManager, audioService?: AudioService);
    /**
     * De-duplicates concurrent loads of `key`, clearing the entry once `promise` settles.
     *
     * The clean-up is attached with `then(clear, clear)` — a chain that *handles* rejection — rather
     * than `promise.finally(clear)`. `.finally` returns a new promise that re-raises whatever the
     * original rejected with, and nothing here was holding that promise, so every failed asset load
     * produced an `unhandledrejection` on top of the error the caller already handled. The editor and
     * the player both listen for that event and surface it as a runtime error, so a single missing
     * texture reported itself twice, the second time with no useful context. It is also why a spec
     * that parsed a `res://` texture without seeding the cache could make Vitest exit non-zero with
     * every test passing.
     *
     * Same reasoning as the `try/finally` inside {@link loadSpineAsset}'s body — a rejection must only
     * ever be observed by the caller's own `await`. This form additionally works for a promise built
     * elsewhere (the atlas view), and refuses to evict a newer entry that has already replaced this
     * one.
     */
    private trackInFlight;
    getResourceManager(): ResourceManager;
    /**
     * Install (or clear with `null`) the pre-launch texture atlas resolver. Set it
     * before `SceneRunner.startScene` — thereafter every atlas-eligible
     * {@link loadTexture} returns a lightweight view onto a packed sheet instead of
     * loading the standalone source file. Null = feature off, byte-identical to the
     * pre-atlas path.
     */
    setAtlasResolver(resolver: AtlasResolver | null): void;
    /**
     * Pre-seed the texture cache with a ready sheet under a synthetic key (e.g.
     * `pix3atlas://<hash>/sheet-0`). The editor packer calls this for its
     * in-memory / cache-hit sheets so the recursive sheet load inside
     * {@link loadTexture} resolves without touching the project filesystem.
     */
    seedTexture(resourcePath: string, texture: Texture): void;
    /**
     * Drop a cached texture entry (does NOT dispose it — other holders keep their
     * ref). Used when installing an atlas resolver: any texture the shared loader
     * cached raw before play (e.g. by the editor's edit-mode viewport) must be
     * evicted so the next `loadTexture` re-resolves it to a sheet view instead of
     * returning the stale raw texture.
     */
    evictTexture(resourcePath: string): void;
    getAudioMetadata(resourcePath: string): LoadedAudioMetadata | null;
    /**
     * Load an asset file and return a NodeBase instance.
     * @param resourcePath Path to the asset file
     * @param nodeId Optional node ID; generates UUID if not provided
     * @param nodeName Optional node name; defaults to asset filename
     * @returns Loaded asset as a NodeBase instance
     */
    loadAsset(resourcePath: string, nodeId?: string, nodeName?: string): Promise<AssetLoaderResult>;
    loadAudio(resourcePath: string): Promise<AudioBuffer>;
    /**
     * Load an image as a THREE.Texture. When an atlas resolver is installed and the
     * path was packed, returns a view onto the shared sheet (see
     * {@link setAtlasResolver}); otherwise loads the standalone file exactly as
     * before. Pass `{ atlas: false }` to force the raw file (3D / tiled consumers).
     */
    loadTexture(resourcePath: string, options?: LoadTextureOptions): Promise<Texture>;
    /**
     * Build (and cache under the original path) a texture view for a packed frame.
     * The sheet is loaded once through the normal path (`atlas: false` so the
     * resolver never re-maps a sheet key), and its GPU image is shared by every
     * view via three.js `Source` refcounting — one upload per sheet. Per-view
     * `offset`/`repeat` are material `uvTransform` uniforms, not GL texture state,
     * so all views of a sheet (identically configured via `configure2DTexture`)
     * share a single GL texture object.
     */
    private buildAtlasView;
    loadAnimationResource(resourcePath: string): Promise<AnimationResource>;
    /**
     * Loads a Spine skeleton + atlas pair, cached and de-duplicated by the three
     * paths that identify it. The returned {@link SpineAsset} (skeleton data + page
     * textures) is SHARED: every node and the editor's viewport proxy build their
     * own `Skeleton`/`AnimationState` on top of it, and nobody but this loader may
     * dispose it.
     *
     * Requires a host-registered Spine module (`setSpineModuleLoader`); rejects with
     * an actionable message when Spine is not installed.
     */
    loadSpineAsset(request: SpineAssetRequest): Promise<SpineAsset>;
    /** Cached Spine asset for a request, or null when it has not been loaded. */
    getCachedSpineAsset(request: SpineAssetRequest): SpineAsset | null;
    /**
     * Drops a cached Spine asset and disposes its page textures. Call when the
     * underlying files changed on disk; live views holding the old asset must be
     * rebuilt by their owners.
     */
    evictSpineAsset(request: SpineAssetRequest): void;
    loadInstancingModel(resourcePath: string): Promise<InstancingModelAsset>;
    /**
     * Load a GLB/GLTF file and convert it to a MeshInstance node.
     * @param resourcePath Path to the .glb/.gltf file
     * @param nodeId Optional node ID; generates UUID if not provided
     * @param nodeName Optional node name; defaults to 'mesh' if not provided
     * @returns MeshInstance node with loaded geometry and animations
     */
    private loadGltfAsMeshInstance;
    private loadGltf;
    private findFirstMesh;
    /**
     * Extract file extension from resource path.
     */
    private getExtension;
}
