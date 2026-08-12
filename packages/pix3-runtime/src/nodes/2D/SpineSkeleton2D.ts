import { Color } from 'three';

import { Node2D, type Node2DProps } from '../Node2D';
import type { PropertySchema } from '../../fw/property-schema';
import type { InstancePropertySchemaProvider } from '../../fw/property-schema-utils';
import {
  assignWithoutSchemaRefresh,
  installReactiveSchemaProperties,
} from '../../fw/reactive-schema-properties';
import { coerceTextureResource, type TextureResourceRef } from '../../core/TextureResource';
import type { SpineAsset, SpineAssetRequest } from '../../core/spine/SpineAsset';
import {
  SpineSkeletonView,
  type SpinePlayOptions,
  type SpineQueueOptions,
  type SpineSetupBounds,
} from '../../core/spine/SpineSkeletonView';

export interface SpineSkeleton2DProps extends Omit<Node2DProps, 'type'> {
  /** `res://…/hero.json` or `res://…/hero.skel`. */
  skeletonPath?: string | null;
  /** `res://…/hero.atlas`. */
  atlasPath?: string | null;
  /** Single-page atlas override; normally the atlas names its own pages. */
  texture?: TextureResourceRef | string | null;
  animation?: string;
  loop?: boolean;
  isPlaying?: boolean;
  skin?: string;
  timeScale?: number;
  defaultMix?: number;
  color?: string;
  twoColorTint?: boolean;
  /** Free the node (`queueFree`) when a non-looping animation finishes. */
  freeOnFinish?: boolean;
  /** Animate in the editor viewport (edit mode) instead of showing one pose. */
  previewInEditor?: boolean;
}

/**
 * A Spine skeleton in the 2D layer.
 *
 * The node owns playback state and the property schema; the actual skeleton comes
 * from a {@link SpineAsset} handed in by the SceneLoader (`setSpineAsset`) — nodes
 * never fetch their own resources. The renderable side lives in
 * {@link SpineSkeletonView}, which the editor's viewport proxy instantiates too so
 * edit mode and play mode draw identically.
 *
 * Scripts drive it through {@link play}/{@link queue}/{@link stop} and read state
 * with {@link getAnimationNames}/{@link getCurrentAnimation}. Emitted signals:
 * `animation-started`, `animation-finished` (non-looping animation ended),
 * `animation-looped`, and `spine-event` for keyed animation events.
 */
export class SpineSkeleton2D extends Node2D implements InstancePropertySchemaProvider {
  skeletonPath: string | null;
  atlasPath: string | null;
  texture: TextureResourceRef | null;
  animation: string;
  loop: boolean;
  isPlaying: boolean;
  skin: string;
  timeScale: number;
  defaultMix: number;
  color: string;
  twoColorTint: boolean;
  freeOnFinish: boolean;
  previewInEditor: boolean;

  private asset: SpineAsset | null = null;
  private view: SpineSkeletonView | null = null;
  private readonly tintColor = new Color('#ffffff');
  private appliedOpacity = -1;
  private appliedTintHex = '';

  constructor(props: SpineSkeleton2DProps) {
    super(props, 'SpineSkeleton2D');

    this.skeletonPath = normalizePath(props.skeletonPath);
    this.atlasPath = normalizePath(props.atlasPath);
    this.texture = coerceTextureResource(props.texture ?? null);
    this.animation = typeof props.animation === 'string' ? props.animation.trim() : '';
    this.loop = props.loop ?? true;
    this.isPlaying = props.isPlaying ?? true;
    this.skin = typeof props.skin === 'string' ? props.skin.trim() : '';
    this.timeScale = props.timeScale ?? 1;
    this.defaultMix = Math.max(0, props.defaultMix ?? 0);
    this.color = props.color ?? '#ffffff';
    this.twoColorTint = props.twoColorTint ?? false;
    this.freeOnFinish = props.freeOnFinish ?? false;
    this.previewInEditor = props.previewInEditor ?? false;
    this.isContainer = false;

    this.tintColor.set(this.color);
    this.syncSerializedProperties();

    // Last: `spine.color = '#f00'` now reaches the private tintColor the per-frame applyTint
    // reads (a bare field write NEVER applied, not even later), and skin/animation/timeScale
    // writes hit the view. Every routed setValue tolerates a still-loading null view.
    installReactiveSchemaProperties(this, SpineSkeleton2D.getPropertySchema);
  }

