import {
  GoldenLayout,
  type LayoutConfig,
  type ContentItem,
  type Stack,
  type ComponentItem,
  type ComponentItemConfig,
} from 'golden-layout';
import { injectable, inject } from '@/fw/di';
import { subscribe } from 'valtio/vanilla';
import { appState, type AppState, type EditorTab, type PanelVisibilityState } from '@/state';
import { IconService, IconSize } from '@/services/editor/IconService';

const PANEL_COMPONENT_TYPES = {
  sceneTree: 'scene-tree',
  viewport: 'viewport',
  inspector: 'inspector',
  profiler: 'profiler',
  assets: 'assets',
  animation: 'animation',
  animationTimeline: 'animation-timeline',
  logs: 'logs',
  background: 'background',
  game: 'game',
  code: 'code',
  runtime: 'runtime',
  spriteEditor: 'sprite-editor',
  agentChat: 'agent-chat',
  library: 'library',
  localization: 'localization',
} as const;

export type PanelComponentType = (typeof PANEL_COMPONENT_TYPES)[keyof typeof PANEL_COMPONENT_TYPES];

const PANEL_TAG_NAMES = {
  [PANEL_COMPONENT_TYPES.sceneTree]: 'pix3-scene-tree-panel',
  [PANEL_COMPONENT_TYPES.viewport]: 'pix3-editor-tab',
  [PANEL_COMPONENT_TYPES.inspector]: 'pix3-inspector-panel',
  [PANEL_COMPONENT_TYPES.profiler]: 'pix3-profiler-panel',
  [PANEL_COMPONENT_TYPES.assets]: 'pix3-assets-panel',
  [PANEL_COMPONENT_TYPES.animation]: 'pix3-animation-panel',
  [PANEL_COMPONENT_TYPES.animationTimeline]: 'pix3-animation-timeline-panel',
  [PANEL_COMPONENT_TYPES.logs]: 'pix3-logs-panel',
  [PANEL_COMPONENT_TYPES.background]: 'pix3-project-home',
  [PANEL_COMPONENT_TYPES.game]: 'pix3-game-tab',
  [PANEL_COMPONENT_TYPES.code]: 'pix3-code-tab',
  [PANEL_COMPONENT_TYPES.runtime]: 'pix3-runtime-panel',
  [PANEL_COMPONENT_TYPES.spriteEditor]: 'pix3-sprite-editor-panel',
  [PANEL_COMPONENT_TYPES.agentChat]: 'pix3-agent-chat-panel',
  [PANEL_COMPONENT_TYPES.library]: 'pix3-library-panel',
  [PANEL_COMPONENT_TYPES.localization]: 'pix3-localization-panel',
} as const;

const PANEL_DISPLAY_TITLES: Record<PanelComponentType, string> = {
  [PANEL_COMPONENT_TYPES.sceneTree]: 'Scene Tree',
  [PANEL_COMPONENT_TYPES.viewport]: 'Viewport',
  [PANEL_COMPONENT_TYPES.inspector]: 'Inspector',
  [PANEL_COMPONENT_TYPES.profiler]: 'Profiler',
  [PANEL_COMPONENT_TYPES.assets]: 'Assets',
  [PANEL_COMPONENT_TYPES.animation]: 'Sprite Animation',
  [PANEL_COMPONENT_TYPES.animationTimeline]: 'Animation',
  [PANEL_COMPONENT_TYPES.logs]: 'Logs',
  [PANEL_COMPONENT_TYPES.background]: 'Home',
  [PANEL_COMPONENT_TYPES.game]: 'Game',
  [PANEL_COMPONENT_TYPES.code]: 'Code',
  [PANEL_COMPONENT_TYPES.runtime]: 'Runtime',
  [PANEL_COMPONENT_TYPES.spriteEditor]: 'Sprite Editor',
  [PANEL_COMPONENT_TYPES.agentChat]: 'Agent',
  [PANEL_COMPONENT_TYPES.library]: 'Library',
  [PANEL_COMPONENT_TYPES.localization]: 'Localization',
};

/**
 * Feather icon name shown at the left of each document tab so the tab type is readable at a glance.
 * Only the component types that live in the editor (document) stack need an entry; anything without
 * one falls back to a generic file icon.
 */
const EDITOR_TAB_ICON_BY_COMPONENT: Partial<Record<PanelComponentType, string>> = {
  [PANEL_COMPONENT_TYPES.background]: 'home',
  [PANEL_COMPONENT_TYPES.viewport]: 'film',
  [PANEL_COMPONENT_TYPES.code]: 'code',
  [PANEL_COMPONENT_TYPES.game]: 'play',
  [PANEL_COMPONENT_TYPES.spriteEditor]: 'image',
  [PANEL_COMPONENT_TYPES.animation]: 'activity',
};

