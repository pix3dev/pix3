import { HemisphereLight } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
export interface HemisphereLightNodeProps extends Omit<Node3DProps, 'type'> {
    skyColor?: string;
    groundColor?: string;
    intensity?: number;
}
export declare class HemisphereLightNode extends Node3D {
    readonly light: HemisphereLight;
    constructor(props: HemisphereLightNodeProps);
    static getPropertySchema(): PropertySchema;
}
