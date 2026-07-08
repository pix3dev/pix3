import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { Node2D, SceneManager, setProjectAODefault } from '@pix3/runtime';
import {
  createDefaultProjectManifest,
  normalizeProjectManifest,
  type ProjectManifest,
  type ProjectAODefault,
} from '@/core/ProjectManifest';
import { ProjectService } from '@/services/ProjectService';
import { ViewportRendererService } from '@/services/ViewportRenderService';

export interface UpdateProjectSettingsParams {
  projectName?: string;
  localAbsolutePath?: string | null;
  defaultExportScenePath?: string | null;
  viewportBaseWidth?: number;
  viewportBaseHeight?: number;
  ambientOcclusion?: ProjectAODefault;
}

interface ProjectManifestSnapshotLike {
  version: string;
  defaultExportScenePath?: string;
  viewportBaseSize: {
    width: number;
    height: number;
  };
  ambientOcclusion: ProjectAODefault;
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
  autoloads: manifest.autoloads.map(entry => ({ ...entry })),
  metadata: manifest.metadata ? { ...manifest.metadata } : {},
});

/**
 * Persists the given recent project entry to localStorage.
 */
function persistRecentProject(entry: {
  id?: string;
  name: string;
  backend: 'local' | 'cloud';
  localAbsolutePath?: string;
  linkedCloudProjectId?: string;
  linkedLocalSessionId?: string;
  lastOpenedAt: number;
}): void {
  try {
    const RECENTS_KEY = 'pix3.recentProjects:v1';
    const raw = localStorage.getItem(RECENTS_KEY);
    const existing = raw ? (JSON.parse(raw) as (typeof entry)[]) : [];
    const filtered = existing.filter(r => (entry.id ? r.id !== entry.id : r.name !== entry.name));
    const updated = [entry, ...filtered].slice(0, 10);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(updated));
  } catch {
    // ignore persistence errors
  }
}

