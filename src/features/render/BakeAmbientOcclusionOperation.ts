import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { GeometryMesh, SceneManager } from '@pix3/runtime';
import type { MeshStandardMaterial, Texture } from 'three';
import { ViewportRendererService } from '@/services/ViewportRenderService';

/** One node's freshly-baked AO assignment (texture already built + PNG saved). */
export interface BakedAOEntry {
  nodeId: string;
  texture: Texture;
  src: string;
}

interface PreviousAO {
  node: GeometryMesh;
  texture: Texture | null;
  src: string;
}

/**
 * Assigns baked ambient-occlusion maps onto their target nodes as a single
 * undoable step. The heavy work (GPU bake, PNG save, texture decode) happens in
 * {@link ../render/BakeAmbientOcclusionCommand} before this runs; here we only
 * swap `aoMap` / `aoMapSrc` on each node so undo/redo is instant.
 */
export class BakeAmbientOcclusionOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'render.bake-ambient-occlusion',
    title: 'Bake Ambient Occlusion',
    description: 'Assign baked AO maps to static meshes',
    tags: ['render', 'ao', 'lightmap'],
  };

  constructor(private readonly entries: readonly BakedAOEntry[]) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { container, state } = context;
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const graph = sceneManager.getActiveSceneGraph();
    if (!graph) {
      return { didMutate: false };
    }

    const previous: PreviousAO[] = [];
    for (const entry of this.entries) {
      const node = graph.nodeMap.get(entry.nodeId);
      if (!(node instanceof GeometryMesh)) {
        continue;
      }
      const material = node.renderMesh?.material as MeshStandardMaterial | undefined;
      previous.push({ node, texture: material?.aoMap ?? null, src: node.aoMapSrc });
      node.setAOMap(entry.texture);
      node.aoMapSrc = entry.src;
    }

    if (previous.length === 0) {
      return { didMutate: false };
    }

    this.markDirty(state);
    this.requestRender(container);

    const entries = this.entries;
    return {
      didMutate: true,
      commit: {
        label: 'Bake Ambient Occlusion',
        beforeSnapshot: context.snapshot,
        undo: async () => {
          for (const p of previous) {
            p.node.setAOMap(p.texture);
            p.node.aoMapSrc = p.src;
          }
          this.markDirty(state);
          this.requestRender(container);
        },
        redo: async () => {
          for (const p of previous) {
            const entry = entries.find(e => e.nodeId === p.node.nodeId);
            if (entry) {
              p.node.setAOMap(entry.texture);
              p.node.aoMapSrc = entry.src;
            }
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
      // Viewport not available (headless) — ignore.
    }
  }
}
