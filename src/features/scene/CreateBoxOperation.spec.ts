import { afterEach, describe, expect, it } from 'vitest';
import { MeshLambertMaterial, MeshStandardMaterial, type Mesh } from 'three';
import type { OperationContext } from '@/core/Operation';
import type { ProjectManifest } from '@/core/ProjectManifest';
import { appState } from '@/state';
import { createInitialAppState } from '@/state/AppState';
import { GeometryMesh, SceneManager, type NodeBase } from '@pix3/runtime';
import { CreateBoxOperation } from './CreateBoxOperation';

/**
 * The mobile-first promise, end to end: a box created in a mobile project must not arrive wearing
 * a PBR material. The node class still defaults to `standard` — this is a creation-time policy, so
 * the only place it can be proven is here.
 */
const contextForNewProject = (): { context: OperationContext; rootNodes: NodeBase[] } => {
  const state = createInitialAppState();
  state.scenes.activeSceneId = 'scene-1';
  state.scenes.descriptors['scene-1'] = {
    id: 'scene-1',
    filePath: 'res://scene.pix3scene',
    name: 'Scene',
    version: '1.0.0',
    isDirty: false,
    lastSavedAt: null,
    fileHandle: null,
    lastModifiedTime: null,
  };

  const rootNodes: NodeBase[] = [];
  const sceneGraph = {
    version: '1.0.0',
    description: 'Scene',
    metadata: {},
    rootNodes,
    nodeMap: new Map<string, NodeBase>(),
  };
  const sceneManagerMock = {
    getSceneGraph: (sceneId: string) => (sceneId === 'scene-1' ? sceneGraph : null),
  } satisfies Pick<SceneManager, 'getSceneGraph'>;

  const container = {
    getOrCreateToken: <T>(token: T): T => token,
    getService: <T>(token: unknown): T => {
      if (token === SceneManager) {
        return sceneManagerMock as T;
      }
      throw new Error(`Unexpected token: ${String(token)}`);
    },
  };

  return {
    rootNodes,
    context: {
      state,
      snapshot: { selection: { primaryNodeId: null } },
      container: container as OperationContext['container'],
      requestedAt: Date.now(),
    } as unknown as OperationContext,
  };
};

const materialOf = (node: NodeBase) =>
  (node.children.find(child => (child as unknown as Mesh).isMesh) as unknown as Mesh).material;

afterEach(() => {
  appState.project.manifest = null;
});

describe('CreateBoxOperation material policy', () => {
  it('creates a cheap lit box in a mobile project', async () => {
    appState.project.manifest = { targetPlatform: 'mobile' } as ProjectManifest;
    const { context, rootNodes } = contextForNewProject();

    const result = await new CreateBoxOperation({ boxName: 'Box' }).perform(context);

    expect(result.didMutate).toBe(true);
    expect((rootNodes[0] as GeometryMesh).materialType).toBe('lambert');
    expect(materialOf(rootNodes[0])).toBeInstanceOf(MeshLambertMaterial);
  });

  it('creates a PBR box once the project says desktop', async () => {
    appState.project.manifest = { targetPlatform: 'desktop' } as ProjectManifest;
    const { context, rootNodes } = contextForNewProject();

    await new CreateBoxOperation({ boxName: 'Box' }).perform(context);

    expect((rootNodes[0] as GeometryMesh).materialType).toBe('standard');
    expect(materialOf(rootNodes[0])).toBeInstanceOf(MeshStandardMaterial);
  });

  it('honours an explicit material family over the project default', async () => {
    appState.project.manifest = { targetPlatform: 'mobile' } as ProjectManifest;
    const { context, rootNodes } = contextForNewProject();

    await new CreateBoxOperation({ boxName: 'Box', materialType: 'standard' }).perform(context);

    expect((rootNodes[0] as GeometryMesh).materialType).toBe('standard');
  });
});
