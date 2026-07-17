import { subscribe } from 'valtio/vanilla';
import { repeat } from 'lit/directives/repeat.js';

import { ComponentBase, customElement, html, state, inject } from '@/fw';
import { appState, type SceneDescriptor } from '@/state';
import { NodeBase } from '@pix3/runtime';
import { getNodeVisuals } from './node-visuals.helper';
import type { SceneTreeNode } from './scene-tree-node';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { KeybindingService } from '@/services/KeybindingService';
import { NodeRegistry } from '@/services/NodeRegistry';
import { NodeTypePickerService } from '@/services/NodeTypePickerService';
import { AddModelCommand } from '@/features/scene/AddModelCommand';
import { CreateAnimatedSprite2DCommand } from '@/features/scene/CreateAnimatedSprite2DCommand';
import { ReparentNodeCommand } from '@/features/scene/ReparentNodeCommand';
import { CreatePrefabInstanceCommand } from '@/features/scene/CreatePrefabInstanceCommand';
import { CreateSprite2DCommand } from '@/features/scene/CreateSprite2DCommand';
import { SaveAsPrefabCommand } from '@/features/scene/SaveAsPrefabCommand';
import { OpenPrefabCommand } from '@/features/scene/OpenPrefabCommand';
import { UnlinkPrefabInstanceCommand } from '@/features/scene/UnlinkPrefabInstanceCommand';
import { FrameSelectedCommand } from '@/features/viewport/FrameSelectedCommand';
import { SceneManager } from '@pix3/runtime';
import { ServiceContainer } from '@/fw/di';
import { classifySceneCreateAssetResource, deriveAssetNodeName } from '@/ui/shared/asset-drag-drop';
import { DropdownPortal } from '../shared/dropdown-portal';
import {
  getPrefabMetadata,
  isPrefabChildNode,
  isPrefabInstanceRoot,
  isPrefabNode,
} from '@/features/scene/prefab-utils';

import '../shared/pix3-panel';
import '../shared/pix3-toolbar';
import '../shared/pix3-toolbar-button';
import './scene-tree-node';
import './scene-tree-panel.ts.css';

interface NodeContextMenuDetail {
  nodeId: string;
  clientX: number;
  clientY: number;
}

interface NodeAssetDropDetail {
  targetNodeId: string;
  position: 'before' | 'inside' | 'after';
  resourcePath: string;
}

@customElement('pix3-scene-tree-panel')
export class SceneTreePanel extends ComponentBase {
  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(KeybindingService)
  private readonly keybindingService!: KeybindingService;

  @inject(NodeRegistry)
  private readonly nodeRegistry!: NodeRegistry;

  @inject(NodeTypePickerService)
  private readonly nodeTypePickerService!: NodeTypePickerService;

  @state()
  private activeScene: SceneDescriptor | null = this.resolveActiveSceneDescriptor();

  @state()
  private activeSceneId: string | null = appState.scenes.activeSceneId;

  @state()
  private hierarchy: SceneTreeNode[] = this.buildTreeNodes(this.resolveActiveHierarchyNodes());

  @state()
  private selectedNodeIds: string[] = [...appState.selection.nodeIds];

  @state()
  private primaryNodeId: string | null = appState.selection.primaryNodeId;

  @state()
  private collapsedNodeIds: Set<string> = new Set();

  @state()
  private loadState = appState.scenes.loadState;

  @state()
  private loadError: string | null = appState.scenes.loadError;

  @state()
  private draggedNodeId: string | null = null;

  @state()
  private draggedNodeType: string | null = null;

  @state()
  private lastLoadedAt = appState.scenes.lastLoadedAt;

  @state()
  private lastNodeDataChangeSignal = appState.scenes.nodeDataChangeSignal;

  @state()
  private contextMenu: {
    nodeId: string;
    x: number;
    y: number;
  } | null = null;

  @state()
  private remoteSelectionByNodeId: Record<string, Array<{ name: string; color: string }>> = {};

