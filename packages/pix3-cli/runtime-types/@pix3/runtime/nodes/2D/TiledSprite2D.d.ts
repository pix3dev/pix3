import { Texture, Vector2 } from 'three';
import { Node2D, type Node2DProps } from '../Node2D';
import type { PropertySchema } from '../../fw/property-schema';
import { type TextureResourceRef } from '../../core/TextureResource';
import { type TiledSpriteAxisStretch, type TiledSpritePatchMode, type TiledSpriteSliceBorder } from '../../core/tiled-sprite-geometry';
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
type TiledSpriteVectorInput = {
    x: number;
    y: number;
} | [number, number];
/**
 * A 2D node that maps a single texture onto an arbitrarily-sized rectangle with
 * several fill algorithms (see {@link TiledSpritePatchMode}): plain stretch,
 * seamless tiling (with scale/offset), and 9-slice / 3-slice scalable borders for
 * building UI panels, frames, and bars. The heavy lifting lives in the shared
 * {@link buildTiledSpriteGeometry} so the editor viewport renders it identically.
 */
export declare class TiledSprite2D extends Node2D {
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
    private mesh;
    private geometry;
    private material;
    constructor(props: TiledSprite2DProps);
    private buildGeometryParams;
    private rebuildGeometry;
    private applyAnchorOffset;
    updateSize(width: number, height: number): void;
    setPatchMode(mode: TiledSpritePatchMode | string): void;
    setSliceBorder(border: Partial<TiledSpriteSliceBorder>): void;
    setDrawCenter(value: boolean): void;
    setAxisStretchHorizontal(value: TiledSpriteAxisStretch | string): void;
    setAxisStretchVertical(value: TiledSpriteAxisStretch | string): void;
    setTileScale(x: number, y: number): void;
    setTileOffset(x: number, y: number): void;
    setAnchor(value: TiledSpriteAnchor2D | [number, number]): void;
    get texturePath(): string | null;
    set texturePath(value: string | null);
    setTextureResource(value: unknown): void;
    /**
     * Apply a loaded texture. Captures the natural size (needed to map 9-slice
     * borders and tiles to UVs) and rebuilds the geometry so those mappings become
     * pixel-accurate once the image resolves.
     */
    setTexture(texture: Texture): void;
    protected disposeResources(): void;
    private static toSize;
    private static normalizePatchMode;
    private static normalizeAxis;
    /** Shared with the skinned UI controls (Button2D/Slider2D/Bar2D). */
    private static normalizeBorder;
    private static normalizeAnchor;
    private static toVector2;
    static getPropertySchema(): PropertySchema;
}
export {};
