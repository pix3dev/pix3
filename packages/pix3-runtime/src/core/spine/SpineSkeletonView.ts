import { MeshBasicMaterial, type MaterialParameters } from 'three';

import type { SpineAsset } from './SpineAsset';
import type {
  SpineBatchMaterial,
  SpineEvent,
  SpineSkeletonMesh,
  SpineTrackEntry,
} from './spine-module';

/** Setup-pose bounding box of a skeleton, in skeleton-local pixels. */
export interface SpineSetupBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpinePlayOptions {
  loop?: boolean;
  trackIndex?: number;
  /** Crossfade duration from the current animation, in seconds. */
  mixDuration?: number;
}

export interface SpineQueueOptions extends SpinePlayOptions {
  /** Extra delay after the previous entry, in seconds. */
  delay?: number;
}

export interface SpineSkeletonViewOptions {
  asset: SpineAsset;
  /** Enable spine's tint-black rendering (skeletons exported with dark tint). */
  twoColorTint?: boolean;
  /** Fired when a non-looping animation reaches its end. */
  onFinished?: (animationName: string, trackIndex: number) => void;
  /** Fired every time a looping animation completes a loop. */
  onLooped?: (animationName: string, trackIndex: number) => void;
  /** Fired when a track entry becomes current. */
  onStarted?: (animationName: string, trackIndex: number) => void;
  /** Fired for each keyed animation event. */
  onEvent?: (
    eventName: string,
    payload: { int: number; float: number; string: string | null },
    trackIndex: number
  ) => void;
}

/**
 * Owns one renderable Spine skeleton instance: a spine-threejs `SkeletonMesh`
 * configured for pix3's 2D overlay pass, plus playback helpers.
 *
 * Deliberately shared between the runtime node and the editor viewport proxy —
 * the editor renders its own proxy objects rather than the runtime node's meshes,
 * so both sides build a `SpineSkeletonView` from the same {@link SpineAsset} and
 * stay pixel-identical. Each view holds its own `Skeleton`/`AnimationState`; the
 * `SkeletonData` and atlas textures belong to the shared asset.
 */
export class SpineSkeletonView {
  /** The object to parent into the scene graph (a three.js `Object3D`). */
  readonly object: SpineSkeletonMesh;

  private readonly asset: SpineAsset;
  private disposed = false;
  private color = { r: 1, g: 1, b: 1 };
  private opacity = 1;

  constructor(private readonly options: SpineSkeletonViewOptions) {
    this.asset = options.asset;

    this.object = new this.asset.spine.SkeletonMesh({
      skeletonData: this.asset.skeletonData,
      twoColorTint: options.twoColorTint ?? false,
      materialFactory: createMaterialFactory(),
    });
    this.object.name = 'SpineSkeletonMesh';
    // Slot Z-spread exists so spine can depth-sort slots; the 2D pass renders
    // with depthTest off and orders purely by draw order, and a non-zero spread
    // would push far slots out of the orthographic frustum on deep skeletons.
    this.object.zOffset = 0;

    this.object.state.addListener({
      start: entry => {
        this.options.onStarted?.(animationNameOf(entry), entry.trackIndex);
      },
      complete: entry => {
        const name = animationNameOf(entry);
        if (entry.loop) {
          this.options.onLooped?.(name, entry.trackIndex);
        } else {
          this.options.onFinished?.(name, entry.trackIndex);
        }
      },
      event: (entry, event: SpineEvent) => {
        this.options.onEvent?.(
          event.data.name,
          { int: event.intValue, float: event.floatValue, string: event.stringValue },
          entry.trackIndex
        );
      },
    });

    // Build the setup-pose geometry so a paused / not-yet-playing skeleton is
    // visible immediately (the editor relies on this: it never ticks by default).
    this.object.update(0);
  }

  get skeletonAsset(): SpineAsset {
    return this.asset;
  }

  /** Animation names available on this skeleton, in export order. */
  getAnimationNames(): string[] {
    return this.asset.skeletonData.animations.map(animation => animation.name);
  }

  /** Skin names available on this skeleton, in export order. */
  getSkinNames(): string[] {
    return this.asset.skeletonData.skins.map(skin => skin.name);
  }

  /** Setup-pose AABB — stable across frames, unlike the live pose bounds. */
  getSetupBounds(): SpineSetupBounds {
    const data = this.asset.skeletonData;
    return { x: data.x, y: data.y, width: data.width, height: data.height };
  }

  /** The animation currently playing on a track, or null. */
  getCurrentAnimation(trackIndex = 0): string | null {
    const entry = this.object.state.tracks[trackIndex] ?? null;
    return entry?.animation?.name ?? null;
  }

  /** Sets the default crossfade duration used when no pair-specific mix exists. */
  setDefaultMix(seconds: number): void {
    this.object.state.data.defaultMix = Math.max(0, seconds);
  }

