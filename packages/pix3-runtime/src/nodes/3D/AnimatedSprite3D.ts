import { Mesh, MeshBasicMaterial, PlaneGeometry, Texture, DoubleSide, Quaternion } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import {
  coerceTextureResource,
  type TextureResourceRef,
} from '../../core/TextureResource';
import { FrameSequencePlayer } from '../../core/FrameSequencePlayer';

export interface AnimatedSprite3DProps extends Omit<Node3DProps, 'type'> {
  frames?: (TextureResourceRef | null)[];
  width?: number;
  height?: number;
  color?: string;
  fps?: number;
  playing?: boolean;
  loop?: boolean;
  /** Free the node (`queueFree`) when a non-looping sequence finishes. */
  freeOnFinish?: boolean;
  billboard?: boolean;
}

export class AnimatedSprite3D extends Node3D {
  frames: (TextureResourceRef | null)[];
  width: number;
  height: number;
  color: string;
  fps: number;
  playing: boolean;
  loop: boolean;
  freeOnFinish: boolean;
  billboard: boolean;

  private _currentFrame: number = 0;
  private readonly frameSequencePlayer = new FrameSequencePlayer();

  private mesh: Mesh;
  private geometry: PlaneGeometry;
  private material: MeshBasicMaterial;
  private loadedTextures: (Texture | null)[] = [];
  private billboardPivot: Mesh;

  private static readonly tempWorldQuaternion = new Quaternion();
  private static readonly tempLocalQuaternion = new Quaternion();

