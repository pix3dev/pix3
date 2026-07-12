import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import {
  createDefaultProjectManifest,
  normalizeProjectManifest,
  type AutoloadConfig,
  type ProjectManifest,
} from '@/core/ProjectManifest';
import { ProjectService } from '@/services/ProjectService';

export interface AddAutoloadParams {
  scriptPath: string;
  singleton: string;
  enabled?: boolean;
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

export class AddAutoloadOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'project.add-autoload',
    title: 'Add Autoload',
    description: 'Add an autoload script to project manifest',
    tags: ['project', 'autoload'],
  };

  constructor(private readonly params: AddAutoloadParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const prevManifest = cloneManifest(
      context.snapshot.project.manifest ?? createDefaultProjectManifest()
    );
    const singleton = this.params.singleton.trim();
    const scriptPath = this.params.scriptPath.trim();
    if (!singleton || !scriptPath) {
      return { didMutate: false };
    }

    if (prevManifest.autoloads.some(entry => entry.singleton === singleton)) {
      return { didMutate: false };
    }

    const nextEntry: AutoloadConfig = {
      scriptPath,
      singleton,
      enabled: this.params.enabled !== false,
    };
    const nextManifest: ProjectManifest = {
      ...prevManifest,
      autoloads: [...prevManifest.autoloads, nextEntry],
    };

    const projectService = context.container.getService<ProjectService>(
      context.container.getOrCreateToken(ProjectService)
    );
    await projectService.saveProjectManifest(nextManifest);
    context.state.project.manifest = nextManifest;

    return {
      didMutate: true,
      commit: {
        label: `Add autoload "${singleton}"`,
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
