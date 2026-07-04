import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import { AddComponentOperation } from '@/features/scripts/AddComponentOperation';
import { createDefaultClip, SceneManager } from '@pix3/runtime';
import { ANIMATION_PLAYER_COMPONENT_TYPE } from './UpdateAnimationPlayerClipsOperation';

/**
 * Adds a `core:AnimationPlayer` component (seeded with one empty clip) to the
 * primary selected node. Used by the timeline panel's empty state and the
 * command palette.
 */
export class AddAnimationPlayerToSelectionCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'animation-timeline.add-player',
    title: 'Add Animation Player',
    description: 'Attach an AnimationPlayer component to the selected node',
    keywords: ['animation', 'player', 'keyframe', 'component', 'add'],
  };

  preconditions(context: CommandContext) {
    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    const scene = sceneManager.getActiveSceneGraph();
    if (!scene) {
      return { canExecute: false as const, reason: 'No active scene' };
    }

    const nodeId = context.state.selection.primaryNodeId;
    if (!nodeId) {
      return { canExecute: false as const, reason: 'No node selected' };
    }

    const node = scene.nodeMap.get(nodeId);
    if (!node) {
      return { canExecute: false as const, reason: 'Selected node not found' };
    }

    const hasPlayer = node.components.some(c => c.type === ANIMATION_PLAYER_COMPONENT_TYPE);
    if (hasPlayer) {
      return {
        canExecute: false as const,
        reason: 'Node already has an AnimationPlayer component',
      };
    }

    return { canExecute: true as const };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const nodeId = context.state.selection.primaryNodeId;
    if (!nodeId) {
      return { didMutate: false, payload: undefined };
    }

    const componentId = `${nodeId}-animation-player-${Date.now()}`;
    const pushed = await operations.invokeAndPush(
      new AddComponentOperation({
        nodeId,
        componentType: ANIMATION_PLAYER_COMPONENT_TYPE,
        componentId,
        config: {
          autoplay: '',
          speed: 1,
          animations: { version: '1.0.0', clips: [createDefaultClip('new-clip')] },
        },
      })
    );

    return { didMutate: pushed, payload: undefined };
  }
}
