import { Quaternion, Vector3 } from 'three';
import { Node3D, type Node3DProps } from '../Node3D';
import type { PropertySchema } from '../../fw/property-schema';
import { type KeyframeEasing } from '../../animation/easing';
/** Default configuration values for a freshly created virtual camera. */
export declare const VIRTUAL_CAMERA_DEFAULTS: {
    readonly priority: 10;
    readonly fov: 60;
    readonly orthographicSize: 5;
    readonly followDamping: 8;
    readonly rotationDamping: 8;
    readonly lookAtWeight: 1;
    readonly blendDuration: 1;
    readonly blendEasing: KeyframeEasing;
};
export interface VirtualCamera3DProps extends Omit<Node3DProps, 'type'> {
    priority?: number;
    fov?: number;
    orthographicSize?: number;
    followTargetId?: string;
    followDamping?: number;
    followOffset?: {
        x: number;
        y: number;
        z: number;
    };
    deadzone?: {
        x: number;
        y: number;
        z: number;
    };
    lookAtTargetId?: string;
    lookAtWeight?: number;
    rotationDamping?: number;
    confinerEnabled?: boolean;
    confinerCenter?: {
        x: number;
        y: number;
        z: number;
    };
    confinerSize?: {
        x: number;
        y: number;
        z: number;
    };
    blendDuration?: number;
    blendEasing?: KeyframeEasing;
}
/**
 * A lightweight "virtual camera" (Cinemachine-lite). It does NOT render — it
 * only describes a desired framing (position via follow, orientation via
 * look-at, plus FOV / ortho size). A {@link CameraBrainBehavior} attached to a
 * real `Camera3D` selects the highest-priority live virtual camera each frame
 * and blends the render camera toward it.
 *
 * Because every knob is exposed through the property schema, the keyframe
 * timeline can animate `priority`, `fov`, `position`, etc. with no animation
 * code — switching cameras is "raise this one's priority above that one".
 *
 * Solving is driven exclusively by the brain (single authority): the brain
 * calls {@link solve} on every virtual camera each frame — including standby
 * ones, so a camera is already framed when it is cut to — then reads the winner
 * via {@link getDesiredWorldPosition} / {@link getDesiredWorldQuaternion}. A
 * virtual camera with no brain in the scene simply sits at its authored pose.
 */
export declare class VirtualCamera3D extends Node3D {
    private priorityValue;
    private fovValue;
    private orthographicSizeValue;
    private followTargetId;
    private followDampingValue;
    private readonly followOffset;
    private readonly deadzone;
    private lookAtTargetId;
    private lookAtWeightValue;
    private rotationDampingValue;
    private confinerEnabledValue;
    private readonly confinerCenter;
    private readonly confinerSize;
    private blendDurationValue;
    private blendEasingValue;
    /** Authored local rotation captured on the first solve, used as the stable
     * base for weighted look-at blending (the live rotation is mutated each
     * frame, so we can't read the authored value from it after frame 1). */
    private authoredQuaternion;
    private readonly scratchWorldPos;
    private readonly scratchTargetPos;
    private readonly scratchDesired;
    private readonly scratchLocal;
    private readonly scratchLookMatrix;
    private readonly scratchLookQuat;
    private readonly scratchBlendQuat;
    private readonly scratchCurrentQuat;
    private readonly scratchParentQuat;
    constructor(props: VirtualCamera3DProps);
    get priority(): number;
    set priority(value: number);
    get fov(): number;
    set fov(value: number);
    get orthographicSize(): number;
    set orthographicSize(value: number);
    get blendDuration(): number;
    set blendDuration(value: number);
    get blendEasing(): KeyframeEasing;
    set blendEasing(value: KeyframeEasing);
    /**
     * Solve this camera's framing for the current frame. Mutates the node's own
     * local transform (so its gizmo tracks the target in play mode) and lazily
     * captures the authored rotation for weighted look-at blending. Cheap and
     * safe to call every frame for standby cameras.
     */
    solve(dt: number): void;
    /** World position after the last {@link solve}. */
    getDesiredWorldPosition(out: Vector3): Vector3;
    /** World orientation after the last {@link solve}. */
    getDesiredWorldQuaternion(out: Quaternion): Quaternion;
    /**
     * Authored configuration as a plain object for scene serialization. Keys match
     * the loader's expected property names one-to-one. Transform (position /
     * rotation / scale) is serialized separately by the generic Node3D path.
     */
    serializeConfig(): Record<string, unknown>;
    private resolveTarget;
    private solveFollow;
    private applyConfiner;
    /**
     * Same correction as {@link Camera3D.lookAt}: this node stands in for a camera, and its own
     * look-at solve already aims -Z at the target, so the inherited `Object3D.lookAt` must not aim
     * the other way.
     */
    lookAt(vector: Vector3): void;
    lookAt(x: number, y: number, z: number): void;
    private solveLookAt;
    private setWorldPosition;
    private setWorldQuaternion;
    get treeIcon(): string;
    static getPropertySchema(): PropertySchema;
}
