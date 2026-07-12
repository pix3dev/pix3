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
import { ProjectService } from './ProjectService';
import { CloudProjectService } from './CloudProjectService';
import { EditorTabService } from './EditorTabService';
import { DialogService } from './DialogService';
import { AuthService } from './AuthService';

export interface CreateProjectDialogInstance {
  id: string;
  initialBackend: 'local' | 'cloud';
  resolve: () => void;
}

export interface CreateProjectParams {
  name: string;
  backend: 'local' | 'cloud';
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

  async showCreateDialog(initialBackend: 'local' | 'cloud' = 'local'): Promise<void> {
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

    if (params.backend === 'local') {
      await this.projectService.createNewProjectWithOptions(
        {
          name: params.name,
          manifest: this.createManifest(params),
          templateId: params.templateId,
        },
        { beforeActivate }
      );
    } else {
      await this.cloudProjectService.createProjectFromTemplate(
        {
          name: params.name,
          manifest: this.createManifest(params),
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
