import { Script } from '../core/ScriptComponent';
import { type KeyframeEasing } from '../animation/easing';
import type { PropertySchema } from '../fw/property-schema';
/**
 * Cinemachine-lite "brain". Attach to a `Camera3D` (the single render camera).
 * Each frame it solves every {@link VirtualCamera3D} in the scene, picks the
 * highest-priority visible one, and drives the host camera toward it — cutting
 * with an eased blend (using the target camera's own blend settings) whenever
 * the active virtual camera changes.
 *
 * The host camera is the only camera that renders; virtual cameras never do.
 * When no virtual camera is present the brain leaves the host camera untouched,
 * so a plain `Camera3D` keeps working exactly as before.
 */
export declare class CameraBrainBehavior extends Script {
    private currentActiveId;
    private blending;
    private blendElapsed;
    private blendDuration;
    private blendEasing;
    /**
     * One-shot blend override consumed by the next {@link beginBlend} (whenever the
     * active virtual camera changes). Set by {@link overrideNextBlend}; the Cutscene
     * Director uses it to force a specific blend into and out of a cinematic vcam,
     * winning even when `blendEnabled` is off.
     */
    private pendingBlendOverride;
    private readonly blendFromPos;
    private readonly blendFromQuat;
    private blendFromFov;
    private blendFromOrtho;
    private readonly targetPos;
    private readonly targetQuat;
    private readonly outPos;
    private readonly outQuat;
    private readonly parentQuat;
    private readonly localPos;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    onStart(): void;
    /**
     * Force the next camera-activation blend to use `durationSec` (and optionally
     * `easing`), regardless of the target vcam's own blend settings or the
     * `blendEnabled` flag. Consumed once, by the next {@link beginBlend}. A duration
     * of 0 makes the next switch a hard cut. Used by the Cutscene Director to
     * smooth the cut into and out of a cinematic virtual camera.
     */
    overrideNextBlend(durationSec: number, easing?: KeyframeEasing): void;
    onUpdate(dt: number): void;
    private beginBlend;
    private applyToHost;
    private pickActive;
    private collectVirtualCameras;
    private rootsFromHost;
}
