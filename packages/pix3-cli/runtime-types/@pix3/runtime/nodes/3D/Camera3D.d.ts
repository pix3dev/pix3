import { Camera, Object3D, Vector3 } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
export declare const TARGET_DISTANCE = 3;
/**
 * Aim a camera-shaped node at a world point, the way a camera means it.
 *
 * `Object3D.lookAt` has two opposite conventions and chooses between them with `isCamera`/`isLight`:
 * a camera is turned so its **-Z** faces the target, everything else so its **+Z** does. A Pix3
 * camera node is a `Node3D` that *holds* a three.js camera as a child, so it fails that check and
 * inherits the object convention — which leaves the real camera pointed exactly 180° away from the
 * target, at a scene that renders as nothing but the clear colour.
 *
 * Every other aiming path in the engine already speaks the camera convention
 * ({@link Camera3D.setTargetPosition}, `VirtualCamera3D`'s look blend, the editor's camera gizmo);
 * this is what makes the inherited method agree with them.
 */
export declare const aimCameraNodeAt: (node: Object3D, x: Vector3 | number, y?: number, z?: number) => void;
export interface Camera3DProps extends Omit<Node3DProps, 'type'> {
    projection?: 'perspective' | 'orthographic';
    fov?: number;
    near?: number;
    far?: number;
    orthographicSize?: number;
}
export declare class Camera3D extends Node3D {
    camera: Camera;
    private targetDistance;
    private shakeRafId;
    private projectionMode;
    private perspectiveFov;
    private orthographicSizeValue;
    constructor(props: Camera3DProps);
    /** @see {@link aimCameraNodeAt} — the inherited `Object3D.lookAt` aims the opposite way. */
    lookAt(vector: Vector3): void;
    lookAt(x: number, y: number, z: number): void;
    getTargetPosition(): Vector3;
    setTargetPosition(targetPos: Vector3): void;
    /**
     * Get the stored field of view in degrees.
     * Orthographic mode preserves the value so switching back restores it.
     */
    get fov(): number;
    /**
     * Set the stored field of view in degrees.
     * In orthographic mode the value is preserved for later perspective use.
     */
    set fov(value: number);
    get projection(): 'perspective' | 'orthographic';
    set projection(value: 'perspective' | 'orthographic');
    get near(): number;
    set near(value: number);
    get far(): number;
    set far(value: number);
    get orthographicSize(): number;
    set orthographicSize(value: number);
    updateAspectRatio(aspect: number): void;
    shake(intensity?: number, duration?: number): void;
    private stopShake;
    private rebuildCamera;
    private applyOrthographicSize;
    static getPropertySchema(): PropertySchema;
}
