import { Node2D, type Node2DProps } from '../Node2D';
import type { PropertySchema } from '../../fw/property-schema';
export interface ColorRect2DProps extends Omit<Node2DProps, 'type'> {
    width?: number;
    height?: number;
    color?: string;
    opacity?: number;
}
export declare class ColorRect2D extends Node2D {
    width: number;
    height: number;
    color: string;
    private mesh;
    private material;
    constructor(props: ColorRect2DProps);
    static getPropertySchema(): PropertySchema;
    private updateSize;
    protected disposeResources(): void;
}
