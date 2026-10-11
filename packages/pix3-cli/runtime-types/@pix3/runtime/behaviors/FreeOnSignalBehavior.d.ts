import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
/**
 * FreeOnSignal — frees the host node (`queueFree`) once a given signal fires on
 * it, after an optional delay. The generic lifecycle half that pairs with any
 * "finished" signal: `animation-finished` from AnimatedSprite2D/3D (one-shot
 * VFX), a fade/sound completion, a gameplay `damaged`/`died` event, etc.
 *
 * Defaults are the one-shot-VFX case (fire on `animation-finished`, free
 * immediately), so a self-destroying flipbook prefab is zero-config:
 *   type: AnimatedSprite2D (loop:false)  +  core:FreeOnSignal
 *
 * Inert in edit mode by construction — it only acts on a play-driven signal and
 * a running `onUpdate`, so nodes never disappear while authoring.
 */
export declare class FreeOnSignalBehavior extends Script {
    private armed;
    private remaining;
    private boundSignal;
    private readonly onSignal;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    onStart(): void;
    onUpdate(dt: number): void;
    onDetach(): void;
    private bind;
    private unbind;
    private getSignal;
    private setSignal;
    private getDelay;
    private setDelay;
}
