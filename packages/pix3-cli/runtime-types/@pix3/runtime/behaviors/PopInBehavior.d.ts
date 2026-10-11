import { Script } from '../core/ScriptComponent';
import { type KeyframeEasing } from '../animation/easing';
import type { PropertySchema } from '../fw/property-schema';
export interface PopInOptions {
    /** Starting scale factor of the authored scale (0 = from nothing). */
    from?: number;
    /** Duration in seconds. */
    duration?: number;
    /** Easing curve; `backOut` / `elasticOut` give the springy pop. */
    easing?: KeyframeEasing;
}
/**
 * Spawn "pop-in": scales the node from `from`× up to its authored scale with an
 * overshoot easing. Ticked through `node.tick`, so it respects `Time.scale`.
 * The authored (resting) scale is captured once on start, so re-triggering the
 * pop always targets the correct final scale. Reusable as the `core:PopIn`
 * preset (auto-plays on start by default) or via `scene.juice.popIn(node)`.
 */
export declare class PopInBehavior extends Script {
    private active;
    private elapsed;
    private captured;
    private readonly baseScale;
    private readonly onTriggerSignal;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    onStart(): void;
    onDetach(): void;
    /** Configure (partial) and (re)start the pop. Used by the juice API. */
    play(options?: PopInOptions): void;
    /** (Re)start the pop from `from`× the authored scale. */
    trigger(): void;
    onUpdate(dt: number): void;
    private captureBase;
    private bindTrigger;
    private unbindTrigger;
    private getFrom;
    private getDuration;
    private getEasing;
    private getTriggerEvent;
    private setTriggerEvent;
    private static num;
}
