import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { createDefaultProjectManifest, type ProjectManifest } from '@/core/ProjectManifest';
import { ProjectService } from '@/services/ProjectService';

export interface ReorderAutoloadParams {
  fromIndex: number;
  toIndex: number;
}

interface ProjectManifestSnapshotLike {
  version: string;
  defaultExportScenePath?: string;
  viewportBaseSize: {
    width: number;
    height: number;
  };
  ambientOcclusion: ProjectManifest['ambientOcclusion'];
  autoloads: ReadonlyArray<{
    scriptPath: string;
    singleton: string;
    enabled: boolean;
  }>;
  metadata?: Record<string, unknown>;
}

const cloneManifest = (manifest: ProjectManifestSnapshotLike): ProjectManifest => ({
  version: manifest.version,
  defaultExportScenePath: manifest.defaultExportScenePath,
  viewportBaseSize: {
    width: manifest.viewportBaseSize.width,
    height: manifest.viewportBaseSize.height,
  },
  ambientOcclusion: manifest.ambientOcclusion,
  metadata: manifest.metadata ? { ...manifest.metadata } : {},
  autoloads: manifest.autoloads.map(entry => ({ ...entry })),
});

export class ReorderAutoloadOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'project.reorder-autoload',
    title: 'Reorder Autoload',
    description: 'Reorder autoload script initialization order',
    tags: ['project', 'autoload'],
  };

  constructor(private readonly params: ReorderAutoloadParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const prevManifest = cloneManifest(
      context.snapshot.project.manifest ?? createDefaultProjectManifest()
    );
    const { fromIndex, toIndex } = this.params;
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= prevManifest.autoloads.length ||
      toIndex >= prevManifest.autoloads.length
    ) {
      return { didMutate: false };
    }

    const nextAutoloads = [...prevManifest.autoloads];
    const [moved] = nextAutoloads.splice(fromIndex, 1);
    nextAutoloads.splice(toIndex, 0, moved);

    const nextManifest: ProjectManifest = {
      ...prevManifest,
      autoloads: nextAutoloads,
    };

    const projectService = context.container.getService<ProjectService>(
      context.container.getOrCreateToken(ProjectService)
    );
    await projectService.saveProjectManifest(nextManifest);
    context.state.project.manifest = nextManifest;

    return {
      didMutate: true,
      commit: {
        label: 'Reorder autoload scripts',
        undo: async () => {
          await projectService.saveProjectManifest(prevManifest);
          context.state.project.manifest = prevManifest;
        },
        redo: async () => {
          await projectService.saveProjectManifest(nextManifest);
          context.state.project.manifest = nextManifest;
        },
      },
    };
  }
}
