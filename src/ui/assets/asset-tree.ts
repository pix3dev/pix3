import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { ifDefined } from 'lit/directives/if-defined.js';
import type { AssetActivation } from '@/services/assets/AssetFileActivationService';
import type { FileDescriptor } from '@/services/project/FileSystemAPIService';
import { AssetsPreviewService } from '@/services/assets/AssetsPreviewService';
import { ProjectService } from '@/services/project/ProjectService';
import { TemplateService, DEFAULT_TEMPLATE_SCENE_ID } from '@/services/project/TemplateService';
import { DialogService } from '@/services/editor/DialogService';
import { IconService } from '@/services/editor/IconService';
import { GeneratedAssetDropService } from '@/services/image-gen/GeneratedAssetDropService';
import { LibraryInsertService } from '@/services/library/LibraryInsertService';
import { computeDirectoryStats } from '@/services/assets/asset-folder-stats';
import { isDocumentActive } from '@/services/core/page-activity';
import {
  ASSET_PATH_LIST_MIME,
  getLibraryItemDragData,
  hasGenerationDragData,
  hasLibraryItemDragData,
} from '@/ui/shared/asset-drag-drop';
import { DropdownPortal } from '@/ui/shared/dropdown-portal';
import { appState, type AssetBrowserViewMode } from '@/state';
import { subscribe } from 'valtio/vanilla';
import { ASSET_CATEGORY_BY_ID, type AssetCategoryId } from '@/core/asset-categories';
import {
  buildGroupedTree,
  collectGroupedExpandedKeys,
  categoryIdFromPath,
  isCategoryPath,
  type AssetTreeNode as Node,
} from './grouped-asset-tree';
import './asset-tree.ts.css';

@customElement('pix3-asset-tree')
export class AssetTree extends ComponentBase {
  @inject(ProjectService)
  private readonly projectService!: ProjectService;
  @inject(TemplateService)
  private readonly templateService!: TemplateService;
  @inject(DialogService)
  private readonly dialogService!: DialogService;
  @inject(IconService)
  private readonly iconService!: IconService;
  @inject(AssetsPreviewService)
  private readonly assetsPreviewService!: AssetsPreviewService;
  @inject(GeneratedAssetDropService)
  private readonly generatedAssetDropService!: GeneratedAssetDropService;
  @inject(LibraryInsertService)
  private readonly libraryInsertService!: LibraryInsertService;
  // Parent will handle actions via 'asset-activate' event

  // root path to show, defaults to project root
  @property({ type: String }) rootPath = '.';

  @state()
  private tree: Node[] = [];

  @state()
  private selectedPath: string | null = null;

  @state()
  private viewMode: AssetBrowserViewMode = 'folders';

  /** The mode `this.tree` was actually built for (lags `viewMode` during a switch). */
  private treeViewMode: AssetBrowserViewMode = 'folders';

  /** Disambiguates selection when the same real path appears under two categories. */
  private selectedCategoryId: AssetCategoryId | null = null;

  /** Public getter for selected path (avoid accessing private internals) */
  public getSelectedPath(): string | null {
    if (isCategoryPath(this.selectedPath)) {
      return null;
    }
    return this.selectedPath;
  }

  public getViewMode(): AssetBrowserViewMode {
    return this.viewMode;
  }

  public async setViewMode(mode: AssetBrowserViewMode): Promise<void> {
    if (mode === this.viewMode) {
      return;
    }
    this.viewMode = mode;
    appState.project.assetBrowserViewMode = mode;
    if (mode === 'folders') {
      this.selectedCategoryId = null;
    }
    await this.loadRoot();
    this.saveState();
  }

  /**
   * Resolves the directory that new assets should be placed in, based on the
   * current selection: a selected folder is used directly, a selected file
   * resolves to its parent directory, and no selection falls back to the
   * project root (`.`). Virtual category rows also fall back to the root.
   */
  public getTargetDirectory(): string {
    const selected = this.selectedPath;
    if (!selected || isCategoryPath(selected)) {
      return '.';
    }
    const found = this.findNodeByPath(selected);
    if (found?.node?.kind === 'directory') {
      return selected;
    }
    return this.getParentPath(selected);
  }

  @state()
  private draggedPath: string | null = null;

  @state()
  private dragOverPath: string | null = null;

  @state()
  private isExternalDrag: boolean = false;

  /** Right-click context menu on a tree row (Rename / Delete). */
  @state()
  private contextMenu: { node: Node; x: number; y: number } | null = null;

