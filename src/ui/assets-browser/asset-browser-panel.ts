import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { ref } from 'lit/directives/ref.js';
import { subscribe } from 'valtio/vanilla';
import { appState, type AssetBrowserViewMode } from '@/state';
import { AssetFileActivationService, type AssetActivation, CommandDispatcher } from '@/services';
import { AssetImportDialogService } from '@/services/AssetImportDialogService';
import { DialogService } from '@/services/DialogService';
import { ProjectService } from '@/services/ProjectService';
import { ProjectScriptLoaderService } from '@/services/ProjectScriptLoaderService';
import { AddAutoloadCommand } from '@/features/project/AddAutoloadCommand';
import type { AssetTree } from './asset-tree';

import '../shared/pix3-panel';
import '../shared/pix3-toolbar';
import '../shared/pix3-toolbar-button';
import '../shared/pix3-dropdown-button';
import './asset-tree';
import './asset-browser-panel.ts.css';

// Use public API on AssetTree to query selected path (do not access internals)
interface ScriptRevealRequestDetail {
  scriptType: string;
  scriptName: string;
  candidatePaths: string[];
}

interface AssetsPreviewRevealPathDetail {
  path: string;
}

@customElement('pix3-asset-browser-panel')
export class AssetBrowserPanel extends ComponentBase {
  @inject(AssetFileActivationService)
  private readonly assetFileActivation!: AssetFileActivationService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(AssetImportDialogService)
  private readonly assetImportDialogService!: AssetImportDialogService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(ProjectService)
  private readonly projectService!: ProjectService;

  @inject(ProjectScriptLoaderService)
  private readonly scriptLoader!: ProjectScriptLoaderService;

  private assetTreeRef: AssetTree | null = null;

  @state()
  private selectedItemName: string | null = null;

  @state()
  private assetViewMode: AssetBrowserViewMode = 'folders';

  private disposeViewModeSubscription?: () => void;

  private scriptFileCreatedHandler?: (e: Event) => void;
  private scriptFileRevealRequestHandler?: (e: Event) => void;
  private assetsPreviewRevealPathHandler?: (e: Event) => void;

  private onAssetActivate = async (e: Event) => {
    const detail = (e as CustomEvent<AssetActivation>).detail;
    if (!detail) return;
    await this.assetFileActivation.handleActivation(detail);
  };

  private onCreateFolder = async () => {
    try {
      console.log('[AssetBrowserPanel] Creating folder...', { assetTreeRef: this.assetTreeRef });
      if (!this.assetTreeRef) {
        console.warn('[AssetBrowserPanel] assetTreeRef is null, cannot create folder');
        return;
      }
      await this.assetTreeRef.createFolder();
      console.log('[AssetBrowserPanel] Folder creation initiated');
    } catch (error) {
      console.error('[AssetBrowserPanel] Failed to create folder:', error);
    }
  };

  private onImportClick = async () => {
    try {
      const targetDirectory = this.assetTreeRef?.getTargetDirectory?.() ?? '.';
      const result = await this.assetImportDialogService.showDialog({ targetDirectory });
      if (result && result.importedPaths.length > 0) {
        // Best-effort reveal of the first imported file once the tree refreshes.
        await this.assetTreeRef?.selectPath(result.importedPaths[0]);
      }
    } catch (error) {
      console.error('[AssetBrowserPanel] Failed to import assets:', error);
    }
  };

  private onCreateScene = () => {
    try {
      console.log('[AssetBrowserPanel] Creating scene...', { assetTreeRef: this.assetTreeRef });
      if (!this.assetTreeRef) {
        console.warn('[AssetBrowserPanel] assetTreeRef is null, cannot create scene');
        return;
      }
      this.assetTreeRef.createScene();
      console.log('[AssetBrowserPanel] Scene creation initiated');
    } catch (error) {
      console.error('[AssetBrowserPanel] Failed to create scene:', error);
    }
  };