export class UpdateProjectSettingsOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'project.update-settings',
    title: 'Update Project Settings',
    description: 'Update project metadata like name and local absolute path',
    tags: ['project', 'settings'],
  };

  constructor(private readonly params: UpdateProjectSettingsParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, snapshot, container } = context;

    const projectService = container.getService<ProjectService>(
      container.getOrCreateToken(ProjectService)
    );

    const prevName = snapshot.project.projectName;
    const prevPath = snapshot.project.localAbsolutePath;
    const prevManifest = cloneManifest(snapshot.project.manifest ?? createDefaultProjectManifest());

    const newName = this.params.projectName !== undefined ? this.params.projectName : prevName;
    const newPath =
      this.params.localAbsolutePath !== undefined ? this.params.localAbsolutePath : prevPath;
    const nextViewportBaseWidth =
      this.params.viewportBaseWidth !== undefined
        ? this.params.viewportBaseWidth
        : prevManifest.viewportBaseSize.width;
    const nextViewportBaseHeight =
      this.params.viewportBaseHeight !== undefined
        ? this.params.viewportBaseHeight
        : prevManifest.viewportBaseSize.height;
    const nextDefaultExportScenePath =
      this.params.defaultExportScenePath !== undefined
        ? this.params.defaultExportScenePath
        : prevManifest.defaultExportScenePath;
    const nextAmbientOcclusion =
      this.params.ambientOcclusion !== undefined
        ? this.params.ambientOcclusion
        : prevManifest.ambientOcclusion;
    const nextManifest = normalizeProjectManifest({
      ...prevManifest,
      defaultExportScenePath: nextDefaultExportScenePath,
      viewportBaseSize: {
        width: nextViewportBaseWidth,
        height: nextViewportBaseHeight,
      },
      ambientOcclusion: nextAmbientOcclusion,
    });

    if (
      prevName === newName &&
      prevPath === newPath &&
      prevManifest.defaultExportScenePath === nextManifest.defaultExportScenePath &&
      prevManifest.viewportBaseSize.width === nextManifest.viewportBaseSize.width &&
      prevManifest.viewportBaseSize.height === nextManifest.viewportBaseSize.height &&
      prevManifest.ambientOcclusion === nextManifest.ambientOcclusion
    ) {
      return { didMutate: false };
    }

    try {
      await projectService.saveProjectManifest(nextManifest);
      state.project.projectName = newName;
      state.project.localAbsolutePath = newPath;
      state.project.manifest = nextManifest;
      setProjectAODefault(nextManifest.ambientOcclusion);
      this.rebakeRootAnchors(context, prevManifest.viewportBaseSize, nextManifest.viewportBaseSize);
    } catch {
      return { didMutate: false };
    }

    // Persist changes to recent projects
    if (state.project.status === 'ready' && state.project.id) {
      persistRecentProject({
        id: state.project.id,
        name: newName ?? 'Untitled Project',
        backend: state.project.backend,
        localAbsolutePath: newPath ?? undefined,
        linkedCloudProjectId: state.project.hybridSync.linkedCloudProjectId ?? undefined,
        linkedLocalSessionId: state.project.hybridSync.linkedLocalSessionId ?? undefined,
        lastOpenedAt: Date.now(),
      });
    }

    return {
      didMutate: true,
      commit: {
        label: 'Update Project Settings',
        undo: async () => {
          await projectService.saveProjectManifest(prevManifest);
          state.project.projectName = prevName;
          state.project.localAbsolutePath = prevPath;
          state.project.manifest = prevManifest;
          setProjectAODefault(prevManifest.ambientOcclusion);
          this.rebakeRootAnchors(
            context,
            nextManifest.viewportBaseSize,
            prevManifest.viewportBaseSize
          );
          if (state.project.status === 'ready' && state.project.id) {
            persistRecentProject({
              id: state.project.id,
              name: prevName ?? 'Untitled Project',
              backend: state.project.backend,
              localAbsolutePath: prevPath ?? undefined,
              linkedCloudProjectId: state.project.hybridSync.linkedCloudProjectId ?? undefined,
              linkedLocalSessionId: state.project.hybridSync.linkedLocalSessionId ?? undefined,
              lastOpenedAt: Date.now(),
            });
          }
        },
        redo: async () => {
          await projectService.saveProjectManifest(nextManifest);
          state.project.projectName = newName;
          state.project.localAbsolutePath = newPath;
          state.project.manifest = nextManifest;
          setProjectAODefault(nextManifest.ambientOcclusion);
          this.rebakeRootAnchors(
            context,
            prevManifest.viewportBaseSize,
            nextManifest.viewportBaseSize
          );
          if (state.project.status === 'ready' && state.project.id) {
            persistRecentProject({
              id: state.project.id,
              name: newName ?? 'Untitled Project',
              backend: state.project.backend,
              localAbsolutePath: newPath ?? undefined,
              linkedCloudProjectId: state.project.hybridSync.linkedCloudProjectId ?? undefined,
              linkedLocalSessionId: state.project.hybridSync.linkedLocalSessionId ?? undefined,
              lastOpenedAt: Date.now(),
            });
          }
        },
      },
    };
  }

  private rebakeRootAnchors(
    context: OperationContext,
    previousBaseSize: { width: number; height: number },
    nextBaseSize: { width: number; height: number }
  ): void {
    const sceneManager = this.tryGetService<SceneManager>(context, SceneManager);
    if (!sceneManager) {
      return;
    }

    const sceneGraph = sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return;
    }

    for (const node of sceneGraph.rootNodes) {
      if (node instanceof Node2D) {
        node.applyAnchoredLayoutRecursive(nextBaseSize, previousBaseSize);
        node.captureAuthoredLayoutRectFromCurrent();
        this.captureAnchoredDescendantRects(node);
      }
    }

    const viewportService = this.tryGetService<ViewportRendererService>(
      context,
      ViewportRendererService
    );
    viewportService?.reflow2DLayout();
  }

  private captureAnchoredDescendantRects(parent: Node2D): void {
    for (const child of parent.children) {
      if (child instanceof Node2D) {
        child.captureAuthoredLayoutRectFromCurrent();
        this.captureAnchoredDescendantRects(child);
      }
    }
  }

  private tryGetService<T>(
    context: OperationContext,
    token: symbol | string | (new (...args: never[]) => T)
  ): T | null {
    try {
      return context.container.getService<T>(context.container.getOrCreateToken(token));
    } catch {
      return null;
    }
  }
}
