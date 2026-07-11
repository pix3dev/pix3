/**
 * AddEffectOperation - attach a shader effect to a GeometryMesh.
 */
import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneManager, GeometryMesh } from '@pix3/runtime';

export interface AddEffectParams {
  nodeId: string;
  effectType: string;
}

export class AddEffectOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata;
  private readonly params: AddEffectParams;

  constructor(params: AddEffectParams) {
    this.params = params;
    this.metadata = {
      id: 'effects.add-effect',
      title: 'Add Effect',
      description: `Add effect ${params.effectType} to node`,
      affectsNodeStructure: false,
      tags: ['effects', 'shader'],
    };
  }

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { container } = context;
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );

    const scene = sceneManager.getActiveSceneGraph();
    if (!scene) {
      console.error('[AddEffectOperation] No active scene');
      return { didMutate: false };
    }

    const node = scene.nodeMap.get(this.params.nodeId);
    if (!(node instanceof GeometryMesh)) {
      console.error(`[AddEffectOperation] Node "${this.params.nodeId}" is not a GeometryMesh`);
      return { didMutate: false };
    }

    const attached = node.attachEffect(this.params.effectType);
    if (!attached) {
      // Already attached (one-per-type) or unknown type.
      return { didMutate: false };
    }

    const activeSceneId = context.state.scenes.activeSceneId;
    const markDirty = (): void => {
      if (activeSceneId) {
        const descriptor = context.state.scenes.descriptors[activeSceneId];
        if (descriptor) descriptor.isDirty = true;
      }
    };
    markDirty();

    return {
      didMutate: true,
      commit: {
        label: `Add Effect ${this.params.effectType}`,
        undo: async () => {
          node.detachEffect(this.params.effectType);
          markDirty();
        },
        redo: async () => {
          node.attachEffect(this.params.effectType);
          markDirty();
        },
      },
    };
  }
}
