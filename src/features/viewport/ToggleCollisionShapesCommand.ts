import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { ToggleUIFlagOperation } from './ToggleUIFlagOperation';

/**
 * Godot's "Visible Collision Shapes", for the editor viewport.
 *
 * Distinct from `view.toggle-colliders`, which is the *running game's* physics
 * wireframe overlay: this one draws the authored `core:Hitbox2D` outlines while
 * editing, where nothing renders them otherwise (the editor draws proxy meshes,
 * not the runtime nodes that carry a hitbox's debug line). A selected node always
 * shows its colliders; this extends that to the whole scene.
 */
export class ToggleCollisionShapesCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.toggle-collision-shapes',
    title: 'Collision Shapes',
    description: 'Show or hide authored 2D collider outlines for every node in the viewport',
    keywords: ['collision', 'collider', 'hitbox', 'polygon', 'shapes', 'viewport', 'toggle'],
    menuPath: 'view',
    addToMenu: true,
    menuOrder: 500,
    checked: snapshot => snapshot.ui.showCollisionShapes,
  };

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    await operations.invoke(
      new ToggleUIFlagOperation('showCollisionShapes', 'Toggle Collision Shapes')
    );

    return { didMutate: true, payload: undefined };
  }
}
