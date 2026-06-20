import { Mesh, MeshBasicMaterial, PlaneGeometry, Texture } from 'three';
import { Node2D, type Node2DProps } from '../Node2D';
import type { PropertySchema } from '../../fw/property-schema';
import { coerceTextureResource, type TextureResourceRef } from '../../core/TextureResource';
import { configure2DTexture } from '../../core/configure-2d-texture';

export interface SpriteAnchor2D {
  x: number;
  y: number;
}

export interface Sprite2DProps extends Omit<Node2DProps, 'type'> {
  texture?: TextureResourceRef | null;
  texturePath?: string | null;
  width?: number;
  height?: number;
  color?: string;
  anchor?: SpriteAnchor2D | [number, number];
  aspectRatioLocked?: boolean;
}

export class Sprite2D extends Node2D {
  texture: TextureResourceRef | null;
  /** Width in pixels. Defaults to texture width when loaded, or 64 as placeholder. */
  width: number | undefined;
  /** Height in pixels. Defaults to texture height when loaded, or 64 as placeholder. */
  height: number | undefined;
  /** Stored aspect ratio of the original texture (width / height), null if unknown. */
  textureAspectRatio: number | null;
  /** If true, height changes proportionally when width is modified and vice versa. */
  aspectRatioLocked: boolean;
  /** Original width (from texture). Used to reset to natural size. */
  originalWidth: number | null;
  /** Original height (from texture). Used to reset to natural size. */
  originalHeight: number | null;
  /** Normalized anchor point in local sprite space: (0,0)=bottom-left, (0.5,0.5)=center, (1,1)=top-right. */
  anchor: SpriteAnchor2D;

  private mesh: Mesh;
  private geometry: PlaneGeometry;
  private material: MeshBasicMaterial;

  constructor(props: Sprite2DProps) {
    super(props, 'Sprite2D');
    this.texture = coerceTextureResource(props.texture ?? props.texturePath ?? null);
    this.width = props.width;
    this.height = props.height;
    this.textureAspectRatio = (props as any).textureAspectRatio ?? null;
    this.aspectRatioLocked = (props as any).aspectRatioLocked ?? false;
    this.originalWidth = null;
    this.originalHeight = null;
    this.anchor = Sprite2D.normalizeAnchor(props.anchor);
    this.isContainer = false;

    // Create visuals
    this.geometry = new PlaneGeometry(this.width ?? 64, this.height ?? 64);
    this.material = new MeshBasicMaterial({
      color: props.color ?? '#ffffff',
      transparent: true,
      depthTest: false,
    });
    this.registerOpacityMaterial(this.material, 1);

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = `${this.name}-Mesh`;
    this.applyAnchorOffset();
    this.add(this.mesh);
  }

  private static normalizeAnchor(
    anchor: SpriteAnchor2D | [number, number] | undefined
  ): SpriteAnchor2D {
    if (!anchor) {
      return { x: 0.5, y: 0.5 };
    }

    if (Array.isArray(anchor)) {
      const x = Number(anchor[0]);
      const y = Number(anchor[1]);
      return {
        x: Number.isFinite(x) ? x : 0.5,
        y: Number.isFinite(y) ? y : 0.5,
      };
    }

    const x = Number(anchor.x);
    const y = Number(anchor.y);
    return {
      x: Number.isFinite(x) ? x : 0.5,
      y: Number.isFinite(y) ? y : 0.5,
    };
  }

  private applyAnchorOffset(): void {
    const width = this.width ?? 64;
    const height = this.height ?? 64;
    this.mesh.position.set((0.5 - this.anchor.x) * width, (0.5 - this.anchor.y) * height, 0);
  }

