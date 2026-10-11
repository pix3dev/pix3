import type { Object3D, Vector3 } from 'three';
import type { NodeBase } from '../nodes/NodeBase';
export interface SceneRaycastHit {
    node: NodeBase;
    distance: number;
    point: Vector3;
    object: Object3D;
    instanceId?: number;
}
export interface SceneRaycaster {
    raycastViewport(normalizedX: number, normalizedY: number): SceneRaycastHit | null;
}
