/**
 * AddEffectOperation - attach a shader effect to any shader-effect host node
 * (GeometryMesh, Sprite2D, AnimatedSprite2D, Button2D, ...).
 */
import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneManager, isShaderEffectHost } from '@pix3/runtime';

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
    if (!node || !isShaderEffectHost(node)) {
      console.error(
        `[AddEffectOperation] Node "${this.params.nodeId}" does not host shader effects`
      );
      return { didMutate: false };
    }

    const stack = node.getShaderEffectStack();
    const attached = stack.attach(this.params.effectType);
    if (!attached) {
      // Already attached (one-per-type), unknown type, or unsupported target.
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
          stack.detach(this.params.effectType);
          markDirty();
        },
        redo: async () => {
          stack.attach(this.params.effectType);
          markDirty();
        },
      },
    };
  }
}