  private portal = new DropdownPortal({ minWidth: '12rem' });
  private lastHierarchyRef: NodeBase[] | null = null;
  private pendingScrollNodeId: string | null = null;
  /**
   * Scene id whose prefab instance roots have already been auto-collapsed. Reset
   * on scene change so each newly loaded scene collapses its instances once, then
   * respects the user's manual expand/collapse toggles.
   */
  private collapseInitializedSceneId: string | null = null;
  private disposeSceneSubscription?: () => void;
  private disposeSelectionSubscription?: () => void;
  private disposeCollaborationSubscription?: () => void;
  private readonly onWindowClick = (event: MouseEvent): void => {
    if (!this.contextMenu) {
      return;
    }

    const target = event.target as Node;
    // Close menu if click was NOT on the portal menu
    if (!this.portal.contains(target)) {
      this.contextMenu = null;
    }
  };
  private readonly onWindowEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.contextMenu) {
      this.contextMenu = null;
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.syncSceneState();
    this.syncSelectionState();
    this.syncRemoteSelections();
    this.disposeSceneSubscription = subscribe(appState.scenes, () => {
      this.syncSceneState();
    });
    this.disposeSelectionSubscription = subscribe(appState.selection, () => {
      this.syncSelectionState();
    });
    this.disposeCollaborationSubscription = subscribe(appState.collaboration, () => {
      this.syncRemoteSelections();
    });

    // Track focus for context-aware shortcuts
    this.addEventListener('focusin', () => {
      appState.editorContext.focusedArea = 'scene-tree';
    });

    document.addEventListener('click', this.onWindowClick, { capture: true });
    window.addEventListener('keydown', this.onWindowEscape);
  }

  disconnectedCallback(): void {
    this.disposeSceneSubscription?.();
    this.disposeSceneSubscription = undefined;
    this.disposeSelectionSubscription?.();
    this.disposeSelectionSubscription = undefined;
    this.disposeCollaborationSubscription?.();
    this.disposeCollaborationSubscription = undefined;
    document.removeEventListener('click', this.onWindowClick, { capture: true });
    window.removeEventListener('keydown', this.onWindowEscape);
    this.portal.close();
    super.disconnectedCallback();
  }

  protected render() {
    const hasHierarchy = this.hierarchy.length > 0;
    const activeSceneName = this.activeScene?.name ?? null;
    const isReadOnly = appState.collaboration.isReadOnly;

    return html`
      <pix3-panel
        panel-description="Browse and organise the hierarchy of nodes in the active scene."
        actions-label="Scene tree controls"
      >
        ${activeSceneName ? html`<span slot="subtitle">${activeSceneName}</span>` : null}
        <pix3-toolbar slot="toolbar" variant="panel" label="Scene tree controls">
          <pix3-toolbar-button
            icon="plus-circle"
            aria-label="Create node"
            ?disabled=${isReadOnly}
            @click=${this.onOpenNodeTypePicker}
          ></pix3-toolbar-button>
        </pix3-toolbar>
        <div
          class="tree-container"
          ?data-dragging=${this.draggedNodeId !== null}
          @toggle-node=${this.onToggleNode.bind(this)}
          @node-drop=${this.onNodeDrop.bind(this)}
          @node-drag-start=${this.onNodeDragStart.bind(this)}
          @node-drag-end=${this.onNodeDragEnd.bind(this)}
          @node-context-menu=${this.onNodeContextMenu.bind(this)}
          @node-asset-drop=${this.onNodeAssetDrop.bind(this)}
          @node-open-prefab=${this.onNodeOpenPrefab.bind(this)}
        >
          ${hasHierarchy
            ? html`<ul
                class="tree-root"
                role="tree"
                aria-label=${this.getTreeAriaLabel(activeSceneName)}
              >
                ${repeat(
                  this.hierarchy,
                  node => node.id,
                  (node, index) =>
                    html`<pix3-scene-tree-node
                      .node=${node}
                      .level=${1}
                      .selectedNodeIds=${this.selectedNodeIds}
                      .primaryNodeId=${this.primaryNodeId}
                      .collapsedNodeIds=${this.collapsedNodeIds}
                      .draggedNodeId=${this.draggedNodeId}
                      .draggedNodeType=${this.draggedNodeType}
                      .remoteSelectionByNodeId=${this.remoteSelectionByNodeId}
                      ?focusable=${index === 0}
                    ></pix3-scene-tree-node>`
                )}
              </ul>`
            : html`<p class="panel-placeholder">${this.getPlaceholderMessage()}</p>`}
          ${this.renderContextMenu()}
        </div>
      </pix3-panel>
    `;
  }

  protected updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    if (changed.has('contextMenu')) {
      if (this.contextMenu && !this.portal.isOpen()) {
        const menuElement = this.querySelector('.scene-tree-context-menu') as HTMLElement;
        if (menuElement) {
          this.portal.openAt(this.contextMenu.x, this.contextMenu.y, menuElement);
        }
      } else if (!this.contextMenu && this.portal.isOpen()) {
        this.portal.close();
      }
    }

    const shouldAttemptSelectionScroll =
      this.pendingScrollNodeId !== null &&
      (changed.has('selectedNodeIds') ||
        changed.has('primaryNodeId') ||
        changed.has('collapsedNodeIds') ||
        changed.has('hierarchy'));

    if (shouldAttemptSelectionScroll && this.pendingScrollNodeId) {
      if (this.scrollNodeIntoView(this.pendingScrollNodeId)) {
        this.pendingScrollNodeId = null;
      }
    }
  }

  private renderContextMenu() {
    if (!this.contextMenu) {
      this.portal.close();
      return null;
    }

    const contextNode = this.resolveContextMenuNode();
    const isInstanceRoot = contextNode ? isPrefabInstanceRoot(contextNode) : false;
    const isChild = contextNode ? isPrefabChildNode(contextNode) : false;
    const isPrefab = contextNode ? isPrefabNode(contextNode) : false;

    return html`
      <div class="scene-tree-context-menu" role="menu" @click=${(e: Event) => e.stopPropagation()}>
        <button type="button" role="menuitem" @click=${() => this.onContextMenuAction('frame')}>
          <span>Frame in Viewport</span>
          <span class="context-menu-shortcut"
            >${this.getCommandShortcut('view.frame-selected')}</span
          >
        </button>
        ${isPrefab
          ? html`<button
              type="button"
              role="menuitem"
              @click=${() => this.onContextMenuAction('openPrefab')}
            >
              <span>Open Prefab</span>
              <span class="context-menu-shortcut"></span>
            </button>`
          : null}
        ${isInstanceRoot
          ? html`<button
              type="button"
              role="menuitem"
              @click=${() => this.onContextMenuAction('unlinkPrefab')}
            >
              <span>Unlink Prefab Instance</span>
              <span class="context-menu-shortcut"></span>
            </button>`
          : null}
        ${isChild
          ? null
          : html`
              <button
                type="button"
                role="menuitem"
                @click=${() => this.onContextMenuAction('duplicate')}
              >
                <span>Duplicate</span>
                <span class="context-menu-shortcut"
                  >${this.getCommandShortcut('scene.duplicate-nodes')}</span
                >
              </button>
              <button
                type="button"
                role="menuitem"
                @click=${() => this.onContextMenuAction('group')}
              >
                <span>Group Selection</span>
                <span class="context-menu-shortcut"
                  >${this.getCommandShortcut('scene.group-selected-nodes')}</span
                >
              </button>
              <button
                type="button"
                role="menuitem"
                @click=${() => this.onContextMenuAction('delete')}
              >
                <span>Delete</span>
                <span class="context-menu-shortcut"
                  >${this.getCommandShortcut('scene.delete-object')}</span
                >
              </button>
              <button
                type="button"
                role="menuitem"
                @click=${() => this.onContextMenuAction('saveAsPrefab')}
              >
                <span>Save Branch as Prefab</span>
                <span class="context-menu-shortcut"></span>
              </button>
            `}
      </div>
    `;
  }

  private resolveContextMenuNode(): NodeBase | null {
    if (!this.contextMenu) {
      return null;
    }
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId) {
      return null;
    }
    const container = ServiceContainer.getInstance();
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    return sceneManager.getSceneGraph(sceneId)?.nodeMap.get(this.contextMenu.nodeId) ?? null;
  }

  private getCommandShortcut(commandId: string): string {
    const displayString = this.keybindingService.getDisplayString(commandId);
    return displayString ?? '';
  }

  private syncSceneState(): void {
    const nextSceneId = appState.scenes.activeSceneId;
    const sceneChanged = this.activeSceneId !== nextSceneId;
    const nextLoadState = appState.scenes.loadState;
    const nextLoadError = appState.scenes.loadError;
    const nextLastLoadedAt = appState.scenes.lastLoadedAt;
    const nextNodeDataChangeSignal = appState.scenes.nodeDataChangeSignal;
    const nextDescriptor = this.resolveActiveSceneDescriptor();
    const nextHierarchyRoots = this.resolveActiveHierarchyNodes();

    // Detect if hierarchy reference changed (new array was assigned)
    const hierarchyChanged = this.lastHierarchyRef !== nextHierarchyRoots;

    // Only rebuild tree if scene changed, load state changed, hierarchy changed, scene was marked dirty/reloaded, or node data changed
    const needsRebuild =
      sceneChanged ||
      this.loadState !== nextLoadState ||
      this.loadError !== nextLoadError ||
      this.lastLoadedAt !== nextLastLoadedAt ||
      this.lastNodeDataChangeSignal !== nextNodeDataChangeSignal ||
      hierarchyChanged;

    this.activeSceneId = nextSceneId;
    this.activeScene = nextDescriptor;
    this.loadState = nextLoadState;
    this.loadError = nextLoadError;
    this.lastLoadedAt = nextLastLoadedAt;
    this.lastNodeDataChangeSignal = nextNodeDataChangeSignal;
    this.lastHierarchyRef = nextHierarchyRoots;

    if (needsRebuild) {
      this.hierarchy = this.buildTreeNodes(nextHierarchyRoots);
    }

    if (sceneChanged) {
      this.collapsedNodeIds = new Set();
      this.collapseInitializedSceneId = null;
    }

    if (
      this.activeSceneId &&
      this.activeSceneId !== this.collapseInitializedSceneId &&
      this.hierarchy.length > 0
    ) {
      // First time this scene's hierarchy is available: collapse prefab instance
      // roots by default so many instances don't flood the tree. Deferred via the
      // sentinel because activeSceneId changes before rootNodes arrive on load.
      this.collapsedNodeIds = this.collectPrefabRootIds(this.hierarchy);
      this.collapseInitializedSceneId = this.activeSceneId;
    } else if (this.collapsedNodeIds.size > 0 && needsRebuild) {
      const validIds = new Set<string>();
      this.collectNodeIds(this.hierarchy, validIds);
      const pruned = new Set([...this.collapsedNodeIds].filter(id => validIds.has(id)));
      if (pruned.size !== this.collapsedNodeIds.size) {
        this.collapsedNodeIds = pruned;
      }
    }
  }

  private collectPrefabRootIds(nodes: SceneTreeNode[]): Set<string> {
    const target = new Set<string>();
    const walk = (list: SceneTreeNode[]): void => {
      for (const node of list) {
        if (node.isPrefabRoot) {
          target.add(node.id);
        }
        if (node.children.length > 0) {
          walk(node.children);
        }
      }
    };
    walk(nodes);
    return target;
  }

  private syncSelectionState(): void {
    this.selectedNodeIds = [...appState.selection.nodeIds];
    this.primaryNodeId = appState.selection.primaryNodeId;

    const selectedNodeId = this.primaryNodeId ?? this.selectedNodeIds[0] ?? null;
    if (!selectedNodeId) {
      this.pendingScrollNodeId = null;
      return;
    }

    this.expandAncestorsForNode(selectedNodeId);
    this.pendingScrollNodeId = selectedNodeId;
  }

  private syncRemoteSelections(): void {
    const next: Record<string, Array<{ name: string; color: string }>> = {};
    for (const user of appState.collaboration.remoteUsers) {
      for (const nodeId of user.selection) {
        if (!next[nodeId]) {
          next[nodeId] = [];
        }
        next[nodeId].push({ name: user.name, color: user.color });
      }
    }
    this.remoteSelectionByNodeId = next;
  }

  private resolveActiveSceneDescriptor(): SceneDescriptor | null {
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId) {
      return null;
    }
    return appState.scenes.descriptors[sceneId] ?? null;
  }

  private resolveActiveHierarchyNodes(): NodeBase[] {
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId) {
      return [];
    }
    const hierarchy = appState.scenes.hierarchies[sceneId];
    if (!hierarchy) {
      return [];
    }
    return (hierarchy.rootNodes ?? []) as NodeBase[];
  }

  /**
   * Converts NodeBase instances to SceneTreeNode view models.
   */
  private buildTreeNodes(nodes: NodeBase[]): SceneTreeNode[] {
    return nodes.map(node => {
      const { color, icon } = getNodeVisuals(node);
      return {
        id: node.nodeId,
        name: node.name,
        type: node.type,
        treeColor: color,
        treeIcon: icon,
        instancePath: node.instancePath,
        properties: node.properties,
        isContainer: node.isContainer,
        scripts:
          node.components && Array.isArray(node.components) ? node.components.map(c => c.type) : [],
        isPrefabNode: isPrefabNode(node),
        isPrefabRoot: isPrefabInstanceRoot(node),
        isPrefabChild: isPrefabChildNode(node),
        // Only include NodeBase children, filter out Three.js objects like Mesh, Light, etc.
        children: this.buildTreeNodes(node.children.filter(child => child instanceof NodeBase)),
      };
    });
  }

  private collectNodeIds(nodes: SceneTreeNode[], target: Set<string>): void {
    for (const node of nodes) {
      target.add(node.id);
      if (node.children.length > 0) {
        this.collectNodeIds(node.children, target);
      }
    }
  }

  private expandAncestorsForNode(nodeId: string): void {
    const ancestorIds = this.findAncestorNodeIds(this.hierarchy, nodeId);
    if (!ancestorIds || ancestorIds.length === 0) {
      return;
    }

    const nextCollapsedNodeIds = new Set(this.collapsedNodeIds);
    let changed = false;
    for (const ancestorId of ancestorIds) {
      if (nextCollapsedNodeIds.delete(ancestorId)) {
        changed = true;
      }
    }

    if (changed) {
      this.collapsedNodeIds = nextCollapsedNodeIds;
    }
  }

  private findAncestorNodeIds(
    nodes: SceneTreeNode[],
    targetNodeId: string,
    ancestors: string[] = []
  ): string[] | null {
    for (const node of nodes) {
      if (node.id === targetNodeId) {
        return ancestors;
      }
      if (node.children.length === 0) {
        continue;
      }
      const foundAncestors = this.findAncestorNodeIds(node.children, targetNodeId, [
        ...ancestors,
        node.id,
      ]);
      if (foundAncestors) {
        return foundAncestors;
      }
    }

    return null;
  }

  private scrollNodeIntoView(nodeId: string): boolean {
    const treeNodeElements = this.querySelectorAll<HTMLElement>(
      '.tree-node__content[data-node-id]'
    );
    for (const treeNodeElement of treeNodeElements) {
      if (treeNodeElement.dataset.nodeId !== nodeId) {
        continue;
      }
      treeNodeElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return true;
    }

    return false;
  }

  private getTreeAriaLabel(activeSceneName: string | null): string {
    if (activeSceneName) {
      return `Scene nodes for ${activeSceneName}`;
    }
    return 'Scene nodes';
  }

  private getPlaceholderMessage(): string {
    if (this.loadState === 'loading') {
      return 'Loading scene…';
    }
    if (this.loadState === 'error') {
      return this.loadError ?? 'Failed to load scene.';
    }
    if (this.activeSceneId && !this.hierarchy.length) {
      return 'The active scene has no nodes yet.';
    }
    return 'Scene hierarchy will appear here once a project is loaded.';
  }

  private onToggleNode(event: CustomEvent): void {
    const { nodeId, isCollapsed } = event.detail;
    const next = new Set(this.collapsedNodeIds);
    if (isCollapsed) {
      next.add(nodeId);
    } else {
      next.delete(nodeId);
    }
    this.collapsedNodeIds = next;
  }

  private async createNodeByType(nodeTypeId: string): Promise<void> {
    const command = this.nodeRegistry.createCommand(nodeTypeId);
    if (!command) {
      console.error('[SceneTreePanel] Unknown node type:', nodeTypeId);
      return;
    }

    try {
      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[SceneTreePanel] Failed to create node:', error);
    }
  }

  private onOpenNodeTypePicker = async (): Promise<void> => {
    const nodeTypeId = await this.nodeTypePickerService.showPicker();
    if (!nodeTypeId) {
      return;
    }

    await this.createNodeByType(nodeTypeId);
  };

  private async onNodeDrop(event: CustomEvent): Promise<void> {
    const { draggedNodeId, targetNodeId, position } = event.detail;

    console.log('[SceneTreePanel] onNodeDrop:', { draggedNodeId, targetNodeId, position });

    // Get scene information
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId) {
      console.log('[SceneTreePanel] No active scene');
      return;
    }

    const container = ServiceContainer.getInstance();
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );

    const sceneGraph = sceneManager.getSceneGraph(sceneId);
    if (!sceneGraph) {
      console.log('[SceneTreePanel] No scene graph');
      return;
    }

    // Find the target node
    const targetNode = sceneGraph.nodeMap.get(targetNodeId);
    if (!targetNode) {
      console.log('[SceneTreePanel] Target node not found:', targetNodeId);
      return;
    }

    let newParentId: string | null = null;
    let newIndex: number = -1;

    if (position === 'before' || position === 'after') {
      // Drop before/after: use target's parent as new parent
      if (targetNode.parentNode) {
        newParentId = targetNode.parentNode.nodeId;
        const targetIndex = targetNode.parentNode.children.indexOf(targetNode);
        newIndex = position === 'before' ? targetIndex : targetIndex + 1;
      } else {
        // Target is at root level
        const targetIndex = sceneGraph.rootNodes.indexOf(targetNode);
        newIndex = position === 'before' ? targetIndex : targetIndex + 1;
      }
    } else {
      // Drop inside: use target as parent
      newParentId = targetNodeId;
      newIndex = -1; // Append
    }

    console.log('[SceneTreePanel] Executing reparent:', {
      draggedNodeId,
      newParentId,
      newIndex,
      position,
    });

    try {
      const command = new ReparentNodeCommand({
        nodeId: draggedNodeId,
        newParentId,
        newIndex,
      });

      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[SceneTreePanel] Failed to reparent node:', error);
    }
  }

  private async onNodeAssetDrop(event: CustomEvent<NodeAssetDropDetail>): Promise<void> {
    const { targetNodeId, position, resourcePath } = event.detail;
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId) {
      return;
    }

    const container = ServiceContainer.getInstance();
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getSceneGraph(sceneId);
    if (!sceneGraph) {
      return;
    }

    const targetNode = sceneGraph.nodeMap.get(targetNodeId);
    if (!targetNode) {
      return;
    }

    let parentNodeId: string | null = null;
    let insertIndex = -1;

    if (position === 'inside' && targetNode.isContainer) {
      parentNodeId = targetNodeId;
      insertIndex = -1;
    } else if (position === 'before' || position === 'after') {
      if (targetNode.parentNode) {
        parentNodeId = targetNode.parentNode.nodeId;
        const targetIndex = targetNode.parentNode.children.indexOf(targetNode);
        insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
      } else {
        const rootIndex = sceneGraph.rootNodes.indexOf(targetNode);
        parentNodeId = null;
        insertIndex = position === 'before' ? rootIndex : rootIndex + 1;
      }
    } else {
      if (targetNode.parentNode) {
        parentNodeId = targetNode.parentNode.nodeId;
        insertIndex = targetNode.parentNode.children.indexOf(targetNode) + 1;
      } else {
        parentNodeId = null;
        insertIndex = sceneGraph.rootNodes.indexOf(targetNode) + 1;
      }
    }

    // Never create a node inside a prefab instance subtree — its structure is
    // owned by the prefab file and additions are lost on save. (The dragover
    // validator already fades these targets; this backstops other entry paths.)
    const effectiveParent = parentNodeId ? sceneGraph.nodeMap.get(parentNodeId) : null;
    if (effectiveParent && isPrefabNode(effectiveParent)) {
      console.warn(
        '[SceneTreePanel] Asset drop rejected: target is inside a prefab instance',
        parentNodeId
      );
      return;
    }

    const assetKind = classifySceneCreateAssetResource(resourcePath);
    if (!assetKind) {
      return;
    }

    if (assetKind === 'prefab') {
      const command = new CreatePrefabInstanceCommand({
        prefabPath: resourcePath,
        parentNodeId,
        insertIndex,
      });
      await this.commandDispatcher.execute(command);
      return;
    }

    if (assetKind === 'image') {
      const command = new CreateSprite2DCommand({
        texturePath: resourcePath,
        spriteName: deriveAssetNodeName(resourcePath, 'Sprite2D'),
        parentNodeId,
        insertIndex,
      });
      await this.commandDispatcher.execute(command);
      return;
    }

    if (assetKind === 'animation') {
      const command = new CreateAnimatedSprite2DCommand({
        nodeName: deriveAssetNodeName(resourcePath, 'AnimatedSprite2D'),
        animationResourcePath: resourcePath,
        parentNodeId,
        insertIndex,
      });
      await this.commandDispatcher.execute(command);
      return;
    }

    if (assetKind === 'model') {
      const command = new AddModelCommand({
        modelPath: resourcePath,
        modelName: deriveAssetNodeName(resourcePath, 'Model'),
        parentNodeId,
        insertIndex,
      });
      await this.commandDispatcher.execute(command);
    }
  }

  private onNodeDragStart(event: CustomEvent): void {
    const { nodeId, nodeType } = event.detail;
    this.draggedNodeId = nodeId;
    this.draggedNodeType = nodeType;
    console.log('[SceneTreePanel] Drag started:', { nodeId, nodeType });
  }

  private onNodeDragEnd(_event: CustomEvent): void {
    this.draggedNodeId = null;
    this.draggedNodeType = null;
    console.log('[SceneTreePanel] Drag ended');
  }

  private onNodeContextMenu(event: CustomEvent<NodeContextMenuDetail>): void {
    event.stopPropagation();
    this.contextMenu = {
      nodeId: event.detail.nodeId,
      x: event.detail.clientX,
      y: event.detail.clientY,
    };
  }

  private async onContextMenuAction(
    action:
      | 'frame'
      | 'duplicate'
      | 'group'
      | 'delete'
      | 'saveAsPrefab'
      | 'openPrefab'
      | 'unlinkPrefab'
  ): Promise<void> {
    // Resolve the context node before clearing the menu — the node id is needed
    // for the prefab-specific actions.
    const contextNode = this.resolveContextMenuNode();
    this.contextMenu = null;

    if (action === 'frame') {
      if (!contextNode) {
        return;
      }
      try {
        await this.commandDispatcher.execute(
          new FrameSelectedCommand({ nodeId: contextNode.nodeId })
        );
      } catch (error) {
        console.error('[SceneTreePanel] Failed to execute "Frame in Viewport"', error);
      }
      return;
    }

    if (action === 'openPrefab') {
      await this.openPrefabForNode(contextNode);
      return;
    }

    if (action === 'unlinkPrefab') {
      if (!contextNode) {
        return;
      }
      try {
        await this.commandDispatcher.execute(
          new UnlinkPrefabInstanceCommand({ nodeId: contextNode.nodeId })
        );
      } catch (error) {
        console.error('[SceneTreePanel] Failed to execute "Unlink Prefab Instance"', error);
      }
      return;
    }

    if (action === 'saveAsPrefab') {
      try {
        await this.commandDispatcher.execute(new SaveAsPrefabCommand());
      } catch (error) {
        console.error('[SceneTreePanel] Failed to execute "Save Branch as Prefab"', error);
      }
      return;
    }

    const commandIdByAction: Record<'duplicate' | 'group' | 'delete', string> = {
      duplicate: 'scene.duplicate-nodes',
      group: 'scene.group-selected-nodes',
      delete: 'scene.delete-object',
    };

    const commandId = commandIdByAction[action];
    try {
      await this.commandDispatcher.executeById(commandId);
    } catch (error) {
      console.error(`[SceneTreePanel] Failed to execute context menu action "${action}"`, error);
    }
  }

  private async onNodeOpenPrefab(event: CustomEvent<{ nodeId: string }>): Promise<void> {
    const sceneId = appState.scenes.activeSceneId;
    if (!sceneId) {
      return;
    }
    const container = ServiceContainer.getInstance();
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );
    const node = sceneManager.getSceneGraph(sceneId)?.nodeMap.get(event.detail.nodeId) ?? null;
    await this.openPrefabForNode(node);
  }

  private async openPrefabForNode(node: NodeBase | null): Promise<void> {
    if (!node) {
      return;
    }
    const marker = getPrefabMetadata(node);
    // Prefer the node's own instancePath (set on instance roots). For a child use
    // the marker's sourcePath — the innermost prefab that defines it. focusLocalId
    // pre-selects the corresponding node in the opened prefab when it is a child.
    const prefabPath = node.instancePath ?? marker?.sourcePath ?? null;
    if (!prefabPath) {
      return;
    }
    const focusLocalId = isPrefabChildNode(node) ? marker?.localId : undefined;
    try {
      await this.commandDispatcher.execute(new OpenPrefabCommand({ prefabPath, focusLocalId }));
    } catch (error) {
      console.error('[SceneTreePanel] Failed to open prefab', error);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-scene-tree-panel': SceneTreePanel;
  }
}