  /** The three files this node needs, or null while any of them is unset. */
  getAssetRequest(): SpineAssetRequest | null {
    if (!this.skeletonPath || !this.atlasPath) {
      return null;
    }
    return {
      skeletonPath: this.skeletonPath,
      atlasPath: this.atlasPath,
      texturePath: this.texture?.url ?? null,
    };
  }

  /** Convenience accessor for the page-image override path. */
  get texturePath(): string | null {
    return this.texture?.url ?? null;
  }

  set texturePath(value: string | null) {
    this.texture = coerceTextureResource(value);
  }

  /** True once a skeleton has been loaded into this node. */
  get isLoaded(): boolean {
    return this.view !== null;
  }

  /**
   * Installs (or clears) the loaded skeleton. Called by the SceneLoader after the
   * asset resolves and again whenever the authored paths change. Rebuilds the
   * renderable view and re-applies the authored animation/skin/mix/tint.
   */
  setSpineAsset(asset: SpineAsset | null): void {
    if (this.view) {
      this.remove(this.view.object);
      this.view.dispose();
      this.view = null;
    }
    this.asset = asset;
    this.appliedOpacity = -1;
    this.appliedTintHex = '';

    if (!asset) {
      return;
    }

    this.view = new SpineSkeletonView({
      asset,
      twoColorTint: this.twoColorTint,
      onStarted: (name, trackIndex) => this.emit('animation-started', name, trackIndex),
      onLooped: (name, trackIndex) => this.emit('animation-looped', name, trackIndex),
      onFinished: (name, trackIndex) => {
        this.isPlaying = false;
        this.properties.isPlaying = false;
        this.emit('animation-finished', name, trackIndex);
        if (this.freeOnFinish) {
          this.queueFree();
        }
      },
      onEvent: (name, payload, trackIndex) => this.emit('spine-event', name, payload, trackIndex),
    });

    this.view.setDefaultMix(this.defaultMix);
    this.view.setTimeScale(this.timeScale);
    if (this.skin) {
      this.view.setSkin(this.skin);
    }
    this.applyTint(true);
    this.applyAuthoredAnimation();
    this.add(this.view.object);
  }

  /** The renderable view, or null before the asset loads. */
  getView(): SpineSkeletonView | null {
    return this.view;
  }

  /** Animation names from the loaded skeleton (empty before it loads). */
  getAnimationNames(): string[] {
    return this.view?.getAnimationNames() ?? [];
  }

  /** Skin names from the loaded skeleton (empty before it loads). */
  getSkinNames(): string[] {
    return this.view?.getSkinNames() ?? [];
  }

  /** Setup-pose AABB of the loaded skeleton, or null. */
  getSetupBounds(): SpineSetupBounds | null {
    return this.view?.getSetupBounds() ?? null;
  }

  /** The animation currently playing on a track. */
  getCurrentAnimation(trackIndex = 0): string | null {
    return this.view?.getCurrentAnimation(trackIndex) ?? null;
  }

  /**
   * Plays an animation. With no name the authored {@link animation} is (re)played.
   * Returns false when the skeleton is not loaded yet or the name is unknown.
   */
  play(animationName?: string, options: SpinePlayOptions = {}): boolean {
    const name = (animationName ?? this.animation).trim();
    if (!this.view || !name) {
      return false;
    }

    const started = this.view.play(name, { loop: options.loop ?? this.loop, ...options });
    if (!started) {
      console.warn(
        `[SpineSkeleton2D] Unknown animation "${name}" on node ${this.nodeId} ` +
          `(available: ${this.getAnimationNames().join(', ') || 'none'})`
      );
      return false;
    }

    if ((options.trackIndex ?? 0) === 0) {
      // The track is already playing with the CALLER's options. A plain assignment would re-enter the
      // schema refresh, which re-plays track 0 with the authored `{loop: this.loop}` and discards the
      // mix/offset the caller asked for — so record the name without re-running the refresh.
      assignWithoutSchemaRefresh(this, 'animation', name);
      this.properties.animation = name;
    }
    assignWithoutSchemaRefresh(this, 'isPlaying', true);
    this.properties.isPlaying = true;
    return true;
  }

  /** Queues an animation after whatever is already on the track. */
  queue(animationName: string, options: SpineQueueOptions = {}): boolean {
    if (!this.view) {
      return false;
    }
    return this.view.queue(animationName, { loop: options.loop ?? false, ...options });
  }

  /**
   * Stops playback. `mixDuration` mixes back to the setup pose instead of
   * snapping to it.
   */
  stop(options: { trackIndex?: number; mixDuration?: number } = {}): void {
    this.isPlaying = false;
    this.properties.isPlaying = false;
    this.view?.stop(options);
  }

