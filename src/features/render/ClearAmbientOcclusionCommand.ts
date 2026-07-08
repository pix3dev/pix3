import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { appState } from '@/state';
import { ProjectService } from '@/services/ProjectService';
import { OperationService } from '@/services/OperationService';
import { ClearAmbientOcclusionOperation } from '@/features/render/ClearAmbientOcclusionOperation';

/**
 * Removes baked ambient-occlusion maps from the active scene: unassigns `aoMap`
 * from every static mesh (undoable) and deletes this scene's baked PNGs from
 * `res://lightmaps/<scene>/` so they don't ship in the export. Use when
 * abandoning baked AO for a scene (e.g. switching to realtime SSAO in-game).
 */
export class ClearAmbientOcclusionCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'render.clear-ao',
    title: 'Clear Baked Ambient Occlusion',
    description: 'Remove baked AO maps from this scene and delete their lightmap files',
    keywords: ['ao', 'ambient', 'occlusion', 'clear', 'remove', 'delete', 'lightmap'],
    menuPath: 'tools',
    addToMenu: true,
    menuOrder: 61,
  };

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const { container } = context;

    const operations = container.getService<OperationService>(
      container.getOrCreateToken(OperationService)
    );
    const unassigned = await operations.invokeAndPush(new ClearAmbientOcclusionOperation());

    // Best-effort delete of this scene's baked lightmap folder.
    const sceneKey = (appState.scenes.activeSceneId ?? 'scene').replace(/[^a-z0-9_-]+/gi, '_');
    const projectService = container.getService<ProjectService>(
      container.getOrCreateToken(ProjectService)
    );
    let filesDeleted = false;
    try {
      await projectService.deleteEntry(`lightmaps/${sceneKey}`);
      filesDeleted = true;
    } catch {
      // Nothing to delete (never baked, or already gone).
    }

    if (!unassigned && !filesDeleted) {
      console.warn('[BakeAO] No baked AO to clear in the active scene.');
      return { didMutate: false, payload: undefined };
    }

    console.log(`[BakeAO] Cleared baked AO (files removed: ${filesDeleted}) for "${sceneKey}".`);
    return { didMutate: unassigned, payload: undefined };
  }
}
