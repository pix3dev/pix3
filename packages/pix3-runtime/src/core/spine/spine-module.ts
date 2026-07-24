import type { Material, MaterialParameters, Object3D, Texture } from 'three';

/**
 * Structural subset of `@esotericsoftware/spine-threejs` (4.3) that the runtime
 * uses — hand-declared on purpose, so the package stays a genuinely OPTIONAL
 * dependency.
 *
 * Why not `import type` from the package: consumer projects compile the runtime
 * sources directly (`@pix3/runtime` ships TS, see its `main`/`types`), so a type
 * import would make `@esotericsoftware/spine-threejs` a hard compile-time
 * requirement for every game — including the ones that never touch Spine. The
 * official Spine Runtimes also ship under the Spine Runtimes License, which is a
 * poor fit for an always-installed transitive dependency.
 *
 * Instead the runtime declares the contract and whoever wants Spine hands the
 * real module in via {@link setSpineModuleLoader}. The declarations below are a
 * strict subset of the real API — widen them when new members are needed, and
 * keep the shape aligned with the pinned `~4.3` release.
 */

/** spine-core `Color` (0..1 components). */
export interface SpineColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** spine-core `Texture` (the runtime-agnostic base). */
export interface SpineTexture {
  dispose(): void;
}

/** spine-threejs `ThreeJsTexture` — owns the three.js texture it creates. */
export interface SpineThreeJsTexture extends SpineTexture {
  texture: Texture;
}

/** spine-core `TextureAtlasPage`. `name` is the page image file name. */
export interface SpineAtlasPage {
  name: string;
  width: number;
  height: number;
  /** Premultiplied-alpha flag from the atlas header (`pma: true`). */
  pma: boolean;
  texture: SpineTexture | null;
  setTexture(texture: SpineTexture): void;
}

/** spine-core `TextureAtlas`. */
export interface SpineTextureAtlas {
  pages: SpineAtlasPage[];
  dispose(): void;
}

/** spine-core `Animation`. */
export interface SpineAnimation {
  name: string;
  duration: number;
}

/** spine-core `Skin`. */
export interface SpineSkin {
  name: string;
}

/** spine-core `SkeletonData`, including the setup-pose bounding box. */
export interface SpineSkeletonData {
  animations: SpineAnimation[];
  skins: SpineSkin[];
  defaultSkin: SpineSkin | null;
  /** Spine editor version the skeleton was exported from, when recorded. */
  version: string | null;
  /** Setup-pose AABB in skeleton space. */
  x: number;
  y: number;
  width: number;
  height: number;
  findAnimation(name: string): SpineAnimation | null;
  findSkin(name: string): SpineSkin | null;
}

/** spine-core `TrackEntry` (subset). */
export interface SpineTrackEntry {
  animation: SpineAnimation | null;
  trackIndex: number;
  loop: boolean;
  trackTime: number;
  timeScale: number;
  mixDuration: number;
}

/** spine-core `Event` fired from an animation's event timeline. */
export interface SpineEvent {
  data: { name: string };
  intValue: number;
  floatValue: number;
  stringValue: string | null;
}

/** spine-core `AnimationStateListener` (subset used for signals). */
export interface SpineAnimationStateListener {
  start?: (entry: SpineTrackEntry) => void;
  interrupt?: (entry: SpineTrackEntry) => void;
  end?: (entry: SpineTrackEntry) => void;
  dispose?: (entry: SpineTrackEntry) => void;
  complete?: (entry: SpineTrackEntry) => void;
  event?: (entry: SpineTrackEntry, event: SpineEvent) => void;
}

/** spine-core `AnimationStateData`. */
export interface SpineAnimationStateData {
  defaultMix: number;
  setMix(fromName: string, toName: string, duration: number): void;
}

/** spine-core `AnimationState` (subset). */
export interface SpineAnimationState {
  data: SpineAnimationStateData;
  timeScale: number;
  /**
   * Per-track current entries; `null` where a track has no animation. This is
   * spine 4.3's accessor — earlier releases exposed `getCurrent(trackIndex)`.
   */
  tracks: (SpineTrackEntry | null)[];
  setAnimation(trackIndex: number, animationName: string, loop?: boolean): SpineTrackEntry;
  addAnimation(
    trackIndex: number,
    animationName: string,
    loop?: boolean,
    delay?: number
  ): SpineTrackEntry;
  setEmptyAnimation(trackIndex: number, mixDuration?: number): SpineTrackEntry;
  clearTrack(trackIndex: number): void;
  clearTracks(): void;
  addListener(listener: SpineAnimationStateListener): void;
}