  constructor(props: AnimatedSprite3DProps) {
    super(props, 'AnimatedSprite3D');
    this.frames = (props.frames || []).map(coerceTextureResource);
    this.width = props.width ?? 1;
    this.height = props.height ?? 1;
    this.color = props.color ?? '#ffffff';
    this.fps = props.fps ?? 10;
    this.playing = props.playing ?? true;
    this.loop = props.loop ?? true;
    this.freeOnFinish = props.freeOnFinish ?? false;
    this.billboard = props.billboard ?? true;

    this.geometry = new PlaneGeometry(this.width, this.height);
    this.material = new MeshBasicMaterial({
      color: this.color,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = `${this.name}-Mesh`;
    this.billboardPivot = this.mesh;
    this.add(this.billboardPivot);

    // Drive the sprite material's alpha from the node opacity / fade APIs.
    this.registerOpacityMaterial(this.material);
  }

  get currentFrame(): number {
    return this._currentFrame;
  }

  set currentFrame(value: number) {
    if (this.frames.length === 0) {
      this._currentFrame = 0;
      return;
    }
    this._currentFrame = Math.max(0, Math.min(value, this.frames.length - 1));
    this.updateTexture();
  }

  setTextureForFrame(index: number, texture: Texture | null): void {
    this.loadedTextures[index] = texture;
    if (index === this._currentFrame) {
      this.updateTexture();
    }
  }

  private updateTexture(): void {
    const tex = this.loadedTextures[this._currentFrame];
    if (tex) {
      if ('colorSpace' in tex) {
        (tex as any).colorSpace = 'srgb';
      } else if ('encoding' in tex) {
        (tex as any).encoding = 3001;
      }
      this.material.map = tex;
      this.material.color.set('#ffffff');
    } else {
      this.material.map = null;
      this.material.color.set(this.color);
    }
    this.material.needsUpdate = true;
  }

  applyBillboard(cameraQuaternion: Quaternion): void {
    if (!this.billboard) {
      this.billboardPivot.quaternion.identity();
      return;
    }

    this.getWorldQuaternion(AnimatedSprite3D.tempWorldQuaternion);

    AnimatedSprite3D.tempLocalQuaternion
      .copy(AnimatedSprite3D.tempWorldQuaternion)
      .invert()
      .multiply(cameraQuaternion);

    this.billboardPivot.quaternion.copy(AnimatedSprite3D.tempLocalQuaternion);
  }

  tick(dt: number): void {
    super.tick(dt);

    if (!this.playing || this.frames.length <= 1 || this.fps <= 0) return;

    const result = this.frameSequencePlayer.advance(
      dt,
      {
        frameCount: this.frames.length,
        fps: this.fps,
        loop: this.loop,
        playbackMode: 'linear',
      },
      this._currentFrame
    );

    // 3D has no per-frame events, so only the final landed frame matters
    // visually — apply just `nextIndex` instead of every intermediate index in
    // `framesAdvanced`, even though a large `dt` may have crossed several.
    if (result.framesAdvanced.length > 0) {
      this.currentFrame = result.nextIndex; // setter clamps + updates texture
    }

    if (result.finished) {
      // The node owns the `playing` flag; flip it off on the non-loop end.
      this.playing = false;
      // One-shot end: fire once on the transition (no args, unlike 2D). VFX can
      // self-free via the `freeOnFinish` flag below or a `core:FreeOnSignal`.
      this.emit('animation-finished');
      if (this.freeOnFinish) {
        this.queueFree();
      }
    }
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = Node3D.getPropertySchema();
    return {
      ...baseSchema,
      nodeType: 'AnimatedSprite3D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'width',
          type: 'number',
          ui: { label: 'Width', group: 'Size', min: 0, step: 0.1 },
          getValue: (node: unknown) => (node as AnimatedSprite3D).width,
          setValue: (node: unknown, value: unknown) => {
            const n = node as AnimatedSprite3D;
            n.width = Number(value);
            n.updateGeometry();
          },
        },
        {
          name: 'height',
          type: 'number',
          ui: { label: 'Height', group: 'Size', min: 0, step: 0.1 },
          getValue: (node: unknown) => (node as AnimatedSprite3D).height,
          setValue: (node: unknown, value: unknown) => {
            const n = node as AnimatedSprite3D;
            n.height = Number(value);
            n.updateGeometry();
          },
        },
        {
          name: 'color',
          type: 'color',
          ui: { label: 'Color', group: 'Style' },
          getValue: (node: unknown) => (node as AnimatedSprite3D).color,
          setValue: (node: unknown, value: unknown) => {
            const n = node as AnimatedSprite3D;
            n.color = String(value);
            n.updateTexture();
          },
        },
        {
          name: 'fps',
          type: 'number',
          ui: { label: 'FPS', group: 'Animation', min: 1, step: 1 },
          getValue: (node: unknown) => (node as AnimatedSprite3D).fps,
          setValue: (node: unknown, value: unknown) => {
            (node as AnimatedSprite3D).fps = Number(value);
          },
        },
        {
          name: 'playing',
          type: 'boolean',
          ui: { label: 'Playing', group: 'Animation' },
          getValue: (node: unknown) => (node as AnimatedSprite3D).playing,
          setValue: (node: unknown, value: unknown) => {
            (node as AnimatedSprite3D).playing = Boolean(value);
          },
        },
        {
          name: 'loop',
          type: 'boolean',
          ui: { label: 'Loop', group: 'Animation' },
          getValue: (node: unknown) => (node as AnimatedSprite3D).loop,
          setValue: (node: unknown, value: unknown) => {
            (node as AnimatedSprite3D).loop = Boolean(value);
          },
        },
        {
          name: 'freeOnFinish',
          type: 'boolean',
          ui: {
            label: 'Free on Finish',
            description: 'Destroy this node when a non-looping sequence finishes (one-shot VFX)',
            group: 'Animation',
          },
          getValue: (node: unknown) => (node as AnimatedSprite3D).freeOnFinish,
          setValue: (node: unknown, value: unknown) => {
            (node as AnimatedSprite3D).freeOnFinish = Boolean(value);
          },
        },
        {
          name: 'currentFrame',
          type: 'number',
          ui: { label: 'Current Frame', group: 'Animation', min: 0, step: 1 },
          getValue: (node: unknown) => (node as AnimatedSprite3D).currentFrame,
          setValue: (node: unknown, value: unknown) => {
            (node as AnimatedSprite3D).currentFrame = Number(value);
          },
        },
        {
          name: 'billboard',
          type: 'boolean',
          ui: { label: 'Billboard', group: 'Style' },
          getValue: (node: unknown) => (node as AnimatedSprite3D).billboard,
          setValue: (node: unknown, value: unknown) => {
            (node as AnimatedSprite3D).billboard = Boolean(value);
          },
        },
        {
          name: 'opacity',
          type: 'number',
          ui: {
            label: 'Opacity',
            description: 'Sprite opacity (use show()/hide() to fade at runtime)',
            group: 'Style',
            step: 0.01,
            precision: 2,
            min: 0,
            max: 1,
          },
          getValue: (node: unknown) => (node as AnimatedSprite3D).opacity,
          setValue: (node: unknown, value: unknown) => {
            (node as AnimatedSprite3D).opacity = Number(value);
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

  private updateGeometry(): void {
    this.geometry.dispose();
    this.geometry = new PlaneGeometry(this.width, this.height);
    this.mesh.geometry = this.geometry;
  }

  protected override disposeResources(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
