import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { Texture } from 'three';
import { GeometryMesh, SceneManager } from '@pix3/runtime';
import type { Mesh } from 'three';
import { appState } from '@/state';
import { ProjectService } from '@/services/project/ProjectService';
import { OperationService } from '@/services/core/OperationService';
import { AOBakeService, type AOBakeTarget } from '@/services/ao-bake/AOBakeService';
import {
  BakeAmbientOcclusionOperation,
  type BakedAOEntry,
} from '@/features/render/BakeAmbientOcclusionOperation';

/**
 * Bakes ambient occlusion for every static `GeometryMesh` in the active scene
 * into per-mesh lightmap textures, saves them under `res://lightmaps/<scene>/`,
 * and assigns them (undoably). Occluders = the same mesh set, so occlusion is
 * mutual (a box darkens the ground and the ground darkens the box).
 */
export class BakeAmbientOcclusionCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'render.bake-ao',
    title: 'Bake Ambient Occlusion',
    description: 'Bake AO for static meshes in this scene into lightmap textures',
    keywords: ['ao', 'ambient', 'occlusion', 'bake', 'lightmap', 'shadow'],
    menuPath: 'tools',
    addToMenu: true,
    menuOrder: 60,
  };

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const { container } = context;
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const graph = sceneManager.getActiveSceneGraph();
    if (!graph) {
      return { didMutate: false, payload: undefined };
    }

    // Collect static GeometryMesh nodes (visible ones) as both targets + occluders.
    const targets: AOBakeTarget[] = [];
    const occluders: Mesh[] = [];
    for (const node of graph.nodeMap.values()) {
      if (!(node instanceof GeometryMesh) || !node.visible) {
        continue;
      }
      node.ensureLightmapUV();
      const mesh = node.renderMesh;
      if (mesh) {
        targets.push({ id: node.nodeId, mesh });
        occluders.push(mesh);
      }
    }

    if (targets.length === 0) {
      console.warn('[BakeAO] No static GeometryMesh nodes to bake in the active scene.');
      return { didMutate: false, payload: undefined };
    }

    const baker = new AOBakeService();
    const pngs = await baker.bake(targets, occluders, { resolution: 256, samples: 64 });

    const sceneKey = (appState.scenes.activeSceneId ?? 'scene').replace(/[^a-z0-9_-]+/gi, '_');
    const projectService = container.getService<ProjectService>(
      container.getOrCreateToken(ProjectService)
    );
    await this.ensureDir(projectService, 'lightmaps');
    await this.ensureDir(projectService, `lightmaps/${sceneKey}`);

    const entries: BakedAOEntry[] = [];
    for (const [nodeId, png] of pngs) {
      const path = `lightmaps/${sceneKey}/${nodeId}.png`;
      await projectService.writeBinaryFile(path, png.buffer as ArrayBuffer);
      const texture = await this.decodeTexture(png);
      entries.push({ nodeId, texture, src: `res://${path}` });
    }

    if (entries.length === 0) {
      return { didMutate: false, payload: undefined };
    }

    const operations = container.getService<OperationService>(
      container.getOrCreateToken(OperationService)
    );
    await operations.invokeAndPush(new BakeAmbientOcclusionOperation(entries));

    console.log(`[BakeAO] Baked AO for ${entries.length} mesh(es) → res://lightmaps/${sceneKey}/`);
    return { didMutate: true, payload: undefined };
  }

  private async ensureDir(projectService: ProjectService, path: string): Promise<void> {
    try {
      await projectService.createDirectory(path);
    } catch {
      // Already exists — fine.
    }
  }

  /** Decode PNG bytes into a three Texture for immediate display (same bytes we saved). */
  private async decodeTexture(png: Uint8Array): Promise<Texture> {
    const blob = new Blob([png], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    const texture = new Texture(bitmap);
    texture.needsUpdate = true;
    return texture;
  }
}
