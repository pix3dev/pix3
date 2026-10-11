import { DirectionalLight, Vector3 } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
export interface DirectionalLightNodeProps extends Omit<Node3DProps, 'type'> {
    color?: string;
    intensity?: number;
    castShadow?: boolean;
    /** Half-size of the orthographic shadow camera frustum (left/right/top/bottom = ±shadowCameraSize). Default: 20. */
    shadowCameraSize?: number;
    /** Shadow map resolution in pixels (width and height). Default: 2048. */
    shadowMapSize?: number;
}
export declare class DirectionalLightNode extends Node3D {
    readonly light: DirectionalLight;
    constructor(props: DirectionalLightNodeProps);
    getTargetPosition(): Vector3;
    setTargetPosition(targetPos: Vector3): void;
    static getPropertySchema(): PropertySchema;
}
