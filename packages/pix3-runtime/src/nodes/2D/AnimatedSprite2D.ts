import { Mesh, MeshBasicMaterial, Texture } from 'three';
import { Node2D, type Node2DProps } from '../Node2D';
import { configure2DTexture } from '../../core/configure-2d-texture';
import { SHARED_UNIT_QUAD_GEOMETRY } from '../../core/shared-quad-geometry';
import {
  applyTextureRegionToTexture,
  composeTextureRegion,
  type TextureRegion,
} from '../../core/texture-region';
import { baseRegionOf, copyAtlasMetadata } from '../../core/atlas-frame-map';
import { BATCHABLE_2D_KEY } from '../../core/batch-2d';
import { parseEventArgs } from '../../core/parse-event-args';
import type { PropertySchema } from '../../fw/property-schema';
import type { InstancePropertySchemaProvider } from '../../fw/property-schema-utils';
import {
  ShaderEffectStack,
  type ShaderEffectEntry,
  type ShaderEffectHost,
} from '../../shader-effects/ShaderEffectStack';
import type { AttachedShaderEffect } from '../../shader-effects/shader-effect-types';
import {
  findAnimationClip,
  isSequenceAnimationFrame,
  type AnimationClip,
  type AnimationFrame,
  type AnimationResource,
} from '../../core/AnimationResource';

export interface AnimatedSprite2DProps extends Omit<Node2DProps, 'type'> {
  animationResourcePath?: string | null;
  currentClip?: string;
  isPlaying?: boolean;
  currentFrame?: number;
  width?: number;
  height?: number;
  color?: string;
  /** Registry-backed shader effects attached to this sprite's material. */
  effects?: ShaderEffectEntry[];
}

