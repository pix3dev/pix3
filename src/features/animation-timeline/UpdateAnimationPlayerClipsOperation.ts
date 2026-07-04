/**
 * UpdateAnimationPlayerClipsOperation — the single mutation seam for all
 * keyframe animation edits (clip CRUD, tracks, keys, duration/loop).
 *
 * The clip data lives in `config.animations` of a `core:AnimationPlayer`
 * component, so this operation mutates the component config in place and the
 * data serializes with the scene. Call sites pass `options.coalesceKey` to
 * `OperationService.invokeAndPush` for drag interactions, together with a
 * `previousSet` captured at drag start so the coalesced history entry undoes
 * back to the pre-drag state.
 */

import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import {
  normalizeKeyframeAnimationSet,
  SceneManager,
  type AnimationPlayerBehavior,
  type KeyframeAnimationSet,
  type ScriptComponent,
} from '@pix3/runtime';

export const ANIMATION_PLAYER_COMPONENT_TYPE = 'core:AnimationPlayer';
export const UPDATE_ANIMATION_CLIPS_OPERATION_ID = 'animation-timeline.update-clips';

export interface UpdateAnimationPlayerClipsParams {
  nodeId: string;
  componentId: string;
  /** Mutate the cloned draft in place or return a replacement set. */
  updater: (draft: KeyframeAnimationSet) => KeyframeAnimationSet | void;
  /** History entry label, e.g. 'Add track position'. */
  label: string;
  /** Drag-start snapshot; undo of a coalesced drag restores this set. */
  previousSet?: KeyframeAnimationSet;
}

export class UpdateAnimationPlayerClipsOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: UPDATE_ANIMATION_CLIPS_OPERATION_ID,
    title: 'Update Animation Clips',
    description: 'Update keyframe animation clips on an AnimationPlayer component',
    affectsNodeStructure: false,
    tags: ['animation-timeline', 'scripts', 'component'],
  };

  constructor(private readonly params: UpdateAnimationPlayerClipsParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { container, state } = context;

    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const scene = sceneManager.getActiveSceneGraph();
    if (!scene) {
      return { didMutate: false };
    }

    const node = scene.nodeMap.get(this.params.nodeId);
    if (!node || !Array.isArray(node.components)) {
      return { didMutate: false };
    }

    const component = node.components.find(c => c.id === this.params.componentId);
    if (!component || component.type !== ANIMATION_PLAYER_COMPONENT_TYPE) {
      return { didMutate: false };
    }

    const current = normalizeKeyframeAnimationSet(component.config.animations);
    const draft = structuredClone(current);
    const next = normalizeKeyframeAnimationSet(this.params.updater(draft) ?? draft);

    const previous =
      this.params.previousSet !== undefined
        ? normalizeKeyframeAnimationSet(this.params.previousSet)
        : current;

    const currentJson = JSON.stringify(current);
    const nextJson = JSON.stringify(next);
    const previousJson = JSON.stringify(previous);

    if (currentJson === nextJson && previousJson === nextJson) {
      return { didMutate: false };
    }

    const activeSceneId = state.scenes.activeSceneId;
    const applySet = (set: KeyframeAnimationSet): void => {
      component.config.animations = structuredClone(set);
      this.invalidateBindings(component);
      this.markSceneDirty(state, activeSceneId);
    };

    if (currentJson !== nextJson) {
      applySet(next);
    }

    return {
      didMutate: true,
      commit: {
        label: this.params.label,
        beforeSnapshot: context.snapshot,
        undo: async () => {
          applySet(previous);
        },
        redo: async () => {
          applySet(next);
        },
      },
    };
  }

  private invalidateBindings(component: ScriptComponent): void {
    const player = component as Partial<Pick<AnimationPlayerBehavior, 'invalidateBindings'>>;
    player.invalidateBindings?.();
  }

  private markSceneDirty(state: OperationContext['state'], activeSceneId: string | null): void {
    if (!activeSceneId) {
      return;
    }
    const descriptor = state.scenes.descriptors[activeSceneId];
    if (descriptor) {
      descriptor.isDirty = true;
    }
    state.scenes.lastLoadedAt = Date.now();
  }
}
