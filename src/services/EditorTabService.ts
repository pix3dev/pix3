import { injectable, inject } from '@/fw/di';
import { appState, type EditorTab, type EditorTabType } from '@/state';
import { LayoutManagerService } from '@/core/LayoutManager';
import { DialogService } from '@/services/DialogService';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { LoadAnimationCommand } from '@/features/scene/LoadAnimationCommand';
import { LoadSceneCommand } from '@/features/scene/LoadSceneCommand';
import { SaveAnimationCommand } from '@/features/scene/SaveAnimationCommand';
import { SaveSceneCommand } from '@/features/scene/SaveSceneCommand';
import { RefreshPrefabInstancesCommand } from '@/features/scene/RefreshPrefabInstancesCommand';
import { deriveAnimationDocumentId } from '@/features/scene/animation-asset-utils';
import { ViewportRendererService } from '@/services/ViewportRenderService';
import { OperationService } from '@/services/OperationService';
import { AnimationEditorService } from '@/services/AnimationEditorService';
import { SetPlayModeOperation } from '@/features/scripts/SetPlayModeOperation';
import { SceneManager } from '@pix3/runtime';
import { subscribe } from 'valtio/vanilla';
import { CodeDocumentService } from '@/services/CodeDocumentService';

export type DirtyCloseDecision = 'save' | 'dont-save' | 'cancel';

@injectable()
export class EditorTabService {
  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(ViewportRendererService)
  private readonly viewportRenderer!: ViewportRendererService;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(OperationService)
  private readonly operationService!: OperationService;

  @inject(AnimationEditorService)
  private readonly animationEditorService!: AnimationEditorService;

  @inject(CodeDocumentService)
  private readonly codeDocumentService!: CodeDocumentService;

  private disposeSceneSubscription?: () => void;
  private disposeAnimationSubscription?: () => void;
  private disposeLayoutSubscription?: () => void;
  private disposeTabsSubscription?: () => void;
  private disposeCodeDocumentsSubscription?: () => void;
  private handleBeforeUnload?: (e: BeforeUnloadEvent) => void;
  private readonly sceneLoadInFlight = new Map<string, Promise<void>>();
  private readonly animationLoadInFlight = new Map<string, Promise<void>>();
  private previousActiveTabIdBeforeGame: string | null = null; // Track tab active before game tab
  private isRestoringProjectSession = false;

