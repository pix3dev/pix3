/**
 * SimpleMoveBehavior - Joystick-driven movement behavior.
 */
import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
export declare class SimpleMoveBehavior extends Script {
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    onUpdate(dt: number): void;
    private getSpeed;
    private getHorizontalAxis;
    private getVerticalAxis;
    private getMovementPlane;
    private isVerticalInverted;
}