  setAnchor(value: SpriteAnchor2D | [number, number]): void {
    this.anchor = Sprite2D.normalizeAnchor(value);
    this.applyAnchorOffset();
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

  /**
   * Set the texture for this sprite.
   * Resizes the mesh if the texture provides dimensions and width/height were not specified.
   */
  setTexture(texture: Texture): void {
    // sRGB + mipmaps disabled (see configure2DTexture for the why).
    configure2DTexture(texture);

    this.material.map = texture;
    this.material.color.set('#ffffff'); // Reset to white once texture is loaded
    this.material.needsUpdate = true;

    // Capture the texture aspect ratio and original dimensions
    if (texture.image) {
      const img = texture.image as any;
      const w = img.naturalWidth ?? img.width;
      const h = img.naturalHeight ?? img.height;

      console.log(
        `[Sprite2D] Texture loaded: ${w}x${h} for node "${this.name}" (natural=${img.naturalWidth}x${img.naturalHeight})`
      );

      if (w && h) {
        this.textureAspectRatio = w / h; // Store aspect ratio
        this.originalWidth = w;
        this.originalHeight = h;

        // If no explicit dimensions, use texture dimensions
        if (this.width === undefined || this.height === undefined) {
          console.log(`[Sprite2D] Auto-resizing "${this.name}" to texture dimensions: ${w}x${h}`);
          this.updateSize(w, h);
        }
      }
    }
  }

  private updateSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.geometry.dispose();
    this.geometry = new PlaneGeometry(w, h);
    this.mesh.geometry = this.geometry;
    this.applyAnchorOffset();

    // Re-apply opacity to the new geometry/material if needed
    // The material is reused, but we need to ensure it updates
    this.material.needsUpdate = true;
    this.refreshOpacity();
  }

  /**
   * Reset sprite size to its original texture dimensions.
   * If no original dimensions are known, does nothing.
   */
  resetToOriginalSize(): void {
    if (!this.originalWidth || !this.originalHeight) {
      return;
    }

    this.updateSize(this.originalWidth, this.originalHeight);
  }

  /**
   * Get the property schema for Sprite2D.
   * Extends Node2D schema with sprite-specific properties.
   */
  static getPropertySchema(): PropertySchema {
    const baseSchema = Node2D.getPropertySchema();

    return {
      nodeType: 'Sprite2D',
      extends: 'Node2D',
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
            (node as Sprite2D).texture ?? {
              type: 'texture',
              url: '',
            },
          setValue: (node: unknown, value: unknown) => {
            (node as Sprite2D).setTextureResource(value);
          },
        },
        {
          name: 'anchor',
          type: 'vector2',
          ui: {
            label: 'Pivot',
            description: 'Normalized pivot point used to position the sprite image',
            group: 'Sprite',
            step: 0.01,
            precision: 2,
          },
          getValue: (node: unknown) => {
            const anchor = (node as Sprite2D).anchor;
            return { x: anchor.x, y: anchor.y };
          },
          setValue: (node: unknown, value: unknown) => {
            const sprite = node as Sprite2D;
            const anchor = value as { x: number; y: number };
            sprite.setAnchor({ x: anchor.x, y: anchor.y });
          },
        },
        {
          name: 'width',
          type: 'number',
          ui: {
            label: 'Width',
            description: 'Sprite width in pixels',
            group: 'Size',
            editor: 'sprite-size',
            step: 1,
            precision: 0,
            min: 1,
            unit: 'px',
          },
          getValue: (node: unknown) => (node as Sprite2D).width ?? 64,
          setValue: (node: unknown, value: unknown) => {
            const sprite = node as Sprite2D;
            sprite.updateSize(Number(value), sprite.height ?? 64);
          },
        },
        {
          name: 'height',
          type: 'number',
          ui: {
            label: 'Height',
            description: 'Sprite height in pixels',
            group: 'Size',
            editor: 'sprite-size',
            step: 1,
            precision: 0,
            min: 1,
            unit: 'px',
          },
          getValue: (node: unknown) => (node as Sprite2D).height ?? 64,
          setValue: (node: unknown, value: unknown) => {
            const sprite = node as Sprite2D;
            sprite.updateSize(sprite.width ?? 64, Number(value));
          },
        },
        {
          name: 'aspectRatioLocked',
          type: 'boolean',
          ui: {
            label: 'Aspect Ratio Locked',
            description: 'Maintain aspect ratio when resizing',
            group: 'Size',
            hidden: true,
          },
          getValue: (node: unknown) => (node as Sprite2D).aspectRatioLocked ?? false,
          setValue: (node: unknown, value: unknown) => {
            (node as Sprite2D).aspectRatioLocked = Boolean(value);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Sprite: {
          label: 'Sprite',
          description: 'Sprite-specific properties',
          expanded: true,
        },
        Size: {
          label: 'Size',
          description: 'Sprite dimensions in pixels',
          expanded: true,
        },
      },
    };
  }
}
