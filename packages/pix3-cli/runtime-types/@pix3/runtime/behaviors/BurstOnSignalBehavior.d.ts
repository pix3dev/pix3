import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
import type { BurstOptions } from '../core/juice-transients';
/**
 * BurstOnSignal — fires a `scene.juice.burst()` at this node's position whenever a
 * signal fires on it. The inspector-attachable half of the particle burst, so a
 * designer gets hit sparks without a script: drop it on the bumper, point it at
 * the signal the gameplay already emits (`hit`, `damaged`, `pointerdown`, an
 * animation event track), tune the colour.
 *
 * Inert while authoring: it only reacts to a play-driven signal, and the burst it
 * spawns is a runtime-only node (never serialized).
 */
export declare class BurstOnSignalBehavior extends Script {
    private boundSignal;
    private readonly onSignal;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    onStart(): void;
    onDetach(): void;
    /** The burst options this component would pass to the juice API. */
    buildOptions(): BurstOptions;
    private bind;
    private unbind;
    private getSignal;
    private setSignal;
    private getColor;
    private getNumber;
    private static num;
}
