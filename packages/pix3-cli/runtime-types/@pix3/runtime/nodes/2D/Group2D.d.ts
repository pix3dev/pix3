import { Vector2 } from 'three';
import { Node2D, type Node2DProps } from '../Node2D';
import type { PropertySchema } from '../../fw/property-schema';
export interface Group2DProps extends Omit<Node2DProps, 'type'> {
    width?: number;
    height?: number;
}
export declare class Group2D extends Node2D {
    private _width;
    private _height;
    constructor(props: Group2DProps, nodeType?: string);
    get width(): number;
    set width(value: number);
    get height(): number;
    set height(value: number);
    getSize(): Vector2;
    setSize(width: number, height: number): void;
    static getPropertySchema(): PropertySchema;
}
