import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
} from '@/core/command';
import type { KeybindingDescriptor } from '@/core/keybinding';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

/** Step in world units for a normal arrow-key nudge. */
const NUDGE_STEP = 1;
/** Larger step used when Shift is held. */
const NUDGE_STEP_LARGE = 10;

export type NudgeDirection = 'up' | 'down' | 'left' | 'right';

interface NudgeCommandOptions {
  direction: NudgeDirection;
  large: boolean;
}

const DIRECTION_KEY: Record<NudgeDirection, string> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
};

const DIRECTION_LABEL: Record<NudgeDirection, string> = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
};

/**
 * Moves the currently selected 2D nodes by one step in a cardinal direction.
 * Registered as eight instances (four directions × normal/large) so that each
 * arrow key — and its Shift variant for a coarser step — maps to a keybinding.
 * Only active while the viewport is focused and no text input has focus.
 */
export class NudgeNodesCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata;
  private readonly dx: number;
  private readonly dy: number;

  constructor(options: NudgeCommandOptions) {
    super();
    const { direction, large } = options;
    const step = large ? NUDGE_STEP_LARGE : NUDGE_STEP;

    // Screen up is +Y in the 2D world (matches dragging).
    const deltas: Record<NudgeDirection, { dx: number; dy: number }> = {
      up: { dx: 0, dy: step },
      down: { dx: 0, dy: -step },
      left: { dx: -step, dy: 0 },
      right: { dx: step, dy: 0 },
    };
    this.dx = deltas[direction].dx;
    this.dy = deltas[direction].dy;

    const keybinding: KeybindingDescriptor = large
      ? `Shift+${DIRECTION_KEY[direction]}`
      : DIRECTION_KEY[direction];

    this.metadata = {
      id: `transform.nudge-${direction}${large ? '-large' : ''}`,
      title: `Nudge ${DIRECTION_LABEL[direction]}${large ? ' (Large)' : ''}`,
      description: `Move selected 2D nodes ${DIRECTION_LABEL[direction].toLowerCase()} by ${step} unit${step === 1 ? '' : 's'}`,
      keywords: ['nudge', 'move', 'arrow', direction],
      keybinding,
      when: 'viewportFocused && !isInputFocused',
    };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const viewportRenderer = context.container.getService<ViewportRendererService>(
      context.container.getOrCreateToken(ViewportRendererService)
    );

    const didMutate = await viewportRenderer.nudgeSelected2DNodes(this.dx, this.dy);

    return {
      didMutate,
      payload: undefined,
    };
  }
}
