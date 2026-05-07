import {
  GoldenLayout,
  type LayoutConfig,
  type ContentItem,
  type Stack,
  type ComponentItem,
  type ComponentItemConfig,
} from 'golden-layout';
import { injectable } from '@/fw/di';
import { appState, type AppState, type EditorTab, type PanelVisibilityState } from '@/state';

const PANEL_COMPONENT_TYPES = {
  sceneTree: 'scene-tree',
  viewport: 'viewport',
  inspector: 'inspector',
  profiler: 'profiler',
  assetBrowser: 'asset-browser',
  assetsPreview: 'assets-preview',
  animation: 'animation',
  logs: 'logs',
  background: 'background',
  game: 'game',
  code: 'code',
} as const;

export type PanelComponentType = (typeof PANEL_COMPONENT_TYPES)[keyof typeof PANEL_COMPONENT_TYPES];

const PANEL_TAG_NAMES = {
  [PANEL_COMPONENT_TYPES.sceneTree]: 'pix3-scene-tree-panel',
  [PANEL_COMPONENT_TYPES.viewport]: 'pix3-editor-tab',
  [PANEL_COMPONENT_TYPES.inspector]: 'pix3-inspector-panel',
  [PANEL_COMPONENT_TYPES.profiler]: 'pix3-profiler-panel',
  [PANEL_COMPONENT_TYPES.assetBrowser]: 'pix3-asset-browser-panel',
  [PANEL_COMPONENT_TYPES.assetsPreview]: 'pix3-assets-preview-panel',
  [PANEL_COMPONENT_TYPES.animation]: 'pix3-animation-panel',
  [PANEL_COMPONENT_TYPES.logs]: 'pix3-logs-panel',
  [PANEL_COMPONENT_TYPES.background]: 'pix3-background',
  [PANEL_COMPONENT_TYPES.game]: 'pix3-game-tab',
  [PANEL_COMPONENT_TYPES.code]: 'pix3-code-tab',
} as const;

const PANEL_DISPLAY_TITLES: Record<PanelComponentType, string> = {
  [PANEL_COMPONENT_TYPES.sceneTree]: 'Scene Tree',
  [PANEL_COMPONENT_TYPES.viewport]: 'Viewport',
  [PANEL_COMPONENT_TYPES.inspector]: 'Inspector',
  [PANEL_COMPONENT_TYPES.profiler]: 'Profiler',
  [PANEL_COMPONENT_TYPES.assetBrowser]: 'Asset Browser',
  [PANEL_COMPONENT_TYPES.assetsPreview]: 'Assets Preview',
  [PANEL_COMPONENT_TYPES.animation]: 'Animation',
  [PANEL_COMPONENT_TYPES.logs]: 'Logs',
  [PANEL_COMPONENT_TYPES.background]: 'Pix3',
  [PANEL_COMPONENT_TYPES.game]: 'Game',
  [PANEL_COMPONENT_TYPES.code]: 'Code',
};

const DEFAULT_PANEL_VISIBILITY: PanelVisibilityState = {
  sceneTree: true,
  viewport: true,
  inspector: true,
  profiler: true,
  assetBrowser: true,
  assetsPreview: true,
  animation: false,
  logs: true,
};

