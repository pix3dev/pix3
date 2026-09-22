import { type CommandMetadata } from '@/core/command';
import {
  CreateNodeBaseCommand,
  type CreateNodeCommandPayload,
} from '@/features/scene/CreateNodeBaseCommand';
import {
  CreatePrefabInstanceOperation,
  type CreatePrefabInstanceOperationParams,
} from '@/features/scene/CreatePrefabInstanceOperation';

export type CreatePrefabInstanceCommandPayload = CreateNodeCommandPayload;

export class CreatePrefabInstanceCommand extends CreateNodeBaseCommand<
  CreatePrefabInstanceOperationParams,
  CreatePrefabInstanceCommandPayload
> {
  readonly metadata: CommandMetadata = {
    id: 'scene.create-prefab-instance',
    title: 'Create Prefab Instance',
    description: 'Instantiate a prefab scene asset in the active scene',
    keywords: ['prefab', 'instance', 'scene', 'create', 'drag-drop'],
    // Not a menu row: the command cannot run without a `prefabPath`, so there is nothing for a
    // zero-argument menu item to do. Prefabs are instantiated by dragging them in from the Assets
    // browser or the Library, and from the Scene Tree's insert flow. (It carried `menuPath:'insert'`
    // for a while, but nothing ever registered the command, so that menu never actually existed.)
    addToMenu: false,
  };

  constructor(params: CreatePrefabInstanceOperationParams) {
    super(
      params,
      operationParams => new CreatePrefabInstanceOperation(operationParams),
      'An active scene is required to create a prefab instance'
    );
  }
}