  private readonly contextMenuPortal = new DropdownPortal({ minWidth: '12rem' });
  private readonly onGlobalPointerDownForMenu = (event: PointerEvent): void => {
    // `Node` is aliased to AssetTreeNode in this module; use the DOM node type explicitly.
    if (this.contextMenu && !this.contextMenuPortal.contains(event.target as globalThis.Node)) {
      this.closeContextMenu();
    }
  };
  private readonly onGlobalKeyDownForMenu = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.closeContextMenu();
    }
  };

  // Click-and-wait rename behavior
  private _lastClickedPath: string | null = null;
  private _renameTimer: number | null = null;
  private readonly _renameDelay = 500; // milliseconds

  private disposeSubscription?: () => void;

  private previousRootSignature: string | null = null;
  private treeRefreshQueue: Promise<void> = Promise.resolve();
  private externalCheckPromise: Promise<void> | null = null;
  private lastExternalCheckAt = 0;
  private readonly externalCheckCooldownMs = 1000;

  private onWindowFocus = async (): Promise<void> => {
    await this.maybeCheckForExternalChanges();
  };

  private onVisibilityChange = async (): Promise<void> => {
    await this.maybeCheckForExternalChanges();
  };

  private get isReadOnly(): boolean {
    return appState.collaboration.isReadOnly;
  }

  public async createFolder(): Promise<void> {
    if (this.isReadOnly) {
      return;
    }
    await this.startCreateFolder();
  }

  /** Recursively enumerates every project entry (files and directories). */
  private async walkProjectEntries(): Promise<FileDescriptor[]> {
    const collected: FileDescriptor[] = [];
    const collect = async (path: string): Promise<void> => {
      const entries = await this.listDirectory(path || '.');
      for (const entry of entries) {
        collected.push(entry);
        if (entry.kind === 'directory') {
          await collect(entry.path);
        }
      }
    };
    await collect(this.rootPath || '.');
    return collected;
  }

  private async buildRootSignature(): Promise<string> {
    try {
      const entries = await this.walkProjectEntries();
      return entries
        .map(entry => `${entry.path}:${entry.kind}`)
        .sort()
        .join('|');
    } catch {
      return '';
    }
  }

  private async checkForExternalChanges(): Promise<void> {
    try {
      const signature = await this.buildRootSignature();
      if (this.previousRootSignature === null) {
        this.previousRootSignature = signature;
        return;
      }

      if (this.previousRootSignature !== signature) {
        console.debug('[AssetTree] External changes detected, refreshing root');
        this.previousRootSignature = signature;
        await this.loadRoot();
      }
    } catch (err) {
      console.error('[AssetTree] Failed to check external changes', err);
    }
  }

  private async maybeCheckForExternalChanges(force = false): Promise<void> {
    if (appState.project.status !== 'ready' || !isDocumentActive(document)) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastExternalCheckAt < this.externalCheckCooldownMs) {
      return;
    }

    if (this.externalCheckPromise) {
      await this.externalCheckPromise;
      return;
    }

    this.lastExternalCheckAt = now;
    this.externalCheckPromise = this.checkForExternalChanges().finally(() => {
      this.externalCheckPromise = null;
    });
    await this.externalCheckPromise;
  }

  public createScene(): void {
    if (this.isReadOnly) {
      return;
    }
    this.startCreateScene();
  }

  public async deleteSelected(): Promise<void> {
    if (this.isReadOnly) {
      return;
    }
    if (!this.selectedPath) {
      console.warn('[AssetTree] No item selected for deletion');
      return;
    }
    await this.deleteEntry(this.selectedPath);
  }

  public async renameSelected(): Promise<void> {
    if (this.isReadOnly) {
      return;
    }
    if (!this.selectedPath) {
      console.warn('[AssetTree] No item selected for rename');
      return;
    }
    await this.startRename(this.selectedPath);
  }

  /**
   * Clears the current tree selection (used by the panel's project-root row,
   * which selects the root outside the tree).
   */
  public clearSelection(): void {
    this.selectedPath = null;
    this.selectedCategoryId = null;
    this.requestUpdate();
    this.saveState();
  }

  /**
   * Programmatically select a file/folder by its path
   * Expands parent directories if needed and ensures the path is visible
   */
  public async selectPath(targetPath: string): Promise<boolean> {
    if (this.viewMode === 'by-type') {
      return await this.selectPathInGroupedTree(targetPath);
    }

    const normalizedPath = targetPath.startsWith('.') ? targetPath.slice(1) : targetPath;
    const searchPath = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath;

    const findAndSelectNode = async (nodes: Node[], pathSegments: string[]): Promise<boolean> => {
      const [currentSegment, ...remainingSegments] = pathSegments;

      for (const node of nodes) {
        if (node.name !== currentSegment) {
          continue;
        }

        if (remainingSegments.length === 0) {
          // Found the target node (a directory — files are no longer tree rows).
          this.selectedPath = node.path;
          void this.assetsPreviewService.syncFromAssetSelection(node.path, node.kind);
          this.tree = [...this.tree];
          return true;
        }

        if (node.kind === 'directory') {
          // Ensure this directory is expanded (loads children if needed).
          if (node.children === null || !node.expanded) {
            await this.expandNode(node);
          }
          if (node.children && (await findAndSelectNode(node.children, remainingSegments))) {
            return true;
          }
          // File fallback: the only unmatched segment left is the final one and
          // it isn't a directory node — it's a file, which no longer exists in
          // the folders-only tree. Select this deepest matched directory and let
          // the content grid select the parent folder + highlight the file.
          if (remainingSegments.length === 1) {
            this.selectedPath = node.path;
            void this.assetsPreviewService.syncFromAssetSelection(targetPath, 'file');
            this.tree = [...this.tree];
            return true;
          }
        }
      }
      return false;
    };

    // Split path into segments
    const pathSegments = this.splitPath(searchPath);

    // Start searching from root
    const found = await findAndSelectNode(this.tree, pathSegments);

    if (!found) {
      // Force refresh and try again
      await this.loadRoot();
      const retryFound = await findAndSelectNode(this.tree, pathSegments);
      if (retryFound) {
        this.saveState();
        return true;
      }

      // Root-level file: it has no parent directory node to anchor on (and is not
      // itself a tree row in the folders-only tree). Select the project root and
      // let the content grid highlight the file.
      const parent = this.getParentPath(targetPath);
      if (parent === '.' || parent === '') {
        this.selectedPath = null;
        this.selectedCategoryId = null;
        void this.assetsPreviewService.syncFromAssetSelection(targetPath, 'file');
        this.tree = [...this.tree];
        this.saveState();
        return true;
      }

      console.warn('[AssetTree] Path not found in tree:', targetPath);
      return false;
    }

    this.saveState();
    return true;
  }

  /**
   * Reveal a file path in the tree and open it, mirroring a double-click activation
   * (dispatches `asset-activate`, so it goes through the same handler as opening a file
   * directly in the Asset Browser). Returns true when the path was found.
   */
  public async revealAndOpen(targetPath: string): Promise<boolean> {
    const selected = await this.selectPath(targetPath);
    if (!selected) {
      return false;
    }

    const normalizedTreePath = this.normalizeTreePath(targetPath);
    const normalizedTarget = this.normalizePath(normalizedTreePath);
    const normalizedSelected = this.selectedPath ? this.normalizePath(this.selectedPath) : null;

    // An exact selection match means a directory node was revealed (files are no
    // longer tree rows). Preserve directory behavior: reveal without activating.
    if (normalizedSelected === normalizedTarget || !normalizedTreePath) {
      return true;
    }

    // File reveal: no tree node exists, so build the activation directly from the
    // path and dispatch `asset-activate`, same as a file double-click did.
    const name = normalizedTreePath.split('/').pop() ?? normalizedTreePath;
    const activation: AssetActivation = {
      name,
      path: targetPath,
      kind: 'file',
      resourcePath: this.buildResourcePath(normalizedTreePath),
      extension: this.getFileExtension(name),
    };

    this.dispatchEvent(
      new CustomEvent<AssetActivation>('asset-activate', {
        detail: activation,
        bubbles: true,
        composed: true,
      })
    );
    return true;
  }

  /**
   * Reveal a real file/folder path inside the grouped view: expand its category and
   * the directory chain leading to it. Paths compacted away (intermediate chain
   * segments) are not present in the grouped tree and report a miss.
   */
  private async selectPathInGroupedTree(targetPath: string): Promise<boolean> {
    const normalized = this.normalizePath(this.normalizeTreePath(targetPath));
    if (!normalized || normalized === '.') {
      return false;
    }

    const tryReveal = (): boolean => {
      for (const category of this.tree) {
        if (category.nodeType !== 'category' || !category.children) {
          continue;
        }
        const trail = this.findGroupedTrail(category.children, normalized);
        if (!trail) {
          continue;
        }
        category.expanded = true;
        for (const ancestor of trail.ancestors) {
          ancestor.expanded = true;
        }
        this.selectedPath = trail.node.path;
        this.selectedCategoryId = category.categoryId ?? null;
        void this.assetsPreviewService.syncFromAssetSelection(trail.node.path, trail.node.kind);
        this.tree = [...this.tree];
        return true;
      }
      return false;
    };

    // File fallback: the path points at a file (no longer a grouped-tree node).
    // Select the deepest matched directory (or the category that lifted the
    // file's folder) and let the content grid highlight the file.
    const tryRevealFile = (): boolean => {
      const lastSlash = normalized.lastIndexOf('/');
      if (lastSlash < 0) {
        return false;
      }
      const parentPath = normalized.slice(0, lastSlash);

      for (const category of this.tree) {
        if (category.nodeType !== 'category' || !category.children) {
          continue;
        }
        const trail = this.findGroupedTrail(category.children, parentPath);
        if (!trail || trail.node.kind !== 'directory') {
          continue;
        }
        category.expanded = true;
        for (const ancestor of trail.ancestors) {
          ancestor.expanded = true;
        }
        trail.node.expanded = true;
        this.selectedPath = trail.node.path;
        this.selectedCategoryId = category.categoryId ?? null;
        void this.assetsPreviewService.syncFromAssetSelection(targetPath, 'file');
        this.tree = [...this.tree];
        return true;
      }

      // The parent folder may have been lifted into its category row.
      for (const category of this.tree) {
        if (category.nodeType !== 'category' || !category.folderPath) {
          continue;
        }
        if (this.normalizePath(category.folderPath) !== parentPath) {
          continue;
        }
        category.expanded = true;
        this.selectedPath = category.path;
        this.selectedCategoryId = category.categoryId ?? null;
        void this.assetsPreviewService.syncFromAssetSelection(targetPath, 'file');
        this.tree = [...this.tree];
        return true;
      }

      return false;
    };

    if (tryReveal()) {
      this.saveState();
      return true;
    }

    // Force refresh and try again (mirrors the folder-mode retry).
    await this.loadRoot();
    if (tryReveal()) {
      this.saveState();
      return true;
    }

    if (tryRevealFile()) {
      this.saveState();
      return true;
    }

    console.warn('[AssetTree] Path not found in grouped tree:', targetPath);
    return false;
  }

  private findGroupedTrail(
    nodes: Node[],
    normalizedPath: string,
    ancestors: Node[] = []
  ): { node: Node; ancestors: Node[] } | null {
    for (const node of nodes) {
      const nodePath = this.normalizePath(node.path);
      if (nodePath === normalizedPath) {
        return { node, ancestors: [...ancestors] };
      }
      if (
        node.kind === 'directory' &&
        node.children &&
        node.children.length > 0 &&
        normalizedPath.startsWith(`${nodePath}/`)
      ) {
        const found = this.findGroupedTrail(node.children, normalizedPath, [...ancestors, node]);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  private splitPath(path: string): string[] {
    return path
      .replace(/^[\\/]+/, '')
      .replace(/\\+/g, '/')
      .split('/')
      .filter(segment => segment.length > 0 && segment !== '.');
  }

  private normalizePath(path: string): string {
    const normalized = path
      .replace(/\\+/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    return normalized || '.';
  }

  private sortNodes(nodes: Node[]): Node[] {
    return nodes.sort(
      (a, b) =>
        Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
        a.name.localeCompare(b.name)
    );
  }

  private collectExpandedPaths(nodes: Node[], expandedPaths: Set<string>): void {
    for (const node of nodes) {
      if (node.kind === 'directory') {
        if (node.expanded) {
          expandedPaths.add(this.normalizePath(node.path));
        }
        if (node.children && node.children.length > 0) {
          this.collectExpandedPaths(node.children, expandedPaths);
        }
      }
    }
  }

  private async buildTreeFromExpandedPaths(
    directoryPath: string,
    expandedPaths: ReadonlySet<string>
  ): Promise<Node[]> {
    const entries = await this.listDirectory(directoryPath);
    const nextNodes: Node[] = [];

    for (const entry of entries) {
      // Folders-only tree: files are shown in the content grid, not as tree rows.
      // `listDirectory` still returns files (folder-size walk, external-change
      // signature, and create-existence checks depend on them) — exclude them
      // only here, at node-build time.
      if (entry.kind === 'file') {
        continue;
      }
      nextNodes.push(await this.createNodeFromEntry(entry, expandedPaths));
    }

    return this.sortNodes(nextNodes);
  }

  private async runSerializedTreeRefresh(task: () => Promise<void>): Promise<void> {
    const next = this.treeRefreshQueue.then(task, task);
    this.treeRefreshQueue = next.then(
      () => undefined,
      () => undefined
    );
    await next;
  }

  protected async firstUpdated(): Promise<void> {
    // Restore asset browser state (expanded folders and selected path) from localStorage
    await this.restoreState();

    // Subscribe only to lastModifiedDirectoryPath changes (file system changes)
    // Do not subscribe to lastOpenedScenePath (scene loading UI state)
    let previousModifiedDir = appState.project.lastModifiedDirectoryPath;
    let previousFileRefreshSignal = appState.project.fileRefreshSignal;
    let previousProjectId = appState.project.id;
    this.disposeSubscription = subscribe(appState.project, async () => {
      const modifiedDir = appState.project.lastModifiedDirectoryPath;
      const fileRefreshSignal = appState.project.fileRefreshSignal;
      const currentProjectId = appState.project.id;

      // Check if project changed - restore state for new project
      if (currentProjectId !== previousProjectId) {
        console.debug('[AssetTree] Project changed, restoring asset browser state', {
          previousProjectId,
          newProjectId: currentProjectId,
        });
        previousProjectId = currentProjectId;
        if (currentProjectId) {
          await this.loadRoot();
          await this.restoreState();
        }
        return;
      }

      // fileRefreshSignal guarantees refresh even for repeated updates in the same directory.
      if (fileRefreshSignal !== previousFileRefreshSignal) {
        previousFileRefreshSignal = fileRefreshSignal;
        previousModifiedDir = modifiedDir;
        console.debug('[AssetTree] Project file refresh signal received', {
          modifiedDirectory: modifiedDir,
          fileRefreshSignal,
        });
        if (modifiedDir) {
          await this.refreshDirectory(modifiedDir);
        } else {
          await this.loadRoot();
        }
        return;
      }

      // Fallback for code paths that still update only lastModifiedDirectoryPath.
      if (modifiedDir !== previousModifiedDir) {
        console.debug('[AssetTree] Project file refresh signal received', {
          modifiedDirectory: modifiedDir,
        });
        previousModifiedDir = modifiedDir;
        if (modifiedDir) {
          // Refresh only the affected directory
          await this.refreshDirectory(modifiedDir);
        } else {
          // If no specific directory indicated, refresh root
          await this.loadRoot();
        }
      }
    });

    // Initialize previous signature
    this.previousRootSignature = await this.buildRootSignature();

    // Listen for window focus and visibility changes to detect external file changes
    window.addEventListener('focus', this.onWindowFocus);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    // Dismiss the row context menu on outside pointerdown / Escape.
    window.addEventListener('pointerdown', this.onGlobalPointerDownForMenu, true);
    window.addEventListener('keydown', this.onGlobalKeyDownForMenu);
  }

  /** Move the row context menu into a body-level portal so it isn't clipped by the tree scroller. */
  protected updated(): void {
    if (this.contextMenu && !this.contextMenuPortal.isOpen()) {
      const menu = this.querySelector<HTMLElement>('.tree-context-menu');
      if (menu) {
        this.contextMenuPortal.openAt(this.contextMenu.x, this.contextMenu.y, menu);
      }
    } else if (!this.contextMenu && this.contextMenuPortal.isOpen()) {
      this.contextMenuPortal.close();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeSubscription?.();

    this.clearRenameTimer();
    this._lastClickedPath = null;

    window.removeEventListener('focus', this.onWindowFocus);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pointerdown', this.onGlobalPointerDownForMenu, true);
    window.removeEventListener('keydown', this.onGlobalKeyDownForMenu);
    this.contextMenuPortal.close();
  }

  /**
   * Saves current asset browser state (view mode, expanded paths/keys and selected path)
   * to appState and localStorage. Only the live tree's mode is re-collected; the other
   * mode keeps its last-saved expansion state.
   */
  private saveState(): void {
    if (this.treeViewMode === 'folders') {
      const expandedPaths = new Set<string>();
      this.collectExpandedPaths(this.tree, expandedPaths);
      appState.project.assetBrowserExpandedPaths = Array.from(expandedPaths);
    } else {
      const expandedKeys = new Set<string>();
      collectGroupedExpandedKeys(this.tree, expandedKeys);
      appState.project.assetBrowserGroupedExpandedKeys = Array.from(expandedKeys);
    }

    appState.project.assetBrowserSelectedPath = this.selectedPath;
    appState.project.assetBrowserViewMode = this.viewMode;

    this.projectService.saveAssetBrowserState({
      expandedPaths: appState.project.assetBrowserExpandedPaths,
      selectedPath: this.selectedPath,
      viewMode: this.viewMode,
      groupedExpandedKeys: appState.project.assetBrowserGroupedExpandedKeys,
    });
  }

  /**
   * Restores asset browser state (view mode, expanded paths and selected path) from localStorage.
   */
  private async restoreState(): Promise<void> {
    // First, load state from localStorage
    const loadedState = this.projectService.loadAssetBrowserState();

    if (loadedState) {
      // Update appState with loaded state
      appState.project.assetBrowserExpandedPaths = loadedState.expandedPaths;
      appState.project.assetBrowserSelectedPath = loadedState.selectedPath;
      appState.project.assetBrowserViewMode = loadedState.viewMode;
      appState.project.assetBrowserGroupedExpandedKeys = loadedState.groupedExpandedKeys;
      this.viewMode = loadedState.viewMode;
    }

    await this.loadRoot();

    if (loadedState && loadedState.selectedPath) {
      if (isCategoryPath(loadedState.selectedPath)) {
        this.selectedPath = loadedState.selectedPath;
        this.selectedCategoryId = categoryIdFromPath(loadedState.selectedPath);
        this.requestUpdate();
      } else {
        this.selectedPath = loadedState.selectedPath;
        await this.selectPath(loadedState.selectedPath);
      }
    }
  }

  private async listDirectory(path: string): Promise<FileDescriptor[]> {
    try {
      const entries = await this.projectService.listDirectory(path);
      return entries.filter(entry => !this.shouldExcludeEntry(entry));
    } catch {
      return [];
    }
  }

  private shouldExcludeEntry(entry: FileDescriptor): boolean {
    const normalizedPath = this.normalizePath(entry.path);
    const pathSegments = normalizedPath.split('/').filter(segment => segment.length > 0);

    if (entry.name.startsWith('.')) {
      return true;
    }

    if (entry.name === 'node_modules') {
      return true;
    }

    if (pathSegments.some(segment => segment.startsWith('.'))) {
      return true;
    }

    if (pathSegments.includes('node_modules')) {
      return true;
    }

    return false;
  }

  private async loadRoot(): Promise<void> {
    if (this.viewMode === 'by-type') {
      await this.loadGroupedRoot();
      return;
    }
    await this.loadFolderRoot();
  }

  private async loadFolderRoot(): Promise<void> {
    await this.runSerializedTreeRefresh(async () => {
      const expandedPaths = new Set<string>(appState.project.assetBrowserExpandedPaths || []);
      if (this.treeViewMode === 'folders') {
        this.collectExpandedPaths(this.tree, expandedPaths);
      }

      const nextTree = await this.buildTreeFromExpandedPaths(this.rootPath || '.', expandedPaths);
      this.tree = nextTree;
      this.treeViewMode = 'folders';

      if (this.selectedPath && !this.findNodeByPath(this.selectedPath)) {
        this.selectedPath = null;
        this.selectedCategoryId = null;
      }
    });
  }

  private async loadGroupedRoot(): Promise<void> {
    await this.runSerializedTreeRefresh(async () => {
      const expandedKeys = new Set<string>(appState.project.assetBrowserGroupedExpandedKeys || []);
      // Expand all categories only on first entry into the grouped view; while the
      // grouped tree is live, an empty set means the user collapsed everything.
      const defaultCategoryExpanded = expandedKeys.size === 0 && this.treeViewMode !== 'by-type';
      if (this.treeViewMode === 'by-type') {
        collectGroupedExpandedKeys(this.tree, expandedKeys);
      }

      const entries = await this.walkProjectEntries();
      const files = entries.filter(entry => entry.kind === 'file');
      this.tree = buildGroupedTree(files, {
        expandedKeys,
        defaultCategoryExpanded,
        // Folders-only tree: keep files in the trie (for compaction / sizes /
        // counts) but omit the file leaf nodes.
        includeFiles: false,
      });
      this.treeViewMode = 'by-type';

      if (this.selectedPath && !this.findNodeByPath(this.selectedPath)) {
        this.selectedPath = null;
        this.selectedCategoryId = null;
      }
    });
  }

  private async refreshDirectory(targetPath: string): Promise<void> {
    console.debug('[AssetTree] Refreshing tree from directory signal', { targetPath });
    await this.loadRoot();
  }

  private async expandNode(node: Node): Promise<void> {
    if (node.kind !== 'directory') return;
    if (node.children === null) {
      const entries = await this.listDirectory(node.path);
      const children: Node[] = [];
      for (const entry of entries) {
        // Folders-only tree: skip files (see buildTreeFromExpandedPaths).
        if (entry.kind === 'file') {
          continue;
        }
        children.push(await this.createNodeFromEntry(entry));
      }
      node.children = this.sortNodes(children);
    }
    node.expanded = true;
    // trigger update
    this.tree = [...this.tree];
    // Save state after expanding
    this.saveState();
  }

  private collapseNode(node: Node): void {
    node.expanded = false;
    this.tree = [...this.tree];
    // Save state after collapsing
    this.saveState();
  }

  private toggleNode(node: Node): void {
    if (node.expanded) this.collapseNode(node);
    else this.expandNode(node);
  }

  private clearRenameTimer(): void {
    if (this._renameTimer) {
      clearTimeout(this._renameTimer);
      this._renameTimer = null;
    }
  }

  private onSelect(node: Node, options?: { suppressRename?: boolean }): void {
    const isSameNode = this._lastClickedPath === node.path;
    const isAlreadySelected = this.selectedPath === node.path;

    this.clearRenameTimer();
    this.selectedCategoryId = node.categoryId ?? null;

    const isRenamable = node.nodeType !== 'category' && !this.isCompactedDirNode(node);
    const shouldStartRename =
      !options?.suppressRename && isSameNode && isAlreadySelected && isRenamable;

    if (shouldStartRename) {
      this._lastClickedPath = node.path;
      this._renameTimer = window.setTimeout(() => {
        this.clearRenameTimer();
        this._lastClickedPath = null;
        void this.startRename(node.path);
      }, this._renameDelay);
    } else if (isSameNode) {
      this._lastClickedPath = null;
      this.selectedPath = node.path;
      this.notifyAssetSelected(node);
    } else {
      this.selectedPath = node.path;
      this.notifyAssetSelected(node);

      this._lastClickedPath = node.path;
    }

    this.requestUpdate();

    // Save state after selection changes
    this.saveState();
  }

  private onNodeDoubleClick(event: MouseEvent, node: Node): void {
    event.preventDefault();
    event.stopPropagation();
    this.clearRenameTimer();
    this._lastClickedPath = null;
    if (node.kind === 'directory') {
      this.toggleNode(node);
      return;
    }
    this.activateAsset(node);
  }

  private onNodeKeyDown(event: KeyboardEvent, node: Node): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.onSelect(node, { suppressRename: true });
      if (event.key === 'Enter') {
        this.activateAsset(node);
      }
    }
  }

  private activateAsset(node: Node): void {
    if (node.kind !== 'file') {
      return;
    }

    const normalizedPath = this.normalizeTreePath(node.path);
    if (!normalizedPath) {
      console.warn('[AssetTree] Asset path is empty', node);
      return;
    }

    const activation: AssetActivation = {
      name: node.name,
      path: node.path,
      kind: node.kind,
      resourcePath: this.buildResourcePath(normalizedPath),
      extension: this.getFileExtension(node.name),
    };

    this.dispatchEvent(
      new CustomEvent<AssetActivation>('asset-activate', {
        detail: activation,
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Compacted grouped-view dirs (chain labels like `assets/ui`) can't be renamed in place. */
  private isCompactedDirNode(node: Node): boolean {
    return node.nodeType === 'dir' && node.name.includes('/');
  }

  private notifyAssetSelected(node: Node): void {
    if (node.nodeType === 'category') {
      // A category that compacted a single project folder opens that folder in the
      // preview; categories spanning multiple folders keep the preview untouched.
      if (node.folderPath) {
        void this.assetsPreviewService.syncFromAssetSelection(node.folderPath, 'directory');
      }
      return;
    }
    void this.assetsPreviewService.syncFromAssetSelection(node.path, node.kind);
    this.dispatchEvent(
      new CustomEvent('asset-selected', {
        detail: { path: node.path, kind: node.kind },
        bubbles: true,
        composed: true,
      })
    );
  }

  private buildResourcePath(normalizedPath: string): string {
    return `res://${normalizedPath}`;
  }

  private normalizeTreePath(path: string): string {
    return path.replace(/^(\.?\/)+/, '').replace(/^\/+/, '');
  }

  private getFileExtension(name: string): string {
    const lastDot = name.lastIndexOf('.');
    if (lastDot === -1 || lastDot === name.length - 1) {
      return '';
    }
    return name.substring(lastDot + 1).toLowerCase();
  }

  private async createNodeFromEntry(
    entry: FileDescriptor,
    expandedPaths?: ReadonlySet<string>
  ): Promise<Node> {
    const sizeBytes = await this.getNodeSizeBytes(entry);

    if (entry.kind === 'directory') {
      const isExpanded = expandedPaths?.has(this.normalizePath(entry.path)) ?? false;
      // The folders-only tree only expands directories that contain subdirectories;
      // a shallow listing tells us whether to render the expand triangle at all.
      const childEntries = await this.listDirectory(entry.path);
      const hasChildDirectories = childEntries.some(child => child.kind === 'directory');
      const directoryNode: Node = {
        name: entry.name,
        path: entry.path,
        kind: entry.kind,
        sizeBytes,
        expanded: isExpanded && hasChildDirectories,
        hasChildDirectories,
        children: isExpanded && hasChildDirectories ? [] : null,
      };

      if (directoryNode.expanded && expandedPaths) {
        directoryNode.children = await this.buildTreeFromExpandedPaths(entry.path, expandedPaths);
      }

      return directoryNode;
    }

    return {
      name: entry.name,
      path: entry.path,
      kind: entry.kind,
      sizeBytes,
      children: [],
    };
  }

  private async getNodeSizeBytes(entry: FileDescriptor): Promise<number | null> {
    if (entry.kind === 'file') {
      return entry.size ?? null;
    }

    return await this.getDirectoryContentSize(entry.path);
  }

  private async getDirectoryContentSize(directoryPath: string): Promise<number> {
    return (await computeDirectoryStats(this.projectService, directoryPath)).sizeBytes;
  }

  private getNodeMetaLabel(node: Node): string | null {
    if (node.sizeBytes === null) {
      return null;
    }

    return this.formatFileSize(node.sizeBytes);
  }

  private formatFileSize(sizeBytes: number): string {
    if (sizeBytes < 1024) {
      return `${sizeBytes} B`;
    }

    const kb = sizeBytes / 1024;
    if (kb < 1024) {
      return `${kb.toFixed(1)} KB`;
    }

    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  }

  private isNodeSelected(node: Node): boolean {
    if (this.selectedPath !== node.path) {
      return false;
    }
    if (node.categoryId === undefined || this.selectedCategoryId === null) {
      return true;
    }
    return this.selectedCategoryId === node.categoryId;
  }

  private renderNode(node: Node, depth = 0): ReturnType<typeof html> {
    const isCategory = node.nodeType === 'category';
    const isSelected = this.isNodeSelected(node);
    const isDragOver = this.dragOverPath === node.path && node.kind === 'directory' && !isCategory;
    const metaLabel = isCategory ? null : this.getNodeMetaLabel(node);
    // Only directories with subdirectories are expandable in the folders-only tree.
    // Folder mode: `hasChildDirectories` (computed at build). Grouped mode: derived
    // from `children`. A category is expandable only when it has child rows — a
    // category that compacted a lone folder holding just files (shown in the content
    // grid, not the tree) has no subfolders, so it gets no expand arrow.
    const isExpandable = isCategory
      ? (node.children?.length ?? 0) > 0
      : node.kind === 'directory' &&
        (node.hasChildDirectories ?? ((node.children?.length ?? 0) > 0 || node.children === null));
    const nameContent =
      isCategory && node.folderLabel
        ? html`${node.name}<span class="node-name-suffix"> (${node.folderLabel})</span>`
        : node.name;
    return html`<div
      class="tree-node"
      data-path=${node.path}
      role="treeitem"
      aria-expanded=${ifDefined(
        node.kind === 'directory' ? (node.expanded ? 'true' : 'false') : undefined
      )}
    >
      <div
        class="node-row ${isSelected ? 'selected' : ''} ${isDragOver
          ? 'drag-over'
          : ''} ${isCategory ? 'node-row--category' : ''}"
        @click=${() => this.onSelect(node)}
        @dblclick=${(e: MouseEvent) => this.onNodeDoubleClick(e, node)}
        @keydown=${(e: KeyboardEvent) => this.onNodeKeyDown(e, node)}
        @dragstart=${(e: DragEvent) => this.onDragStart(e, node)}
        @dragend=${(e: DragEvent) => this.onDragEnd(e)}
        @dragover=${(e: DragEvent) => this.onDragOver(e, node)}
        @dragleave=${(e: DragEvent) => this.onDragLeave(e, node)}
        @drop=${(e: DragEvent) => this.onDrop(e, node)}
        @contextmenu=${(e: MouseEvent) => this.onNodeContextMenu(e, node)}
        draggable=${isCategory ? 'false' : 'true'}
        tabindex="0"
      >
        ${isExpandable
          ? html`<button
              type="button"
              class="expander expander--visible expander--button ${node.expanded
                ? ''
                : 'expander--collapsed'}"
              @click=${(e: Event) => {
                e.stopPropagation();
                this.toggleNode(node);
              }}
              aria-label=${node.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            ></button>`
          : html`<span class="expander" aria-hidden="true"></span>`}
        ${isCategory
          ? this.categoryIcon(node)
          : node.kind === 'directory'
            ? this.folderIcon(!!node.expanded)
            : this.fileIcon()}
        ${node.editing
          ? html`<input
              class="node-edit"
              .value=${this._editingValue ?? node.name}
              @input=${(e: Event) => (this._editingValue = (e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => this.onEditKeyDown(e, node)}
              @blur=${() => this.commitCreateFolder(node)}
            />`
          : html`<span class="node-name">${nameContent}</span>`}
        ${isCategory && node.fileCount !== undefined
          ? html`<span class="node-meta node-count">${node.fileCount}</span>`
          : metaLabel
            ? html`<span class="node-meta">${metaLabel}</span>`
            : null}
      </div>
      ${node.expanded && node.children && node.children.length
        ? html`<div class="node-children" role="group">
            ${node.children.map(child => this.renderNode(child, depth + 1))}
          </div>`
        : null}
    </div>`;
  }

  private onDragStart(e: DragEvent, node: Node): void {
    // Prevent dragging while editing; virtual category rows are not draggable
    if (node.editing || node.nodeType === 'category') {
      e.preventDefault();
      return;
    }

    this.draggedPath = node.path;
    this.isExternalDrag = false;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = node.kind === 'file' ? 'copyMove' : 'move';
      e.dataTransfer.setData('text/plain', node.path);

      if (node.kind === 'file') {
        const normalizedPath = this.normalizeTreePath(node.path);
        if (normalizedPath) {
          const resourcePath = this.buildResourcePath(normalizedPath);
          e.dataTransfer.setData('application/x-pix3-asset-path', node.path);
          e.dataTransfer.setData('application/x-pix3-asset-resource', resourcePath);
          e.dataTransfer.setData('text/uri-list', resourcePath);
        }
      }
    }
  }

  private onDragEnd(_e: DragEvent): void {
    this.draggedPath = null;
    this.dragOverPath = null;
  }

  private onDragOver(_e: DragEvent, node: Node): void {
    // Virtual category rows are never drop targets (any payload kind).
    if (node.nodeType === 'category') {
      return;
    }

    // Dragging an Sprite Editor history entry — accept on directories only.
    if (hasGenerationDragData(_e.dataTransfer)) {
      if (node.kind !== 'directory') {
        return;
      }
      _e.preventDefault();
      if (_e.dataTransfer) {
        _e.dataTransfer.dropEffect = 'copy';
      }
      this.dragOverPath = node.path;
      return;
    }

    // Dragging a Library card — import its files into the project (directories only).
    if (hasLibraryItemDragData(_e.dataTransfer)) {
      if (node.kind !== 'directory') {
        return;
      }
      _e.preventDefault();
      if (_e.dataTransfer) {
        _e.dataTransfer.dropEffect = 'copy';
      }
      this.dragOverPath = node.path;
      return;
    }

    // Check if this is an external drag (files from outside browser)
    if (_e.dataTransfer?.items && _e.dataTransfer.items.length > 0) {
      const hasFiles = Array.from(_e.dataTransfer.items).some(item => item.kind === 'file');
      if (hasFiles) {
        this.isExternalDrag = true;
        // Only allow dropping on directories for external files
        if (node.kind !== 'directory') {
          return;
        }
        _e.preventDefault();
        if (_e.dataTransfer) {
          _e.dataTransfer.dropEffect = 'copy';
        }
        this.dragOverPath = node.path;
        return;
      }
    }

    // Handle internal drag (existing logic)
    // Only allow dropping on directories
    if (node.kind !== 'directory' || this.draggedPath === node.path) {
      return;
    }

    _e.preventDefault();
    if (_e.dataTransfer) {
      _e.dataTransfer.dropEffect = 'move';
    }

    // Clear tree root highlight when hovering over a specific node
    this.dragOverPath = node.path;
  }

  private onDragLeave(_e: DragEvent, node: Node): void {
    // Only clear drag over if we're actually leaving this node
    if (this.dragOverPath === node.path) {
      // Use a small delay to allow tree root drag over to take precedence
      setTimeout(() => {
        if (this.dragOverPath === node.path) {
          this.dragOverPath = null;
        }
      }, 10);
    }
  }

  private onTreeDragOver(e: DragEvent): void {
    // In the grouped view the tree background is the category list, not the project root.
    if (this.viewMode === 'by-type') {
      return;
    }

    // Dragging an Sprite Editor history entry — drop into the project root.
    if (hasGenerationDragData(e.dataTransfer)) {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      if (!this.dragOverPath || this.dragOverPath === '__TREE_ROOT__') {
        this.dragOverPath = '__TREE_ROOT__';
      }
      return;
    }

    // Dragging a Library card — import into the project root.
    if (hasLibraryItemDragData(e.dataTransfer)) {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      if (!this.dragOverPath || this.dragOverPath === '__TREE_ROOT__') {
        this.dragOverPath = '__TREE_ROOT__';
      }
      return;
    }

    // Check if this is an external drag (files from outside browser)
    if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
      const hasFiles = Array.from(e.dataTransfer.items).some(item => item.kind === 'file');
      if (hasFiles) {
        this.isExternalDrag = true;
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy';
        }
        // Only set tree root drag over if we're not already over a specific node
        if (!this.dragOverPath || this.dragOverPath === '__TREE_ROOT__') {
          this.dragOverPath = '__TREE_ROOT__';
        }
        return;
      }
    }

    // Handle internal drag (existing logic)
    if (!this.draggedPath) {
      return;
    }

    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }

    // Only set tree root drag over if we're not already over a specific node
    if (!this.dragOverPath || this.dragOverPath === '__TREE_ROOT__') {
      this.dragOverPath = '__TREE_ROOT__';
    }
  }

  private onTreeDragLeave(_e: DragEvent): void {
    // Clear drag over state if we're leaving the tree area
    // Use a small delay to allow node drag over to take precedence
    setTimeout(() => {
      if (this.dragOverPath === '__TREE_ROOT__') {
        this.dragOverPath = null;
      }
    }, 10);
  }

  private async onTreeDrop(e: DragEvent): Promise<void> {
    // Grouped view: "move to project root" via background drop is disabled.
    if (this.viewMode === 'by-type') {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (!e.dataTransfer) {
      this.dragOverPath = null;
      return;
    }

    // Reuse the shared root-drop handler (also called directly by the panel root row).
    await this.handleRootDrop(e.dataTransfer);
  }

  /**
   * Handles a drop targeting the project root (`.`): a generated-asset drop, an
   * external-file drop, or an internal move — the latter supports moving a whole
   * grid multi-selection at once. Exposed so the unified Assets panel's root row
   * can reuse the exact same logic instead of duplicating it.
   */
  public async handleRootDrop(dataTransfer: DataTransfer): Promise<void> {
    this.dragOverPath = null;

    // Dropping a Sprite Editor history entry into the project root.
    if (hasGenerationDragData(dataTransfer)) {
      await this.generatedAssetDropService.handleDrop(dataTransfer, '.');
      return;
    }

    // Dropping a Library card — import its files into the project.
    if (hasLibraryItemDragData(dataTransfer)) {
      await this.importLibraryBundle(dataTransfer);
      return;
    }

    // Check if this is an external file drop.
    const hasExternalFiles =
      !!dataTransfer.items && Array.from(dataTransfer.items).some(item => item.kind === 'file');
    if (this.isExternalDrag || hasExternalFiles) {
      if (dataTransfer.items) {
        await this.handleExternalFileDrop(dataTransfer.items, '.');
      }
      this.isExternalDrag = false;
      return;
    }

    // Internal move → project root (supports multi-path grid drags).
    await this.moveDroppedPaths(dataTransfer, '.', 'project root');
  }

  /**
   * Import a Library card dropped from the Library document: copies its bundle files into the
   * project (no scene node). Bundles always land under `res://assets/library/<slug>/`, so the
   * hovered folder is not honored — this is a plain "add files to the project" action. The write
   * signals a directory change, so both panes refresh automatically.
   */
  private async importLibraryBundle(dataTransfer: DataTransfer | null): Promise<void> {
    const drag = getLibraryItemDragData(dataTransfer);
    if (!drag) {
      return;
    }
    try {
      await this.libraryInsertService.copyBundleIntoProject(drag.itemId);
    } catch (error) {
      console.error('[AssetTree] Failed to import library item:', error);
    }
  }

  /**
   * Reads the dragged source paths from a drop, preferring the multi-path list
   * MIME (a JSON array set by the content grid's drag start) so an entire
   * multi-selection moves at once; falls back to the single `text/plain` path
   * (a tree-node drag) when the list MIME is absent.
   */
  private getDroppedSourcePaths(dataTransfer: DataTransfer): string[] {
    const listRaw = dataTransfer.getData(ASSET_PATH_LIST_MIME);
    if (listRaw) {
      try {
        const parsed: unknown = JSON.parse(listRaw);
        if (Array.isArray(parsed)) {
          const paths = parsed.filter(
            (value): value is string => typeof value === 'string' && value.length > 0
          );
          if (paths.length > 0) {
            return paths;
          }
        }
      } catch {
        // fall through to the single-path fallback
      }
    }

    const plain = dataTransfer.getData('text/plain');
    return plain ? [plain] : [];
  }

  /**
   * Moves the dragged source paths into `targetDirPath` behind a single
   * confirmation dialog, skipping no-op moves (items already in the target).
   */
  private async moveDroppedPaths(
    dataTransfer: DataTransfer,
    targetDirPath: string,
    targetLabel: string
  ): Promise<void> {
    const targetDir = targetDirPath || '.';
    const sourcePaths = this.getDroppedSourcePaths(dataTransfer).filter(sourcePath => {
      if (!sourcePath || sourcePath === targetDir) {
        return false;
      }
      // Skip items that already live directly in the target directory.
      return this.getParentPath(sourcePath) !== targetDir;
    });

    if (sourcePaths.length === 0) {
      return;
    }

    const message =
      sourcePaths.length === 1
        ? `Move "${sourcePaths[0].split('/').pop() || sourcePaths[0]}" to "${targetLabel}"?`
        : `Move ${sourcePaths.length} items to "${targetLabel}"?`;

    try {
      const confirmed = await this.dialogService.showConfirmation({
        title: sourcePaths.length === 1 ? 'Move Item?' : 'Move Items?',
        message,
        confirmLabel: 'Move',
        cancelLabel: 'Cancel',
        isDangerous: false,
      });

      if (!confirmed) {
        return;
      }

      for (const sourcePath of sourcePaths) {
        await this.performMove(sourcePath, targetDir);
      }
    } catch (error) {
      console.error('[AssetTree] Error during move operation:', error);
    }
  }

  private async onDrop(e: DragEvent, targetNode: Node): Promise<void> {
    // Defensive: category rows never accept drops (dragover doesn't preventDefault).
    if (targetNode.nodeType === 'category') {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    this.dragOverPath = null;

    // Dropping an Sprite Editor history entry — save into the target directory.
    if (hasGenerationDragData(e.dataTransfer)) {
      const targetDirectory =
        targetNode.kind === 'directory' ? targetNode.path : this.getParentPath(targetNode.path);
      await this.generatedAssetDropService.handleDrop(e.dataTransfer, targetDirectory);
      return;
    }

    // Dropping a Library card — import its files into the project.
    if (hasLibraryItemDragData(e.dataTransfer)) {
      await this.importLibraryBundle(e.dataTransfer);
      return;
    }

    // Check if this is an external file drop
    if (this.isExternalDrag && e.dataTransfer?.items) {
      await this.handleExternalFileDrop(e.dataTransfer.items, targetNode.path);
      this.isExternalDrag = false;
      return;
    }

    // Handle internal drag — supports multi-path grid drags via the list MIME.
    if (targetNode.kind !== 'directory' || !e.dataTransfer) {
      return;
    }
    await this.moveDroppedPaths(e.dataTransfer, targetNode.path, targetNode.name);
  }

  private async performMove(sourcePath: string, targetDirPath: string): Promise<void> {
    try {
      const sourceName = sourcePath.split('/').pop() || sourcePath;
      const targetPath = this.joinPath(targetDirPath === '.' ? '' : targetDirPath, sourceName);

      console.log('[AssetTree] Moving', { sourcePath, targetPath });

      // Use ProjectService to move the file/folder
      await this.projectService.moveItem(sourcePath, targetPath);

      // Refresh both source parent and target directory
      const sourceParent = this.getParentPath(sourcePath);
      const targetParent = targetDirPath;

      // Refresh source parent
      if (sourceParent === '.' || sourceParent === '') {
        await this.loadRoot();
      } else {
        await this.refreshDirectory(sourceParent);
      }

      // Refresh target if different from source
      if (targetParent !== sourceParent) {
        if (targetParent === '.' || targetParent === '') {
          // Refresh root to show the moved item
          await this.loadRoot();
        } else {
          await this.refreshDirectory(targetParent);
        }
      }

      this.selectedPath = targetPath;
      console.log('[AssetTree] Move completed successfully');
    } catch (error) {
      console.error('[AssetTree] Failed to move item:', error);
    }
  }

  private async handleExternalFileDrop(
    items: DataTransferItemList,
    targetPath: string
  ): Promise<void> {
    try {
      // Get files from dataTransfer (simplified approach)
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }

      if (files.length === 0) {
        return;
      }

      // Show confirmation dialog for multiple files
      const message =
        files.length === 1
          ? `Copy "${files[0].name}" to "${targetPath === '.' ? 'project root' : targetPath}"?`
          : `Copy ${files.length} items to "${targetPath === '.' ? 'project root' : targetPath}"?`;

      const confirmed = await this.dialogService.showConfirmation({
        title: 'Copy Files?',
        message,
        confirmLabel: 'Copy',
        cancelLabel: 'Cancel',
        isDangerous: false,
      });

      if (!confirmed) {
        return;
      }

      // Process each file
      for (const file of files) {
        await this.copyExternalFile(file, targetPath);
      }

      // Refresh target directory
      if (targetPath === '.' || targetPath === '') {
        await this.loadRoot();
      } else {
        await this.refreshDirectory(targetPath);
      }

      console.log(
        `[AssetTree] Successfully copied ${files.length} external files to ${targetPath}`
      );
    } catch (error) {
      console.error('[AssetTree] Error handling external file drop:', error);
    }
  }

  private async copyExternalFile(file: File, targetPath: string): Promise<void> {
    try {
      // Handle directory structure in file name
      const fullPath = this.joinPath(targetPath === '.' ? '' : targetPath, file.name);
      console.log(`[AssetTree] Copying file ${file.name} to ${fullPath}`);

      // If file contains path separators, create directories
      const pathParts = fullPath.split('/');
      if (pathParts.length > 1) {
        const dirPath = pathParts.slice(0, -1).join('/');
        console.log(`[AssetTree] Creating directory structure: ${dirPath}`);
        await this.projectService.createDirectory(dirPath);
      }

      // Read file content and write to project
      if (
        file.type.startsWith('text/') ||
        file.name.endsWith('.json') ||
        file.name.endsWith('.pix3scene')
      ) {
        // Text files
        const content = await file.text();
        await this.projectService.writeFile(fullPath, content);
      } else {
        // Binary files
        const arrayBuffer = await file.arrayBuffer();
        await this.projectService.writeBinaryFile(fullPath, arrayBuffer);
      }

      console.log(`[AssetTree] Copied external file: ${file.name} to ${fullPath}`);
    } catch (error) {
      console.error(`[AssetTree] Failed to copy external file ${file.name}:`, error);
      throw error;
    }
  }

  private folderIcon(open: boolean) {
    const title = open ? 'Open folder' : 'Closed folder';

    return html`<span class="icon folder" role="img" aria-label=${title} title=${title}>
      ${this.iconService.getIcon('folder-solid', 16)}
    </span>`;
  }

  private fileIcon() {
    const title = 'File';
    return html`<span class="icon file" role="img" aria-label=${title} title=${title}>
      ${this.iconService.getIcon('file-solid', 16)}
    </span>`;
  }

  private categoryIcon(node: Node) {
    const definition = node.categoryId ? ASSET_CATEGORY_BY_ID[node.categoryId] : null;
    return html`<span class="icon category" role="img" aria-label=${node.name} title=${node.name}>
      ${this.iconService.getIcon(definition?.icon ?? 'folder', 16)}
    </span>`;
  }

  protected render() {
    const isDragOverRoot = this.dragOverPath === '__TREE_ROOT__';
    return html`<div class="asset-tree-root">
      <div
        class="tree ${isDragOverRoot ? 'drag-over-root' : ''}"
        role="tree"
        aria-label="Assets"
        @dragover=${this.onTreeDragOver}
        @dragleave=${this.onTreeDragLeave}
        @drop=${this.onTreeDrop}
      >
        ${this.tree.length === 0
          ? html`<p class="empty">No assets</p>`
          : this.tree.map(n => this.renderNode(n))}
      </div>
      ${this.renderContextMenu()}
    </div>`;
  }

  // ── Row context menu (Rename / Delete) ───────────────────────────────────
  private onNodeContextMenu(event: MouseEvent, node: Node): void {
    // Virtual category rows and compacted grouped dirs can't be renamed/deleted.
    if (node.nodeType === 'category' || this.isCompactedDirNode(node)) {
      this.closeContextMenu();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.onSelect(node, { suppressRename: true });
    this.contextMenu = { node, x: event.clientX, y: event.clientY };
  }

  private closeContextMenu(): void {
    if (this.contextMenu) {
      this.contextMenu = null;
    }
  }

  private onContextRename(node: Node): void {
    this.closeContextMenu();
    void this.startRename(node.path);
  }

  private async onContextDelete(node: Node): Promise<void> {
    this.closeContextMenu();
    if (this.isReadOnly || isCategoryPath(node.path)) {
      return;
    }
    const confirmed = await this.dialogService.showConfirmation({
      title: 'Delete Item?',
      message: `Are you sure you want to delete ${node.name}?`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      isDangerous: true,
    });
    if (confirmed) {
      await this.deleteEntry(node.path);
    }
  }

  private renderContextMenu(): ReturnType<typeof html> {
    // Always rendered (gated by `hidden`) so DropdownPortal can move/restore the same
    // node cleanly — matches the content pane's context menu.
    const node = this.contextMenu?.node ?? null;
    return html`<div
      class="tree-context-menu"
      role="menu"
      ?hidden=${!this.contextMenu}
      @click=${(e: Event) => e.stopPropagation()}
    >
      ${node
        ? html`
            <button type="button" role="menuitem" @click=${() => this.onContextRename(node)}>
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              class="is-danger"
              @click=${() => void this.onContextDelete(node)}
            >
              Delete
            </button>
          `
        : null}
    </div>`;
  }

  private async startRename(path: string): Promise<void> {
    if (this.isReadOnly) {
      return;
    }
    if (isCategoryPath(path)) {
      return;
    }
    const nodeEntry = this.findNodeByPath(path);
    if (!nodeEntry || !nodeEntry.node) {
      console.warn('[AssetTree] Node not found for rename:', path);
      return;
    }
    if (nodeEntry.node.nodeType === 'category' || this.isCompactedDirNode(nodeEntry.node)) {
      return;
    }

    this.clearRenameTimer();
    this._lastClickedPath = null;

    const node = nodeEntry.node;
    node.editing = true;

    // Cache the original file extension for rename operations
    const originalName = node.name;
    const lastDotIndex = originalName.lastIndexOf('.');
    this._originalExtension = lastDotIndex > -1 ? originalName.substring(lastDotIndex) : '';
    this._isNewScene = false; // This is a rename, not new scene creation

    // For files, show name without extension for cleaner editing
    this._editingValue = lastDotIndex > -1 ? originalName.substring(0, lastDotIndex) : originalName;
    this.requestUpdate();

    // focus input after render
    await this.updateComplete;
    const input = this.renderRoot.querySelector('.node-edit') as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.select();
    }
  }

  private _editingValue: string | null = null;

  // Cache original extension and operation type for rename operations
  private _originalExtension: string = '';
  private _isNewScene: boolean = true;

  /**
   * Resolves the real directory node that create flows should nest under.
   * Virtual category rows (grouped view) fall back to the project root.
   */
  private resolveCreateParent(): { parentPath: string; parentNode: Node | null } {
    const selected =
      this.selectedPath && !isCategoryPath(this.selectedPath)
        ? this.findNodeByPath(this.selectedPath)
        : null;
    const node =
      selected?.node && selected.node.nodeType !== 'category' && selected.node.kind === 'directory'
        ? selected.node
        : null;
    return node
      ? { parentPath: node.path, parentNode: node }
      : { parentPath: '.', parentNode: null };
  }

  private startCreateScene(): void {
    if (this.isReadOnly) {
      return;
    }
    // similar to startCreateFolder but for scene file
    const { parentPath, parentNode } = this.resolveCreateParent();

    const newName = 'New Scene';
    const newPath = this.joinPath(parentPath, `${newName}.pix3scene`);
    const newNode: Node = {
      name: `${newName}.pix3scene`,
      path: newPath,
      kind: 'file',
      sizeBytes: null,
      children: [],
      editing: true,
    };

    if (parentNode) {
      parentNode.children = parentNode.children || [];
      parentNode.children.unshift(newNode);
      parentNode.expanded = true;
    } else {
      this.tree.unshift(newNode);
    }

    // For new scene creation, force .pix3scene extension
    this._isNewScene = true;
    this._originalExtension = '.pix3scene';
    this._editingValue = newName; // Show without extension for editing
    this.selectedPath = newPath;
    this.requestUpdate();

    this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector('.node-edit') as HTMLInputElement | null;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  private async startCreateFolder(): Promise<void> {
    if (this.isReadOnly) {
      return;
    }
    // determine parent path; ensure parent is expanded and children loaded
    const { parentPath, parentNode } = this.resolveCreateParent();
    if (parentNode && parentNode.children === null) {
      await this.expandNode(parentNode);
    }

    const newName = 'New Folder';
    const newPath = this.joinPath(parentPath, newName);
    const newNode: Node = {
      name: newName,
      path: newPath,
      kind: 'directory',
      sizeBytes: 0,
      children: [],
      editing: true,
    };

    if (parentNode) {
      parentNode.children = parentNode.children || [];
      parentNode.children.unshift(newNode);
      parentNode.expanded = true;
    } else {
      // root
      this.tree.unshift(newNode);
    }

    // For folder creation, no extension needed
    this._isNewScene = false;
    this._originalExtension = '';
    this._editingValue = newName;
    this.selectedPath = newPath;
    this.requestUpdate();

    // focus input after render
    await this.updateComplete;
    const input = this.renderRoot.querySelector('.node-edit') as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.select();
    }
  }

  private onEditKeyDown(e: KeyboardEvent, node: Node) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.cancelCreateFolder(node);
    } else if (e.key === 'Enter') {
      e.preventDefault(); // Prevent any default form submission or other behavior
      e.stopPropagation();
      this.commitCreateFolder(node);
    }
  }

  private async cancelCreateFolder(node: Node) {
    // remove the temporary node
    const removed = this.removeNodeByPath(node.path);
    this._editingValue = null;
    this._originalExtension = '';
    this._isNewScene = true;
    if (removed) {
      this.requestUpdate();
    }
  }

  private _committing = false;

  private async commitCreateFolder(node: Node) {
    // Prevent double execution
    if (this._committing) {
      return;
    }
    this._committing = true;

    let isRename = false;

    try {
      const finalName = (this._editingValue ?? node.name).trim();

      // Check if this is a rename (existing node) or create (new node)
      // by checking if the file exists in the filesystem
      const parentPath = this.getParentPath(node.path);
      const entries = await this.listDirectory(parentPath === '.' ? '.' : parentPath);
      const existingEntry = entries.find(e => e.path === node.path);
      isRename = !!existingEntry;

      // If this is a rename and the name is empty or unchanged, just cancel editing
      if (isRename) {
        const originalName = node.name;
        const finalNameWithoutExt = finalName.includes('.')
          ? finalName.substring(0, finalName.lastIndexOf('.'))
          : finalName;
        const originalNameWithoutExt = originalName.includes('.')
          ? originalName.substring(0, originalName.lastIndexOf('.'))
          : originalName;

        if (!finalName || finalNameWithoutExt === originalNameWithoutExt) {
          // Just cancel editing without deleting the existing folder
          node.editing = false;
          this._editingValue = null;
          this._originalExtension = '';
          this._isNewScene = true;
          this.requestUpdate();
          return;
        }
      } else {
        // For new items, empty name means cancel creation
        if (!finalName) {
          await this.cancelCreateFolder(node);
          return;
        }
      }

      console.log('[AssetTree] commitCreateFolder', {
        nodePath: node.path,
        finalName,
        isRename,
        existingEntry: existingEntry?.name,
        editingValue: this._editingValue,
        nodeName: node.name,
      });

      const newPath = this.joinPath(parentPath === '.' ? '' : parentPath, finalName);

      if (isRename) {
        // Rename existing item
        let finalFileName = finalName;

        if (node.kind === 'file') {
          // For rename operations, preserve the original extension unless user explicitly removed it
          // and they want to change it to a scene file
          if (this._originalExtension) {
            // User had an extension, check if they want to keep it or change it
            if (!finalName.includes('.')) {
              // User didn't specify extension, restore the original one
              finalFileName = finalName + this._originalExtension;
            } else {
              // User specified an extension, use what they provided
              finalFileName = finalName;
            }
          } else {
            // No original extension (unlikely for files, but handle it)
            finalFileName = finalName;
          }
        }

        const renamedPath = this.joinPath(parentPath === '.' ? '' : parentPath, finalFileName);
        await this.projectService.moveItem(node.path, renamedPath);
        node.path = renamedPath;
        node.name = finalFileName;
      } else {
        // Create new item
        if (node.kind === 'directory') {
          await this.projectService.createDirectory(newPath);
        } else if (node.kind === 'file') {
          // For new files, force the appropriate extension
          let filename = finalName;

          if (this._isNewScene) {
            // New scene creation - always force .pix3scene extension
            if (!filename.endsWith('.pix3scene')) {
              filename = `${filename}.pix3scene`;
            }
          } else if (this._originalExtension) {
            // New file with original extension preserved
            if (!filename.includes('.')) {
              filename = filename + this._originalExtension;
            }
          }
          // If no extension specified and no original extension, leave as-is

          const filePath = this.joinPath(parentPath === '.' ? '' : parentPath, filename);

          if (this._isNewScene) {
            const template = this.templateService.getSceneTemplate(DEFAULT_TEMPLATE_SCENE_ID);
            await this.projectService.writeFile(filePath, template);
          }

          node.path = filePath;
          node.name = filename;
        }
      }

      // refresh parent in UI
      if (parentPath === '.' || parentPath === '') {
        await this.loadRoot();
      } else {
        const parentNodeEntry = this.findNodeByPath(parentPath);
        if (parentNodeEntry && parentNodeEntry.node) {
          parentNodeEntry.node.children = null;
          await this.expandNode(parentNodeEntry.node);
        }
      }

      this.selectedPath = newPath.replace(/^\//, '');
      node.editing = false;
      this._editingValue = null;
      this._originalExtension = '';
      this._isNewScene = true;
      this.requestUpdate();
    } catch (err) {
      console.error('Failed to create/rename item', err);
      // remove temp node for create operations
      if (!isRename) {
        await this.cancelCreateFolder(node);
      }
    } finally {
      this._committing = false;
    }
  }

  private getParentPath(path: string): string {
    const parts = path.split('/').filter(p => p.length > 0);
    if (parts.length <= 1) return '.';
    return parts.slice(0, -1).join('/');
  }

  private joinPath(base: string, name: string): string {
    if (!base || base === '.' || base === '') return name;
    return `${base.replace(/\/+$/, '')}/${name}`;
  }

  private findNodeByPath(path: string): { node?: Node; parent?: Node | null } | null {
    const stack: Array<{ node: Node; parent: Node | null }> = this.tree.map(n => ({
      node: n,
      parent: null,
    }));
    while (stack.length) {
      const { node, parent } = stack.shift()!;
      if (node.path === path) return { node, parent };
      if (node.children && node.children.length) {
        for (const child of node.children) stack.push({ node: child, parent: node });
      }
    }
    return null;
  }

  private removeNodeByPath(path: string): boolean {
    // try root
    const idx = this.tree.findIndex(n => n.path === path);
    if (idx >= 0) {
      this.tree.splice(idx, 1);
      this.tree = [...this.tree];
      return true;
    }
    // recurse
    const walk = (nodes: Node[]): boolean => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.path === path) {
          nodes.splice(i, 1);
          return true;
        }
        if (n.children && n.children.length) {
          if (walk(n.children)) return true;
        }
      }
      return false;
    };
    const removed = walk(this.tree);
    if (removed) this.tree = [...this.tree];
    return removed;
  }

  private async deleteEntry(path: string): Promise<void> {
    if (this.isReadOnly) {
      return;
    }
    if (isCategoryPath(path)) {
      console.warn('[AssetTree] Category rows cannot be deleted:', path);
      return;
    }
    try {
      console.log('[AssetTree] Deleting entry at path:', path);
      await this.projectService.deleteEntry(path);

      // Remove from tree UI
      const found = this.removeNodeByPath(path);
      if (!found) {
        console.warn('[AssetTree] Entry not found in tree:', path);
      }

      // Clear selection
      this.selectedPath = null;
      this.requestUpdate();

      console.log('[AssetTree] Entry deleted successfully:', path);
    } catch (error) {
      console.error('[AssetTree] Failed to delete entry:', error);
      throw error;
    }
  }

  // create-asset event no longer used here; menu directly starts creation flows
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-asset-tree': AssetTree;
  }
}
