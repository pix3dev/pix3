/**
 * RemoveEffectOperation - detach a shader effect from any shader-effect host
 * node (GeometryMesh, Sprite2D, AnimatedSprite2D, Button2D, ...).
 */
import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { SceneManager, isShaderEffectHost } from '@pix3/runtime';

export interface RemoveEffectParams {
  nodeId: string;
  effectType: string;
}

export class RemoveEffectOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata;
  private readonly params: RemoveEffectParams;

  constructor(params: RemoveEffectParams) {
    this.params = params;
    this.metadata = {
      id: 'effects.remove-effect',
      title: 'Remove Effect',
      description: `Remove effect ${params.effectType} from node`,
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
      console.error('[RemoveEffectOperation] No active scene');
      return { didMutate: false };
    }

    const node = scene.nodeMap.get(this.params.nodeId);
    if (!node || !isShaderEffectHost(node)) {
      console.error(
        `[RemoveEffectOperation] Node "${this.params.nodeId}" does not host shader effects`
      );
      return { didMutate: false };
    }

    const stack = node.getShaderEffectStack();
    const removed = stack.detach(this.params.effectType);
    if (!removed) {
      return { didMutate: false };
    }
    // Snapshot the authored state so undo restores enabled + param overrides.
    const restore = { enabled: removed.enabled, params: { ...removed.params } };

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
        label: `Remove Effect ${this.params.effectType}`,
        undo: async () => {
          stack.attach(this.params.effectType, restore);
          markDirty();
        },
        redo: async () => {
          stack.detach(this.params.effectType);
          markDirty();
        },
      },
    };
  }
}
