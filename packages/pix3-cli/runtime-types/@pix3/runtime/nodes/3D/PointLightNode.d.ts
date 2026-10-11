import { PointLight } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
export interface PointLightNodeProps extends Omit<Node3DProps, 'type'> {
    color?: string;
    intensity?: number;
    distance?: number;
    decay?: number;
    castShadow?: boolean;
}
export declare class PointLightNode extends Node3D {
    readonly light: PointLight;
    constructor(props: PointLightNodeProps);
    static getPropertySchema(): PropertySchema;
}
