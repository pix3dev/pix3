import {
  DoubleSide,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Texture,
} from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import {
  coerceTextureResource,
  type TextureResourceRef,
} from '../../core/TextureResource';

export interface Sprite3DProps extends Omit<Node3DProps, 'type'> {
  texture?: TextureResourceRef | null;
  texturePath?: string | null;
  width?: number;
  height?: number;
  color?: string;
  billboard?: boolean;
  billboardRoll?: number;
  textureAspectRatio?: number | null;
  aspectRatioLocked?: boolean;
}

export class Sprite3D extends Node3D {
  texture: TextureResourceRef | null;
  width: number;
  height: number;
  color: string;
  billboard: boolean;
  billboardRoll: number;
  /** Stored aspect ratio of the original texture (width / height), null if unknown. */
  textureAspectRatio: number | null;
  /** If true, height changes proportionally when width is modified and vice versa. */
  aspectRatioLocked: boolean;
  /** Original width (from texture). Used to reset to natural size. */
  originalWidth: number | null;
  /** Original height (from texture). Used to reset to natural size. */
  originalHeight: number | null;

  private mesh: Mesh;
  private geometry: PlaneGeometry;
  private material: MeshBasicMaterial;
  private billboardPivot: Mesh;

  private static readonly tempWorldQuaternion = new Quaternion();
  private static readonly tempLocalQuaternion = new Quaternion();

