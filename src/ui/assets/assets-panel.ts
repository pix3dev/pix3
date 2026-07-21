import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { ref } from 'lit/directives/ref.js';
import { subscribe } from 'valtio/vanilla';
import { appState, type AssetBrowserViewMode } from '@/state';
import {
  AssetFileActivationService,
  type AssetActivation,
} from '@/services/AssetFileActivationService';
import { AssetsPreviewService } from '@/services/AssetsPreviewService';
import { IconService, IconSize } from '@/services/IconService';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { AssetImportDialogService } from '@/services/AssetImportDialogService';
import { DialogService } from '@/services/DialogService';
import { ProjectService } from '@/services/ProjectService';
import { ProjectScriptLoaderService } from '@/services/ProjectScriptLoaderService';
import { AddAutoloadCommand } from '@/features/project/AddAutoloadCommand';
import type { AssetTree } from './asset-tree';

import '../shared/pix3-panel';
import '../shared/pix3-dropdown-button';
import './asset-tree';
import './assets-content';
import './assets-panel.ts.css';

interface ScriptRevealRequestDetail {
  scriptType: string;
  scriptName: string;
  candidatePaths: string[];
  /** When true, the resolved file is opened in a code tab, not just revealed/selected. */
  open?: boolean;
}

interface AssetsPreviewRevealPathDetail {
  path: string;
}

const MIN_TREE_PANE_WIDTH = 140;
const DEFAULT_TREE_PANE_WIDTH = 220;

/**
 * Unified Assets panel (Phase 4): a folder-only navigator (left) + thumbnail/list
 * content pane (right), split by a draggable handle. Hosts the create/import/rename/
 * delete/open-in-IDE toolbar and the project-root row; delegates file rendering to
 * `<pix3-assets-content>` and folder navigation to `<pix3-asset-tree>`.
 */
@customElement('pix3-assets-panel')
export class AssetsPanel extends ComponentBase {
  @inject(AssetFileActivationService)
  private readonly assetFileActivation!: AssetFileActivationService;

  @inject(AssetsPreviewService)
  private readonly assetsPreviewService!: AssetsPreviewService;

  @inject(IconService)
  private readonly iconService!: IconService;

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
  private splitEl: HTMLElement | null = null;

  @state()
  private assetViewMode: AssetBrowserViewMode = 'folders';

  @state()
  private treePaneWidth = DEFAULT_TREE_PANE_WIDTH;

  /** Currently-selected folder path from the AssetsPreviewService (drives root-row highlight). */
  @state()
  private selectedFolderPath: string | null = null;

  private disposeViewModeSubscription?: () => void;
  private disposePreviewSubscription?: () => void;

  private scriptFileCreatedHandler?: (e: Event) => void;
  private scriptFileRevealRequestHandler?: (e: Event) => void;
  private assetsPreviewRevealPathHandler?: (e: Event) => void;

  // Splitter drag bookkeeping.
  private splitterActive = false;
  private splitterStartX = 0;
  private splitterStartWidth = DEFAULT_TREE_PANE_WIDTH;