  initialize(): void {
    if (this.disposeSceneSubscription) return;

    // Keep tab titles in sync with resource descriptor dirty state.
    this.disposeSceneSubscription = subscribe(appState.scenes, () => {
      this.syncResourceTabsFromDescriptors();
    });

    this.disposeAnimationSubscription = subscribe(appState.animations, () => {
      this.syncResourceTabsFromDescriptors();
    });

    this.disposeCodeDocumentsSubscription = this.codeDocumentService.subscribeAll(() => {
      this.syncResourceTabsFromDescriptors();
    });

    this.disposeLayoutSubscription = this.layoutManager.subscribeEditorTabFocused(tabId => {
      void this.handleGoldenLayoutTabFocused(tabId);
    });

    // Route Golden Layout tab close (x) through our close flow.
    this.layoutManager.subscribeEditorTabCloseRequested(tabId => {
      void this.closeTab(tabId);
    });

    // Persist open tabs and active tab per project.
    this.disposeTabsSubscription = subscribe(
      appState.tabs,
      () => {
        const projectId = appState.project.id;
        if (!projectId) return;

        const filteredTabs = appState.tabs.tabs.filter(
          t => !t.resourceId.startsWith('templ://') && t.type !== 'game'
        );

        let savedActiveTabId = appState.tabs.activeTabId;
        const activeTab = appState.tabs.tabs.find(t => t.id === savedActiveTabId);

        // If the active tab is excluded (like game tab), use the previous active tab
        if (
          activeTab &&
          (activeTab.resourceId.startsWith('templ://') || activeTab.type === 'game')
        ) {
          savedActiveTabId =
            this.previousActiveTabIdBeforeGame ??
            (filteredTabs.length > 0 ? filteredTabs[0].id : null);
        }

        const session = {
          tabs: filteredTabs.map(t => ({
            resourceId: t.resourceId,
            type: t.type,
            title: t.title,
            contextState: t.contextState,
          })),
          activeTabId: savedActiveTabId,
        };

        try {
          localStorage.setItem(`pix3.projectTabs:${projectId}`, JSON.stringify(session));
        } catch (e) {
          console.error('[EditorTabService] Failed to persist tabs session', e);
        }
      },
      true // deep subscription to catch contextState changes
    );

    this.handleBeforeUnload = (e: BeforeUnloadEvent) => {
      this.captureActiveContextState();

      // Prompt the user if any editor tab has unsaved changes.
      if (!appState.ui.warnOnUnsavedUnload) {
        return;
      }

      const hasDirty = appState.tabs.tabs.some(t => t.isDirty);
      if (hasDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', this.handleBeforeUnload);
  }

  dispose(): void {
    this.disposeSceneSubscription?.();
    this.disposeSceneSubscription = undefined;
    this.disposeAnimationSubscription?.();
    this.disposeAnimationSubscription = undefined;
    this.disposeLayoutSubscription?.();
    this.disposeLayoutSubscription = undefined;
    this.disposeTabsSubscription?.();
    this.disposeTabsSubscription = undefined;
    this.disposeCodeDocumentsSubscription?.();
    this.disposeCodeDocumentsSubscription = undefined;
    if (this.handleBeforeUnload) {
      window.removeEventListener('beforeunload', this.handleBeforeUnload);
      this.handleBeforeUnload = undefined;
    }
  }

  async openResourceTab(
    type: EditorTabType,
    resourceId: string,
    contextState?: EditorTab['contextState'],
    activate = true,
    initialTitle?: string
  ): Promise<EditorTab> {
    this.initialize();

    const tabId = this.deriveTabId(type, resourceId);
    const existing = appState.tabs.tabs.find(t => t.id === tabId);
    console.log('[EditorTabService] openResourceTab:', {
      type,
      resourceId,
      tabId,
      activate,
      existing: !!existing,
    });

    if (existing) {
      if (activate) {
        this.layoutManager.ensureEditorTab(existing, true);
        await this.focusTab(existing.id);
      } else {
        // Even if not activating, ensure GL component exists if it's already in state
        this.layoutManager.ensureEditorTab(existing, false);
      }
      return existing;
    }

    // Before opening a game tab, save the current active scene tab to restore later.
    // Use active scene as source of truth because layout focus events can temporarily
    // desync appState.tabs.activeTabId from the scene currently being edited.
    if (type === 'game' && !existing && activate) {
      const activeSceneTabId = this.findSceneTabIdBySceneId(appState.scenes.activeSceneId);
      this.previousActiveTabIdBeforeGame = activeSceneTabId ?? appState.tabs.activeTabId;
      console.log(
        '[EditorTabService] Saving previous active tab before game:',
        this.previousActiveTabIdBeforeGame
      );
    }

    const tab: EditorTab = {
      id: tabId,
      type,
      resourceId,
      title: initialTitle ?? this.deriveTitle(resourceId),
      isDirty: false,
      contextState: contextState ?? {},
    };

    appState.tabs.tabs = [...appState.tabs.tabs, tab];

    // When activating, allow auto-focus; when not activating, prevent auto-focus to avoid interfering with explicit focus later
    this.layoutManager.ensureEditorTab(tab, activate);
    // focusEditorTab is now called asynchronously inside ensureEditorTab after the component factory runs (if shouldAutoFocus=true)

    if (activate) {
      await this.activateTab(tab.id);
    }

    return tab;
  }

  async focusOrOpenScene(resourcePath: string): Promise<void> {
    await this.openResourceTab('scene', resourcePath);
  }

  async focusOrOpenAnimation(resourcePath: string): Promise<void> {
    await this.openResourceTab('animation', resourcePath);
  }

  async focusOrOpenCode(resourcePath: string): Promise<void> {
    await this.openResourceTab('code', resourcePath);
  }

  remapSceneTabs(remapResourcePath: (resourcePath: string) => string | null): void {
    let didChange = false;
    let nextActiveTabId = appState.tabs.activeTabId;
    const tabsToRecreate: EditorTab[] = [];
    const nextTabs: EditorTab[] = [];

    for (const tab of appState.tabs.tabs) {
      if (tab.type !== 'scene') {
        nextTabs.push(tab);
        continue;
      }

      const nextResourceId = remapResourcePath(tab.resourceId);
      if (!nextResourceId || nextResourceId === tab.resourceId) {
        nextTabs.push(tab);
        continue;
      }

      didChange = true;
      const nextTabId = this.deriveTabId(tab.type, nextResourceId);
      const nextTitleBase = this.deriveTitle(nextResourceId);
      const nextTab: EditorTab = {
        ...tab,
        id: nextTabId,
        resourceId: nextResourceId,
        title: tab.isDirty ? `*${nextTitleBase}` : nextTitleBase,
      };

      if (tab.id !== nextTabId) {
        this.layoutManager.removeEditorTab(tab.id);
        tabsToRecreate.push(nextTab);
      } else {
        this.layoutManager.updateEditorTabTitle(nextTab.id, nextTab.title);
      }

      if (nextActiveTabId === tab.id) {
        nextActiveTabId = nextTab.id;
      }

      nextTabs.push(nextTab);
    }

    if (!didChange) {
      return;
    }

    appState.tabs.tabs = nextTabs;
    appState.tabs.activeTabId = nextActiveTabId;

    for (const tab of tabsToRecreate) {
      this.layoutManager.ensureEditorTab(tab, false);
    }

    if (nextActiveTabId) {
      this.layoutManager.focusEditorTab(nextActiveTabId);
    }
  }

  async restoreProjectSession(projectId: string): Promise<boolean> {
    const raw = localStorage.getItem(`pix3.projectTabs:${projectId}`);
    if (!raw) return false;

    try {
      const session = JSON.parse(raw);
      if (!session || !Array.isArray(session.tabs)) return false;

      console.log('[EditorTabService] Restoring session:', {
        savedTabCount: session.tabs.length,
        savedActiveTabId: session.activeTabId,
        tabs: session.tabs.map(
          (t: { type: string; resourceId: string }) => `${t.type}:${t.resourceId}`
        ),
      });

      // Skip template tabs (templ://) — they should not be restored.
      const tabsToRestore = (
        session.tabs as Array<{
          type: string;
          resourceId: string;
          title?: string;
          contextState?: EditorTab['contextState'];
        }>
      ).filter((t: { resourceId: string; type: string }) => {
        if (t.resourceId.startsWith('templ://')) return false;
        if (t.type === 'game') return false;
        return true;
      });

      console.log('[EditorTabService] Tabs to restore (after filter):', {
        count: tabsToRestore.length,
        tabs: tabsToRestore.map(t => `${t.type}:${t.resourceId}`),
      });

      this.isRestoringProjectSession = true;
      try {
        for (const tabData of tabsToRestore) {
          console.log(
            '[EditorTabService] Opening tab without activation:',
            `${tabData.type}:${tabData.resourceId}`
          );
          await this.openResourceTab(
            tabData.type as EditorTabType,
            tabData.resourceId,
            tabData.contextState,
            false,
            tabData.title
          );
        }

        console.log(
          '[EditorTabService] All tabs opened, now focusing active tab:',
          session.activeTabId
        );
        let tabFocused = false;
        if (session.activeTabId) {
          console.log('[EditorTabService] Restoring saved active tab:', session.activeTabId);
          await this.focusTab(session.activeTabId);
          tabFocused = appState.tabs.tabs.some(t => t.id === session.activeTabId);
        }

        if (!tabFocused && tabsToRestore.length > 0) {
          const firstTabId = this.deriveTabId(
            tabsToRestore[0].type as EditorTabType,
            tabsToRestore[0].resourceId
          );
          console.log('[EditorTabService] No saved active tab, focusing first tab:', firstTabId);
          await this.focusTab(firstTabId);
        }
      } finally {
        this.isRestoringProjectSession = false;
      }

      return tabsToRestore.length > 0;
    } catch (e) {
      console.error('[EditorTabService] Failed to restore project session', e);
      return false;
    }
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = appState.tabs.tabs.find(t => t.id === tabId);
    if (!tab) {
      return;
    }

    console.log('[EditorTabService] closeTab:', {
      tabId,
      currentActiveTabId: appState.tabs.activeTabId,
      tabType: tab.type,
      allTabs: appState.tabs.tabs.map(t => ({ id: t.id, type: t.type })),
    });

    await this.closeTabInternal(tab, false);
  }

  getDirtyTabs(): EditorTab[] {
    return appState.tabs.tabs.filter(tab => {
      if (!tab.isDirty) {
        return false;
      }

      if (appState.project.backend !== 'cloud') {
        return true;
      }

      return tab.type === 'code';
    });
  }

  async saveDirtyTabs(): Promise<void> {
    const dirtyTabs = this.getDirtyTabs();
    for (const tab of dirtyTabs) {
      await this.saveTabResource(tab);
    }
  }

  async closeAllTabs(skipDirtyPrompt = false): Promise<void> {
    const tabs = [...appState.tabs.tabs];
    for (const tab of tabs) {
      await this.closeTabInternal(tab, skipDirtyPrompt);
    }
  }

  async focusTab(tabId: string): Promise<void> {
    const tab = appState.tabs.tabs.find(t => t.id === tabId);
    if (!tab) return;

    this.layoutManager.focusEditorTab(tabId);
    await this.activateTab(tabId);
  }

  async handleGoldenLayoutTabFocused(tabId: string): Promise<void> {
    if (this.isRestoringProjectSession) {
      console.log('[EditorTabService] Ignoring layout focus during session restore:', tabId);
      return;
    }
    await this.activateTab(tabId);
  }

  private async activateTab(tabId: string): Promise<void> {
    const next = appState.tabs.tabs.find(t => t.id === tabId);
    if (!next) return;

    const previousId = appState.tabs.activeTabId;
    console.log('[EditorTabService] activateTab:', {
      activeTabId: tabId,
      previousId,
      tabType: next.type,
    });

    // Capture state from previous active tab before switching.
    if (previousId && previousId !== tabId) {
      this.captureActiveContextState();
    }

    appState.tabs.activeTabId = tabId;

    await this.activateResourceTab(next);
  }

  async saveActiveTab(): Promise<void> {
    const activeTabId = appState.tabs.activeTabId;
    if (!activeTabId) {
      return;
    }

    await this.saveTabById(activeTabId);
  }

  async saveTabById(tabId: string): Promise<void> {
    const tab = appState.tabs.tabs.find(candidate => candidate.id === tabId);
    if (!tab) {
      return;
    }

    await this.saveTabResource(tab);
  }

  private async activateResourceTab(tab: EditorTab): Promise<void> {
    switch (tab.type) {
      case 'scene':
        await this.activateSceneTab(tab);
        return;
      case 'animation':
        await this.activateAnimationTab(tab);
        return;
      case 'code':
        await this.activateCodeTab(tab);
        return;
      default:
        return;
    }
  }

  private async activateSceneTab(tab: EditorTab): Promise<void> {
    this.animationEditorService.setActiveAssetPath(null);

    const sceneId = this.deriveSceneIdFromResource(tab.resourceId);

    // Load if needed.
    const alreadyLoaded = Boolean(appState.scenes.descriptors[sceneId]);
    if (!alreadyLoaded) {
      let loadPromise = this.sceneLoadInFlight.get(sceneId);
      if (!loadPromise) {
        const command = new LoadSceneCommand({ filePath: tab.resourceId, sceneId });
        loadPromise = this.commandDispatcher
          .execute(command)
          .then(() => undefined)
          .finally(() => {
            this.sceneLoadInFlight.delete(sceneId);
          });
        this.sceneLoadInFlight.set(sceneId, loadPromise);
      }

      await loadPromise;
    } else {
      appState.scenes.activeSceneId = sceneId;
      const refreshCommand = new RefreshPrefabInstancesCommand({ sceneId });
      try {
        await this.commandDispatcher.execute(refreshCommand);
      } catch (error) {
        console.error('[EditorTabService] Failed to refresh prefab instances on tab activation', {
          sceneId,
          error,
        });
      }
    }

    // Restore selection (per-tab) into global selection state.
    const selection = tab.contextState?.selection;
    if (selection) {
      appState.selection.nodeIds = [...selection.nodeIds];
      appState.selection.primaryNodeId = selection.primaryNodeId;
    }

    // Restore camera state into renderer.
    const camera = tab.contextState?.camera;
    if (camera) {
      this.viewportRenderer.applyCameraState(camera);
    } else {
      const sceneCamera = appState.scenes.cameraStates[sceneId];
      if (sceneCamera) {
        this.viewportRenderer.applyCameraState(sceneCamera);
      }
    }

    // Sync title now that descriptor is available.
    this.syncResourceTabsFromDescriptors();
  }

  private async activateAnimationTab(tab: EditorTab): Promise<void> {
    this.animationEditorService.setActiveAssetPath(tab.resourceId);

    const animationId = this.deriveAnimationIdFromResource(tab.resourceId);
    const alreadyLoaded = Boolean(appState.animations.descriptors[animationId]);

    if (!alreadyLoaded) {
      let loadPromise = this.animationLoadInFlight.get(animationId);
      if (!loadPromise) {
        const command = new LoadAnimationCommand({
          filePath: tab.resourceId,
          animationId,
        });
        loadPromise = this.commandDispatcher
          .execute(command)
          .then(() => undefined)
          .finally(() => {
            this.animationLoadInFlight.delete(animationId);
          });
        this.animationLoadInFlight.set(animationId, loadPromise);
      }

      await loadPromise;
    } else {
      appState.animations.activeAnimationId = animationId;
    }

    this.syncResourceTabsFromDescriptors();
  }

  private async activateCodeTab(tab: EditorTab): Promise<void> {
    this.animationEditorService.setActiveAssetPath(null);
    await this.codeDocumentService.ensureLoaded(tab.resourceId);
    this.syncResourceTabsFromDescriptors();
  }

  private captureActiveContextState(): void {
    const activeTabId = appState.tabs.activeTabId;
    if (!activeTabId) return;
    const tab = appState.tabs.tabs.find(t => t.id === activeTabId);
    if (!tab) return;

    if (tab.type === 'scene') {
      const sceneId = this.deriveSceneIdFromResource(tab.resourceId);

      // Save camera state.
      const camera = this.viewportRenderer.captureCameraState();
      if (camera) {
        tab.contextState = { ...(tab.contextState ?? {}), camera };
        appState.scenes.cameraStates[sceneId] = camera;
      }

      // Save selection state.
      tab.contextState = {
        ...(tab.contextState ?? {}),
        selection: {
          nodeIds: [...appState.selection.nodeIds],
          primaryNodeId: appState.selection.primaryNodeId,
        },
      };
    }
  }

  private async saveTabResource(tab: EditorTab): Promise<void> {
    if (appState.project.backend === 'cloud' && tab.type !== 'code') {
      return;
    }

    switch (tab.type) {
      case 'scene': {
        const sceneId = this.deriveSceneIdFromResource(tab.resourceId);
        await this.commandDispatcher.execute(new SaveSceneCommand({ sceneId }));
        return;
      }
      case 'animation': {
        const animationId = this.deriveAnimationIdFromResource(tab.resourceId);
        await this.commandDispatcher.execute(new SaveAnimationCommand({ animationId }));
        return;
      }
      case 'code': {
        await this.codeDocumentService.save(tab.resourceId);
        return;
      }
      default:
        return;
    }
  }

  private async promptDirtyClose(tab: EditorTab): Promise<DirtyCloseDecision> {
    const choice = await this.dialogService.showChoice({
      title: 'Unsaved Changes',
      message: `Save changes to ${tab.title}?`,
      confirmLabel: 'Save',
      secondaryLabel: "Don't Save",
      cancelLabel: 'Cancel',
      isDangerous: false,
      secondaryIsDangerous: true,
    });

    if (choice === 'confirm') return 'save';
    if (choice === 'secondary') return 'dont-save';
    return 'cancel';
  }

  private async closeTabInternal(tab: EditorTab, skipDirtyPrompt: boolean): Promise<void> {
    if (tab.isDirty && !skipDirtyPrompt) {
      const decision = await this.promptDirtyClose(tab);
      if (decision === 'cancel') {
        this.layoutManager.focusEditorTab(tab.id);
        return;
      }
      if (decision === 'save') {
        await this.saveTabResource(tab);
      }
    }

    if (tab.type === 'game' && !appState.ui.isGamePopoutOpen) {
      await this.operationService.invoke(
        new SetPlayModeOperation({
          isPlaying: false,
          status: 'stopped',
        })
      );
    }

    if (appState.tabs.activeTabId === tab.id) {
      this.captureActiveContextState();
    }

    this.cleanupClosedTabState(tab);

    appState.tabs.tabs = appState.tabs.tabs.filter(t => t.id !== tab.id);

    if (appState.tabs.activeTabId === tab.id) {
      let next: EditorTab | undefined;
      if (tab.type === 'game' && this.previousActiveTabIdBeforeGame) {
        next = appState.tabs.tabs.find(t => t.id === this.previousActiveTabIdBeforeGame);
        console.log('[EditorTabService] Game tab closed, restoring previous active tab:', {
          closedTabId: tab.id,
          restoringTabId: this.previousActiveTabIdBeforeGame,
          found: !!next,
        });
        this.previousActiveTabIdBeforeGame = null;
      }

      if (!next) {
        next = appState.tabs.tabs[appState.tabs.tabs.length - 1] ?? null;
        console.log('[EditorTabService] Active tab was closed, finding next tab:', {
          closedTabId: tab.id,
          nextTab: next ? { id: next.id, type: next.type } : null,
          remainingTabs: appState.tabs.tabs.map(t => ({ id: t.id, type: t.type })),
        });
      }

      appState.tabs.activeTabId = null;
      if (next) {
        await this.activateTab(next.id);
      }
    }

    this.layoutManager.removeEditorTab(tab.id);
  }

  private syncResourceTabsFromDescriptors(): void {
    // Keep tab.isDirty/title aligned with loaded resource descriptor state.
    let didChange = false;
    const nextTabs = appState.tabs.tabs.map(tab => {
      const descriptor = this.getResourceDescriptor(tab);
      if (!descriptor) {
        return tab;
      }

      const fileTitle = this.deriveTitle(descriptor.filePath);
      const treatAsClean = appState.project.backend === 'cloud' && tab.type !== 'code';
      const title = treatAsClean ? fileTitle : descriptor.isDirty ? `*${fileTitle}` : fileTitle;
      const isDirty = treatAsClean ? false : descriptor.isDirty;

      if (tab.title !== title || tab.isDirty !== isDirty) {
        didChange = true;
        const updated: EditorTab = { ...tab, title, isDirty };
        this.layoutManager.updateEditorTabTitle(updated.id, updated.title);
        return updated;
      }

      // Make sure GL title stays in sync even if state didn't change (e.g. restored tabs).
      this.layoutManager.updateEditorTabTitle(tab.id, tab.title);
      return tab;
    });

    if (didChange) {
      appState.tabs.tabs = nextTabs;
    }
  }

  private deriveTabId(type: EditorTabType, resourceId: string): string {
    return `${type}:${resourceId}`;
  }

  private deriveTitle(resourceId: string): string {
    if (resourceId === 'game-view-instance') {
      return 'Game';
    }
    const normalized = resourceId.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    return segments.length ? segments[segments.length - 1] : resourceId;
  }

  private deriveSceneIdFromResource(resourcePath: string): string {
    const withoutScheme = resourcePath
      .replace(/^res:\/\//i, '')
      .replace(/^templ:\/\//i, '')
      .replace(/^collab:\/\//i, '');
    const withoutExtension = withoutScheme.replace(/\.[^./]+$/i, '');
    const normalized = withoutExtension
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    return normalized || 'scene';
  }

  private deriveAnimationIdFromResource(resourcePath: string): string {
    return deriveAnimationDocumentId(resourcePath);
  }

  private getResourceDescriptor(tab: EditorTab): { filePath: string; isDirty: boolean } | null {
    switch (tab.type) {
      case 'scene': {
        const sceneId = this.deriveSceneIdFromResource(tab.resourceId);
        return appState.scenes.descriptors[sceneId] ?? null;
      }
      case 'animation': {
        const animationId = this.deriveAnimationIdFromResource(tab.resourceId);
        return appState.animations.descriptors[animationId] ?? null;
      }
      case 'code': {
        const document = this.codeDocumentService.getDocument(tab.resourceId);
        if (!document) {
          return null;
        }
        return {
          filePath: document.resourcePath,
          isDirty: document.isDirty,
        };
      }
      default:
        return null;
    }
  }

  private cleanupClosedTabState(tab: EditorTab): void {
    if (tab.type === 'scene') {
      const sceneId = this.deriveSceneIdFromResource(tab.resourceId);
      delete appState.scenes.descriptors[sceneId];
      delete appState.scenes.hierarchies[sceneId];
      if (appState.scenes.cameraStates[sceneId]) {
        delete appState.scenes.cameraStates[sceneId];
      }

      if (appState.scenes.activeSceneId === sceneId) {
        appState.scenes.activeSceneId = null;
        appState.selection.nodeIds = [];
        appState.selection.primaryNodeId = null;
        appState.selection.hoveredNodeId = null;
      }

      this.sceneManager.removeSceneGraph(sceneId);
      return;
    }

    if (tab.type === 'animation') {
      if (this.animationEditorService.getActiveAssetPath() === tab.resourceId) {
        this.animationEditorService.setActiveAssetPath(null);
      }

      const animationId = this.deriveAnimationIdFromResource(tab.resourceId);
      delete appState.animations.descriptors[animationId];
      delete appState.animations.resources[animationId];

      if (appState.animations.activeAnimationId === animationId) {
        appState.animations.activeAnimationId = null;
      }
      return;
    }

    if (tab.type === 'code') {
      this.codeDocumentService.close(tab.resourceId);
    }
  }

  private findSceneTabIdBySceneId(sceneId: string | null): string | null {
    if (!sceneId) return null;
    const tab = appState.tabs.tabs.find(
      t => t.type === 'scene' && this.deriveSceneIdFromResource(t.resourceId) === sceneId
    );
    return tab?.id ?? null;
  }
}