const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  settings: {
    hasHeaders: true,
    reorderEnabled: true,
  },
  header: {
    show: 'top',
  },
  dimensions: {
    minItemHeight: 120,
    minItemWidth: 200,
  },
  root: {
    type: 'row',
    content: [
      {
        type: 'column',
        width: 20,
        content: [
          {
            type: 'component',
            componentType: PANEL_COMPONENT_TYPES.sceneTree,
            title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.sceneTree],
            isClosable: false,
          },
          {
            type: 'component',
            componentType: PANEL_COMPONENT_TYPES.assetBrowser,
            title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.assetBrowser],
            height: 50,
            isClosable: false,
          },
        ],
      },
      {
        type: 'column',
        width: 50,
        content: [
          {
            type: 'stack',
            id: 'editor-stack',
            content: [
              {
                type: 'component',
                componentType: PANEL_COMPONENT_TYPES.background,
                title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.background],
                isClosable: false,
                reorderEnabled: false,
              } as ComponentItemConfig,
            ],
          },
          {
            type: 'stack',
            height: 25,
            content: [
              {
                type: 'component',
                componentType: PANEL_COMPONENT_TYPES.assetsPreview,
                title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.assetsPreview],
                isClosable: false,
              },
              {
                type: 'component',
                componentType: PANEL_COMPONENT_TYPES.logs,
                title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.logs],
                isClosable: true,
              },
            ],
          },
        ],
      },

      {
        type: 'stack',
        width: 30,
        content: [
          {
            type: 'component',
            componentType: PANEL_COMPONENT_TYPES.inspector,
            title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.inspector],
            isClosable: false,
          },
          {
            type: 'component',
            componentType: PANEL_COMPONENT_TYPES.profiler,
            title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.profiler],
            isClosable: false,
          },
        ],
      },
    ],
  },
} satisfies LayoutConfig;

@injectable()
export class LayoutManagerService {
  private layout: GoldenLayout | null = null;
  private readonly state: AppState;
  private container: HTMLElement | null = null;
  private editorStack: Stack | null = null;
  private editorTabContainers = new Map<string, ContentItem>();
  private editorTabItems = new Map<string, ContentItem>();
  private editorTabFocusedListeners = new Set<(tabId: string) => void>();
  private editorTabCloseRequestedListeners = new Set<(tabId: string) => void>();
  private handleTabCloseClick?: (e: MouseEvent) => void;

  constructor(state: AppState = appState) {
    this.state = state;
  }

  async initialize(container: HTMLElement): Promise<void> {
    if (this.layout && this.container === container) {
      return;
    }

    if (this.layout) {
      this.dispose();
    }

    this.container = container;
    this.layout = new GoldenLayout(container);
    this.layout.resizeWithContainerAutomatically = true;

    // Intercept GL tab close button clicks before they reach GL's internal handler.
    // GL's .lm_close_tab element uses mousedown to trigger close, bypassing click events.
    this.handleTabCloseClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('lm_close_tab')) return;

      // Walk up to find the .lm_tab and then the tab title to match our tabId.
      const tabEl = target.closest('.lm_tab') as HTMLElement | null;
      if (!tabEl) return;

      // Find the ComponentItem that owns this tab by matching against our tracked items.
      const tabTitle = tabEl.querySelector('.lm_title')?.textContent ?? '';
      let matchedTabId: string | null = null;

      for (const [tabId] of this.editorTabContainers) {
        // Match by checking the item's title against the tab title.
        const item = this.editorTabItems.get(tabId);
        if (item && (item as ComponentItem).title === tabTitle) {
          matchedTabId = tabId;
          break;
        }
      }

      // Fallback: search by component state tabId in the GL tree.
      if (!matchedTabId && this.layout) {
        const root = (this.layout as unknown as { rootItem?: ContentItem }).rootItem;
        if (root) {
          matchedTabId = this.findTabIdByTitle(root, tabTitle);
        }
      }

      if (!matchedTabId) return; // Not one of our editor tabs, let GL handle it.

      // Prevent GL's default close behavior.
      e.stopPropagation();
      e.preventDefault();