  constructor(props: Sprite3DProps) {
    super(props, 'Sprite3D');

    this.texture = coerceTextureResource(props.texture ?? props.texturePath ?? null);
    this.width = typeof props.width === 'number' && props.width > 0 ? props.width : 1;
    this.height = typeof props.height === 'number' && props.height > 0 ? props.height : 1;
    this.color = props.color ?? '#ffffff';
    this.billboard = props.billboard ?? false;
    this.billboardRoll = props.billboardRoll ?? 0;
    this.textureAspectRatio = props.textureAspectRatio ?? null;
    this.aspectRatioLocked = props.aspectRatioLocked ?? false;
    this.originalWidth = null;
    this.originalHeight = null;

    this.geometry = new PlaneGeometry(this.width, this.height);
    this.material = new MeshBasicMaterial({
      color: this.color,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = `${this.name}-Mesh`;

    // Pivot used for billboarding so node transform can still define placement in world.
    this.billboardPivot = this.mesh;
    this.add(this.billboardPivot);

    // Drive the sprite material's alpha from the node opacity / fade APIs.
    this.registerOpacityMaterial(this.material);
  }

  get texturePath(): string | null {
    return this.texture?.url ?? null;
  }

  set texturePath(value: string | null) {
    this.texture = coerceTextureResource(value);
  }

  setTextureResource(value: unknown): void {
    this.texture = coerceTextureResource(value);
  }

  setTexture(texture: Texture): void {
    texture.colorSpace = SRGBColorSpace;
    this.material.map = texture;
    this.material.color.set('#ffffff');
    this.material.transparent = true;
    this.material.needsUpdate = true;

    // Capture the texture aspect ratio and original dimensions
    if (texture.image) {
      const img = texture.image as any;
      const w = img.naturalWidth ?? img.width;
      const h = img.naturalHeight ?? img.height;

      console.log(`[Sprite3D] Texture loaded: ${w}x${h} for node "${this.name}" (natural=${img.naturalWidth}x${img.naturalHeight})`);

      if (w && h) {
        this.textureAspectRatio = w / h;
        this.originalWidth = w;
        this.originalHeight = h;
      }
    }
  }

  clearTexture(): void {
    this.material.map = null;
    this.material.needsUpdate = true;
  }

  setSize(width: number, height: number): void {
    const nextWidth = Number.isFinite(width) && width > 0 ? width : this.width;
    const nextHeight = Number.isFinite(height) && height > 0 ? height : this.height;

    if (nextWidth === this.width && nextHeight === this.height) {
      return;
    }

    this.width = nextWidth;
    this.height = nextHeight;

    this.geometry.dispose();
    this.geometry = new PlaneGeometry(this.width, this.height);
    this.mesh.geometry = this.geometry;
  }

  /**
   * Reset sprite size to its original texture dimensions.
   * If no original dimensions are known, does nothing.
   */
  resetToOriginalSize(): void {
    if (!this.originalWidth || !this.originalHeight) {
      return;
    }

    this.setSize(this.originalWidth, this.originalHeight);
  }

  applyBillboard(cameraQuaternion: Quaternion): void {
    if (!this.billboard) {
      this.billboardPivot.quaternion.identity();
      return;
    }

    this.getWorldQuaternion(Sprite3D.tempWorldQuaternion);

    Sprite3D.tempLocalQuaternion
      .copy(Sprite3D.tempWorldQuaternion)
      .invert()
      .multiply(cameraQuaternion);

    this.billboardPivot.quaternion.copy(Sprite3D.tempLocalQuaternion);
    this.billboardPivot.rotateZ(MathUtils.degToRad(this.billboardRoll));
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = Node3D.getPropertySchema();

    return {
      nodeType: 'Sprite3D',
      extends: 'Node3D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'texture',
          type: 'object',
          ui: {
            label: 'Texture',
            description: 'Path to the sprite texture',
            group: 'Sprite',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: (node: unknown) =>
            (node as Sprite3D).texture ?? {
              type: 'texture',
              url: '',
            },
          setValue: (node: unknown, value: unknown) => {
            (node as Sprite3D).setTextureResource(value);
          },
        },
        {
          name: 'width',
          type: 'number',
          ui: {
            label: 'Width',
            description: 'Sprite width in world units',
            group: 'Sprite',
            editor: 'sprite-size',
            step: 0.01,
            precision: 2,
            min: 0.01,
          },
          getValue: (node: unknown) => (node as Sprite3D).width,
          setValue: (node: unknown, value: unknown) => {
            const n = node as Sprite3D;
            n.setSize(Number(value), n.height);
          },
        },
        {
          name: 'height',
          type: 'number',
          ui: {
            label: 'Height',
            description: 'Sprite height in world units',
            group: 'Sprite',
            editor: 'sprite-size',
            step: 0.01,
            precision: 2,
            min: 0.01,
          },
          getValue: (node: unknown) => (node as Sprite3D).height,
          setValue: (node: unknown, value: unknown) => {
            const n = node as Sprite3D;
            n.setSize(n.width, Number(value));
          },
        },
        {
          name: 'billboard',
          type: 'boolean',
          ui: {
            label: 'Billboard',
            description: 'Face the active camera while keeping world placement',
            group: 'Sprite',
          },
          getValue: (node: unknown) => (node as Sprite3D).billboard,
          setValue: (node: unknown, value: unknown) => {
            (node as Sprite3D).billboard = !!value;
          },
        },
        {
          name: 'billboardRoll',
          type: 'number',
          ui: {
            label: 'Billboard Roll',
            description: 'Additional roll angle when billboard is enabled',
            group: 'Sprite',
            step: 0.1,
            precision: 1,
            unit: '°',
          },
          getValue: (node: unknown) => (node as Sprite3D).billboardRoll,
          setValue: (node: unknown, value: unknown) => {
            (node as Sprite3D).billboardRoll = Number(value);
          },
        },
        {
          name: 'opacity',
          type: 'number',
          ui: {
            label: 'Opacity',
            description: 'Sprite opacity (use show()/hide() to fade at runtime)',
            group: 'Sprite',
            step: 0.01,
            precision: 2,
            min: 0,
            max: 1,
          },
          getValue: (node: unknown) => (node as Sprite3D).opacity,
          setValue: (node: unknown, value: unknown) => {
            (node as Sprite3D).opacity = Number(value);
          },
        },
        {
          name: 'textureAspectRatio',
          type: 'number',
          ui: {
            hidden: true,
          },
          getValue: (node: unknown) => (node as Sprite3D).textureAspectRatio ?? null,
          setValue: (node: unknown, value: unknown) => {
            (node as Sprite3D).textureAspectRatio = value === null ? null : Number(value);
          },
        },
        {
          name: 'aspectRatioLocked',
          type: 'boolean',
          ui: {
            hidden: true,
          },
          getValue: (node: unknown) => (node as Sprite3D).aspectRatioLocked,
          setValue: (node: unknown, value: unknown) => {
            (node as Sprite3D).aspectRatioLocked = Boolean(value);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Sprite: {
          label: 'Sprite',
          description: '3D sprite rendering properties',
          expanded: true,
        },
      },
    };
  }
}
