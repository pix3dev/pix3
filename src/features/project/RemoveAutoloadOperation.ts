import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import {
  createDefaultProjectManifest,
  normalizeProjectManifest,
  type ProjectManifest,
} from '@/core/ProjectManifest';
import { ProjectService } from '@/services/ProjectService';

export interface RemoveAutoloadParams {
  singleton: string;
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

const cloneManifest = (manifest: ProjectManifestSnapshotLike): ProjectManifest =>
  // Normalization deep-fills current manifest fields (incl. projectType,
  // targetPlatform, quality) so snapshots stay valid as the schema grows.
  normalizeProjectManifest({
    ...manifest,
    metadata: manifest.metadata ? { ...manifest.metadata } : {},
    autoloads: manifest.autoloads.map(entry => ({ ...entry })),
  });

export class RemoveAutoloadOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'project.remove-autoload',
    title: 'Remove Autoload',
    description: 'Remove an autoload script from project manifest',
    tags: ['project', 'autoload'],
  };

  constructor(private readonly params: RemoveAutoloadParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const prevManifest = cloneManifest(
      context.snapshot.project.manifest ?? createDefaultProjectManifest()
    );
    const singleton = this.params.singleton.trim();
    if (!singleton) {
      return { didMutate: false };
    }

    const nextAutoloads = prevManifest.autoloads.filter(entry => entry.singleton !== singleton);
    if (nextAutoloads.length === prevManifest.autoloads.length) {
      return { didMutate: false };
    }

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
        label: `Remove autoload "${singleton}"`,
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