  connectedCallback(): void {
    super.connectedCallback();

    // Track focus for context-aware shortcuts.
    this.addEventListener('focusin', () => {
      appState.editorContext.focusedArea = 'assets';
    });

    // Keep the group-by-type toggle in sync with restored per-project state.
    this.assetViewMode = appState.project.assetBrowserViewMode;
    this.disposeViewModeSubscription = subscribe(appState.project, () => {
      if (appState.project.assetBrowserViewMode !== this.assetViewMode) {
        this.assetViewMode = appState.project.assetBrowserViewMode;
      }
    });

    // Track the selected folder so the root row can reflect the "root selected" state.
    this.disposePreviewSubscription = this.assetsPreviewService.subscribe(snapshot => {
      if (snapshot.selectedFolderPath !== this.selectedFolderPath) {
        this.selectedFolderPath = snapshot.selectedFolderPath;
      }
    });

    // Restore the persisted tree-pane width.
    const persisted = this.projectService.loadAssetBrowserState();
    if (persisted?.treePaneWidth && Number.isFinite(persisted.treePaneWidth)) {
      this.treePaneWidth = Math.max(MIN_TREE_PANE_WIDTH, Math.round(persisted.treePaneWidth));
    }

    this.scriptFileCreatedHandler = (e: Event) => {
      const customEvent = e as CustomEvent<{ filePath: string }>;
      void this.onScriptFileCreated(customEvent.detail.filePath);
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
    this.disposePreviewSubscription?.();
    this.disposePreviewSubscription = undefined;

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

  private setAssetTreeRef = (element: Element | undefined) => {
    this.assetTreeRef = (element as AssetTree) || null;
  };

  private setSplitRef = (element: Element | undefined) => {
    this.splitEl = (element as HTMLElement) || null;
  };

  private get isRootSelected(): boolean {
    return (
      this.selectedFolderPath === null ||
      this.selectedFolderPath === '' ||
      this.selectedFolderPath === '.'
    );
  }

  // ── Asset activation ─────────────────────────────────────────────────────
  private onAssetActivate = async (e: Event) => {
    const detail = (e as CustomEvent<AssetActivation>).detail;
    if (!detail) return;
    await this.assetFileActivation.handleActivation(detail);
  };

  // ── Root-row selection ───────────────────────────────────────────────────
  private selectRoot(): void {
    this.assetTreeRef?.clearSelection();
    void this.assetsPreviewService.syncFromAssetSelection('.', 'directory');
  }

  // ── Content-pane events ──────────────────────────────────────────────────
  private onFolderNavigate = (e: Event) => {
    const path = (e as CustomEvent<{ path: string }>).detail?.path;
    if (path === undefined) return;
    if (path === '.' || path === '') {
      this.selectRoot();
      return;
    }
    void this.assetTreeRef?.selectPath(path);
  };

  private onContentRenameRequest = (e: Event) => {
    const path = (e as CustomEvent<{ path: string }>).detail?.path;
    if (!path) return;
    void this.renamePath(path);
  };

  private onContentDeleteRequest = (e: Event) => {
    const paths = (e as CustomEvent<{ paths: string[] }>).detail?.paths;
    if (!paths || paths.length === 0) return;
    void this.deletePaths(paths);
  };

  // ── Toolbar actions ──────────────────────────────────────────────────────
  private onCreateFolder = async () => {
    try {
      await this.assetTreeRef?.createFolder();
    } catch (error) {
      console.error('[AssetsPanel] Failed to create folder:', error);
    }
  };

  private onCreateScene = () => {
    try {
      this.assetTreeRef?.createScene();
    } catch (error) {
      console.error('[AssetsPanel] Failed to create scene:', error);
    }
  };

  private onImportClick = async () => {
    try {
      const targetDirectory =
        this.selectedFolderPath ?? this.assetTreeRef?.getTargetDirectory?.() ?? '.';
      const result = await this.assetImportDialogService.showDialog({ targetDirectory });
      if (result && result.importedPaths.length > 0) {
        await this.assetTreeRef?.selectPath(result.importedPaths[0]);
      }
    } catch (error) {
      console.error('[AssetsPanel] Failed to import assets:', error);
    }
  };

  private onToggleViewMode = () => {
    const next: AssetBrowserViewMode = this.assetViewMode === 'by-type' ? 'folders' : 'by-type';
    this.assetViewMode = next;
    void this.assetTreeRef?.setViewMode(next);
  };

  // ── Autoload script creation (migrated verbatim from AssetBrowserPanel) ────
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
      console.error('[AssetsPanel] Failed to create autoload script:', error);
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

  // ── Grid file operations (dialog rename + multi-delete) ───────────────────
  private async renamePath(path: string): Promise<void> {
    if (appState.collaboration.isReadOnly) {
      return;
    }
    const name = path.split('/').pop() ?? path;
    const dotIndex = name.lastIndexOf('.');
    const hasExtension = dotIndex > 0;
    const baseName = hasExtension ? name.slice(0, dotIndex) : name;
    const originalExtension = hasExtension ? name.slice(dotIndex) : '';

    const input = window.prompt('Rename to:', baseName);
    if (input === null) {
      return;
    }
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    // Preserve the original extension unless the user typed one explicitly.
    const finalName =
      originalExtension && !trimmed.includes('.') ? `${trimmed}${originalExtension}` : trimmed;
    if (finalName === name) {
      return;
    }

    const lastSlash = path.lastIndexOf('/');
    const parentPath = lastSlash >= 0 ? path.slice(0, lastSlash) : '';
    const newPath = parentPath ? `${parentPath}/${finalName}` : finalName;

    try {
      // moveItem bumps fileRefreshSignal + lastModifiedDirectoryPath, so both the
      // AssetsPreviewService grid and the tree refresh automatically.
      await this.projectService.moveItem(path, newPath);
    } catch (error) {
      console.error('[AssetsPanel] Failed to rename asset:', error);
    }
  }

  private async deletePaths(paths: string[]): Promise<void> {
    if (appState.collaboration.isReadOnly || paths.length === 0) {
      return;
    }

    const message =
      paths.length === 1
        ? `Are you sure you want to delete ${paths[0].split('/').pop() ?? paths[0]}?`
        : `Delete ${paths.length} items?`;

    const confirmed = await this.dialogService.showConfirmation({
      title: paths.length === 1 ? 'Delete Item?' : 'Delete Items?',
      message,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      isDangerous: true,
    });
    if (!confirmed) {
      return;
    }

    try {
      for (const path of paths) {
        // deleteEntry bumps fileRefreshSignal + lastModifiedDirectoryPath (refreshes both panes).
        await this.projectService.deleteEntry(path);
      }
    } catch (error) {
      console.error('[AssetsPanel] Failed to delete assets:', error);
    }
    // Drop the (now stale) grid selection; the content pane mirrors this.
    this.assetsPreviewService.clearSelectedItem();
  }

  // ── Window-event reveal handlers (external entry points) ──────────────────
  private async onScriptFileCreated(filePath: string): Promise<void> {
    try {
      await this.assetTreeRef?.selectPath(filePath);
    } catch (error) {
      console.error('[AssetsPanel] Failed to select newly created script file:', error);
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
      return;
    }

    for (const candidatePath of detail.candidatePaths) {
      const selected = detail.open
        ? await this.assetTreeRef.revealAndOpen(candidatePath)
        : await this.assetTreeRef.selectPath(candidatePath);
      if (selected) {
        return;
      }
    }

    console.warn('[AssetsPanel] Failed to reveal user script:', detail);
  }

  private async onAssetsPreviewRevealPath(detail: AssetsPreviewRevealPathDetail): Promise<void> {
    if (!detail?.path || !this.assetTreeRef) {
      return;
    }
    const selected = await this.assetTreeRef.selectPath(detail.path);
    if (!selected) {
      console.warn('[AssetsPanel] Failed to reveal folder from assets preview:', detail.path);
    }
  }

  // ── Splitter ─────────────────────────────────────────────────────────────
  private onSplitterPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    this.splitterActive = true;
    this.splitterStartX = event.clientX;
    this.splitterStartWidth = this.treePaneWidth;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', this.onSplitterPointerMove);
    handle.addEventListener('pointerup', this.onSplitterPointerUp);
    handle.addEventListener('lostpointercapture', this.onSplitterPointerUp);
  };

  private onSplitterPointerMove = (event: PointerEvent) => {
    if (!this.splitterActive) {
      return;
    }
    const delta = event.clientX - this.splitterStartX;
    const maxWidth = this.splitEl
      ? Math.max(MIN_TREE_PANE_WIDTH, this.splitEl.clientWidth * 0.5)
      : 400;
    const next = Math.min(maxWidth, Math.max(MIN_TREE_PANE_WIDTH, this.splitterStartWidth + delta));
    this.treePaneWidth = Math.round(next);
  };

  private onSplitterPointerUp = (event: PointerEvent) => {
    if (!this.splitterActive) {
      return;
    }
    this.splitterActive = false;
    const handle = event.currentTarget as HTMLElement;
    handle.removeEventListener('pointermove', this.onSplitterPointerMove);
    handle.removeEventListener('pointerup', this.onSplitterPointerUp);
    handle.removeEventListener('lostpointercapture', this.onSplitterPointerUp);
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch {
      // pointer already released
    }
    this.projectService.saveAssetBrowserState({ treePaneWidth: this.treePaneWidth });
  };

  // ── Drop target for the root row ─────────────────────────────────────────
  private onRootDragOver = (event: DragEvent) => {
    if (appState.collaboration.isReadOnly) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  };

  private onRootDrop = (event: DragEvent) => {
    if (appState.collaboration.isReadOnly || !event.dataTransfer) {
      return;
    }
    event.preventDefault();
    void this.assetTreeRef?.handleRootDrop(event.dataTransfer);
  };

  protected render() {
    const isReadOnly = appState.collaboration.isReadOnly;
    const rootLabel = appState.project.projectName ?? 'Assets';

    return html`
      <pix3-panel
        panel-description="Open a project to browse textures, models, and prefabs."
        actions-label="Assets actions"
        @asset-activate=${this.onAssetActivate}
        @folder-navigate=${this.onFolderNavigate}
        @content-rename-request=${this.onContentRenameRequest}
        @content-delete-request=${this.onContentDeleteRequest}
      >
        <div
          class="assets-split"
          style=${`--assets-tree-width: ${this.treePaneWidth}px;`}
          ${ref(this.setSplitRef)}
        >
          <div class="assets-tree-pane">
            <div
              class="tree-root-row ${this.isRootSelected ? 'selected' : ''}"
              @click=${() => this.selectRoot()}
              @dragover=${this.onRootDragOver}
              @drop=${this.onRootDrop}
            >
              <span class="icon folder"
                >${this.iconService.getIcon('folder-solid', IconSize.MEDIUM)}</span
              >
              <span class="root-label" title=${rootLabel}>${rootLabel}</span>
              <span class="root-actions" @click=${(e: Event) => e.stopPropagation()}>
                <pix3-dropdown-button
                  class="root-create"
                  icon="plus-circle"
                  aria-label="Create asset"
                  ?disabled=${isReadOnly}
                  .items=${[
                    { id: 'folder', label: 'Create folder', icon: 'folder' },
                    { id: 'scene', label: 'Create scene', icon: 'film' },
                    { id: 'autoload-script', label: 'Create autoload script', icon: 'code' },
                    { id: 'import-divider', label: '', divider: true },
                    { id: 'import', label: 'Import…', icon: 'upload' },
                  ]}
                  @item-select=${(e: CustomEvent) => {
                    const id = (e.detail as { id: string }).id;
                    if (id === 'folder') {
                      void this.onCreateFolder();
                    } else if (id === 'scene') {
                      this.onCreateScene();
                    } else if (id === 'autoload-script') {
                      void this.onCreateAutoloadScript();
                    } else if (id === 'import') {
                      void this.onImportClick();
                    }
                  }}
                ></pix3-dropdown-button>
                <button
                  type="button"
                  class="root-action-btn ${this.assetViewMode === 'by-type' ? 'is-active' : ''}"
                  aria-label="Group by type"
                  aria-pressed=${this.assetViewMode === 'by-type'}
                  title=${this.assetViewMode === 'by-type'
                    ? 'Show project folder structure'
                    : 'Group assets by type'}
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this.onToggleViewMode();
                  }}
                >
                  ${this.iconService.getIcon('layers', IconSize.SMALL)}
                </button>
              </span>
            </div>
            <pix3-asset-tree ${ref(this.setAssetTreeRef)}></pix3-asset-tree>
          </div>
          <div
            class="assets-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize folder pane"
            @pointerdown=${this.onSplitterPointerDown}
          ></div>
          <pix3-assets-content></pix3-assets-content>
        </div>
      </pix3-panel>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-assets-panel': AssetsPanel;
  }
}