  /**
   * Rewinds to the first frame of the current animation (setup pose when no
   * animation is set). Pose-only: it does not touch {@link isPlaying} or any
   * other authored property, so it is safe to call outside an operation — the
   * editor's "reset" affordance uses it as transient preview state.
   */
  resetToFirstFrame(trackIndex = 0): void {
    this.view?.rewind(trackIndex);
  }

  /** Pauses time advance while keeping the current pose. */
  pause(): void {
    this.isPlaying = false;
    this.properties.isPlaying = false;
  }

  /** Resumes time advance. */
  resume(): void {
    this.isPlaying = true;
    this.properties.isPlaying = true;
  }

  /** Applies a skin by name (empty string = the skeleton's default skin). */
  setSkin(skinName: string): boolean {
    const name = skinName.trim();
    if (this.view && !this.view.setSkin(name)) {
      console.warn(
        `[SpineSkeleton2D] Unknown skin "${name}" on node ${this.nodeId} ` +
          `(available: ${this.getSkinNames().join(', ') || 'none'})`
      );
      return false;
    }

    this.skin = name;
    if (name) {
      this.properties.skin = name;
    } else {
      delete this.properties.skin;
    }
    this.view?.refresh();
    return true;
  }

  /** Sets the crossfade duration between two animations, in seconds. */
  setMix(fromAnimation: string, toAnimation: string, seconds: number): void {
    this.view?.setMix(fromAnimation, toAnimation, seconds);
  }

  /** Playback speed multiplier (1 = authored speed). */
  setTimeScale(scale: number): void {
    this.timeScale = Number.isFinite(scale) ? scale : 1;
    this.properties.timeScale = this.timeScale;
    this.view?.setTimeScale(this.timeScale);
  }

  override tick(dt: number): void {
    super.tick(dt);

    if (!this.view) {
      return;
    }

    // Tint/alpha reach the batched vertex colors, which are rebuilt by update(),
    // so a change while paused still needs one geometry refresh to show up.
    const tintChanged = this.applyTint(false);
    if (this.isPlaying) {
      this.view.update(dt);
    } else if (tintChanged) {
      this.view.refresh();
    }
  }

