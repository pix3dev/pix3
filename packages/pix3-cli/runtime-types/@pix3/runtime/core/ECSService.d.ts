import type { ECSRegistration, ECSServiceOptions } from './ecs';
import type { InputService } from './InputService';
import type { SceneService } from './SceneService';
export declare class ECSService {
    readonly fixedTimeStep: number;
    readonly maxFixedStepsPerFrame: number;
    private readonly registrations;
    private scene;
    private input;
    private elapsedTime;
    private frame;
    private alpha;
    constructor(options?: ECSServiceOptions);
    registerWorld<TWorld>(registration: ECSRegistration<TWorld>): () => void;
    clear(): void;
    dispose(): void;
    beginScene(scene: SceneService, input: InputService): void;
    endScene(): void;
    setInterpolationAlpha(alpha: number): void;
    setFrameMetrics(time: number, frame: number): void;
    update(dt: number, alpha?: number): void;
    fixedUpdate(dt: number): void;
    private runPhase;
    private tryCreateContext;
    private disposeRegistration;
}
