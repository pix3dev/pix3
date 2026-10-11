import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
/**
 * SineBehavior - Custom behavior script for oscillating a node.
 *
 * Demonstrates basic animation by modifying the node's position over time
 * according to a sine wave.
 */
export declare class SineBehavior extends Script {
    private elapsedTime;
    private initialPositionX;
    private initialPositionY;
    private initialPositionZ;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    onStart(): void;
    onUpdate(dt: number): void;
    private getAmplitude;
    private getFrequency;
    private getAxis;
}
