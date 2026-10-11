import { Euler, Vector3, type Material } from 'three';
import { NodeBase, type NodeBaseProps } from './NodeBase';
import type { PropertySchema } from '../fw/property-schema';
export interface Node3DProps extends Omit<NodeBaseProps, 'type'> {
    position?: Vector3;
    rotation?: Euler;
    rotationOrder?: Euler['order'];
    scale?: Vector3;
    opacity?: number;
}
export declare class Node3D extends NodeBase {
    private _opacity;
    /** Opacity to restore on show() after a hide(). */
    private visibleOpacity;
    /** Materials whose opacity is driven by this node's opacity. */
    private readonly opacityMaterials;
    private visibilityFade;
    constructor(props: Node3DProps, nodeType?: string);
    /** Local opacity (0..1) applied to materials registered via registerOpacityMaterial. */
    get opacity(): number;
    set opacity(value: number);
    /**
     * Hide this node, optionally fading out over `fadeTime` seconds. When the
     * fade completes the node's visibility is set to false.
     */
    hide(fadeTime?: number, onComplete?: () => void): void;
    /**
     * Show this node, optionally fading in over `fadeTime` seconds to the last
     * visible opacity.
     */
    show(fadeTime?: number, onComplete?: () => void): void;
    tick(dt: number): void;
    /**
     * Register a material whose opacity should track this node's opacity.
     * Subclasses call this for the materials they own (e.g. a sprite plane).
     */
    protected registerOpacityMaterial(material: Material, baseOpacity?: number): void;
    private applyOpacityToMaterials;
    private applyOpacityToMaterial;
    private setVisibleState;
    private static clampOpacity;
    private static toNonNegativeSeconds;
    get treeColor(): string;
    get treeIcon(): string;
    /**
     * Get the property schema for Node3D.
     * Extends NodeBase schema with 3D-specific transform properties.
     */
    static getPropertySchema(): PropertySchema;
}
