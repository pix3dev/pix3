import { inject, injectable } from '@/fw/di';
import {
  createDefaultProjectManifest,
  createDefaultQualitySettings,
  type ProjectManifest,
  type ProjectType,
  type TargetPlatform,
} from '@/core/ProjectManifest';
import { LayoutManagerService } from '@/core/LayoutManager';
import { appState } from '@/state';
import { ref } from 'valtio/vanilla';
import { ProjectService } from './ProjectService';
import { CloudProjectService } from './CloudProjectService';
import { BrowserProjectStorageService } from './BrowserProjectStorageService';
import { FileSystemAPIService } from './FileSystemAPIService';
import { EditorTabService } from './EditorTabService';
import { DialogService } from './DialogService';
import { AuthService } from './AuthService';
import type { ProjectBackend } from '@/state';

export interface CreateProjectDialogInstance {
  id: string;
  initialBackend: ProjectBackend;
  resolve: () => void;
}

export interface CreateProjectParams {
  name: string;
  backend: ProjectBackend;
  viewportBaseWidth: number;
  viewportBaseHeight: number;
  templateId?: string;
  projectType?: ProjectType;
  targetPlatform?: TargetPlatform;
}

export class ProjectAuthRequiredError extends Error {
  constructor(message = 'Authentication is required to create a cloud project.') {
    super(message);
    this.name = 'ProjectAuthRequiredError';
  }
}

@injectable()
export class ProjectLifecycleService {
  @inject(ProjectService)
  private readonly projectService!: ProjectService;

  @inject(CloudProjectService)
  private readonly cloudProjectService!: CloudProjectService;

  @inject(BrowserProjectStorageService)
  private readonly browserStore!: BrowserProjectStorageService;

  @inject(FileSystemAPIService)
  private readonly fileSystem!: FileSystemAPIService;

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(AuthService)
  private readonly authService!: AuthService;

  private activeCreateDialog: CreateProjectDialogInstance | null = null;
  private listeners = new Set<(dialog: CreateProjectDialogInstance | null) => void>();
  private nextId = 0;
  private pendingCloudCreation: { params: CreateProjectParams; skipConfirm: boolean } | null = null;

  async showCreateDialog(
    initialBackend: ProjectBackend = this.browserStore.isSupported() ? 'browser' : 'local'
  ): Promise<void> {
    if (this.activeCreateDialog) {
      return;
    }

    return new Promise(resolve => {
      const id = `create-project-${this.nextId++}`;
      this.activeCreateDialog = {
        id,
        initialBackend,
        resolve: () => {
          this.activeCreateDialog = null;
          this.notifyListeners();
          resolve();
        },
      };

      this.notifyListeners();
    });
  }

  closeCreateDialog(): void {
    this.activeCreateDialog?.resolve();
  }

  subscribe(listener: (dialog: CreateProjectDialogInstance | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.activeCreateDialog);
    return () => this.listeners.delete(listener);
  }

  hasPendingCloudCreation(): boolean {
    return this.pendingCloudCreation !== null;
  }

  async createProject(params: CreateProjectParams): Promise<void> {
    await this.createProjectInternal(params, false);
  }

