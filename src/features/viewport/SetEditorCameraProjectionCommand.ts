import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import type { EditorCameraProjection } from '@/state';
import { OperationService } from '@/services/OperationService';
import { SetEditorCameraProjectionOperation } from './SetEditorCameraProjectionOperation';

class SetEditorCameraProjectionCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'viewport.set-editor-camera-projection',
    title: 'Set Editor Camera Projection',
    description: 'Switch the editor viewport between perspective and orthographic projection',
    keywords: ['viewport', 'camera', 'projection', 'perspective', 'orthographic'],
  };

  constructor(private readonly projection: EditorCameraProjection) {
    super();
  }

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const result = await operations.invoke(
      new SetEditorCameraProjectionOperation({ projection: this.projection })
    );

    return {
      didMutate: result.didMutate,
      payload: undefined,
    };
  }
}

export const setEditorCameraProjection = (projection: EditorCameraProjection) =>
  new SetEditorCameraProjectionCommand(projection);