  private onCreateAutoloadScript = async () => {
    const singletonName = this.promptForAutoloadSingleton();
    if (!singletonName) {
      return;
    }

    const filePath = `scripts/${singletonName}.ts`;
    try {
      await this.ensureScriptsDirectory();
      const exists = await this.fileExists(filePath);
      if (exists) {
        await this.dialogService.showConfirmation({
          title: 'File Already Exists',
          message: `A script file already exists at "${filePath}". Choose a different singleton name.`,
          confirmLabel: 'OK',
          cancelLabel: 'Close',
        });
        return;
      }

      const template = this.generateAutoloadTemplate(singletonName);
      await this.projectService.writeFile(filePath, template);

      await this.scriptLoader.syncAndBuild();

      const didMutate = await this.commandDispatcher.execute(
        new AddAutoloadCommand({
          scriptPath: filePath,
          singleton: singletonName,
          enabled: true,
        })
      );

      if (!didMutate) {
        await this.dialogService.showConfirmation({
          title: 'Autoload Registration Failed',
          message: `Created "${filePath}", but failed to add "${singletonName}" to project autoloads.`,
          confirmLabel: 'OK',
          cancelLabel: 'Close',
        });
        return;
      }

      window.dispatchEvent(
        new CustomEvent('script-file-created', {
          detail: {
            filePath,
          },
        })
      );
    } catch (error) {
      console.error('[AssetBrowserPanel] Failed to create autoload script:', error);
      await this.dialogService.showConfirmation({
        title: 'Autoload Creation Failed',
        message: error instanceof Error ? error.message : 'Failed to create autoload script.',
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
    }
  };

  private promptForAutoloadSingleton(): string | null {
    const input = window.prompt(
      'Autoload singleton name (letters, numbers, underscore):',
      'Events'
    );
    if (!input) {
      return null;
    }
    const singletonName = input.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(singletonName)) {
      void this.dialogService.showConfirmation({
        title: 'Invalid Singleton Name',
        message:
          'Singleton name must start with a letter or underscore and contain only letters, numbers, and underscores.',
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
      return null;
    }
    return singletonName;
  }

  private async ensureScriptsDirectory(): Promise<void> {
    try {
      await this.projectService.createDirectory('scripts');
    } catch {
      // Directory already exists.
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      const entries = await this.projectService.listDirectory('scripts');
      return entries.some(entry => entry.kind === 'file' && entry.path === path);
    } catch {
      return false;
    }
  }

  private generateAutoloadTemplate(singletonName: string): string {
    return `import { Script } from '@pix3/runtime';

export class ${singletonName} extends Script {
  onAttach(): void {
    this.node?.signal('initialized');
    this.node?.emit('initialized');
  }
}
`;
  }

  private onDeleteClick = () => {
    try {
      const selectedPath = this.assetTreeRef?.getSelectedPath?.();

      if (!selectedPath) {
        console.warn('[AssetBrowserPanel] No item selected for deletion');
        return;
      }

      // Extract name from path for display
      const itemName = selectedPath.split('/').pop() || selectedPath;
      this.selectedItemName = itemName;

      // Show confirmation dialog
      void this.showDeleteConfirmation(itemName);
    } catch (error) {
      console.error('[AssetBrowserPanel] Failed to open delete confirmation:', error);
    }
  };

  private onRenameClick = () => {
    try {
      console.log('[AssetBrowserPanel] Renaming item...', { assetTreeRef: this.assetTreeRef });
      if (!this.assetTreeRef) {
        console.warn('[AssetBrowserPanel] assetTreeRef is null, cannot rename');
        return;
      }
      void this.assetTreeRef.renameSelected();
      console.log('[AssetBrowserPanel] Rename initiated');
    } catch (error) {
      console.error('[AssetBrowserPanel] Failed to rename item:', error);
    }
  };

  private onOpenInIdeClick = () => {
    void this.commandDispatcher.executeById('project.open-in-ide');
  };

  private onToggleViewMode = () => {
    const next: AssetBrowserViewMode = this.assetViewMode === 'by-type' ? 'folders' : 'by-type';
    this.assetViewMode = next;
    void this.assetTreeRef?.setViewMode(next);
  };

  private async showDeleteConfirmation(itemName: string): Promise<void> {
    try {
      const confirmed = await this.dialogService.showConfirmation({
        title: 'Delete Item?',
        message: `Are you sure you want to delete ${itemName}?`,
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        isDangerous: true,
      });

      if (confirmed) {
        await this.performDelete();
      }
    } catch (error) {
      console.error('[AssetBrowserPanel] Error showing delete confirmation:', error);
    }
  }

  private async performDelete(): Promise<void> {
    try {
      console.log('[AssetBrowserPanel] Performing delete of:', this.selectedItemName);

      if (!this.assetTreeRef) {
        console.warn('[AssetBrowserPanel] assetTreeRef is null');
        return;
      }

      await this.assetTreeRef.deleteSelected();
      console.log('[AssetBrowserPanel] Item deleted successfully');
      this.selectedItemName = null;
    } catch (error) {
      console.error('[AssetBrowserPanel] Failed to delete item:', error);
    }
  }

  private setAssetTreeRef = (element: Element | undefined) => {
    this.assetTreeRef = (element as AssetTree) || null;
  };

  connectedCallback(): void {
    super.connectedCallback();

    // Track focus for context-aware shortcuts
    this.addEventListener('focusin', () => {
      appState.editorContext.focusedArea = 'assets';
    });

    // Keep the view-mode toggle in sync with restored per-project state.
    this.assetViewMode = appState.project.assetBrowserViewMode;
    this.disposeViewModeSubscription = subscribe(appState.project, () => {
      if (appState.project.assetBrowserViewMode !== this.assetViewMode) {
        this.assetViewMode = appState.project.assetBrowserViewMode;
      }
    });

    this.scriptFileCreatedHandler = (e: Event) => {
      const customEvent = e as CustomEvent;
      const { filePath } = customEvent.detail;
      void this.onScriptFileCreated(filePath);
    };

    window.addEventListener('script-file-created', this.scriptFileCreatedHandler as EventListener);

    this.scriptFileRevealRequestHandler = (e: Event) => {
      const customEvent = e as CustomEvent<ScriptRevealRequestDetail>;
      void this.onScriptFileRevealRequested(customEvent.detail);
    };
    window.addEventListener(
      'script-file-reveal-request',
      this.scriptFileRevealRequestHandler as EventListener
    );

    this.assetsPreviewRevealPathHandler = (e: Event) => {
      const customEvent = e as CustomEvent<AssetsPreviewRevealPathDetail>;
      void this.onAssetsPreviewRevealPath(customEvent.detail);
    };
    window.addEventListener(
      'assets-preview:reveal-path',
      this.assetsPreviewRevealPathHandler as EventListener
    );
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();

    this.disposeViewModeSubscription?.();
    this.disposeViewModeSubscription = undefined;

    if (this.scriptFileCreatedHandler) {
      window.removeEventListener(
        'script-file-created',
        this.scriptFileCreatedHandler as EventListener
      );
      this.scriptFileCreatedHandler = undefined;
    }

    if (this.scriptFileRevealRequestHandler) {
      window.removeEventListener(
        'script-file-reveal-request',
        this.scriptFileRevealRequestHandler as EventListener
      );
      this.scriptFileRevealRequestHandler = undefined;
    }

    if (this.assetsPreviewRevealPathHandler) {
      window.removeEventListener(
        'assets-preview:reveal-path',
        this.assetsPreviewRevealPathHandler as EventListener
      );
      this.assetsPreviewRevealPathHandler = undefined;
    }
  }

  private async onScriptFileCreated(filePath: string): Promise<void> {
    try {
      if (!this.assetTreeRef) {
        console.warn('[AssetBrowserPanel] assetTreeRef is null, cannot select file');
        return;
      }
      await this.assetTreeRef.selectPath(filePath);
      console.log('[AssetBrowserPanel] Selected newly created script file:', filePath);
    } catch (error) {
      console.error('[AssetBrowserPanel] Failed to select newly created script file:', error);
    }
  }

  private async onScriptFileRevealRequested(detail: ScriptRevealRequestDetail): Promise<void> {
    if (!detail || detail.scriptType.length === 0 || detail.scriptName.length === 0) {
      return;
    }

    if (!detail.scriptType.startsWith('user:')) {
      return;
    }

    if (!this.assetTreeRef) {
      console.warn('[AssetBrowserPanel] assetTreeRef is null, cannot reveal script');
      return;
    }

    for (const candidatePath of detail.candidatePaths) {
      const selected = await this.assetTreeRef.selectPath(candidatePath);
      if (selected) {
        console.log('[AssetBrowserPanel] Revealed user script:', candidatePath);
        return;
      }
    }

    console.warn('[AssetBrowserPanel] Failed to reveal user script in Asset Browser:', detail);
  }

  private async onAssetsPreviewRevealPath(detail: AssetsPreviewRevealPathDetail): Promise<void> {
    if (!detail?.path || !this.assetTreeRef) {
      return;
    }

    const selected = await this.assetTreeRef.selectPath(detail.path);
    if (!selected) {
      console.warn('[AssetBrowserPanel] Failed to reveal folder from assets preview:', detail.path);
    }
  }

  protected render() {
    const isReadOnly = appState.collaboration.isReadOnly;

    return html`
      <pix3-panel
        panel-description="Open a project to browse textures, models, and prefabs."
        actions-label="Asset browser actions"
        @asset-activate=${this.onAssetActivate}
      >
        <pix3-toolbar label="Asset browser tools" slot="toolbar" variant="panel">
          <pix3-dropdown-button
            icon="plus-circle"
            aria-label="Create"
            ?disabled=${isReadOnly}
            .items=${[
              { id: 'folder', label: 'Create folder', icon: 'folder' },
              { id: 'scene', label: 'Create scene', icon: 'film' },
              { id: 'autoload-script', label: 'Create autoload script', icon: 'code' },
            ]}
            @item-select=${(e: CustomEvent) => {
              if (e.detail.id === 'folder') {
                this.onCreateFolder();
              } else if (e.detail.id === 'scene') {
                this.onCreateScene();
              } else if (e.detail.id === 'autoload-script') {
                void this.onCreateAutoloadScript();
              }
            }}
          ></pix3-dropdown-button>
          <pix3-toolbar-button
            icon="layers"
            label="Group by type"
            title=${this.assetViewMode === 'by-type'
              ? 'Show project folder structure'
              : 'Group assets by type'}
            ?toggled=${this.assetViewMode === 'by-type'}
            @click=${this.onToggleViewMode}
          ></pix3-toolbar-button>
          <pix3-toolbar-button
            icon="upload"
            label="Import"
            title="Import assets into the selected folder"
            ?disabled=${isReadOnly}
            @click=${this.onImportClick}
          ></pix3-toolbar-button>
          <pix3-toolbar-button
            icon="edit"
            label="Rename"
            title="Rename selected item"
            ?disabled=${isReadOnly}
            @click=${this.onRenameClick}
          ></pix3-toolbar-button>
          <pix3-toolbar-button
            icon="trash"
            label="Delete"
            title="Delete selected item"
            ?disabled=${isReadOnly}
            @click=${this.onDeleteClick}
          ></pix3-toolbar-button>
          <pix3-toolbar-button
            icon="external-link"
            label="Open in IDE"
            title="Open project folder in VS Code"
            @click=${this.onOpenInIdeClick}
          ></pix3-toolbar-button>
        </pix3-toolbar>

        <pix3-asset-tree ${ref(this.setAssetTreeRef)}></pix3-asset-tree>
      </pix3-panel>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-asset-browser-panel': AssetBrowserPanel;
  }
}
