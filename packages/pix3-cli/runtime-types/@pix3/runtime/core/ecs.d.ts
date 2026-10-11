import type { InputService } from './InputService';
import type { SceneService } from './SceneService';
export type ECSPhase = 'update' | 'fixedUpdate';
export interface ECSUpdateContext {
    readonly dt: number;
    readonly time: number;
    readonly frame: number;
    readonly fixedTimeStep: number;
    readonly alpha: number;
    readonly scene: SceneService;
    readonly input: InputService;
}
export interface ECSSystem {
    readonly id?: string;
    readonly phase: ECSPhase;
    update(context: ECSUpdateContext): void;
}
export interface ECSWorldAdapter<TWorld = unknown> {
    readonly world: TWorld;
    initialize?(context: ECSUpdateContext): void;
    dispose?(): void;
}
export interface ECSServiceOptions {
    fixedTimeStep?: number;
    maxFixedStepsPerFrame?: number;
}
export interface ECSRegistration<TWorld = unknown> {
    world: ECSWorldAdapter<TWorld>;
    systems: readonly ECSSystem[];
}