  /** Sets the crossfade duration for one animation pair. */
  setMix(fromAnimation: string, toAnimation: string, seconds: number): void {
    this.object.state.data.setMix(fromAnimation, toAnimation, Math.max(0, seconds));
  }

  setTimeScale(scale: number): void {
    this.object.state.timeScale = Number.isFinite(scale) ? scale : 1;
  }

  /**
   * Plays an animation on a track, replacing whatever is on it. Unknown names are
   * reported by the caller — this returns false instead of throwing so a stale
   * authored name cannot break a scene load.
   */
  play(animationName: string, options: SpinePlayOptions = {}): boolean {
    const name = animationName.trim();
    if (!name || !this.asset.skeletonData.findAnimation(name)) {
      return false;
    }

    const entry = this.object.state.setAnimation(
      options.trackIndex ?? 0,
      name,
      options.loop ?? false
    );
    if (options.mixDuration !== undefined) {
      entry.mixDuration = Math.max(0, options.mixDuration);
    }
    return true;
  }

  /** Queues an animation after the ones already on the track. */
  queue(animationName: string, options: SpineQueueOptions = {}): boolean {
    const name = animationName.trim();
    if (!name || !this.asset.skeletonData.findAnimation(name)) {
      return false;
    }

    const entry = this.object.state.addAnimation(
      options.trackIndex ?? 0,
      name,
      options.loop ?? false,
      options.delay ?? 0
    );
    if (options.mixDuration !== undefined) {
      entry.mixDuration = Math.max(0, options.mixDuration);
    }
    return true;
  }

  /**
   * Clears playback. With a `mixDuration` the skeleton mixes back to the setup
   * pose (spine's recommended way out of an animation); without one the tracks
   * are cleared and the current pose is reset immediately.
   */
  stop(options: { trackIndex?: number; mixDuration?: number } = {}): void {
    const { trackIndex, mixDuration } = options;
    if (mixDuration !== undefined && mixDuration > 0) {
      this.object.state.setEmptyAnimation(trackIndex ?? 0, mixDuration);
      return;
    }

    if (trackIndex === undefined) {
      this.object.state.clearTracks();
    } else {
      this.object.state.clearTrack(trackIndex);
    }
    this.object.skeleton.setupPose();
    this.object.update(0);
  }

  /** Applies a skin by name. Returns false for an unknown skin. */
  setSkin(skinName: string): boolean {
    const name = skinName.trim();
    if (!name) {
      this.object.skeleton.skin = null;
      this.object.skeleton.setupPoseSlots();
      return true;
    }

    if (!this.asset.skeletonData.findSkin(name)) {
      return false;
    }

    this.object.skeleton.setSkin(name);
    this.object.skeleton.setupPoseSlots();
    return true;
  }

  /**
   * Tint + alpha for the whole skeleton. Applied through spine's own skeleton
   * color (which reaches the batched vertex colors) rather than per-material,
   * because the batch materials are created lazily and replaced as slots change.
   */
  setTint(color: { r: number; g: number; b: number }, opacity: number): void {
    this.color = color;
    this.opacity = clamp01(opacity);
    const skeletonColor = this.object.skeleton.color;
    skeletonColor.r = color.r;
    skeletonColor.g = color.g;
    skeletonColor.b = color.b;
    skeletonColor.a = this.opacity;
  }

  setOpacity(opacity: number): void {
    this.setTint(this.color, opacity);
  }

  /** Advances animation state and rebuilds geometry. */
  update(dt: number): void {
    if (this.disposed) {
      return;
    }
    this.object.update(Math.max(0, dt));
  }

  /** Rebuilds geometry for the current pose without advancing time. */
  refresh(): void {
    this.update(0);
  }

  /**
   * Disposes the per-instance mesh, geometry and materials. The shared
   * {@link SpineAsset} (skeleton data + page textures) is owned by the asset
   * cache and intentionally NOT disposed here.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.object.removeFromParent();
    this.object.dispose();
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value));
}

function animationNameOf(entry: SpineTrackEntry): string {
  return entry.animation?.name ?? '';
}

/**
 * Materials for the 2D overlay pass. Spine's defaults enable depth test/write,
 * which is wrong here: the 2D pass draws after a `clearDepth()` with ordering
 * decided solely by `renderOrder`, and mixed depth flags make 2D content vanish
 * behind other nodes' quads.
 *
 * `parameters` is spine's shared static default object — it must be spread, never
 * mutated. spine's `MeshBatcher` assigns `map`/blending afterwards and patches
 * `onBeforeCompile`, so a stock `MeshBasicMaterial` is all that is needed.
 */
function createMaterialFactory(): (parameters: MaterialParameters) => SpineBatchMaterial {
  return parameters =>
    new MeshBasicMaterial({
      ...parameters,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
}
