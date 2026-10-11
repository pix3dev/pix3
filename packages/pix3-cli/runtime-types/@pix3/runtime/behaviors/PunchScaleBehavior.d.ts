import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
export interface PunchScaleOptions {
    /** Peak scale delta (0.3 = +30% at the first bounce). */
    amount?: number;
    /** Duration in seconds. */
    duration?: number;
    /** Number of oscillations before settling. */
    vibrato?: number;
}
/**
 * Squash-and-stretch "punch" on the node's scale — an instant pop that
 * oscillates back to the authored scale. Ticked through `node.tick`, so it
 * respects the global `Time.scale`. Reusable as the `core:PunchScale` preset
 * (trigger on a signal / play on start) or via `scene.juice.punchScale(node)`.
 *
 * The resting scale is captured on trigger (not construction), so it plays
 * correctly regardless of the node's authored scale and never drifts.
 */
export declare class PunchScaleBehavior extends Script {
    private active;
    private elapsed;
    private readonly baseScale;
    private readonly onTriggerSignal;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    onStart(): void;
    onDetach(): void;
    /** Configure (partial) and (re)start the punch. Used by the juice API. */
    play(options?: PunchScaleOptions): void;
    /** (Re)start the punch from the beginning. */
    trigger(): void;
    onUpdate(dt: number): void;
    private restore;
    private bindTrigger;
    private unbindTrigger;
    private getAmount;
    private getDuration;
    private getVibrato;
    private getTriggerEvent;
    private setTriggerEvent;
    private static num;
}
