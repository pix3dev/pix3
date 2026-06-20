import { Mesh, MeshBasicMaterial, PlaneGeometry, Texture } from 'three';
import { Node2D, type Node2DProps } from '../Node2D';
import { configure2DTexture } from '../../core/configure-2d-texture';
import type { PropertySchema } from '../../fw/property-schema';
import {
  findAnimationClip,
  getAnimationFrameTexturePath,
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
}

export class AnimatedSprite2D extends Node2D {
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
  private geometry: PlaneGeometry;
  private material: MeshBasicMaterial;

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

    this.geometry = new PlaneGeometry(this.width, this.height);
    this.material = new MeshBasicMaterial({
      color: this.color,
      transparent: true,
      depthTest: false,
    });
    this.registerOpacityMaterial(this.material, 1);

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = `${this.name}-Mesh`;
    this.add(this.mesh);
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

      const nextFrame = this.getNextFrameIndex(clip);

      this.currentFrame = nextFrame;

      if (!this.isPlaying) {
        this.timeAccumulator = 0;
        break;
      }
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
            sprite.updateGeometry();
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
            sprite.updateGeometry();
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

      if (usesSequenceTexture) {
        texture.offset.set(0, 0);
        texture.repeat.set(1, 1);
      } else if (currentFrame) {
        texture.offset.set(currentFrame.offset.x, currentFrame.offset.y);
        texture.repeat.set(currentFrame.repeat.x, currentFrame.repeat.y);
      } else {
        texture.offset.set(0, 0);
        texture.repeat.set(1, 1);
      }

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
    return nextTexture;
  }

  private updateGeometry(): void {
    this.geometry.dispose();
    this.geometry = new PlaneGeometry(this.width, this.height);
    this.mesh.geometry = this.geometry;
  }

  dispose(): void {
    this.geometry.dispose();
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
