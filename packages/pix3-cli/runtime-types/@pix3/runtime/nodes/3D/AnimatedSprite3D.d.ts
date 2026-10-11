import { Texture, Quaternion } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import { type TextureResourceRef } from '../../core/TextureResource';
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
export declare class AnimatedSprite3D extends Node3D {
    frames: (TextureResourceRef | null)[];
    width: number;
    height: number;
    color: string;
    fps: number;
    playing: boolean;
    loop: boolean;
    freeOnFinish: boolean;
    billboard: boolean;
    private _currentFrame;
    private readonly frameSequencePlayer;
    private mesh;
    private geometry;
    private material;
    private loadedTextures;
    private billboardPivot;
    private static readonly tempWorldQuaternion;
    private static readonly tempLocalQuaternion;
    constructor(props: AnimatedSprite3DProps);
    get currentFrame(): number;
    set currentFrame(value: number);
    setTextureForFrame(index: number, texture: Texture | null): void;
    private updateTexture;
    applyBillboard(cameraQuaternion: Quaternion): void;
    tick(dt: number): void;
    static getPropertySchema(): PropertySchema;
    private updateGeometry;
    protected disposeResources(): void;
}