  /**
   * Advances the skeleton by `dt` regardless of {@link isPlaying}. Used by the
   * editor's preview ticker, which drives the viewport proxy's own view.
   */
  advancePreview(dt: number): void {
    this.applyTint(false);
    this.view?.update(dt);
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = Node2D.getPropertySchema();
    return {
      ...baseSchema,
      nodeType: 'SpineSkeleton2D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'skeletonPath',
          type: 'string',
          ui: {
            label: 'Skeleton',
            description: 'Spine skeleton export (.json or .skel)',
            group: 'Spine',
            editor: 'file-resource',
            extensions: ['json', 'skel'],
          },
          getValue: node => (node as SpineSkeleton2D).skeletonPath ?? '',
          setValue: (node, value) => {
            const spine = node as SpineSkeleton2D;
            spine.skeletonPath = normalizePath(value as string | null);
            spine.syncSerializedProperties();
          },
        },
        {
          name: 'atlasPath',
          type: 'string',
          ui: {
            label: 'Atlas',
            description: 'Spine atlas export (.atlas)',
            group: 'Spine',
            editor: 'file-resource',
            extensions: ['atlas'],
          },
          getValue: node => (node as SpineSkeleton2D).atlasPath ?? '',
          setValue: (node, value) => {
            const spine = node as SpineSkeleton2D;
            spine.atlasPath = normalizePath(value as string | null);
            spine.syncSerializedProperties();
          },
        },
        {
          name: 'texture',
          type: 'object',
          ui: {
            label: 'Page Texture',
            description:
              'Optional override for a single-page atlas. Multi-page atlases always use the page names inside the .atlas file.',
            group: 'Spine',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: node => (node as SpineSkeleton2D).texture,
          setValue: (node, value) => {
            const spine = node as SpineSkeleton2D;
            spine.texture = coerceTextureResource(value);
            spine.syncSerializedProperties();
          },
        },
        {
          name: 'animation',
          type: 'string',
          ui: { label: 'Animation', group: 'Animation' },
          getValue: node => (node as SpineSkeleton2D).animation,
          setValue: (node, value) => {
            const spine = node as SpineSkeleton2D;
            const name = String(value ?? '').trim();
            spine.animation = name;
            if (name) {
              spine.properties.animation = name;
            } else {
              delete spine.properties.animation;
            }
            spine.applyAuthoredAnimation();
          },
        },
        {
          name: 'loop',
          type: 'boolean',
          ui: { label: 'Loop', group: 'Animation' },
          getValue: node => (node as SpineSkeleton2D).loop,
          setValue: (node, value) => {
            const spine = node as SpineSkeleton2D;
            spine.loop = Boolean(value);
            spine.properties.loop = spine.loop;
            spine.applyAuthoredAnimation();
          },
        },
        {
          name: 'isPlaying',
          type: 'boolean',
          ui: { label: 'Playing', group: 'Animation' },
          getValue: node => (node as SpineSkeleton2D).isPlaying,
          setValue: (node, value) => {
            const spine = node as SpineSkeleton2D;
            spine.isPlaying = Boolean(value);
            spine.properties.isPlaying = spine.isPlaying;
          },
        },
        {
          name: 'skin',
          type: 'string',
          ui: { label: 'Skin', group: 'Animation' },
          getValue: node => (node as SpineSkeleton2D).skin,
          setValue: (node, value) => {
            (node as SpineSkeleton2D).setSkin(String(value ?? ''));
          },
        },
        {
          name: 'timeScale',
          type: 'number',
          ui: { label: 'Time Scale', group: 'Animation', min: 0, step: 0.05 },
          getValue: node => (node as SpineSkeleton2D).timeScale,
          setValue: (node, value) => {
            (node as SpineSkeleton2D).setTimeScale(Number(value));
          },
        },
        {
          name: 'defaultMix',
          type: 'number',
          ui: {
            label: 'Default Mix',
            description: 'Crossfade duration between animations, in seconds',
            group: 'Animation',
            min: 0,
            step: 0.01,
            unit: 's',
          },
          getValue: node => (node as SpineSkeleton2D).defaultMix,
          setValue: (node, value) => {
            const spine = node as SpineSkeleton2D;
            spine.defaultMix = Math.max(0, Number(value) || 0);
            spine.properties.defaultMix = spine.defaultMix;
            spine.view?.setDefaultMix(spine.defaultMix);
          },
        },
        {
          name: 'freeOnFinish',
          type: 'boolean',
          ui: {
            label: 'Free on Finish',
            description: 'Destroy this node when a non-looping animation finishes',
            group: 'Animation',
          },
          getValue: node => (node as SpineSkeleton2D).freeOnFinish,
          setValue: (node, value) => {
            const spine = node as SpineSkeleton2D;
            spine.freeOnFinish = Boolean(value);
            if (spine.freeOnFinish) {
              spine.properties.freeOnFinish = true;
            } else {
              delete spine.properties.freeOnFinish;
            }
          },
        },
        {
          name: 'previewInEditor',
          type: 'boolean',
          ui: {
            label: 'Editor Preview',
            description:
              'Animate in the editor viewport instead of holding a single pose. Playback is off by default; Reset rewinds to the first frame.',
            group: 'Animation',
            editor: 'spine-preview',
          },
          getValue: node => (node as SpineSkeleton2D).previewInEditor,
          setValue: (node, value) => {
            const spine = node as SpineSkeleton2D;
            spine.previewInEditor = Boolean(value);
            if (spine.previewInEditor) {
              spine.properties.previewInEditor = true;
            } else {
              delete spine.properties.previewInEditor;
            }
          },
        },
        {
          name: 'color',
          type: 'color',
          ui: { label: 'Tint', group: 'Style' },
          getValue: node => (node as SpineSkeleton2D).color,
          setValue: (node, value) => {
            const spine = node as SpineSkeleton2D;
            spine.color = String(value ?? '#ffffff');
            spine.properties.color = spine.color;
            spine.tintColor.set(spine.color);
            spine.applyTint(true);
            spine.view?.refresh();
          },
        },
        {
          name: 'twoColorTint',
          type: 'boolean',
          ui: {
            label: 'Two Color Tint',
            description: 'Enable spine tint-black rendering (skeletons exported with dark tint)',
            group: 'Style',
          },
          getValue: node => (node as SpineSkeleton2D).twoColorTint,
          setValue: (node, value) => {
            const spine = node as SpineSkeleton2D;
            const next = Boolean(value);
            if (next === spine.twoColorTint) {
              return;
            }
            spine.twoColorTint = next;
            if (next) {
              spine.properties.twoColorTint = true;
            } else {
              delete spine.properties.twoColorTint;
            }
            // The flag is baked into the mesh's materials at construction.
            spine.setSpineAsset(spine.asset);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Spine: { label: 'Spine', expanded: true },
        Animation: { label: 'Animation', expanded: true },
        Style: { label: 'Style', expanded: true },
      },
    };
  }

  /**
   * Per-instance schema: once the skeleton is loaded, `animation` and `skin`
   * become dropdowns of the names the skeleton actually declares. Before that
   * they stay plain text fields (from the static schema) so an authored name
   * survives a missing/unloaded asset.
   */
  getInstancePropertySchema(): PropertySchema | null {
    if (!this.view) {
      return null;
    }

    const animations = this.getAnimationNames();
    const skins = this.getSkinNames();
    if (animations.length === 0 && skins.length === 0) {
      return null;
    }

    const properties: PropertySchema['properties'] = [];
    if (animations.length > 0) {
      properties.push({
        name: 'animation',
        type: 'select',
        ui: { label: 'Animation', group: 'Animation', options: ['', ...animations] },
        getValue: node => (node as SpineSkeleton2D).animation,
        setValue: (node, value) => {
          const spine = node as SpineSkeleton2D;
          const name = String(value ?? '').trim();
          spine.animation = name;
          if (name) {
            spine.properties.animation = name;
          } else {
            delete spine.properties.animation;
          }
          spine.applyAuthoredAnimation();
        },
      });
    }
    if (skins.length > 0) {
      properties.push({
        name: 'skin',
        type: 'select',
        ui: { label: 'Skin', group: 'Animation', options: ['', ...skins] },
        getValue: node => (node as SpineSkeleton2D).skin,
        setValue: (node, value) => {
          (node as SpineSkeleton2D).setSkin(String(value ?? ''));
        },
      });
    }

    return { nodeType: 'SpineSkeleton2D', properties };
  }

  protected override disposeResources(): void {
    if (this.view) {
      this.view.dispose();
      this.view = null;
    }
    // The SpineAsset (skeleton data + atlas page textures) is shared through the
    // AssetLoader cache and must NOT be disposed here.
    this.asset = null;
  }

  /** Starts (or restarts) the authored animation on track 0. */
  private applyAuthoredAnimation(): void {
    if (!this.view) {
      return;
    }

    if (!this.animation) {
      this.view.stop();
      return;
    }

    if (!this.view.play(this.animation, { loop: this.loop })) {
      console.warn(
        `[SpineSkeleton2D] Unknown animation "${this.animation}" on node ${this.nodeId} ` +
          `(available: ${this.getAnimationNames().join(', ') || 'none'})`
      );
      return;
    }

    // Land the first pose immediately: the editor does not tick, and play mode
    // would otherwise show the setup pose for one frame.
    this.view.refresh();
  }

  /**
   * Pushes tint + inherited opacity into the skeleton color. Returns true when
   * anything actually changed (so a paused view knows it must rebuild geometry).
   */
  private applyTint(force: boolean): boolean {
    if (!this.view) {
      return false;
    }

    const opacity = this.computedOpacity;
    if (!force && this.appliedOpacity === opacity && this.appliedTintHex === this.color) {
      return false;
    }

    this.appliedOpacity = opacity;
    this.appliedTintHex = this.color;
    this.view.setTint({ r: this.tintColor.r, g: this.tintColor.g, b: this.tintColor.b }, opacity);
    return true;
  }

  /**
   * Mirrors authored values into `properties`, the record the prefab-override
   * diff and the scene saver read. Only non-defaults are stored.
   */
  private syncSerializedProperties(): void {
    if (this.skeletonPath) {
      this.properties.skeletonPath = this.skeletonPath;
    } else {
      delete this.properties.skeletonPath;
    }

    if (this.atlasPath) {
      this.properties.atlasPath = this.atlasPath;
    } else {
      delete this.properties.atlasPath;
    }

    if (this.texture) {
      this.properties.texture = { ...this.texture };
    } else {
      delete this.properties.texture;
    }

    if (this.animation) {
      this.properties.animation = this.animation;
    } else {
      delete this.properties.animation;
    }

    if (this.skin) {
      this.properties.skin = this.skin;
    } else {
      delete this.properties.skin;
    }

    this.properties.loop = this.loop;
    this.properties.isPlaying = this.isPlaying;
    this.properties.timeScale = this.timeScale;
    this.properties.defaultMix = this.defaultMix;
    this.properties.color = this.color;

    if (this.twoColorTint) {
      this.properties.twoColorTint = true;
    } else {
      delete this.properties.twoColorTint;
    }

    if (this.freeOnFinish) {
      this.properties.freeOnFinish = true;
    } else {
      delete this.properties.freeOnFinish;
    }

    if (this.previewInEditor) {
      this.properties.previewInEditor = true;
    } else {
      delete this.properties.previewInEditor;
    }
  }
}

function normalizePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
