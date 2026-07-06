import { BufferGeometry, Mesh, MeshBasicMaterial, Texture, Vector2 } from 'three';
import { Node2D, type Node2DProps } from '../Node2D';
import type { PropertySchema } from '../../fw/property-schema';
import { coerceTextureResource, type TextureResourceRef } from '../../core/TextureResource';
import { configure2DTexture } from '../../core/configure-2d-texture';
import {
  buildTiledSpriteGeometry,
  type TiledSpriteAxisStretch,
  type TiledSpritePatchMode,
  type TiledSpriteSliceBorder,
} from '../../core/tiled-sprite-geometry';

export interface TiledSpriteAnchor2D {
  x: number;
  y: number;
}

export interface TiledSprite2DProps extends Omit<Node2DProps, 'type'> {
  texture?: TextureResourceRef | null;
  texturePath?: string | null;
  width?: number;
  height?: number;
  color?: string;
  patchMode?: TiledSpritePatchMode;
  sliceBorder?: Partial<TiledSpriteSliceBorder>;
  drawCenter?: boolean;
  axisStretchHorizontal?: TiledSpriteAxisStretch;
  axisStretchVertical?: TiledSpriteAxisStretch;
  tileScale?: TiledSpriteVectorInput;
  tileOffset?: TiledSpriteVectorInput;
  anchor?: TiledSpriteAnchor2D | [number, number];
}

type TiledSpriteVectorInput = { x: number; y: number } | [number, number];

const PATCH_MODES: readonly TiledSpritePatchMode[] = [
  'stretch',
  'tile',
  'nine-slice',
  'three-slice-h',
  'three-slice-v',
];
const AXIS_STRETCH_MODES: readonly TiledSpriteAxisStretch[] = ['stretch', 'tile'];

const DEFAULT_SIZE = 128;

/**
 * A 2D node that maps a single texture onto an arbitrarily-sized rectangle with
 * several fill algorithms (see {@link TiledSpritePatchMode}): plain stretch,
 * seamless tiling (with scale/offset), and 9-slice / 3-slice scalable borders for
 * building UI panels, frames, and bars. The heavy lifting lives in the shared
 * {@link buildTiledSpriteGeometry} so the editor viewport renders it identically.
 */
export class TiledSprite2D extends Node2D {
  texture: TextureResourceRef | null;
  width: number;
  height: number;
  patchMode: TiledSpritePatchMode;
  sliceBorder: TiledSpriteSliceBorder;
  drawCenter: boolean;
  axisStretchHorizontal: TiledSpriteAxisStretch;
  axisStretchVertical: TiledSpriteAxisStretch;
  readonly tileScale: Vector2;
  readonly tileOffset: Vector2;
  /** Normalized pivot: (0,0)=bottom-left, (0.5,0.5)=center, (1,1)=top-right. */
  anchor: TiledSpriteAnchor2D;
  /** Natural texture size in pixels, captured on texture load (0 = unknown). */
  textureWidth: number;
  textureHeight: number;

  private mesh: Mesh;
  private geometry: BufferGeometry;
  private material: MeshBasicMaterial;

