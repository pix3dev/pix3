import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
/**
 * SfxOnSignal — plays a procedural {@link SfxPreset} on the `sfx` bus whenever a
 * signal fires on this node. The asset-free counterpart of `core:PlaySound`: no
 * audio file, no import, no loading — pick the preset that matches the beat
 * (`bounce` on a wall hit, `score` on a bumper, `lose` on a drain).
 *
 * Silent no-op when Web Audio is unavailable (headless runs, tests).
 */
export declare class SfxOnSignalBehavior extends Script {
    private boundSignal;
    private readonly onSignal;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    onStart(): void;
    onDetach(): void;
    private bind;
    private unbind;
    private getSignal;
    private setSignal;
    private getPreset;
    private getVolume;
    private getPitch;
    private static clamp01;
}
