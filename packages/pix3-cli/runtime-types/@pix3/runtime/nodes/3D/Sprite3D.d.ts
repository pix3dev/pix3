import { Quaternion, Texture } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import { type TextureResourceRef } from '../../core/TextureResource';
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
export declare class Sprite3D extends Node3D {
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
    private mesh;
    private geometry;
    private material;
    private billboardPivot;
    private static readonly tempWorldQuaternion;
    private static readonly tempLocalQuaternion;
    constructor(props: Sprite3DProps);
    get texturePath(): string | null;
    set texturePath(value: string | null);
    setTextureResource(value: unknown): void;
    setTexture(texture: Texture): void;
    clearTexture(): void;
    setSize(width: number, height: number): void;
    /**
     * Reset sprite size to its original texture dimensions.
     * If no original dimensions are known, does nothing.
     */
    resetToOriginalSize(): void;
    applyBillboard(cameraQuaternion: Quaternion): void;
    static getPropertySchema(): PropertySchema;
}
