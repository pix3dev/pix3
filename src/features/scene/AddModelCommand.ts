import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  AddModelOperation,
  type AddModelOperationParams,
} from '@/features/scene/AddModelOperation';
import { requireActiveScene } from '@/features/scene/scene-command-utils';

export type AddModelCommandPayload = object;

export class AddModelCommand extends CommandBase<AddModelCommandPayload, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.add-model',
    title: 'Add Model to Scene',
    description: 'Add a model file to the scene hierarchy',
    keywords: ['add', 'model', 'mesh', 'glb', 'gltf', 'import'],
  };

  private readonly params: AddModelOperationParams;

  constructor(params: AddModelOperationParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext) {
    return requireActiveScene(context, 'An active scene is required to add a model');
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<AddModelCommandPayload>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const op = new AddModelOperation(this.params);
    const pushed = await operations.invokeAndPush(op);
    return { didMutate: pushed, payload: {} };
  }
}