  constructor(props: TiledSprite2DProps) {
    super(props, 'TiledSprite2D');
    this.texture = coerceTextureResource(props.texture ?? props.texturePath ?? null);
    this.width = TiledSprite2D.toSize(props.width);
    this.height = TiledSprite2D.toSize(props.height);
    this.patchMode = TiledSprite2D.normalizePatchMode(props.patchMode);
    this.sliceBorder = TiledSprite2D.normalizeBorder(props.sliceBorder);
    this.drawCenter = props.drawCenter ?? true;
    this.axisStretchHorizontal = TiledSprite2D.normalizeAxis(props.axisStretchHorizontal);
    this.axisStretchVertical = TiledSprite2D.normalizeAxis(props.axisStretchVertical);
    this.tileScale = TiledSprite2D.toVector2(props.tileScale, 1, 1);
    this.tileOffset = TiledSprite2D.toVector2(props.tileOffset, 0, 0);
    this.anchor = TiledSprite2D.normalizeAnchor(props.anchor);
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.isContainer = false;

    this.geometry = buildTiledSpriteGeometry(this.buildGeometryParams());
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

  private buildGeometryParams() {
    return {
      mode: this.patchMode,
      width: this.width,
      height: this.height,
      textureWidth: this.textureWidth,
      textureHeight: this.textureHeight,
      border: this.sliceBorder,
      drawCenter: this.drawCenter,
      axisStretchHorizontal: this.axisStretchHorizontal,
      axisStretchVertical: this.axisStretchVertical,
      tileScale: { x: this.tileScale.x, y: this.tileScale.y },
      tileOffset: { x: this.tileOffset.x, y: this.tileOffset.y },
    };
  }

  private rebuildGeometry(): void {
    const next = buildTiledSpriteGeometry(this.buildGeometryParams());
    this.geometry.dispose();
    this.geometry = next;
    this.mesh.geometry = next;
    this.applyAnchorOffset();
    this.material.needsUpdate = true;
    this.refreshOpacity();
  }

  private applyAnchorOffset(): void {
    this.mesh.position.set(
      (0.5 - this.anchor.x) * this.width,
      (0.5 - this.anchor.y) * this.height,
      0
    );
  }

  updateSize(width: number, height: number): void {
    this.width = TiledSprite2D.toSize(width);
    this.height = TiledSprite2D.toSize(height);
    this.rebuildGeometry();
  }

  setPatchMode(mode: TiledSpritePatchMode | string): void {
    this.patchMode = TiledSprite2D.normalizePatchMode(mode);
    this.rebuildGeometry();
  }

  setSliceBorder(border: Partial<TiledSpriteSliceBorder>): void {
    this.sliceBorder = TiledSprite2D.normalizeBorder({ ...this.sliceBorder, ...border });
    this.rebuildGeometry();
  }

  setDrawCenter(value: boolean): void {
    this.drawCenter = Boolean(value);
    this.rebuildGeometry();
  }

  setAxisStretchHorizontal(value: TiledSpriteAxisStretch | string): void {
    this.axisStretchHorizontal = TiledSprite2D.normalizeAxis(value);
    this.rebuildGeometry();
  }

  setAxisStretchVertical(value: TiledSpriteAxisStretch | string): void {
    this.axisStretchVertical = TiledSprite2D.normalizeAxis(value);
    this.rebuildGeometry();
  }

  setTileScale(x: number, y: number): void {
    this.tileScale.set(Number.isFinite(x) ? x : 1, Number.isFinite(y) ? y : 1);
    this.rebuildGeometry();
  }

  setTileOffset(x: number, y: number): void {
    this.tileOffset.set(Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0);
    this.rebuildGeometry();
  }

  setAnchor(value: TiledSpriteAnchor2D | [number, number]): void {
    this.anchor = TiledSprite2D.normalizeAnchor(value);
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
   * Apply a loaded texture. Captures the natural size (needed to map 9-slice
   * borders and tiles to UVs) and rebuilds the geometry so those mappings become
   * pixel-accurate once the image resolves.
   */
  setTexture(texture: Texture): void {
    configure2DTexture(texture);
    this.material.map = texture;
    this.material.color.set('#ffffff');
    this.material.needsUpdate = true;

    if (texture.image) {
      const img = texture.image as {
        naturalWidth?: number;
        naturalHeight?: number;
        width?: number;
        height?: number;
      };
      const w = img.naturalWidth ?? img.width;
      const h = img.naturalHeight ?? img.height;
      if (w && h) {
        this.textureWidth = w;
        this.textureHeight = h;
      }
    }

    this.rebuildGeometry();
  }

  protected override disposeResources(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private static toSize(value: unknown): number {
    // Honor the `min: 0` schema: an explicit 0 (a collapsed rect) is valid; only
    // absent/invalid/negative input falls back to the placeholder default.
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SIZE;
  }

  private static normalizePatchMode(value: unknown): TiledSpritePatchMode {
    return PATCH_MODES.includes(value as TiledSpritePatchMode)
      ? (value as TiledSpritePatchMode)
      : 'stretch';
  }

  private static normalizeAxis(value: unknown): TiledSpriteAxisStretch {
    return AXIS_STRETCH_MODES.includes(value as TiledSpriteAxisStretch)
      ? (value as TiledSpriteAxisStretch)
      : 'stretch';
  }

  private static normalizeBorder(
    border: Partial<TiledSpriteSliceBorder> | undefined
  ): TiledSpriteSliceBorder {
    const clamp = (v: unknown): number => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    return {
      left: clamp(border?.left),
      right: clamp(border?.right),
      top: clamp(border?.top),
      bottom: clamp(border?.bottom),
    };
  }

  private static normalizeAnchor(
    anchor: TiledSpriteAnchor2D | [number, number] | undefined
  ): TiledSpriteAnchor2D {
    if (!anchor) {
      return { x: 0.5, y: 0.5 };
    }
    const rawX = Array.isArray(anchor) ? anchor[0] : anchor.x;
    const rawY = Array.isArray(anchor) ? anchor[1] : anchor.y;
    const x = Number(rawX);
    const y = Number(rawY);
    return {
      x: Number.isFinite(x) ? x : 0.5,
      y: Number.isFinite(y) ? y : 0.5,
    };
  }

  private static toVector2(
    value: TiledSpriteVectorInput | undefined,
    defaultX: number,
    defaultY: number
  ): Vector2 {
    if (!value) {
      return new Vector2(defaultX, defaultY);
    }
    const rawX = Array.isArray(value) ? value[0] : value.x;
    const rawY = Array.isArray(value) ? value[1] : value.y;
    const x = Number(rawX);
    const y = Number(rawY);
    return new Vector2(Number.isFinite(x) ? x : defaultX, Number.isFinite(y) ? y : defaultY);
  }

  static getPropertySchema(): PropertySchema {
    const baseSchema = Node2D.getPropertySchema();

    return {
      nodeType: 'TiledSprite2D',
      extends: 'Node2D',
      properties: [
        ...baseSchema.properties,
        {
          name: 'patchMode',
          type: 'enum',
          ui: {
            label: 'Mode',
            description: 'How the texture fills the rectangle',
            group: 'Patch',
            options: {
              Stretch: 'stretch',
              Tile: 'tile',
              '9-Slice': 'nine-slice',
              '3-Slice Horizontal': 'three-slice-h',
              '3-Slice Vertical': 'three-slice-v',
            },
          },
          getValue: (node: unknown) => (node as TiledSprite2D).patchMode,
          setValue: (node: unknown, value: unknown) => {
            (node as TiledSprite2D).setPatchMode(String(value));
          },
        },
        {
          name: 'texture',
          type: 'object',
          ui: {
            label: 'Texture',
            description: 'Path to the texture',
            group: 'Patch',
            editor: 'texture-resource',
            resourceType: 'texture',
          },
          getValue: (node: unknown) =>
            (node as TiledSprite2D).texture ?? { type: 'texture', url: '' },
          setValue: (node: unknown, value: unknown) => {
            (node as TiledSprite2D).setTextureResource(value);
          },
        },
        {
          name: 'anchor',
          type: 'vector2',
          ui: {
            label: 'Pivot',
            description: 'Normalized pivot point used to position the image',
            group: 'Patch',
            step: 0.01,
            precision: 2,
          },
          getValue: (node: unknown) => {
            const anchor = (node as TiledSprite2D).anchor;
            return { x: anchor.x, y: anchor.y };
          },
          setValue: (node: unknown, value: unknown) => {
            const anchor = value as { x: number; y: number };
            (node as TiledSprite2D).setAnchor({ x: anchor.x, y: anchor.y });
          },
        },
        {
          name: 'width',
          type: 'number',
          ui: {
            label: 'Width',
            description: 'Width in pixels',
            group: 'Size',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: (node: unknown) => (node as TiledSprite2D).width,
          setValue: (node: unknown, value: unknown) => {
            const n = node as TiledSprite2D;
            n.updateSize(Number(value), n.height);
          },
        },
        {
          name: 'height',
          type: 'number',
          ui: {
            label: 'Height',
            description: 'Height in pixels',
            group: 'Size',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: (node: unknown) => (node as TiledSprite2D).height,
          setValue: (node: unknown, value: unknown) => {
            const n = node as TiledSprite2D;
            n.updateSize(n.width, Number(value));
          },
        },
        {
          name: 'sliceBorderLeft',
          type: 'number',
          ui: {
            label: 'Left',
            description: 'Left border inset (source px)',
            group: 'Slice',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: (node: unknown) => (node as TiledSprite2D).sliceBorder.left,
          setValue: (node: unknown, value: unknown) => {
            (node as TiledSprite2D).setSliceBorder({ left: Number(value) });
          },
        },
        {
          name: 'sliceBorderRight',
          type: 'number',
          ui: {
            label: 'Right',
            description: 'Right border inset (source px)',
            group: 'Slice',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: (node: unknown) => (node as TiledSprite2D).sliceBorder.right,
          setValue: (node: unknown, value: unknown) => {
            (node as TiledSprite2D).setSliceBorder({ right: Number(value) });
          },
        },
        {
          name: 'sliceBorderTop',
          type: 'number',
          ui: {
            label: 'Top',
            description: 'Top border inset (source px)',
            group: 'Slice',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: (node: unknown) => (node as TiledSprite2D).sliceBorder.top,
          setValue: (node: unknown, value: unknown) => {
            (node as TiledSprite2D).setSliceBorder({ top: Number(value) });
          },
        },
        {
          name: 'sliceBorderBottom',
          type: 'number',
          ui: {
            label: 'Bottom',
            description: 'Bottom border inset (source px)',
            group: 'Slice',
            min: 0,
            step: 1,
            precision: 0,
            unit: 'px',
          },
          getValue: (node: unknown) => (node as TiledSprite2D).sliceBorder.bottom,
          setValue: (node: unknown, value: unknown) => {
            (node as TiledSprite2D).setSliceBorder({ bottom: Number(value) });
          },
        },
        {
          name: 'drawCenter',
          type: 'boolean',
          ui: {
            label: 'Draw Center',
            description: 'Draw the centre patch (uncheck for a hollow frame)',
            group: 'Slice',
          },
          getValue: (node: unknown) => (node as TiledSprite2D).drawCenter,
          setValue: (node: unknown, value: unknown) => {
            (node as TiledSprite2D).setDrawCenter(Boolean(value));
          },
        },
        {
          name: 'axisStretchHorizontal',
          type: 'enum',
          ui: {
            label: 'Horizontal Fill',
            description: 'How the horizontal middle fills in slice modes',
            group: 'Slice',
            options: { Stretch: 'stretch', Tile: 'tile' },
          },
          getValue: (node: unknown) => (node as TiledSprite2D).axisStretchHorizontal,
          setValue: (node: unknown, value: unknown) => {
            (node as TiledSprite2D).setAxisStretchHorizontal(String(value));
          },
        },
        {
          name: 'axisStretchVertical',
          type: 'enum',
          ui: {
            label: 'Vertical Fill',
            description: 'How the vertical middle fills in slice modes',
            group: 'Slice',
            options: { Stretch: 'stretch', Tile: 'tile' },
          },
          getValue: (node: unknown) => (node as TiledSprite2D).axisStretchVertical,
          setValue: (node: unknown, value: unknown) => {
            (node as TiledSprite2D).setAxisStretchVertical(String(value));
          },
        },
        {
          name: 'tileScale',
          type: 'vector2',
          ui: {
            label: 'Tile Scale',
            description: 'Tile size multiplier (Tile mode)',
            group: 'Tile',
            step: 0.01,
            precision: 2,
          },
          getValue: (node: unknown) => {
            const t = (node as TiledSprite2D).tileScale;
            return { x: t.x, y: t.y };
          },
          setValue: (node: unknown, value: unknown) => {
            const v = value as { x: number; y: number };
            (node as TiledSprite2D).setTileScale(v.x, v.y);
          },
        },
        {
          name: 'tileOffset',
          type: 'vector2',
          ui: {
            label: 'Tile Offset',
            description: 'UV phase offset in tiles (Tile mode)',
            group: 'Tile',
            step: 0.01,
            precision: 2,
          },
          getValue: (node: unknown) => {
            const t = (node as TiledSprite2D).tileOffset;
            return { x: t.x, y: t.y };
          },
          setValue: (node: unknown, value: unknown) => {
            const v = value as { x: number; y: number };
            (node as TiledSprite2D).setTileOffset(v.x, v.y);
          },
        },
      ],
      groups: {
        ...baseSchema.groups,
        Patch: { label: 'Patch', description: 'Texture and fill mode', expanded: true },
        Size: { label: 'Size', description: 'Rectangle dimensions in pixels', expanded: true },
        Slice: { label: 'Slice', description: '9-slice / 3-slice borders', expanded: true },
        Tile: { label: 'Tile', description: 'Tiling scale and offset', expanded: false },
      },
    };
  }
}
