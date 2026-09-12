import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';

export interface SetPlayPausedOperationParams {
  paused: boolean;
}

/**
 * Flip the running session between `playing` and `paused`.
 *
 * Deliberately commit-less, so it never lands in the undo stack: a pause is a view onto the running
 * game, not an edit to the project, and an undo that silently resumed (or re-froze) the game would
 * be one nothing on screen explains. `SetPlayModeOperation` still owns start/stop — this one only
 * ever touches `playModeStatus`, and only while `isPlaying` is true.
 */
export class SetPlayPausedOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scene.set-play-paused',
    title: 'Set Play Paused',
    description: 'Pause or resume the running play session',
    tags: ['scene', 'play-mode', 'ui'],
  };

  constructor(private readonly params: SetPlayPausedOperationParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, snapshot } = context;
    const nextStatus = this.params.paused ? 'paused' : 'playing';

    if (!snapshot.ui.isPlaying || snapshot.ui.playModeStatus === nextStatus) {
      return { didMutate: false };
    }

    state.ui.playModeStatus = nextStatus;

    return { didMutate: true };
  }
}
