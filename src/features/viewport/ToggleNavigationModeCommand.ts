import { CommandBase, type CommandContext, type CommandExecutionResult } from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { SceneManager, Node3D } from '@pix3/runtime';
import { SelectObjectOperation } from '@/features/selection/SelectObjectOperation';
import type { NavigationMode } from '@/state';
import {
  deriveSceneLayerCapabilities,
  isNavigationModeAvailable,
} from '@/features/viewport/scene-layer-capabilities';

export interface ToggleNavigationModeParams {
  mode?: NavigationMode;
}

export class ToggleNavigationModeCommand extends CommandBase<void, void> {
  readonly metadata = {
    id: 'viewport.toggle-navigation-mode',
    title: 'Toggle Navigation Mode',
    description: 'Switch between 3D orbit navigation and 2D orthographic navigation',
    keywords: ['viewport', 'navigation', '2d', '3d', 'camera'],
    menuPath: 'view',
    keybinding: 'N',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 24,
  } as const;

  private readonly params: ToggleNavigationModeParams;

  constructor(params: ToggleNavigationModeParams = {}) {
    super();
    this.params = params;
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const { snapshot, state, container } = context;
    const currentMode: NavigationMode = snapshot.ui.navigationMode ?? '3d';
    const nextMode: NavigationMode = this.params.mode ?? (currentMode === '3d' ? '2d' : '3d');

    if (currentMode === nextMode) {
      return { didMutate: false, payload: undefined };
    }

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const capabilities = deriveSceneLayerCapabilities(sceneManager.getActiveSceneGraph());

    // Respect the layer lock: a scene with only one kind of content cannot enter
    // the navigation mode for the absent dimension (keyboard shortcut / command).
    if (!isNavigationModeAvailable(nextMode, capabilities)) {
      return { didMutate: false, payload: undefined };
    }

    state.ui.navigationMode = nextMode;

    if (nextMode === '2d' && snapshot.selection.nodeIds.length > 0) {
      const sceneGraph = sceneManager.getActiveSceneGraph();
      if (sceneGraph) {
        const has3DSelection = snapshot.selection.nodeIds.some(nodeId => {
          const node = sceneGraph.nodeMap.get(nodeId);
          return node instanceof Node3D;
        });

        if (has3DSelection) {
          const operations = container.getService<OperationService>(
            container.getOrCreateToken(OperationService)
          );
          await operations.invokeAndPush(new SelectObjectOperation({ nodeId: null }));
        }
      }
    }

    return { didMutate: true, payload: undefined };
  }
}

export const toggleNavigationMode = () => new ToggleNavigationModeCommand();
export const setNavigationMode = (mode: NavigationMode) =>
  new ToggleNavigationModeCommand({ mode });
