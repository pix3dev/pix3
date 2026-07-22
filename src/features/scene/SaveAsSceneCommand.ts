import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { FileSystemAPIService } from '@/services/project/FileSystemAPIService';
import {
  SaveAsSceneOperation,
  type SaveAsSceneOperationParams,
} from '@/features/scene/SaveAsSceneOperation';
import { SceneManager } from '@pix3/runtime';

export class SaveAsSceneCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.save-as',
    title: 'Save As',
    description: 'Save the active scene to a new file',
    keywords: ['save', 'scene', 'export', 'as'],
    menuPath: 'file',
    keybinding: 'Mod+Shift+S',
    when: '!isInputFocused',
    addToMenu: true,
  };

  private params?: SaveAsSceneOperationParams;

  constructor(params?: SaveAsSceneOperationParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );

    console.debug('[SaveAsSceneCommand] Checking preconditions', {
      projectStatus: context.state.project.status,
      activeSceneId: context.state.scenes.activeSceneId,
    });

    if (context.state.project.status !== 'ready') {
      console.warn('[SaveAsSceneCommand] Project not ready:', context.state.project.status);
      return {
        canExecute: false,
        reason: 'Project must be opened before saving scenes',
        scope: 'project',
        recoverable: true,
      };
    }

    const activeGraph = sceneManager.getActiveSceneGraph();
    const hasActiveScene = Boolean(activeGraph);
    console.debug('[SaveAsSceneCommand] Active scene check', {
      hasActiveScene,
      rootNodeCount: activeGraph?.rootNodes.length,
    });

    if (!hasActiveScene) {
      console.warn('[SaveAsSceneCommand] No active scene');
      return {
        canExecute: false,
        reason: 'An active scene is required to save',
        scope: 'scene',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const fileSystemService = context.container.getService<FileSystemAPIService>(
      context.container.getOrCreateToken(FileSystemAPIService)
    );

    // If no params provided, open a file picker
    let filePath = this.params?.filePath;
    let fileHandle: FileSystemFileHandle | undefined;
    let isHandleInProject = false;

    if (!filePath) {
      try {
        // Use showSaveFilePicker API to let user choose destination
        type ShowSaveFilePickerFn = (opts?: unknown) => Promise<FileSystemFileHandle>;
        type WindowWithSave = { showSaveFilePicker?: ShowSaveFilePickerFn };
        const w = window as unknown as WindowWithSave;
        const showSaveFilePicker = w.showSaveFilePicker;

        const handle = await showSaveFilePicker?.({
          suggestedName: 'scene.pix3scene',
          types: [
            {
              description: 'Pix3 Scene Files',
              accept: { 'application/yaml': ['.pix3scene'] },
            },
          ],
        });

        if (!handle) {
          console.warn('[SaveAsSceneCommand] User cancelled file picker');
          return { didMutate: false, payload: undefined };
        }

        console.debug('[SaveAsSceneCommand] User selected file:', handle.name);
        fileHandle = handle;

        // Check if the selected file is within the project
        if (fileHandle) {
          isHandleInProject = await fileSystemService.isHandleInProject(fileHandle);
          if (isHandleInProject) {
            const resolved = await fileSystemService.resolveHandleToResourcePath(fileHandle);
            if (resolved) {
              filePath = resolved;
            }
          }
          console.debug('[SaveAsSceneCommand] Checked if file is in project', {
            fileName: fileHandle.name,
            isInProject: isHandleInProject,
          });
        }
      } catch (error) {
        // User cancelled or error occurred
        if (error instanceof Error && error.name !== 'AbortError') {
          console.error('[SaveAsSceneCommand] File picker error:', error);
        }
        return { didMutate: false, payload: undefined };
      }
    }

    if (!filePath && !fileHandle) {
      console.error('[SaveAsSceneCommand] No file path or handle available');
      return { didMutate: false, payload: undefined };
    }

    console.debug('[SaveAsSceneCommand] Executing save', {
      filePath,
      hasFileHandle: !!fileHandle,
      fileName: fileHandle?.name,
      isHandleInProject,
    });

    const op = new SaveAsSceneOperation({
      filePath: filePath || '',
      fileHandle,
      isHandleInProject,
      sceneId: undefined,
    });
    const pushed = await operationService.invokeAndPush(op);

    if (pushed) {
      console.info('[SaveAsSceneCommand] Scene saved successfully');
    } else {
      console.warn('[SaveAsSceneCommand] Operation was not pushed to history');
    }

    return { didMutate: pushed, payload: undefined };
  }
}