const DEFAULT_PANEL_VISIBILITY: PanelVisibilityState = {
  sceneTree: true,
  viewport: true,
  inspector: true,
  profiler: true,
  assets: true,
  animation: false,
  animationTimeline: true,
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
    headerHeight: 34,
  },
  root: {
    type: 'row',
    content: [
      {
        type: 'column',
        width: 20,
        content: [
          {
            type: 'stack',
            content: [
              {
                type: 'component',
                componentType: PANEL_COMPONENT_TYPES.sceneTree,
                title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.sceneTree],
                isClosable: false,
              },
              {
                type: 'component',
                componentType: PANEL_COMPONENT_TYPES.runtime,
                title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.runtime],
                isClosable: true,
              },
            ],
          },
        ],
      },
      {
        type: 'column',
        width: 55,
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
                componentType: PANEL_COMPONENT_TYPES.assets,
                title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.assets],
                isClosable: false,
              },
              {
                type: 'component',
                componentType: PANEL_COMPONENT_TYPES.animationTimeline,
                title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.animationTimeline],
                isClosable: true,
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
        id: 'agent-stack',
        width: 25,
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
          {
            type: 'component',
            componentType: PANEL_COMPONENT_TYPES.agentChat,
            title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.agentChat],
            isClosable: true,
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
  private disposePlaySubscription?: () => void;
  private lastIsPlaying = false;
  private editorStack: Stack | null = null;
  private editorTabContainers = new Map<string, ContentItem>();
  private editorTabItems = new Map<string, ContentItem>();
  private editorTabFocusedListeners = new Set<(tabId: string) => void>();
  private editorTabCloseRequestedListeners = new Set<(tabId: string) => void>();
  private handleTabCloseClick?: (e: MouseEvent) => void;
  private tabDecorationHandle: ReturnType<typeof setTimeout> | null = null;

  @inject(IconService)
  private readonly iconService!: IconService;

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
                : tab.type === 'sprite-editor'
                  ? PANEL_COMPONENT_TYPES.spriteEditor
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

      // Adding a tab rebuilds the header, so re-apply icons/dirty markers to every tab.
      this.scheduleEditorTabDecorations();
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

    // Removing a tab rebuilds the header for the survivors; re-decorate them.
    this.scheduleEditorTabDecorations();
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

  /**
   * Activate the pinned Project Home tab (the `background` slot, always first in
   * the editor document stack) and ask it to refresh. Used by the
   * `editor.open-project-home` command (Mod+1).
   */
  focusHomeTab(): void {
    this.focusPanel(PANEL_COMPONENT_TYPES.background);
    try {
      window.dispatchEvent(new CustomEvent('pix3-project-home:activate'));
    } catch {
      // ignore in non-DOM environments
    }
  }

  /**
   * Reveal the Agent chat panel. It lives as a docked column to the right of the viewport in the
   * default layout, so normally this just brings it to the front of its stack. If the user closed
   * the panel, re-add it as a new column before the Inspector (falling back to Golden Layout's
   * default placement if the tree can't be navigated).
   */
  revealAgentPanel(): void {
    if (!this.layout) {
      return;
    }

    const rootItem = (this.layout as unknown as { rootItem?: ContentItem }).rootItem;
    const existing = this.findPanelByComponentType(rootItem, PANEL_COMPONENT_TYPES.agentChat);
    if (existing) {
      this.focusPanel(PANEL_COMPONENT_TYPES.agentChat);
      return;
    }

    const componentConfig: ComponentItemConfig = {
      type: 'component',
      componentType: PANEL_COMPONENT_TYPES.agentChat,
      title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.agentChat],
      isClosable: true,
    };

    // Re-add as its own column just before the Inspector (the last top-level child).
    try {
      const root = rootItem as
        | (ContentItem & {
            addItem?: (config: unknown, index?: number) => number;
            contentItems?: ContentItem[];
          })
        | undefined;
      if (root && root.type === 'row' && typeof root.addItem === 'function') {
        const insertIndex = Math.max(0, (root.contentItems?.length ?? 1) - 1);
        root.addItem({ type: 'stack', content: [componentConfig] }, insertIndex);
        this.focusPanel(PANEL_COMPONENT_TYPES.agentChat);
        return;
      }
    } catch (error) {
      console.error('[LayoutManager] Failed to re-add Agent panel as a column', error);
    }

    // Fallback: let Golden Layout choose a placement.
    try {
      const layoutApi = this.layout as unknown as {
        addComponent?: (componentType: string, state?: unknown, title?: string) => void;
      };
      layoutApi.addComponent?.(
        PANEL_COMPONENT_TYPES.agentChat,
        undefined,
        PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.agentChat]
      );
      this.focusPanel(PANEL_COMPONENT_TYPES.agentChat);
    } catch (error) {
      console.error('[LayoutManager] Failed to re-add Agent panel', error);
    }
  }

  /**
   * Reveal the Localization panel. It is not part of the default layout, so the
   * first open docks it as a new column just before the Inspector (falling back
   * to Golden Layout's default placement if the tree can't be navigated); once
   * present, this just brings it to the front of its stack.
   */
  revealLocalizationPanel(): void {
    if (!this.layout) {
      return;
    }

    const rootItem = (this.layout as unknown as { rootItem?: ContentItem }).rootItem;
    const existing = this.findPanelByComponentType(rootItem, PANEL_COMPONENT_TYPES.localization);
    if (existing) {
      this.focusPanel(PANEL_COMPONENT_TYPES.localization);
      return;
    }

    const componentConfig: ComponentItemConfig = {
      type: 'component',
      componentType: PANEL_COMPONENT_TYPES.localization,
      title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.localization],
      isClosable: true,
    };

    try {
      const root = rootItem as
        | (ContentItem & {
            addItem?: (config: unknown, index?: number) => number;
            contentItems?: ContentItem[];
          })
        | undefined;
      if (root && root.type === 'row' && typeof root.addItem === 'function') {
        const insertIndex = Math.max(0, (root.contentItems?.length ?? 1) - 1);
        root.addItem({ type: 'stack', content: [componentConfig] }, insertIndex);
        this.focusPanel(PANEL_COMPONENT_TYPES.localization);
        return;
      }
    } catch (error) {
      console.error('[LayoutManager] Failed to re-add Localization panel as a column', error);
    }

    try {
      const layoutApi = this.layout as unknown as {
        addComponent?: (componentType: string, state?: unknown, title?: string) => void;
      };
      layoutApi.addComponent?.(
        PANEL_COMPONENT_TYPES.localization,
        undefined,
        PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.localization]
      );
      this.focusPanel(PANEL_COMPONENT_TYPES.localization);
    } catch (error) {
      console.error('[LayoutManager] Failed to re-add Localization panel', error);
    }
  }

  /**
   * Reveal the Asset Library panel. It is not part of the default layout, so the first open docks
   * it as a new column just before the Inspector (falling back to Golden Layout's default
   * placement if the tree can't be navigated); once present, this just brings it to the front of
   * its stack. Being a normal docked panel, the user can drag/snap it anywhere — e.g. beside the
   * viewport so the editor and library sit side by side.
   */
  revealLibraryPanel(): void {
    if (!this.layout) {
      return;
    }

    const rootItem = (this.layout as unknown as { rootItem?: ContentItem }).rootItem;
    const existing = this.findPanelByComponentType(rootItem, PANEL_COMPONENT_TYPES.library);
    if (existing) {
      this.focusPanel(PANEL_COMPONENT_TYPES.library);
      return;
    }

    const componentConfig: ComponentItemConfig = {
      type: 'component',
      componentType: PANEL_COMPONENT_TYPES.library,
      title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.library],
      isClosable: true,
    };

    try {
      const root = rootItem as
        | (ContentItem & {
            addItem?: (config: unknown, index?: number) => number;
            contentItems?: ContentItem[];
          })
        | undefined;
      if (root && root.type === 'row' && typeof root.addItem === 'function') {
        const insertIndex = Math.max(0, (root.contentItems?.length ?? 1) - 1);
        root.addItem({ type: 'stack', content: [componentConfig] }, insertIndex);
        this.focusPanel(PANEL_COMPONENT_TYPES.library);
        return;
      }
    } catch (error) {
      console.error('[LayoutManager] Failed to re-add Library panel as a column', error);
    }

    try {
      const layoutApi = this.layout as unknown as {
        addComponent?: (componentType: string, state?: unknown, title?: string) => void;
      };
      layoutApi.addComponent?.(
        PANEL_COMPONENT_TYPES.library,
        undefined,
        PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.library]
      );
      this.focusPanel(PANEL_COMPONENT_TYPES.library);
    } catch (error) {
      console.error('[LayoutManager] Failed to re-add Library panel', error);
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
      componentType === PANEL_COMPONENT_TYPES.code ||
      componentType === PANEL_COMPONENT_TYPES.spriteEditor
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
    // Always re-run decorations: dirty state may have flipped even when the title text is unchanged
    // (unsaved edits no longer alter the title). Schedule first so the early-return path below can't
    // skip it.
    this.scheduleEditorTabDecorations();

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

  /**
   * Re-derive the type icon + unsaved (dirty) indicator on every document tab. Golden Layout owns
   * the tab DOM and rebuilds it whenever the header re-renders (tab add/remove), so we re-apply the
   * decorations wholesale rather than tracking incremental diffs. The pass is idempotent and cheap.
   */
  refreshEditorTabDecorations(): void {
    this.ensureEditorStack();
    const stack = this.editorStack;
    const items = stack?.contentItems;
    if (!items) return;

    for (const contentItem of items) {
      const ci = contentItem as ContentItem & {
        type?: string;
        componentType?: PanelComponentType;
        container?: { state?: { tabId?: string } };
        tab?: { element?: HTMLElement };
      };
      if (ci.type !== 'component') continue;

      const tabEl = ci.tab?.element;
      if (!tabEl) continue;

      const iconName =
        EDITOR_TAB_ICON_BY_COMPONENT[ci.componentType as PanelComponentType] ?? 'file';
      const tabId = ci.container?.state?.tabId;
      const isDirty = tabId
        ? (appState.tabs.tabs.find(t => t.id === tabId)?.isDirty ?? false)
        : false;

      this.applyTabDecoration(tabEl, iconName, isDirty);
    }
  }

  /** Debounced wrapper so bursts of title/dirty updates coalesce into one DOM pass next tick. */
  private scheduleEditorTabDecorations(): void {
    if (this.tabDecorationHandle !== null) return;
    this.tabDecorationHandle = setTimeout(() => {
      this.tabDecorationHandle = null;
      try {
        this.refreshEditorTabDecorations();
      } catch (error) {
        console.error('[LayoutManager] Failed to refresh editor tab decorations', error);
      }
    }, 0);
  }

  private applyTabDecoration(tabEl: HTMLElement, iconName: string, isDirty: boolean): void {
    let iconEl = tabEl.querySelector<HTMLElement>('.pix3-tab-icon');
    if (!iconEl) {
      iconEl = document.createElement('span');
      iconEl.className = 'pix3-tab-icon';
      iconEl.setAttribute('aria-hidden', 'true');
      const titleEl = tabEl.querySelector('.lm_title');
      tabEl.insertBefore(iconEl, titleEl);
    }
    if (iconEl.dataset.icon !== iconName) {
      iconEl.innerHTML = this.iconService.getIconSvg(iconName, IconSize.SMALL);
      iconEl.dataset.icon = iconName;
    }

    tabEl.classList.toggle('pix3-tab-dirty', isDirty);
  }

  private async loadDefaultLayout(): Promise<void> {
    if (!this.layout) {
      throw new Error('LayoutManager has not been initialized');
    }

    this.layout.loadLayout(DEFAULT_LAYOUT_CONFIG);

    this.ensureEditorStack();

    // Decorate the initial Home tab (and any tabs restored into the default layout).
    this.scheduleEditorTabDecorations();

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

    // Bring the Runtime panel to the front when play mode starts, so live
    // runtime instances are immediately visible.
    this.lastIsPlaying = appState.ui.isPlaying;
    this.disposePlaySubscription?.();
    this.disposePlaySubscription = subscribe(appState.ui, () => {
      const playing = appState.ui.isPlaying;
      if (playing && !this.lastIsPlaying) {
        this.focusPanel(PANEL_COMPONENT_TYPES.runtime);
      } else if (!playing && this.lastIsPlaying) {
        // Returning from play mode: bring the Scene Tree back to the front of its
        // stack (play mode swapped it for the Runtime panel).
        this.focusPanel(PANEL_COMPONENT_TYPES.sceneTree);
      }
      this.lastIsPlaying = playing;
    });

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
        previousPanelVisibility.assets === nextPanelVisibility.assets &&
        previousPanelVisibility.animation === nextPanelVisibility.animation &&
        previousPanelVisibility.animationTimeline === nextPanelVisibility.animationTimeline &&
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
    this.disposePlaySubscription?.();
    this.disposePlaySubscription = undefined;
    if (this.tabDecorationHandle !== null) {
      clearTimeout(this.tabDecorationHandle);
      this.tabDecorationHandle = null;
    }
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
        if (componentType === PANEL_COMPONENT_TYPES.runtime) {
          void import('@/ui/runtime/runtime-panel');
        }
        if (componentType === PANEL_COMPONENT_TYPES.spriteEditor) {
          void import('@/ui/sprite-editor/sprite-editor-panel');
        }
        if (componentType === PANEL_COMPONENT_TYPES.agentChat) {
          void import('@/ui/agent-chat/pix3-agent-chat-panel');
        }
        if (componentType === PANEL_COMPONENT_TYPES.animationTimeline) {
          void import('@/ui/animation-timeline/animation-timeline-panel');
        }
        if (componentType === PANEL_COMPONENT_TYPES.library) {
          void import('@/ui/asset-library/library-panel');
        }
        if (componentType === PANEL_COMPONENT_TYPES.localization) {
          void import('@/ui/localization-view/localization-panel');
        }
        if (componentType === PANEL_COMPONENT_TYPES.assets) {
          void import('@/ui/assets/assets-panel');
        }
        if (componentType === PANEL_COMPONENT_TYPES.background) {
          void import('@/ui/home/pix3-project-home');
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
