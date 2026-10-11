import { AmbientLight } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
export interface AmbientLightNodeProps extends Omit<Node3DProps, 'type'> {
    color?: string;
    intensity?: number;
}
export declare class AmbientLightNode extends Node3D {
    readonly light: AmbientLight;
    constructor(props: AmbientLightNodeProps);
    static getPropertySchema(): PropertySchema;
}
