import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
export declare class FollowBehavior extends Script {
    private targetNode;
    private readonly targetWorldPosition;
    private readonly targetLocalPosition;
    private readonly targetWorldQuaternion;
    private readonly targetLocalQuaternion;
    private readonly parentWorldQuaternion;
    private readonly parentWorldQuaternionInverse;
    private readonly targetEuler;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    onStart(): void;
    onUpdate(dt: number): void;
    private updatePosition;
    private updateRotation;
    private resolveTargetNode;
    private getTargetNodeId;
    private setTargetNodeId;
    private getPositionSmoothing;
    private getRotationSmoothing;
    private isPositionAxisEnabled;
    private isRotationAxisEnabled;
    private getDampingAlpha;
    private dampAngle;
}
