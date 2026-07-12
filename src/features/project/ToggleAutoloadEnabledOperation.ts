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

export interface ToggleAutoloadEnabledParams {
  singleton: string;
  enabled: boolean;
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

export class ToggleAutoloadEnabledOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'project.toggle-autoload-enabled',
    title: 'Toggle Autoload',
    description: 'Enable or disable an autoload script',
    tags: ['project', 'autoload'],
  };

  constructor(private readonly params: ToggleAutoloadEnabledParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const prevManifest = cloneManifest(
      context.snapshot.project.manifest ?? createDefaultProjectManifest()
    );
    const singleton = this.params.singleton.trim();
    if (!singleton) {
      return { didMutate: false };
    }

    const index = prevManifest.autoloads.findIndex(entry => entry.singleton === singleton);
    if (index === -1) {
      return { didMutate: false };
    }

    const current = prevManifest.autoloads[index];
    if (current.enabled === this.params.enabled) {
      return { didMutate: false };
    }

    const nextAutoloads = [...prevManifest.autoloads];
    nextAutoloads[index] = { ...current, enabled: this.params.enabled };
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
        label: `${this.params.enabled ? 'Enable' : 'Disable'} autoload "${singleton}"`,
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