export class AnimatedSprite2D
  extends Node2D
  implements InstancePropertySchemaProvider, ShaderEffectHost
{
  animationResourcePath: string | null;
  currentClip: string;
  isPlaying: boolean;
  width: number;
  height: number;
  color: string;

  private _currentFrame: number;
  private timeAccumulator = 0;
  private playbackDirection = 1;
  private animationResource: AnimationResource | null = null;
  private activeClip: AnimationClip | null = null;
  private spritesheetTexture: Texture | null = null;
  private readonly frameTextures = new Map<number, Texture>();

  private mesh: Mesh;
  private material: MeshBasicMaterial;
  /** Registry-backed shader effects; while non-empty the mesh opts out of the
   * 2D quad batcher so its effected material is used directly (see Sprite2D). */
  private readonly effectStack: ShaderEffectStack;

  constructor(props: AnimatedSprite2DProps) {
    super(props, 'AnimatedSprite2D');

    this.animationResourcePath =
      typeof props.animationResourcePath === 'string' && props.animationResourcePath.trim().length > 0
        ? props.animationResourcePath.trim()
        : null;
    this.currentClip = typeof props.currentClip === 'string' ? props.currentClip.trim() : '';
    this.isPlaying = props.isPlaying ?? true;
    this.width = props.width ?? 64;
    this.height = props.height ?? 64;
    this.color = props.color ?? '#ffffff';
    this._currentFrame = Math.max(0, Math.floor(props.currentFrame ?? 0));
    this.isContainer = false;

    if (this.animationResourcePath) {
      this.properties.animationResourcePath = this.animationResourcePath;
    }
    if (this.currentClip) {
      this.properties.currentClip = this.currentClip;
    }
    this.properties.isPlaying = this.isPlaying;
    this.properties.currentFrame = this._currentFrame;

    this.material = new MeshBasicMaterial({
      color: this.color,
      transparent: true,
      depthTest: false,
    });
    this.registerOpacityMaterial(this.material, 1);

    // Size is mesh.scale over the shared unit quad (see SHARED_UNIT_QUAD_GEOMETRY).
    this.mesh = new Mesh(SHARED_UNIT_QUAD_GEOMETRY, this.material);
    this.mesh.name = `${this.name}-Mesh`;
    this.mesh.scale.set(this.width, this.height, 1);
    this.mesh.userData[BATCHABLE_2D_KEY] = true;
    this.add(this.mesh);

    // Shader effects: install before attaching, then attach authored entries.
    this.effectStack = new ShaderEffectStack({
      nodeType: 'AnimatedSprite2D',
      target: 'basic',
      onAttachmentsChanged: () => {
        this.mesh.userData[BATCHABLE_2D_KEY] = this.effectStack.isEmpty;
      },
    });
    this.effectStack.install(this.material);
    const effectEntries = props.effects ?? (this.properties.effects as ShaderEffectEntry[] | undefined);
    for (const entry of effectEntries ?? []) {
      if (entry && typeof entry.type === 'string') {
        this.effectStack.attach(entry.type, { enabled: entry.enabled, params: entry.params });
      }
    }
  }

  /** The shader-effect stack driving this sprite's material. */
  getShaderEffectStack(): ShaderEffectStack {
    return this.effectStack;
  }

  /** Per-instance schema contribution: the attached effects' `fx.*` params. */
  getInstancePropertySchema(): PropertySchema | null {
    return this.effectStack.buildInstanceSchema();
  }

  /** Attach a shader effect by registry id (e.g. `core:adjust`). */
  attachEffect(
    type: string,
    init?: { enabled?: boolean; params?: Record<string, unknown> }
  ): boolean {
    return this.effectStack.attach(type, init);
  }

  /** Detach an effect by type. Returns the removed attachment or null. */
  detachEffect(type: string): AttachedShaderEffect | null {
    return this.effectStack.detach(type);
  }

  /** Enable/disable an attached effect. */
  setEffectEnabled(type: string, on: boolean): void {
    this.effectStack.setEnabled(type, on);
  }

  /** Set one param on an attached effect (by registry id or short key). */
  setEffectParam(typeOrKey: string, param: string, value: unknown): boolean {
    return this.effectStack.setParam(typeOrKey, param, value);
  }

  /** The attached effects, in composition order (read-only view). */
  getAttachedEffects(): readonly AttachedShaderEffect[] {
    return this.effectStack.getAttached();
  }

  get currentFrame(): number {
    return this._currentFrame;
  }

  set currentFrame(value: number) {
    const normalized = Math.max(0, Math.floor(value));
    const frameCount = this.activeClip?.frames.length ?? 0;
    this._currentFrame = frameCount > 0 ? Math.min(normalized, frameCount - 1) : normalized;
    this.properties.currentFrame = this._currentFrame;
    this.refreshTexturePresentation();
  }

  setAnimationResource(resource: AnimationResource | null): void {
    this.animationResource = resource;
    this.syncActiveClip(false);
  }

  setFrameTexture(frameIndex: number, texture: Texture | null): void {
    const normalizedIndex = Math.max(0, Math.floor(frameIndex));
    const previousTexture = this.frameTextures.get(normalizedIndex);
    if (previousTexture) {
      previousTexture.dispose();
      this.frameTextures.delete(normalizedIndex);
    }

    if (texture) {
      this.frameTextures.set(normalizedIndex, this.cloneTexture(texture));
    }

    if (normalizedIndex === this._currentFrame) {
      this.refreshTexturePresentation();
    }
  }

  setSpritesheetTexture(texture: Texture | null): void {
    if (this.spritesheetTexture) {
      this.spritesheetTexture.dispose();
      this.spritesheetTexture = null;
    }

    if (texture) {
      this.spritesheetTexture = this.cloneTexture(texture);
    }

    this.refreshTexturePresentation();
  }

  tick(dt: number): void {
    super.tick(dt);
    this.effectStack.tick(dt);

    const clip = this.activeClip;
    if (!this.isPlaying || !clip || clip.frames.length <= 1 || clip.fps <= 0) {
      return;
    }

    this.timeAccumulator += dt;

    while (true) {
      const activeFrame = this.getCurrentFrameData();
      const frameDuration = Math.max(
        0.001,
        (1 / clip.fps) * (activeFrame?.durationMultiplier ?? 1)
      );
      if (this.timeAccumulator < frameDuration) {
        break;
      }

      this.timeAccumulator -= frameDuration;

      const prevFrame = this._currentFrame;
      const nextFrame = this.getNextFrameIndex(clip);

      this.currentFrame = nextFrame;

      // Fire per-frame events only on a real play-driven advance — never from the
      // currentFrame setter, which the inspector scrub / syncActiveClip / editor
      // proxy also call and would spuriously fire.
      if (this._currentFrame !== prevFrame) {
        this.emitFrameEvents(this._currentFrame);
      }

      if (!this.isPlaying) {
        this.timeAccumulator = 0;
        break;
      }
    }
  }

  private emitFrameEvents(frameIndex: number): void {
    const frame = this.activeClip?.frames[frameIndex];
    if (!frame || !frame.events || frame.events.length === 0) {
      return;
    }
    for (const event of frame.events) {
      if (event.signal.length === 0) {
        continue;
      }
      this.emit(event.signal, ...parseEventArgs(event.args));
    }
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = Node2D.getPropertySchema();
    return {
      ...baseSchema,
      nodeType: 'AnimatedSprite2D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'width',
          type: 'number',
          ui: { label: 'Width', group: 'Size', min: 0, step: 1 },
          getValue: (node: unknown) => (node as AnimatedSprite2D).width,
          setValue: (node: unknown, value: unknown) => {
            const sprite = node as AnimatedSprite2D;
            sprite.width = Number(value);
            sprite.updateSize();
          },
        },
        {
          name: 'height',
          type: 'number',
          ui: { label: 'Height', group: 'Size', min: 0, step: 1 },
          getValue: (node: unknown) => (node as AnimatedSprite2D).height,
          setValue: (node: unknown, value: unknown) => {
            const sprite = node as AnimatedSprite2D;
            sprite.height = Number(value);
            sprite.updateSize();
          },
        },
        {
          name: 'color',
          type: 'color',
          ui: { label: 'Color', group: 'Style' },
          getValue: (node: unknown) => (node as AnimatedSprite2D).color,
          setValue: (node: unknown, value: unknown) => {
            const sprite = node as AnimatedSprite2D;
            sprite.color = String(value);
            sprite.refreshTexturePresentation();
          },
        },
        {
          name: 'animationResourcePath',
          type: 'string',
          ui: { label: 'Animation Asset', group: 'Animation', editor: 'animation-resource' },
          getValue: (node: unknown) => (node as AnimatedSprite2D).animationResourcePath ?? '',
          setValue: (node: unknown, value: unknown) => {
            const sprite = node as AnimatedSprite2D;
            const nextPath = String(value ?? '').trim();
            sprite.animationResourcePath = nextPath || null;
            if (sprite.animationResourcePath) {
              sprite.properties.animationResourcePath = sprite.animationResourcePath;
            } else {
              delete sprite.properties.animationResourcePath;
            }
          },
        },
        {
          name: 'currentClip',
          type: 'string',
          ui: { label: 'Clip', group: 'Animation' },
          getValue: (node: unknown) => (node as AnimatedSprite2D).currentClip,
          setValue: (node: unknown, value: unknown) => {
            const sprite = node as AnimatedSprite2D;
            sprite.currentClip = String(value ?? '').trim();
            if (sprite.currentClip) {
              sprite.properties.currentClip = sprite.currentClip;
            } else {
              delete sprite.properties.currentClip;
            }
            sprite.syncActiveClip(true);
          },
        },
        {
          name: 'isPlaying',
          type: 'boolean',
          ui: { label: 'Playing', group: 'Animation' },
          getValue: (node: unknown) => (node as AnimatedSprite2D).isPlaying,
          setValue: (node: unknown, value: unknown) => {
            const sprite = node as AnimatedSprite2D;
            sprite.isPlaying = Boolean(value);
            sprite.properties.isPlaying = sprite.isPlaying;
          },
        },
        {
          name: 'currentFrame',
          type: 'number',
          ui: { label: 'Current Frame', group: 'Animation', min: 0, step: 1 },
          getValue: (node: unknown) => (node as AnimatedSprite2D).currentFrame,
          setValue: (node: unknown, value: unknown) => {
            (node as AnimatedSprite2D).currentFrame = Number(value);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Size: { label: 'Size', expanded: true },
        Style: { label: 'Style', expanded: true },
        Animation: { label: 'Animation', expanded: true },
      },
    };
  }

  private getCurrentFrameData(): AnimationFrame | null {
    const frames = this.activeClip?.frames ?? [];
    if (frames.length === 0) {
      return null;
    }

    return frames[this._currentFrame] ?? null;
  }

  private refreshTexturePresentation(): void {
    const currentFrame = this.getCurrentFrameData();
    const frameTexture = currentFrame ? this.frameTextures.get(this._currentFrame) ?? null : null;
    const usesSequenceTexture = isSequenceAnimationFrame(currentFrame) && Boolean(frameTexture);
    const texture = usesSequenceTexture ? frameTexture : this.spritesheetTexture;

    if (texture) {
      if (this.material.map !== texture) {
        this.material.map = texture;
        this.material.needsUpdate = true;
      }

      // Compose the frame's local UV rect against the texture's atlas frame (if
      // it is an atlas view) so the sampled subrect lands inside the packed
      // frame. A sequence frame or the no-frame fallback used to reset to
      // (0,0)/(1,1) — which would erase the atlas region — so they now resolve to
      // the base frame region (null localRegion → base). baseRegionOf is null for
      // a non-atlased texture, giving the original absolute behavior.
      const baseRegion = baseRegionOf(texture);
      let localRegion: TextureRegion | null = null;
      if (!usesSequenceTexture && currentFrame) {
        localRegion = {
          x: currentFrame.offset.x,
          y: currentFrame.offset.y,
          width: currentFrame.repeat.x,
          height: currentFrame.repeat.y,
        };
      }
      applyTextureRegionToTexture(texture, composeTextureRegion(baseRegion, localRegion));

      this.material.color.set('#ffffff');
    } else {
      if (this.material.map) {
        this.material.map = null;
        this.material.needsUpdate = true;
      }

      this.material.color.set(this.color);
    }
  }

  private syncActiveClip(resetFrame: boolean): void {
    const previousClipName = this.activeClip?.name ?? null;
    this.activeClip = findAnimationClip(this.animationResource, this.currentClip);

    const resolvedClipName = this.activeClip?.name ?? this.currentClip;
    if (resolvedClipName !== this.currentClip) {
      this.currentClip = resolvedClipName;
      if (resolvedClipName) {
        this.properties.currentClip = resolvedClipName;
      } else {
        delete this.properties.currentClip;
      }
    }

    if (resetFrame && previousClipName !== this.activeClip?.name) {
      this._currentFrame = 0;
      this.properties.currentFrame = this._currentFrame;
      this.timeAccumulator = 0;
      this.playbackDirection = 1;
    }

    const frameCount = this.activeClip?.frames.length ?? 0;
    if (frameCount > 0) {
      this._currentFrame = Math.max(0, Math.min(this._currentFrame, frameCount - 1));
      this.properties.currentFrame = this._currentFrame;
    } else {
      this._currentFrame = Math.max(0, this._currentFrame);
      this.properties.currentFrame = this._currentFrame;
      this.timeAccumulator = 0;
      this.playbackDirection = 1;
    }

    this.refreshTexturePresentation();
  }

  private getNextFrameIndex(clip: AnimationClip): number {
    if (clip.playbackMode === 'ping-pong' && clip.frames.length > 1) {
      let nextFrame = this._currentFrame + this.playbackDirection;
      if (nextFrame >= clip.frames.length) {
        if (!clip.loop) {
          this.isPlaying = false;
          this.properties.isPlaying = false;
          return clip.frames.length - 1;
        }

        this.playbackDirection = -1;
        nextFrame = Math.max(0, clip.frames.length - 2);
      } else if (nextFrame < 0) {
        if (!clip.loop) {
          this.isPlaying = false;
          this.properties.isPlaying = false;
          return 0;
        }

        this.playbackDirection = 1;
        nextFrame = Math.min(clip.frames.length - 1, 1);
      }

      return nextFrame;
    }

    const nextFrame = this._currentFrame + 1;
    if (nextFrame < clip.frames.length) {
      return nextFrame;
    }

    if (clip.loop) {
      return 0;
    }

    this.isPlaying = false;
    this.properties.isPlaying = false;
    return clip.frames.length - 1;
  }

  private cloneTexture(texture: Texture): Texture {
    const nextTexture = texture.clone();
    // sRGB + mipmaps disabled (see configure2DTexture for the why).
    configure2DTexture(nextTexture);
    // Re-stamp atlas metadata explicitly — Texture.copy's userData handling
    // varies across three versions — so per-frame region composition can find
    // the packed frame region on this per-node clone.
    copyAtlasMetadata(texture, nextTexture);
    return nextTexture;
  }

  private updateSize(): void {
    // Size is mesh.scale over the shared unit quad — no geometry churn on resize.
    this.mesh.scale.set(this.width, this.height, 1);
  }

  protected override disposeResources(): void {
    // The geometry is the shared unit quad and must NOT be disposed here.
    if (this.spritesheetTexture) {
      this.spritesheetTexture.dispose();
      this.spritesheetTexture = null;
    }
    for (const texture of this.frameTextures.values()) {
      texture.dispose();
    }
    this.frameTextures.clear();
    this.material.dispose();
  }
}
