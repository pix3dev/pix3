import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { GeometryMesh, SceneManager } from '@pix3/runtime';
import type { MeshStandardMaterial, Texture } from 'three';
import { ViewportRendererService } from '@/services/ViewportRenderService';

interface ClearedAO {
  node: GeometryMesh;
  texture: Texture | null;
  src: string;
}

/**
 * Removes the baked AO map from every `GeometryMesh` in the active scene, as a
 * single undoable step (undo restores the previous `aoMap` / `aoMapSrc`). File
 * deletion is handled separately by
 * {@link ../render/ClearAmbientOcclusionCommand} — undo restores the in-memory
 * texture, but not deleted files (re-bake to regenerate).
 */
export class ClearAmbientOcclusionOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'render.clear-ambient-occlusion',
    title: 'Clear Ambient Occlusion',
    description: 'Remove baked AO maps from static meshes',
    tags: ['render', 'ao', 'lightmap'],
  };

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { container, state } = context;
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const graph = sceneManager.getActiveSceneGraph();
    if (!graph) {
      return { didMutate: false };
    }

    const cleared: ClearedAO[] = [];
    for (const node of graph.nodeMap.values()) {
      if (!(node instanceof GeometryMesh) || !node.aoMapSrc) {
        continue;
      }
      const material = node.renderMesh?.material as MeshStandardMaterial | undefined;
      cleared.push({ node, texture: material?.aoMap ?? null, src: node.aoMapSrc });
      node.setAOMap(null);
      node.aoMapSrc = '';
    }

    if (cleared.length === 0) {
      return { didMutate: false };
    }

    this.markDirty(state);
    this.requestRender(container);

    return {
      didMutate: true,
      commit: {
        label: 'Clear Ambient Occlusion',
        beforeSnapshot: context.snapshot,
        undo: async () => {
          for (const c of cleared) {
            c.node.setAOMap(c.texture);
            c.node.aoMapSrc = c.src;
          }
          this.markDirty(state);
          this.requestRender(container);
        },
        redo: async () => {
          for (const c of cleared) {
            c.node.setAOMap(null);
            c.node.aoMapSrc = '';
          }
          this.markDirty(state);
          this.requestRender(container);
        },
      },
    };
  }

  private markDirty(state: OperationContext['state']): void {
    const activeSceneId = state.scenes.activeSceneId;
    if (activeSceneId) {
      state.scenes.lastLoadedAt = Date.now();
      const descriptor = state.scenes.descriptors[activeSceneId];
      if (descriptor) {
        descriptor.isDirty = true;
      }
    }
  }

  private requestRender(container: OperationContext['container']): void {
    try {
      const vr = container.getService(
        container.getOrCreateToken(ViewportRendererService)
      ) as ViewportRendererService;
      vr.requestRender();
    } catch {
      // Viewport not available — ignore.
    }
  }
}
