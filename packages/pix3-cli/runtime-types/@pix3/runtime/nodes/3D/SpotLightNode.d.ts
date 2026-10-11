import { SpotLight, Vector3 } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
export interface SpotLightNodeProps extends Omit<Node3DProps, 'type'> {
    color?: string;
    intensity?: number;
    distance?: number;
    angle?: number;
    penumbra?: number;
    decay?: number;
    castShadow?: boolean;
}
export declare class SpotLightNode extends Node3D {
    readonly light: SpotLight;
    constructor(props: SpotLightNodeProps);
    getTargetPosition(): Vector3;
    setTargetPosition(targetPos: Vector3): void;
    static getPropertySchema(): PropertySchema;
}
