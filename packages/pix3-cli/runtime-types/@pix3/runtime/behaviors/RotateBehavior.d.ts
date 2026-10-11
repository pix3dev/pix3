/**
 * RotateBehavior - A simple component for testing the script system
 *
 * Rotates a node continuously based on a configurable speed parameter.
 */
import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
export declare class RotateBehavior extends Script {
    private rotationSpeed;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    onAttach(): void;
    onUpdate(dt: number): void;
    private getRotationSpeed;
    private setRotationSpeed;
}
