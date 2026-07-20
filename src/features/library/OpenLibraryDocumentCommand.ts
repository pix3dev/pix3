import { inject } from '@/fw/di';
import { LayoutManagerService } from '@/core/LayoutManager';
import { CommandBase, type CommandExecutionResult, type CommandMetadata } from '@/core/command';

/**
 * Reveal the Asset Library panel (reusable prefabs/images/fonts/audio/shaders across projects).
 * It docks as a normal panel the user can drag/snap anywhere — e.g. beside the viewport so the
 * editor and library sit side by side. Revealing a panel is not an undoable state change, so this
 * returns `didMutate: false` and never creates an Operation.
 */
export class OpenLibraryDocumentCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'library.open-document',
    title: 'Asset Library',
    description: 'Open the reusable asset library (prefabs, images, fonts, audio, shaders)',
    menuPath: 'view',
    addToMenu: true,
    menuOrder: 48,
    keywords: ['library', 'assets', 'store', 'prefab', 'reuse', 'kit', 'marketplace'],
  };

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  async execute(): Promise<CommandExecutionResult<void>> {
    this.layoutManager.revealLibraryPanel();
    return {
      didMutate: false,
      payload: undefined,
    };
  }
}