/** spine-core `Skeleton` (subset). */
export interface SpineSkeleton {
  data: SpineSkeletonData;
  skin: SpineSkin | null;
  color: SpineColor;
  scaleX: number;
  scaleY: number;
  setSkin(skinName: string): void;
  /** Resets slots + draw order to the setup pose (4.3 name). */
  setupPoseSlots(): void;
  /** Resets bones, constraints and slots to the setup pose (4.3 name). */
  setupPose(): void;
}

/** spine-threejs `SkeletonMesh` — a three.js `Object3D` with dynamic children. */
export interface SpineSkeletonMesh extends Object3D {
  skeleton: SpineSkeleton;
  state: SpineAnimationState;
  /**
   * Per-slot Z spread spine uses to depth-sort slots. The 2D pass draws with
   * `depthTest: false`, so the view zeroes it and relies on draw order instead.
   */
  zOffset: number;
  update(deltaTime: number): void;
  dispose(): void;
}

/** A three.js material usable by spine's mesh batcher. */
export type SpineBatchMaterial = Material & { map: Texture | null };

export interface SpineSkeletonMeshConfiguration {
  skeletonData: SpineSkeletonData;
  twoColorTint?: boolean;
  materialFactory?: (parameters: MaterialParameters) => SpineBatchMaterial;
}

interface SpineSkeletonLoader<TSource> {
  scale: number;
  readSkeletonData(source: TSource): SpineSkeletonData;
}

/** The pieces of `@esotericsoftware/spine-threejs` the runtime constructs. */
export interface SpineModule {
  TextureAtlas: new (atlasText: string) => SpineTextureAtlas;
  AtlasAttachmentLoader: new (atlas: SpineTextureAtlas) => unknown;
  SkeletonJson: new (attachmentLoader: unknown) => SpineSkeletonLoader<string | unknown>;
  SkeletonBinary: new (attachmentLoader: unknown) => SpineSkeletonLoader<Uint8Array>;
  SkeletonMesh: new (configuration: SpineSkeletonMeshConfiguration) => SpineSkeletonMesh;
  ThreeJsTexture: new (image: unknown, pma?: boolean) => SpineThreeJsTexture;
}

export type SpineModuleLoader = () => Promise<SpineModule>;

let moduleLoader: SpineModuleLoader | null = null;
let modulePromise: Promise<SpineModule> | null = null;

/**
 * Registers the loader that resolves `@esotericsoftware/spine-threejs`.
 *
 * The host application owns this call because only the host's bundler can turn a
 * literal `import('@esotericsoftware/spine-threejs')` into a lazily fetched
 * chunk. The editor and the exported player register it at startup; a consumer
 * project that uses `SpineSkeleton2D` registers it once in its bootstrap:
 *
 * ```ts
 * setSpineModuleLoader(() => import('@esotericsoftware/spine-threejs'));
 * ```
 *
 * Passing a different loader resets the cached module so a host can swap
 * implementations (tests do this).
 */
export function setSpineModuleLoader(loader: SpineModuleLoader | null): void {
  if (moduleLoader === loader) {
    return;
  }
  moduleLoader = loader;
  modulePromise = null;
}

/** True when a host registered a Spine module loader. */
export function isSpineModuleAvailable(): boolean {
  return moduleLoader !== null;
}

/**
 * Resolves the Spine module, loading it on first use. Rejects with an actionable
 * message when no loader was registered — that is the "Spine is not installed"
 * path, not a bug.
 */
export function loadSpineModule(): Promise<SpineModule> {
  if (!moduleLoader) {
    return Promise.reject(
      new Error(
        '[Spine] No Spine runtime registered. Install `@esotericsoftware/spine-threejs` ' +
          '(~4.3) and call `setSpineModuleLoader(() => import("@esotericsoftware/spine-threejs"))` ' +
          'during startup before using SpineSkeleton2D.'
      )
    );
  }

  if (!modulePromise) {
    const loader = moduleLoader;
    modulePromise = loader().catch((error: unknown) => {
      // Let the next call retry a transient chunk-load failure.
      if (moduleLoader === loader) {
        modulePromise = null;
      }
      throw error;
    });
  }

  return modulePromise;
}