      // Route through our close flow (which shows dirty confirmation).
      for (const listener of this.editorTabCloseRequestedListeners) {
        try {
          listener(matchedTabId);
        } catch {
          // ignore
        }
      }
    };
    container.addEventListener('mousedown', this.handleTabCloseClick, true);

    this.registerComponents(this.layout);
    await this.loadDefaultLayout();
  }

  async resetLayout(): Promise<void> {
    if (!this.layout) {
      return;
    }

    // Clear cached stack reference so it's re-discovered after layout reset.
    this.editorStack = null;
    this.editorTabContainers.clear();
    this.editorTabItems.clear();

    await this.loadDefaultLayout();
  }

  /**
   * Backwards compatible method for the (single-tab) viewport.
   * With multi-tab, prefer updateEditorTabTitle(tabId, title).
   */
  setViewportTitle(title: string): void {
    // If there is an active editor tab, update that title.
    const activeTabId = appState.tabs.activeTabId;
    if (activeTabId) {
      this.updateEditorTabTitle(activeTabId, title);
    }
  }

  subscribeEditorTabFocused(listener: (tabId: string) => void): () => void {
    this.editorTabFocusedListeners.add(listener);
    return () => this.editorTabFocusedListeners.delete(listener);
  }

  subscribeEditorTabCloseRequested(listener: (tabId: string) => void): () => void {
    this.editorTabCloseRequestedListeners.add(listener);
    return () => this.editorTabCloseRequestedListeners.delete(listener);
  }

  ensureEditorTab(tab: EditorTab, shouldAutoFocus = true): void {
    if (!this.layout) return;
    this.ensureEditorStack();
    if (!this.editorStack) return;

    // Reconcile our bookkeeping with Golden Layout: the app can keep a tab in state even if the
    // corresponding GL item was closed/destroyed (or not tracked due to async timing).
    try {
      const root = (this.layout as unknown as { rootItem?: ContentItem }).rootItem;
      const itemInLayout = this.findEditorTabByTabId(root, tab.id);
      if (itemInLayout) {
        this.editorTabItems.set(tab.id, itemInLayout as ContentItem);
        this.updateEditorTabTitle(tab.id, tab.title);
        return;
      }

      // If we thought we had it, but it doesn't exist in the layout tree anymore, drop stale refs.
      if (this.editorTabItems.has(tab.id)) {
        this.editorTabItems.delete(tab.id);
      }
      if (this.editorTabContainers.has(tab.id)) {
        this.editorTabContainers.delete(tab.id);
      }
    } catch {
      // ignore, fall through to normal add path
    }

    // Create a new component item inside the editor stack.
    try {
      console.log('[LayoutManager] Adding tab to editor stack:', {
        tabId: tab.id,
        title: tab.title,
        shouldAutoFocus,
      });

      const itemConfig: ComponentItemConfig & { popoutEnabled?: boolean } = {
        type: 'component',
        componentType:
          tab.type === 'game'
            ? PANEL_COMPONENT_TYPES.game
            : tab.type === 'animation'
              ? PANEL_COMPONENT_TYPES.animation
              : tab.type === 'code'
                ? PANEL_COMPONENT_TYPES.code
                : PANEL_COMPONENT_TYPES.viewport,
        title: tab.title,
        isClosable: true,
        // PREVENT DRAGGING to enforce Single Document Interface
        reorderEnabled: false,
        // PREVENT POPPING OUT
        popoutEnabled: false,
        componentState: {
          tabId: tab.id,
        },
      };

      const index = this.editorStack.addItem(itemConfig, undefined);

      console.log('[LayoutManager] addItem returned index:', index);

      // Log all content items in the stack after adding
      console.log('[LayoutManager] Stack content items after add:');
      if (this.editorStack && this.editorStack.contentItems) {
        for (let i = 0; i < this.editorStack.contentItems.length; i++) {
          const item = this.editorStack.contentItems[i];
          const itemInfo = item as ContentItem & {
            type?: string;
            componentType?: string;
            container?: { state?: { tabId?: string } };
          };
          console.log(
            '[LayoutManager]   Item',
            i,
            '- type:',
            itemInfo.type,
            'component:',
            itemInfo.componentType,
            'tabId:',
            itemInfo.container?.state?.tabId
          );
        }
      }

      // Best-effort: capture the newly created item.
      const created = this.editorStack.contentItems?.[index];
      if (created) {
        console.log('[LayoutManager] Captured newly created item');
        this.editorTabItems.set(tab.id, created);
      } else {
        console.log('[LayoutManager] Could not capture newly created item at index', index);
      }

      // Use a small timeout to ensure the component factory has run
      // Golden Layout renders asynchronously and the component instance needs time to be created
      if (shouldAutoFocus) {
        setTimeout(() => {
          console.log('[LayoutManager] Attempting async focus for tab:', tab.id);
          this.focusEditorTab(tab.id);
        }, 50);
      }
    } catch (error) {
      console.error('[LayoutManager] Failed to add editor tab', error);
    }
  }

  removeEditorTab(tabId: string): void {
    const item = this.editorTabItems.get(tabId);
    if (!item) {
      this.editorTabContainers.delete(tabId);
      return;
    }
    try {
      const closableItem = item as ContentItem & { close?: () => void };
      closableItem.close?.();
    } catch {
      try {
        const destroyableItem = item as ContentItem & { destroy?: () => void };
        destroyableItem.destroy?.();
      } catch {
        // ignore
      }
    }
    this.editorTabItems.delete(tabId);
    this.editorTabContainers.delete(tabId);
  }

  focusEditorTab(tabId: string): void {
    if (!this.layout) return;
    this.ensureEditorStack();

    let item = this.editorTabItems.get(tabId);

    // Fallback: if map is not yet updated, search the tree manually
    if (!item) {
      console.log('[LayoutManager] Item not in map, searching tree...');
      const rootItem = (this.layout as unknown as { rootItem?: ContentItem }).rootItem;
      item = this.findEditorTabByTabId(rootItem, tabId);
      if (item) {
        console.log('[LayoutManager] Found item in tree');
        this.editorTabItems.set(tabId, item);
      }
    }

    // Final fallback: search contentItems directly (helps with recently added tabs)
    if (!item && this.editorStack && this.editorStack.contentItems) {
      console.log('[LayoutManager] Searching editor stack content items...');
      for (const contentItem of this.editorStack.contentItems) {
        const ci = contentItem as ContentItem & {
          container?: { state?: { tabId?: string } };
          type?: string;
          componentType?: string;
        };
        const itemTabId = ci.container?.state?.tabId;
        if (
          ci.type === 'component' &&
          this.isEditorTabComponentType(ci.componentType) &&
          itemTabId === tabId
        ) {
          item = contentItem as ContentItem;
          console.log('[LayoutManager] Found item in editor stack');
          this.editorTabItems.set(tabId, item);
          break;
        }
      }
    }

    if (!item) {
      console.log('[LayoutManager] Item not found, skipping focus');
      return;
    }

    console.log('[LayoutManager] Found item, attempting to focus...');

    try {
      const parent = (item as ContentItem & { parent?: unknown }).parent as
        | {
            setActiveComponentItem?: (it: ComponentItem, focus?: boolean) => void;
          }
        | undefined;
      if (parent && typeof parent.setActiveComponentItem === 'function') {
        console.log('[LayoutManager] Calling setActiveComponentItem on parent');
        if ((item as ContentItem).type === 'component') {
          parent.setActiveComponentItem?.(item as ComponentItem, true);
        }
      } else {
        console.log('[LayoutManager] Parent or method not available, trying direct stack focus');
        // If parent not available, try to find the parent stack from the item
        const parentStack = this.findClosestStack(
          item as unknown as ContentItem & {
            setActiveComponentItem?: (it: ComponentItem, focus?: boolean) => void;
          }
        );
        if (
          parentStack &&
          typeof parentStack.setActiveComponentItem === 'function' &&
          (item as ContentItem).type === 'component'
        ) {
          console.log('[LayoutManager] Found parent stack, calling setActiveComponentItem');
          parentStack.setActiveComponentItem(item as ComponentItem, true);
        }
      }
    } catch (error) {
      console.error('[LayoutManager] Error focusing tab:', error);
    }
  }

  focusPanel(componentType: PanelComponentType): void {
    if (!this.layout) {
      return;
    }

    const rootItem = (this.layout as unknown as { rootItem?: ContentItem }).rootItem;
    const item = this.findPanelByComponentType(rootItem, componentType);
    if (!item || item.type !== 'component') {
      return;
    }

    const parentStack = this.findClosestStack(item);
    if (parentStack && typeof parentStack.setActiveComponentItem === 'function') {
      parentStack.setActiveComponentItem(item as ComponentItem, true);
    }
  }

  private findEditorTabByTabId(
    node: ContentItem | null | undefined,
    tabId: string
  ): ContentItem | undefined {
    if (!node) return undefined;
    const nodeInfo = node as ContentItem & {
      type?: string;
      componentType?: string;
      container?: { state?: { tabId?: string } };
    };
    if (
      nodeInfo.type === 'component' &&
      this.isEditorTabComponentType(nodeInfo.componentType) &&
      nodeInfo.container?.state?.tabId === tabId
    ) {
      return node as ContentItem;
    }
    const children: ContentItem[] = nodeInfo.contentItems ?? [];
    for (const child of children) {
      const found = this.findEditorTabByTabId(child, tabId);
      if (found) return found;
    }
    return undefined;
  }

  private isEditorTabComponentType(
    componentType: string | undefined
  ): componentType is PanelComponentType {
    return (
      componentType === PANEL_COMPONENT_TYPES.viewport ||
      componentType === PANEL_COMPONENT_TYPES.animation ||
      componentType === PANEL_COMPONENT_TYPES.game ||
      componentType === PANEL_COMPONENT_TYPES.code
    );
  }

  private findPanelByComponentType(
    node: ContentItem | null | undefined,
    componentType: PanelComponentType
  ): ContentItem | undefined {
    if (!node) {
      return undefined;
    }

    const nodeInfo = node as ContentItem & {
      type?: string;
      componentType?: string;
      contentItems?: ContentItem[];
    };
    if (nodeInfo.type === 'component' && nodeInfo.componentType === componentType) {
      return node as ContentItem;
    }

    for (const child of nodeInfo.contentItems ?? []) {
      const found = this.findPanelByComponentType(child, componentType);
      if (found) {
        return found;
      }
    }

    return undefined;
  }

  updateEditorTabTitle(tabId: string, title: string): void {
    const container = this.editorTabContainers.get(tabId);
    if (container) {
      try {
        const c = container as ContentItem & { setTitle?: (title: string) => void };
        c.setTitle?.(title);
      } catch {
        // ignore
      }
      return;
    }

    const item = this.editorTabItems.get(tabId);
    if (item) {
      try {
        const it = item as ContentItem & { setTitle?: (title: string) => void };
        it.setTitle?.(title);
      } catch {
        // ignore
      }
    }
  }

  private async loadDefaultLayout(): Promise<void> {
    if (!this.layout) {
      throw new Error('LayoutManager has not been initialized');
    }

    this.layout.loadLayout(DEFAULT_LAYOUT_CONFIG);

    this.ensureEditorStack();

    // Track active editor tab focus changes.
    try {
      // GoldenLayout's typings are not ideal here; use a narrow handler type
      const layoutApi = this.layout as unknown as {
        on: (name: string, handler: (...args: unknown[]) => void) => void;
      };
      layoutApi.on('activeContentItemChanged', (...args: unknown[]) => {
        try {
          const item = args[0] as ContentItem | undefined;
          const itemInfo = item as
            | (ContentItem & {
                componentType?: string;
                container?: { state?: { tabId?: string } };
              })
            | undefined;

          const componentType = itemInfo?.componentType;
          if (!componentType || componentType === PANEL_COMPONENT_TYPES.background) return;

          this.state.ui.focusedPanelId = componentType;

          if (!this.isEditorTabComponentType(componentType)) {
            return;
          }

          // IMPORTANT: Invalidate the cached editorStack because the active content changed
          // This ensures we get fresh contentItems array when reopening tabs after close
          this.editorStack = null;
          this.ensureEditorStack();

          // Track the current "main editor" stack so new tabs open in the same area.
          const parentStack = itemInfo ? this.findClosestStack(itemInfo) : undefined;
          if (parentStack) {
            this.editorStack = parentStack;
          }
          const tabId = itemInfo?.container?.state?.tabId;
          if (typeof tabId !== 'string' || !tabId) return;
          for (const listener of this.editorTabFocusedListeners) {
            listener(tabId);
          }
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }

    // Inline logic from InitializeLayoutCommand
    const previousLayoutReady = this.state.ui.isLayoutReady;
    const previousPanelVisibility = { ...this.state.ui.panelVisibility };
    const previousFocusedPanelId = this.state.ui.focusedPanelId;

    const nextPanelVisibility = { ...DEFAULT_PANEL_VISIBILITY };
    const nextFocusedPanelId = 'viewport';

    const didMutate =
      previousLayoutReady === false ||
      !(
        previousPanelVisibility.sceneTree === nextPanelVisibility.sceneTree &&
        previousPanelVisibility.viewport === nextPanelVisibility.viewport &&
        previousPanelVisibility.inspector === nextPanelVisibility.inspector &&
        previousPanelVisibility.profiler === nextPanelVisibility.profiler &&
        previousPanelVisibility.assetBrowser === nextPanelVisibility.assetBrowser &&
        previousPanelVisibility.assetsPreview === nextPanelVisibility.assetsPreview &&
        previousPanelVisibility.animation === nextPanelVisibility.animation &&
        previousPanelVisibility.logs === nextPanelVisibility.logs
      ) ||
      previousFocusedPanelId !== nextFocusedPanelId;

    if (!didMutate) {
      return;
    }

    this.state.ui.isLayoutReady = true;
    this.state.ui.panelVisibility = nextPanelVisibility;
    this.state.ui.focusedPanelId = nextFocusedPanelId;
  }

  dispose(): void {
    if (this.container && this.handleTabCloseClick) {
      this.container.removeEventListener('mousedown', this.handleTabCloseClick, true);
      this.handleTabCloseClick = undefined;
    }
    if (this.layout) {
      try {
        this.layout.destroy();
      } catch (error) {
        console.error('[LayoutManager] Failed to dispose layout', error);
      }
    }
    this.layout = null;
    this.container = null;
  }

  private registerComponents(layout: GoldenLayout): void {
    Object.entries(PANEL_TAG_NAMES).forEach(([componentType, tagName]) => {
      layout.registerComponentFactoryFunction(componentType, container => {
        if (componentType === PANEL_COMPONENT_TYPES.code) {
          void import('@/ui/code-editor/code-tab');
        }

        const tabId = (container.state as { tabId?: string } | undefined)?.tabId;
        if (this.isEditorTabComponentType(componentType)) {
          const tabTitle =
            typeof tabId === 'string' && tabId
              ? appState.tabs.tabs.find(tab => tab.id === tabId)?.title
              : undefined;
          container.setTitle(tabTitle ?? container.title ?? PANEL_DISPLAY_TITLES.viewport);

          if (typeof tabId === 'string' && tabId) {
            this.editorTabContainers.set(tabId, container as unknown as ContentItem);

            try {
              const parent = (container as unknown as { _parent?: ContentItem })._parent;
              if (parent) {
                this.editorTabItems.set(tabId, parent);
              }
            } catch {
              // ignore
            }
          }
        } else {
          container.setTitle(PANEL_DISPLAY_TITLES[componentType as PanelComponentType]);
        }

        const element = document.createElement(tagName);
        element.setAttribute('data-panel-id', componentType);

        // Forward tab id into the element for the editor-tab component.
        if (this.isEditorTabComponentType(componentType)) {
          const tabId = (container.state as { tabId?: string } | undefined)?.tabId;
          if (typeof tabId === 'string' && tabId) {
            element.setAttribute('tab-id', tabId);
          }
        }

        container.element.append(element);
        container.on('destroy', () => {
          try {
            if (this.isEditorTabComponentType(componentType)) {
              const tabId = (container.state as { tabId?: string } | undefined)?.tabId;
              if (typeof tabId === 'string' && tabId) {
                this.editorTabContainers.delete(tabId);
                this.editorTabItems.delete(tabId);
              }
            }
          } catch {
            // ignore
          }
          element.remove();
        });
      });
    });
  }

  private ensureEditorStack(): void {
    if (!this.layout) return;

    try {
      const root = (this.layout as unknown as { rootItem?: ContentItem }).rootItem;
      // Find the stack by its known id 'editor-stack'.
      const editorStackById = this.findStackById(root, 'editor-stack');
      if (editorStackById) {
        this.editorStack = editorStackById;
        return;
      }
      // Fallback: find stack that owns a viewport or background component (main editor area).
      const mainStack = this.findMainEditorStack(root);
      this.editorStack = mainStack ?? this.findFirstStack(root);
    } catch (error) {
      console.error('[LayoutManager] Error in ensureEditorStack:', error);
      this.editorStack = null;
    }
  }

  private findStackById(node: ContentItem | null | undefined, id: string): Stack | null {
    if (!node) return null;
    if (node.type === 'stack' && node.id === id) return node as Stack;
    const children: ContentItem[] = (node as { contentItems?: ContentItem[] }).contentItems ?? [];
    for (const child of children) {
      const found = this.findStackById(child, id);
      if (found) return found;
    }
    return null;
  }

  private findClosestStack(node: ContentItem | null | undefined): Stack | null {
    if (!node) return null;
    let current: ContentItem | null = node;
    while (current) {
      if (current.type === 'stack') return current as Stack;
      current = current.parent ?? (current as { _parent?: ContentItem })._parent ?? null;
    }
    return null;
  }

  private findMainEditorStack(node: ContentItem | null | undefined): Stack | null {
    if (!node) return null;
    const componentNode = node as ComponentItem & { componentType?: string };

    if (
      node.type === 'component' &&
      (this.isEditorTabComponentType(componentNode.componentType) ||
        componentNode.componentType === PANEL_COMPONENT_TYPES.background)
    ) {
      return this.findClosestStack(
        node.parent ?? (node as { _parent?: ContentItem })._parent ?? null
      );
    }

    const children: ContentItem[] = (node as { contentItems?: ContentItem[] }).contentItems ?? [];
    for (const child of children) {
      const found = this.findMainEditorStack(child);
      if (found) return found;
    }

    return null;
  }

  private findFirstStack(node: ContentItem | null | undefined): Stack | null {
    if (!node) return null;
    if (node.type === 'stack') return node as Stack;
    const children: ContentItem[] = (node as { contentItems?: ContentItem[] }).contentItems ?? [];
    for (const child of children) {
      const found = this.findFirstStack(child);
      if (found) return found;
    }
    return null;
  }

  /**
   * Walk the GL tree to find a viewport component whose title matches and return its tabId.
   */
  private findTabIdByTitle(node: ContentItem | null | undefined, title: string): string | null {
    if (!node) return null;
    const nodeInfo = node as ContentItem & {
      type?: string;
      componentType?: string;
      container?: { state?: { tabId?: string } };
    };
    if (
      nodeInfo.type === 'component' &&
      this.isEditorTabComponentType(nodeInfo.componentType) &&
      (node as ComponentItem).title === title
    ) {
      return nodeInfo.container?.state?.tabId ?? null;
    }
    const children: ContentItem[] =
      (nodeInfo as { contentItems?: ContentItem[] }).contentItems ?? [];
    for (const child of children) {
      const found = this.findTabIdByTitle(child, title);
      if (found) return found;
    }
    return null;
  }
}