  /**
   * Promote the active browser-storage (OPFS) project to a real folder on disk.
   * Copies the whole tree into a user-picked empty folder, switches the project
   * to the 'local' backend, and only then removes the OPFS copy — so any failure
   * during the copy leaves the in-browser project untouched.
   *
   * Handles the expected non-error outcomes internally (not a browser project,
   * user cancelled, picker aborted, folder not empty). Unexpected failures
   * propagate to the caller.
   */
  async moveBrowserProjectToFolder(): Promise<void> {
    if (appState.project.backend !== 'browser') {
      return;
    }
    const projectId = appState.project.id;
    const source = this.fileSystem.getProjectDirectory();
    if (!projectId || !source) {
      return;
    }

    const confirmed = await this.dialogService.showConfirmation({
      title: 'Move Project to Folder',
      message:
        'Move this project to a folder on disk? You will pick an empty folder, and the ' +
        'in-browser copy will be removed once the move succeeds.',
      confirmLabel: 'Choose Folder…',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) {
      return;
    }

    let target: FileSystemDirectoryHandle;
    try {
      target = await this.fileSystem.pickDirectory('readwrite');
    } catch (error) {
      if (this.isAbortError(error)) {
        return;
      }
      throw error;
    }

    if (!(await this.fileSystem.isDirectoryEmpty(target))) {
      await this.dialogService.showConfirmation({
        title: 'Folder Not Empty',
        message: 'Please choose an empty folder for the project.',
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
      return;
    }

    // Flush pending edits so the copied folder reflects the latest state.
    await this.editorTabService.saveDirtyTabs();

    await this.fileSystem.copyDirectoryContents(source, target);

    // Switch the live project to the on-disk folder before touching OPFS.
    this.fileSystem.setProjectDirectory(target);
    appState.project.backend = 'local';
    appState.project.directoryHandle = ref(target);
    await this.projectService.persistProjectDirectoryHandle(projectId, target);
    this.projectService.syncProjectMetadata();

    // Copy + switch succeeded — safe to drop the in-browser copy now.
    await this.browserStore.deleteProject(projectId);
  }

  private isAbortError(error: unknown): boolean {
    if (error instanceof DOMException) {
      return error.name === 'AbortError';
    }
    const cause = (error as { cause?: unknown } | null | undefined)?.cause;
    return cause instanceof DOMException && cause.name === 'AbortError';
  }

  async resumePendingCloudCreation(): Promise<void> {
    const pending = this.pendingCloudCreation;
    if (!pending) {
      return;
    }

    this.pendingCloudCreation = null;
    await this.createProjectInternal(
      {
        ...pending.params,
        backend: 'cloud',
      },
      pending.skipConfirm
    );
  }

  async logout(): Promise<void> {
    await this.authService.logout();
    await this.cloudProjectService.loadProjects();
  }

  /**
   * Close the current project and return to the welcome screen.
   *
   * Always asks the user to confirm closing. When the "warn about unsaved
   * changes" editor setting is enabled and there are dirty tabs, the
   * confirmation escalates to a Save / Don't Save / Cancel choice instead.
   *
   * @returns `true` if the project was closed, `false` if the user cancelled.
   */
  async closeCurrentProject(): Promise<boolean> {
    if (!(await this.confirmCloseProject())) {
      return false;
    }

    await this.editorTabService.closeAllTabs(true);
    this.projectService.closeCurrentProject();
    await this.layoutManager.resetLayout();
    return true;
  }

  private async confirmCloseProject(): Promise<boolean> {
    if (appState.project.status !== 'ready') {
      return true;
    }

    const hasUnsavedChanges = this.editorTabService.getDirtyTabs().length > 0;

    if (appState.ui.warnOnUnsavedUnload && hasUnsavedChanges) {
      const choice = await this.dialogService.showChoice({
        title: 'Close Project',
        message: 'You have unsaved changes. Save them before closing the project?',
        confirmLabel: 'Save',
        secondaryLabel: "Don't Save",
        cancelLabel: 'Cancel',
        secondaryIsDangerous: true,
      });

      if (choice === 'cancel') {
        return false;
      }

      if (choice === 'confirm') {
        await this.editorTabService.saveDirtyTabs();
      }

      return true;
    }

    return this.dialogService.showConfirmation({
      title: 'Close Project',
      message: 'Are you sure you want to close the project?',
      confirmLabel: 'Close Project',
      cancelLabel: 'Cancel',
    });
  }

  private async createProjectInternal(
    params: CreateProjectParams,
    skipConfirm: boolean
  ): Promise<void> {
    if (!skipConfirm && !(await this.confirmProjectSwitchIfNeeded())) {
      return;
    }

    if (params.backend === 'cloud' && !appState.auth.isAuthenticated) {
      this.pendingCloudCreation = {
        params,
        skipConfirm: true,
      };
      throw new ProjectAuthRequiredError();
    }

    const beforeActivate = async () => {
      await this.editorTabService.closeAllTabs(true);
    };

    if (params.backend === 'cloud') {
      await this.cloudProjectService.createProjectFromTemplate(
        {
          name: params.name,
          manifest: this.createManifest(params),
        },
        { beforeActivate }
      );
    } else {
      // 'local' or 'browser'. Browser projects live in OPFS, which can be
      // evicted under storage pressure — best-effort request persistence first.
      if (params.backend === 'browser') {
        await this.browserStore.requestPersistence();
      }
      await this.projectService.createNewProjectWithOptions(
        {
          name: params.name,
          manifest: this.createManifest(params),
          templateId: params.templateId,
          backend: params.backend,
        },
        { beforeActivate }
      );
    }

    await this.projectService.openStartupScene();
    this.pendingCloudCreation = null;
    this.closeCreateDialog();
  }

  private async confirmProjectSwitchIfNeeded(): Promise<boolean> {
    if (appState.project.status !== 'ready') {
      return true;
    }

    const dirtyTabs = this.editorTabService.getDirtyTabs();
    if (dirtyTabs.length === 0) {
      return true;
    }

    const choice = await this.dialogService.showChoice({
      title: 'Unsaved Changes',
      message: 'Save changes before switching projects?',
      confirmLabel: 'Save',
      secondaryLabel: "Don't Save",
      cancelLabel: 'Cancel',
      secondaryIsDangerous: true,
    });

    if (choice === 'cancel') {
      return false;
    }

    if (choice === 'confirm') {
      await this.editorTabService.saveDirtyTabs();
    }

    return true;
  }

  private createManifest(params: CreateProjectParams): ProjectManifest {
    const manifest = createDefaultProjectManifest();
    const targetPlatform = params.targetPlatform ?? manifest.targetPlatform;
    return {
      ...manifest,
      viewportBaseSize: {
        width: params.viewportBaseWidth,
        height: params.viewportBaseHeight,
      },
      projectType: params.projectType ?? manifest.projectType,
      targetPlatform,
      quality: createDefaultQualitySettings(targetPlatform),
      metadata: {
        ...(manifest.metadata ?? {}),
        projectName: params.name,
        ...(params.templateId ? { templateId: params.templateId } : {}),
      },
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.activeCreateDialog);
    }
  }

  dispose(): void {
    this.pendingCloudCreation = null;
    this.activeCreateDialog = null;
    this.listeners.clear();
  }
}
