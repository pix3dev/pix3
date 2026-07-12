import { ComponentBase, customElement, html, inject, property, state, css, unsafeCSS } from '@/fw';
import { subscribe } from 'valtio/vanilla';
import { appState, type EditorCameraProjection, type NavigationMode } from '@/state';
import styles from './editor-tab.ts.css?raw';
import dropdownButtonStyles from '@/ui/shared/pix3-dropdown-button.ts.css?raw';
import visibilityPopoverStyles from './viewport-visibility-popover.ts.css?raw';
import { ViewportRendererService, type TransformMode } from '@/services/ViewportRenderService';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { IconService } from '@/services/IconService';
import { Navigation2DController } from '@/services/Navigation2DController';
import { SceneManager, Camera3D, Node2D, NodeBase } from '@pix3/runtime';
import { Vector2, Vector3 } from 'three';
import {
  selectObject,
  selectObjects,
  toggleObjectSelection,
} from '@/features/selection/SelectObjectCommand';
import { AddModelCommand } from '@/features/scene/AddModelCommand';
import { CreateAnimatedSprite2DCommand } from '@/features/scene/CreateAnimatedSprite2DCommand';
import { CreateSprite2DCommand } from '@/features/scene/CreateSprite2DCommand';
import { CreatePrefabInstanceCommand } from '@/features/scene/CreatePrefabInstanceCommand';
import { isPrefabNode } from '@/features/scene/prefab-utils';
import {
  setNavigationMode,
  toggleNavigationMode,
} from '@/features/viewport/ToggleNavigationModeCommand';
import {
  deriveSceneLayerCapabilities,
  resolveValidNavigationMode,
} from '@/features/viewport/scene-layer-capabilities';
import { setEditorCameraProjection } from '@/features/viewport/SetEditorCameraProjectionCommand';
import { setPreviewCamera } from '@/features/viewport/SetPreviewCameraCommand';
import { align2DNodes } from '@/features/alignment/Align2DNodesCommand';
import type { Align2DActionId } from '@/features/alignment/types';
import {
  classifySceneCreateAssetResource,
  deriveAssetNodeName,
  getDroppedAssetResourcePath,
  hasAssetDragData,
} from '@/ui/shared/asset-drag-drop';
import {
  renderTransformToolbarOverlay,
  renderViewportToolbar,
  renderViewportZoomOverlay,
} from './viewport-toolbar';
import '../shared/pix3-dropdown-button';
import './viewport-visibility-popover';

@customElement('pix3-editor-tab')
export class EditorTabComponent extends ComponentBase {
  static useShadowDom = true;

  @inject(ViewportRendererService)
  private readonly viewportRenderer!: ViewportRendererService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(IconService)
  private readonly iconService!: IconService;

  @inject(Navigation2DController)
  private readonly navigation2D!: Navigation2DController;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @property({ type: String, reflect: true, attribute: 'tab-id' })
  tabId: string = '';

  @state()
  private transformMode: TransformMode = 'select';

  @state()
  private showGrid = false;

  @state()
  private snapToGrid = false;

  @state()
  private showLayer2D = false;

  @state()
  private showLayer3D = false;

  @state()
  private showLighting = false;

  @state()
  private navigationMode: NavigationMode = '3d';

  @state()
  private editorCameraProjection: EditorCameraProjection = 'perspective';

  private canvasHost?: HTMLElement;
  private disposeUiSubscription?: () => void;
  private disposeTabsSubscription?: () => void;
  private disposeScenesSubscription?: () => void;
  private disposeSelectionSubscription?: () => void;
  private pointerDownPos?: { x: number; y: number };
  private pointerDownTime?: number;
  private marqueeSelectionStart?: { x: number; y: number };
  private marqueeSelectionNodeIds: string[] = [];
  private isDragging = false;
  private touchGestureInProgress = false;
  private singleTouchPanPointerId: number | null = null;
  private readonly dragThreshold = 5;
  private wheelCanvas?: HTMLCanvasElement;

  @state()
  private marqueeSelectionRect?: { left: number; top: number; width: number; height: number };

  @state()
  private has2DSelection = false;

  @state()
  private canAlignToContainer = false;

  @state()
  private canAlignToSelectionBounds = false;

  @state()
  private canDistributeSelection = false;

  @state()
  private sceneHas2D = true;

  @state()
  private sceneHas3D = true;

  @state()
  private isAssetDragOver = false;

  private readonly resizeObserver = new ResizeObserver(entries => {
    const entry = entries[0];
    if (!entry) return;
    const { width, height } = entry.contentRect;
    if (width <= 0 || height <= 0) return;
    this.viewportRenderer.resize(width, height);
  });

  private readonly handleViewportFocusIn = (): void => {
    appState.editorContext.focusedArea = 'viewport';
  };

  connectedCallback(): void {
    super.connectedCallback();

    // Initialize state from current appState values
    this.showGrid = appState.ui.showGrid;
    this.snapToGrid = appState.ui.snapToGrid;
    this.showLayer2D = appState.ui.showLayer2D;
    this.showLayer3D = appState.ui.showLayer3D;
    this.showLighting = appState.ui.showLighting;
    this.navigationMode = appState.ui.navigationMode;
    this.editorCameraProjection = appState.ui.editorCameraProjection;
    this.syncAlignmentToolbarState();
    this.syncSceneLayerCapabilities();

    this.disposeUiSubscription = subscribe(appState.ui, () => {
      this.showGrid = appState.ui.showGrid;
      this.snapToGrid = appState.ui.snapToGrid;
      this.showLayer2D = appState.ui.showLayer2D;
      this.showLayer3D = appState.ui.showLayer3D;
      this.showLighting = appState.ui.showLighting;
      this.navigationMode = appState.ui.navigationMode;
      this.editorCameraProjection = appState.ui.editorCameraProjection;
      this.requestUpdate();
    });

    this.disposeTabsSubscription = subscribe(appState.tabs, () => {
      this.syncActiveState();
    });

    this.disposeScenesSubscription = subscribe(appState.scenes, () => {
      this.syncAlignmentToolbarState();
      this.syncSceneLayerCapabilities();
      this.requestUpdate();
    });

    this.disposeSelectionSubscription = subscribe(appState.selection, () => {
      this.syncAlignmentToolbarState();
      this.requestUpdate();
    });

    this.addEventListener('wheel', this.handleWheel as EventListener, {
      passive: false,
      capture: true,
    });
    this.addEventListener('focusin', this.handleViewportFocusIn);
    this.addEventListener('pointerdown', this.handleCanvasPointerDown);
    this.addEventListener('pointermove', this.handleCanvasPointerMove);
    this.addEventListener('pointerup', this.handleCanvasPointerUp);
    this.addEventListener('pointercancel', this.handleCanvasPointerCancel);

    // Re-observe canvas host if it exists (handles reconnection/reparenting by Golden Layout)
    if (this.canvasHost) {
      try {
        this.resizeObserver.observe(this.canvasHost);
      } catch {
        // ignore
      }
    }

    this.syncActiveState();
  }

  disconnectedCallback(): void {
    this.resizeObserver.disconnect();
    this.disposeUiSubscription?.();
    this.disposeUiSubscription = undefined;
    this.disposeTabsSubscription?.();
    this.disposeTabsSubscription = undefined;
    this.disposeScenesSubscription?.();
    this.disposeScenesSubscription = undefined;
    this.disposeSelectionSubscription?.();
    this.disposeSelectionSubscription = undefined;
    this.removeEventListener('wheel', this.handleWheel as EventListener, true);
    this.renderRoot.removeEventListener('wheel', this.handleWheel as EventListener, true);
    this.wheelCanvas?.removeEventListener('wheel', this.handleWheel as EventListener, true);
    this.wheelCanvas = undefined;
    this.removeEventListener('focusin', this.handleViewportFocusIn);
    this.removeEventListener('pointerdown', this.handleCanvasPointerDown);
    this.removeEventListener('pointermove', this.handleCanvasPointerMove);
    this.removeEventListener('pointerup', this.handleCanvasPointerUp);
    this.removeEventListener('pointercancel', this.handleCanvasPointerCancel);
    this.navigation2D.clearTouchState();
    this.singleTouchPanPointerId = null;
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.canvasHost = this.renderRoot.querySelector<HTMLElement>('.viewport-host') ?? undefined;
    if (this.canvasHost) {
      try {
        this.resizeObserver.observe(this.canvasHost);
      } catch {
        // ignore
      }
    }
    // Ensure wheel events are captured inside the shadow root.
    this.renderRoot.addEventListener('wheel', this.handleWheel as EventListener, {
      passive: false,
      capture: true,
    });
    this.syncActiveState();
  }

  protected render() {
    const tab = appState.tabs.tabs.find(t => t.id === this.tabId);
    const isSceneTab = tab?.type === 'scene';
    const {
      items: previewCameraItems,
      label: previewCameraLabel,
      isActive: isPreviewCameraActive,
    } = this.getPreviewCameraDropdownState();
    const showAlignmentTools = isSceneTab && this.has2DSelection;

    return html`
      <section
        class="panel ${this.isAssetDragOver ? 'panel--asset-dragover' : ''}"
        role="region"
        aria-label="Editor tab"
        tabindex="0"
        data-nav-mode="${this.navigationMode}"
        @dragenter=${this.handleDragOver}
        @dragover=${this.handleDragOver}
        @drop=${this.handleDrop}
        @dragleave=${this.handleDragLeave}
      >
        <div class="viewport-toolbar-shell">
          ${renderViewportToolbar(
            {
              transformMode: isSceneTab ? this.transformMode : null,
              showGrid: this.showGrid,
              snapToGrid: this.snapToGrid,
              showLighting: this.showLighting,
              navigationMode: this.navigationMode,
              showLayer3D: this.showLayer3D,
              showLayer2D: this.showLayer2D,
              canToggleLayerVisibility: this.sceneHas2D && this.sceneHas3D,
              canToggleNavigationMode: this.sceneHas2D && this.sceneHas3D,
              previewCameraLabel,
              previewCameraItems,
              isPreviewCameraActive,
              editorCameraProjection: this.editorCameraProjection,
              showAlignmentTools,
              canAlignToContainer: isSceneTab && this.canAlignToContainer,
              canAlignToSelectionBounds: isSceneTab && this.canAlignToSelectionBounds,
              canDistributeSelection: isSceneTab && this.canDistributeSelection,
            },
            {
              onTransformModeChange: m => this.handleTransformModeChange(m),
              onToggleNavigationMode: () => this.toggleNavigationMode(),
              onSelectPreviewCamera: itemId => this.handlePreviewCameraSelect(itemId),
              onToggleGrid: () => this.toggleGrid(),
              onToggleSnapToGrid: () => this.toggleSnapToGrid(),
              onToggleLighting: () => this.toggleLighting(),
              onToggleLayer3D: () => this.toggleLayer3D(),
              onToggleLayer2D: () => this.toggleLayer2D(),
              onSetEditorCameraProjection: projection => this.setEditorCameraProjection(projection),
              onRunAlignmentAction: action => this.handleAlignmentAction(action),
            },
            this.iconService
          )}
        </div>

        <div
          class="viewport-host"
          part="canvas-host"
          @dragenter=${this.handleDragOver}
          @dragover=${this.handleDragOver}
          @drop=${this.handleDrop}
          @dragleave=${this.handleDragLeave}
        >
          ${this.marqueeSelectionRect
            ? html`<div
                class="viewport-marquee-selection"
                style=${this.getMarqueeSelectionStyle(this.marqueeSelectionRect)}
              ></div>`
            : null}
          ${renderTransformToolbarOverlay(
            {
              transformMode: isSceneTab ? this.transformMode : null,
            },
            {
              onTransformModeChange: m => this.handleTransformModeChange(m),
            },
            this.iconService
          )}
          ${isSceneTab
            ? renderViewportZoomOverlay(
                {
                  onZoomIn: () => this.zoomIn(),
                  onZoomOut: () => this.zoomOut(),
                  onZoomAll: () => this.zoomAll(),
                },
                this.iconService
              )
            : null}
        </div>
      </section>
    `;
  }

  private handleDragOver = (event: DragEvent): void => {
    if (!hasAssetDragData(event.dataTransfer ?? null)) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    this.isAssetDragOver = true;
  };

  private handleDragLeave = (_event: DragEvent): void => {
    this.isAssetDragOver = false;
  };

  private handleDrop = (event: DragEvent): void => {
    event.preventDefault();
    event.stopPropagation();

    const resourcePath = getDroppedAssetResourcePath(event.dataTransfer ?? null);
    this.isAssetDragOver = false;
    if (!resourcePath) {
      return;
    }

    const assetKind = classifySceneCreateAssetResource(resourcePath);
    if (!assetKind) {
      return;
    }

    const screenPoint = this.getViewportScreenPoint(event);

    if (assetKind === 'prefab') {
      const command = new CreatePrefabInstanceCommand({
        prefabPath: resourcePath,
        viewportScreenPoint: screenPoint,
      });
      void this.commandDispatcher.execute(command);
      return;
    }

    if (assetKind === 'image') {
      const placement = this.resolve2DAssetDropPlacement(screenPoint);
      const command = new CreateSprite2DCommand({
        texturePath: resourcePath,
        spriteName: deriveAssetNodeName(resourcePath, 'Sprite2D'),
        parentNodeId: placement.parentNodeId,
        position: placement.position,
      });
      void this.commandDispatcher.execute(command);
      return;
    }

    if (assetKind === 'animation') {
      const placement = this.resolve2DAssetDropPlacement(screenPoint);
      const command = new CreateAnimatedSprite2DCommand({
        nodeName: deriveAssetNodeName(resourcePath, 'AnimatedSprite2D'),
        animationResourcePath: resourcePath,
        parentNodeId: placement.parentNodeId,
        position: placement.position,
      });
      void this.commandDispatcher.execute(command);
      return;
    }

    if (assetKind === 'model') {
      const command = new AddModelCommand({
        modelPath: resourcePath,
        modelName: deriveAssetNodeName(resourcePath, 'Model'),
        viewportScreenPoint: screenPoint,
      });
      void this.commandDispatcher.execute(command);
    }
  };

  private getViewportScreenPoint(event: DragEvent): { x: number; y: number } | null {
    const canvas = this.viewportRenderer.getCanvasElement();
    if (!canvas) {
      return null;
    }

    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }

    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
  }

  private resolve2DAssetDropPlacement(screenPoint: { x: number; y: number } | null): {
    parentNodeId?: string | null;
    position?: Vector2;
  } {
    const worldPoint = screenPoint
      ? this.viewportRenderer.resolve2DAssetDropPosition(screenPoint.x, screenPoint.y)
      : null;
    const parentNode = screenPoint ? this.resolve2DDropParentNode(screenPoint) : null;

    if (!worldPoint) {
      return {
        parentNodeId: parentNode?.nodeId,
      };
    }

    if (!parentNode) {
      return {
        position: worldPoint,
      };
    }

    parentNode.updateWorldMatrix(true, false);
    const localPosition = parentNode.worldToLocal(new Vector3(worldPoint.x, worldPoint.y, 0));
    return {
      parentNodeId: parentNode.nodeId,
      position: new Vector2(localPosition.x, localPosition.y),
    };
  }

  private resolve2DDropParentNode(screenPoint: { x: number; y: number }): Node2D | null {
    const normalizedPoint = this.getViewportNormalizedPoint(screenPoint);
    const hitNode = normalizedPoint
      ? this.viewportRenderer.raycastObject(normalizedPoint.x, normalizedPoint.y)
      : null;
    const hitParent = this.getCompatible2DDropParent(hitNode);
    if (hitParent) {
      return hitParent;
    }

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      return null;
    }

    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return null;
    }

    const selectedNodeId =
      appState.selection.primaryNodeId ?? appState.selection.nodeIds[0] ?? null;
    const selectedNode = selectedNodeId ? (sceneGraph.nodeMap.get(selectedNodeId) ?? null) : null;
    const selectedParent = this.getCompatible2DDropParent(selectedNode);
    if (selectedParent) {
      return selectedParent;
    }

    const uiLayer = sceneGraph.rootNodes.find(
      node => node instanceof Node2D && node.isContainer && node.name === 'UI Layer'
    );
    if (uiLayer instanceof Node2D) {
      return uiLayer;
    }

    const compatibleRootNodes = sceneGraph.rootNodes.filter(
      (node): node is Node2D => node instanceof Node2D && node.isContainer
    );
    return compatibleRootNodes.length === 1 ? (compatibleRootNodes[0] ?? null) : null;
  }

  private getCompatible2DDropParent(node: NodeBase | null): Node2D | null {
    // Never parent a newly created node inside a prefab instance — its structure
    // is owned by the prefab and additions are discarded on save.
    if (node instanceof Node2D && node.isContainer && !isPrefabNode(node)) {
      return node;
    }

    const parentNode = node?.parentNode;
    return parentNode instanceof Node2D && parentNode.isContainer && !isPrefabNode(parentNode)
      ? parentNode
      : null;
  }

  private getViewportNormalizedPoint(screenPoint: { x: number; y: number }): {
    x: number;
    y: number;
  } | null {
    const canvas = this.viewportRenderer.getCanvasElement();
    if (!canvas) {
      return null;
    }

    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }

    return {
      x: screenPoint.x / bounds.width,
      y: screenPoint.y / bounds.height,
    };
  }

  private syncActiveState(): void {
    if (!this.tabId) return;
    if (appState.tabs.activeTabId !== this.tabId) return;
    if (!this.canvasHost) return;

    this.viewportRenderer.attachToHost(this.canvasHost);

    // Bind wheel listener to the actual renderer canvas (it is moved between hosts).
    const canvas = this.viewportRenderer.getCanvasElement();
    if (canvas && canvas !== this.wheelCanvas) {
      this.wheelCanvas?.removeEventListener('wheel', this.handleWheel as EventListener, true);
      this.wheelCanvas = canvas;
      this.wheelCanvas.addEventListener('wheel', this.handleWheel as EventListener, {
        passive: false,
        capture: true,
      });
    }

    const rect = this.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      // Account for toolbar height by measuring host.
      const hostRect = this.canvasHost.getBoundingClientRect();
      if (hostRect.width > 0 && hostRect.height > 0) {
        this.viewportRenderer.resize(hostRect.width, hostRect.height);
      } else {
        this.viewportRenderer.resize(rect.width, rect.height);
      }
    }
  }

  private syncAlignmentToolbarState(): void {
    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      this.has2DSelection = false;
      this.canAlignToContainer = false;
      this.canAlignToSelectionBounds = false;
      this.canDistributeSelection = false;
      return;
    }

    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      this.has2DSelection = false;
      this.canAlignToContainer = false;
      this.canAlignToSelectionBounds = false;
      this.canDistributeSelection = false;
      return;
    }

    const selectedNodes = appState.selection.nodeIds
      .map(nodeId => sceneGraph.nodeMap.get(nodeId) ?? null)
      .filter((node): node is NodeBase => node !== null);
    const selected2DNodes = selectedNodes.filter((node): node is Node2D => node instanceof Node2D);

    if (selected2DNodes.length === 0) {
      this.has2DSelection = false;
      this.canAlignToContainer = false;
      this.canAlignToSelectionBounds = false;
      this.canDistributeSelection = false;
      return;
    }

    const sharedParent = selected2DNodes[0]?.parentNode ?? null;
    const sharesParent = selected2DNodes.every(node => node.parentNode === sharedParent);

    this.has2DSelection = true;
    this.canAlignToContainer =
      sharesParent && (sharedParent === null || sharedParent instanceof Node2D);
    this.canAlignToSelectionBounds = selected2DNodes.length > 1;
    this.canDistributeSelection = selected2DNodes.length > 2;
  }

  /**
   * Derive which layers/navigation modes the active scene needs from its
   * content and adapt the viewport accordingly: the toolbar hides the layer and
   * navigation controls that don't apply, and — for the active tab — navigation
   * is locked to the only available mode when the scene is single-dimensional.
   */
  private syncSceneLayerCapabilities(): void {
    const activeSceneId = appState.scenes.activeSceneId;
    const sceneGraph = activeSceneId ? this.sceneManager.getSceneGraph(activeSceneId) : null;
    const capabilities = deriveSceneLayerCapabilities(sceneGraph);
    this.sceneHas2D = capabilities.has2D;
    this.sceneHas3D = capabilities.has3D;

    // Only the active viewport enforces the navigation lock, so background tabs
    // never fight over the shared navigation mode.
    if (appState.tabs.activeTabId !== this.tabId) {
      return;
    }

    const validMode = resolveValidNavigationMode(appState.ui.navigationMode, capabilities);
    if (validMode !== appState.ui.navigationMode) {
      void this.commandDispatcher.execute(setNavigationMode(validMode));
    }
  }

  private handleTransformModeChange(mode: TransformMode): void {
    this.transformMode = mode;
    this.viewportRenderer.setTransformMode(mode);
  }

  private handleAlignmentAction(action: Align2DActionId): void {
    void this.commandDispatcher.execute(align2DNodes(action)).then(didMutate => {
      if (didMutate) {
        this.viewportRenderer.requestRender();
      }
    });
  }

  private toggleGrid(): void {
    void this.commandDispatcher.executeById('view.toggle-grid');
  }

  private toggleSnapToGrid(): void {
    void this.commandDispatcher.executeById('view.toggle-snap-to-grid');
  }

  private toggleLayer2D(): void {
    void this.commandDispatcher.executeById('view.toggle-layer-2d');
  }

  private toggleLayer3D(): void {
    void this.commandDispatcher.executeById('view.toggle-layer-3d');
  }

  private toggleLighting(): void {
    void this.commandDispatcher.executeById('view.toggle-lighting');
  }

  private toggleNavigationMode(): void {
    const command = toggleNavigationMode();
    this.commandDispatcher.execute(command);
  }

  private zoomIn(): void {
    void this.commandDispatcher.executeById('view.zoom-in');
  }

  private zoomOut(): void {
    void this.commandDispatcher.executeById('view.zoom-out');
  }

  private handlePreviewCameraSelect(itemId: string): void {
    const cameraNodeId = itemId === 'hide' ? null : itemId;
    void this.commandDispatcher.execute(setPreviewCamera(cameraNodeId)).then(() => {
      this.viewportRenderer.updateSelection();
      this.viewportRenderer.requestRender();
    });
  }

  private setEditorCameraProjection(projection: EditorCameraProjection): void {
    void this.commandDispatcher.execute(setEditorCameraProjection(projection)).then(() => {
      this.viewportRenderer.requestRender();
    });
  }

  private getPreviewCameraDropdownState(): {
    items: Array<{ id: string; label: string }>;
    label: string;
    isActive: boolean;
  } {
    const activeSceneId = appState.scenes.activeSceneId;
    const selectedCameraNodeId = activeSceneId
      ? (appState.scenes.previewCameraNodeIds[activeSceneId] ?? null)
      : null;
    const items = [{ id: 'hide', label: selectedCameraNodeId === null ? 'Hide (Active)' : 'Hide' }];

    if (!activeSceneId) {
      return {
        items,
        label: 'Hide',
        isActive: false,
      };
    }

    const sceneGraph = this.sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) {
      return {
        items,
        label: 'Hide',
        isActive: false,
      };
    }

    const cameras = this.collectCameraNodes(sceneGraph.rootNodes);
    for (const camera of cameras) {
      const cameraLabel = camera.name || camera.nodeId;
      items.push({
        id: camera.nodeId,
        label: camera.nodeId === selectedCameraNodeId ? `${cameraLabel} (Active)` : cameraLabel,
      });
    }

    const selectedCamera = selectedCameraNodeId
      ? (cameras.find(camera => camera.nodeId === selectedCameraNodeId) ?? null)
      : null;

    return {
      items,
      label: selectedCamera?.name || 'Hide',
      isActive: selectedCamera !== null,
    };
  }

  private collectCameraNodes(nodes: NodeBase[]): Camera3D[] {
    const cameras: Camera3D[] = [];

    for (const node of nodes) {
      if (node instanceof Camera3D) {
        cameras.push(node);
      }

      if (node.children.length > 0) {
        cameras.push(...this.collectCameraNodes(node.children));
      }
    }

    return cameras;
  }

  private zoomAll(): void {
    void this.commandDispatcher.executeById('view.zoom-all');
  }

  private handleWheel = (event: WheelEvent): void => {
    if (appState.tabs.activeTabId !== this.tabId) {
      return;
    }
    this.navigation2D.handleWheel(event);
  };

  private handleCanvasPointerDown = (event: PointerEvent): void => {
    if (appState.tabs.activeTabId !== this.tabId) return;

    const isToolbar = this.isToolbarInteraction(event);
    if (isToolbar) return;

    this.focusViewportRegion();

    const canvas = this.viewportRenderer.getCanvasElement();
    const rect = canvas?.getBoundingClientRect() ?? this.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    const handleType = this.viewportRenderer.get2DHandleAt?.(screenX, screenY) ?? 'idle';
    const isSelectionModifier = event.ctrlKey || event.metaKey;
    this.clearMarqueeSelection();
    const shouldStartSingleTouchPan =
      event.pointerType === 'touch' &&
      this.shouldStartSingleTouchPan(handleType, screenX, screenY, canvas, rect);

    if (event.pointerType === 'touch' && appState.ui.navigationMode === '2d') {
      this.capturePointerSafely(event.pointerId);

      if (
        this.singleTouchPanPointerId !== null &&
        this.singleTouchPanPointerId !== event.pointerId
      ) {
        this.navigation2D.endPan();
        this.singleTouchPanPointerId = null;
      }

      if (!this.viewportRenderer.has2DTransform?.()) {
        this.navigation2D.startTouchPointer(event.pointerId, screenX, screenY);
      }

      if (this.navigation2D.isTouchGestureActive()) {
        this.navigation2D.endPan();
        this.singleTouchPanPointerId = null;
        this.touchGestureInProgress = true;
        this.clearPointerInteraction();
        this.isDragging = true;
        return;
      }
    }

    // Handle right-click pan in 2D mode
    if (event.button === 2 && appState.ui.navigationMode === '2d') {
      this.navigation2D.startPan(event.pointerId, screenX, screenY);
      this.isDragging = true;
      return;
    }

    if (handleType && handleType !== 'idle' && !isSelectionModifier) {
      this.viewportRenderer.start2DTransform?.(screenX, screenY, handleType);
      this.pointerDownPos = { x: event.clientX, y: event.clientY };
      this.pointerDownTime = Date.now();
      this.isDragging = true;
      return;
    }

    if (shouldStartSingleTouchPan) {
      this.navigation2D.startPan(event.pointerId, screenX, screenY);
      this.singleTouchPanPointerId = event.pointerId;
    } else if (event.pointerType === 'touch') {
      this.singleTouchPanPointerId = null;
    }

    this.pointerDownPos = { x: event.clientX, y: event.clientY };
    this.pointerDownTime = Date.now();
    this.marqueeSelectionStart = this.shouldStartMarqueeSelection(
      event,
      handleType,
      screenX,
      screenY
    )
      ? { x: screenX, y: screenY }
      : undefined;
    this.isDragging = false;
  };

  private focusViewportRegion(): void {
    const panelElement = this.renderRoot.querySelector<HTMLElement>('.panel');
    panelElement?.focus({ preventScroll: true });
    appState.editorContext.focusedArea = 'viewport';
  }

  private handleCanvasPointerMove = (event: PointerEvent): void => {
    if (appState.tabs.activeTabId !== this.tabId) return;

    const canvas = this.viewportRenderer.getCanvasElement();
    const rect = canvas?.getBoundingClientRect() ?? this.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    if (
      event.pointerType === 'touch' &&
      appState.ui.navigationMode === '2d' &&
      this.navigation2D.isTouchPointerTracked(event.pointerId)
    ) {
      const didUpdateGesture = this.navigation2D.updateTouchPointer(
        event.pointerId,
        screenX,
        screenY
      );
      if (didUpdateGesture) {
        this.touchGestureInProgress = true;
        this.clearPointerInteraction();
        this.isDragging = true;
        return;
      }

      if (this.touchGestureInProgress || this.navigation2D.isTouchGestureActive()) {
        return;
      }
    }

    if (
      event.pointerType === 'touch' &&
      appState.ui.navigationMode === '2d' &&
      this.singleTouchPanPointerId === event.pointerId
    ) {
      const dx = event.clientX - (this.pointerDownPos?.x ?? event.clientX);
      const dy = event.clientY - (this.pointerDownPos?.y ?? event.clientY);
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > this.dragThreshold) {
        this.navigation2D.updateTouchPan(screenX, screenY);
        this.isDragging = true;
      }
      return;
    }

    // Handle right-click pan in 2D mode
    if (event.buttons === 2 && appState.ui.navigationMode === '2d') {
      this.navigation2D.updatePan(screenX, screenY);
      this.isDragging = true;
      return;
    }

    if (!this.pointerDownPos || !this.pointerDownTime) {
      this.viewportRenderer.updateHandleHover?.(screenX, screenY);
      this.viewportRenderer.update2DHoverPreview?.(screenX, screenY);
      return;
    }

    const has2DTransform = this.viewportRenderer.has2DTransform?.();
    if (has2DTransform) {
      this.viewportRenderer.update2DTransform?.(screenX, screenY, {
        preserveAspectRatio: event.shiftKey,
        constrainMoveToAxis: event.shiftKey,
        snapRotation: event.shiftKey,
        // Hold Alt to temporarily invert the persistent snap setting.
        snapToGrid: appState.ui.snapToGrid !== event.altKey,
        gridSize: appState.ui.grid2DSize,
      });
      this.isDragging = true;
      return;
    }

    const dx = event.clientX - this.pointerDownPos.x;
    const dy = event.clientY - this.pointerDownPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (this.marqueeSelectionStart && appState.ui.navigationMode === '2d') {
      if (distance > this.dragThreshold) {
        const marqueeSelectionRect = this.createMarqueeSelectionRect(this.marqueeSelectionStart, {
          x: screenX,
          y: screenY,
        });
        this.marqueeSelectionRect = marqueeSelectionRect;
        this.updateMarqueeSelectionPreview(
          this.viewportRenderer.getSelectable2DNodeIdsInScreenRect(
            marqueeSelectionRect.left,
            marqueeSelectionRect.top,
            marqueeSelectionRect.left + marqueeSelectionRect.width,
            marqueeSelectionRect.top + marqueeSelectionRect.height
          )
        );
        this.isDragging = true;
      } else {
        this.marqueeSelectionRect = undefined;
        this.clearMarqueeSelectionPreview();
      }
      return;
    }

    if (distance > this.dragThreshold) {
      this.isDragging = true;
    }
  };

  private handleCanvasPointerUp = (event: PointerEvent): void => {
    if (appState.tabs.activeTabId !== this.tabId) return;

    if (event.pointerType === 'touch') {
      this.releasePointerSafely(event.pointerId);

      if (this.singleTouchPanPointerId === event.pointerId) {
        this.navigation2D.endPan();
        this.singleTouchPanPointerId = null;
      }

      const touchGestureWasActive =
        this.touchGestureInProgress || this.navigation2D.isTouchGestureActive();
      const hadTrackedTouch = this.navigation2D.endTouchPointer(event.pointerId);

      if (touchGestureWasActive) {
        this.clearPointerInteraction();
        this.touchGestureInProgress = this.navigation2D.isTouchGestureActive();
        return;
      }

      if (hadTrackedTouch && this.navigation2D.isTouchGestureActive()) {
        this.touchGestureInProgress = true;
        this.clearPointerInteraction();
        return;
      }
    }

    // End right-click pan if active
    if (event.button === 2 && appState.ui.navigationMode === '2d') {
      this.navigation2D.endPan();
    }

    const isToolbar = this.isToolbarInteraction(event);
    if (isToolbar) {
      this.pointerDownPos = undefined;
      this.pointerDownTime = undefined;
      this.isDragging = false;
      return;
    }

    const has2DTransform = this.viewportRenderer.has2DTransform?.();
    if (has2DTransform) {
      this.viewportRenderer.complete2DTransform?.();
      this.pointerDownPos = undefined;
      this.pointerDownTime = undefined;
      this.isDragging = false;
      return;
    }

    const canvas = this.viewportRenderer.getCanvasElement();
    if (!canvas) {
      this.clearPointerInteraction();
      return;
    }

    const marqueeSelectionRect = this.marqueeSelectionRect;
    if (marqueeSelectionRect) {
      void this.commandDispatcher.execute(selectObjects(this.marqueeSelectionNodeIds));
      this.clearPointerInteraction();
      return;
    }

    if (!this.isDragging) {
      const rect = canvas.getBoundingClientRect();
      const canvasWidth = rect.width;
      const canvasHeight = rect.height;
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const normalizedX = pointerX / canvasWidth;
      const normalizedY = pointerY / canvasHeight;

      const hitNode = this.viewportRenderer.raycastObject(normalizedX, normalizedY);
      if (hitNode) {
        const command =
          event.ctrlKey || event.metaKey
            ? toggleObjectSelection(hitNode.nodeId)
            : selectObject(hitNode.nodeId);
        void this.commandDispatcher.execute(command);
      } else if (!(event.ctrlKey || event.metaKey)) {
        const command = selectObject(null);
        void this.commandDispatcher.execute(command);
      }
    }

    this.clearPointerInteraction();
  };

  private handleCanvasPointerCancel = (event: PointerEvent): void => {
    if (appState.tabs.activeTabId !== this.tabId) return;

    if (event.pointerType === 'touch') {
      this.releasePointerSafely(event.pointerId);
      if (this.singleTouchPanPointerId === event.pointerId) {
        this.navigation2D.endPan();
        this.singleTouchPanPointerId = null;
      }
      this.navigation2D.endTouchPointer(event.pointerId);
      this.touchGestureInProgress = this.navigation2D.isTouchGestureActive();
    }

    if (event.button === 2 && appState.ui.navigationMode === '2d') {
      this.navigation2D.endPan();
    }

    this.clearPointerInteraction();
  };

  private clearPointerInteraction(): void {
    this.pointerDownPos = undefined;
    this.pointerDownTime = undefined;
    this.isDragging = false;
    this.clearMarqueeSelection();
  }

  private clearMarqueeSelection(): void {
    this.marqueeSelectionStart = undefined;
    this.marqueeSelectionRect = undefined;
    this.clearMarqueeSelectionPreview();
  }

  private updateMarqueeSelectionPreview(nodeIds: string[]): void {
    this.marqueeSelectionNodeIds = nodeIds;
    const didChange = this.viewportRenderer.set2DMarqueePreviewNodeIds?.(nodeIds) ?? false;
    if (didChange) {
      this.viewportRenderer.requestRender();
    }
  }

  private clearMarqueeSelectionPreview(): void {
    this.marqueeSelectionNodeIds = [];
    const didChange = this.viewportRenderer.clear2DMarqueePreview?.() ?? false;
    if (didChange) {
      this.viewportRenderer.requestRender();
    }
  }

  private shouldStartMarqueeSelection(
    event: PointerEvent,
    handleType: string,
    screenX: number,
    screenY: number
  ): boolean {
    if (
      appState.ui.navigationMode !== '2d' ||
      event.pointerType === 'touch' ||
      event.button !== 0 ||
      handleType !== 'idle'
    ) {
      return false;
    }

    const normalizedPoint = this.getViewportNormalizedPoint({ x: screenX, y: screenY });
    if (!normalizedPoint) {
      return false;
    }

    return this.viewportRenderer.raycastObject(normalizedPoint.x, normalizedPoint.y) === null;
  }

  private createMarqueeSelectionRect(
    start: { x: number; y: number },
    end: { x: number; y: number }
  ): { left: number; top: number; width: number; height: number } {
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);

    return { left, top, width, height };
  }

  private getMarqueeSelectionStyle(rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  }): string {
    return `left: ${rect.left}px; top: ${rect.top}px; width: ${rect.width}px; height: ${rect.height}px;`;
  }

  private isToolbarInteraction(event: PointerEvent): boolean {
    return event
      .composedPath()
      .some(
        el =>
          el instanceof HTMLElement &&
          (el.classList.contains('top-toolbar') ||
            el.classList.contains('transform-overlay') ||
            el.classList.contains('transform-overlay-shell') ||
            el.classList.contains('zoom-overlay') ||
            el.classList.contains('zoom-overlay-shell') ||
            el.classList.contains('toolbar-group') ||
            el.classList.contains('toolbar-button') ||
            el.classList.contains('toolbar-dropdown-button'))
      );
  }

  private shouldStartSingleTouchPan(
    handleType: string,
    screenX: number,
    screenY: number,
    canvas: HTMLCanvasElement | undefined,
    rect: DOMRect
  ): boolean {
    if (appState.ui.navigationMode !== '2d' || handleType !== 'idle') {
      return false;
    }

    if (appState.selection.nodeIds.length === 0) {
      return true;
    }

    if (!canvas || rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    const hitNode = this.viewportRenderer.raycastObject(
      screenX / rect.width,
      screenY / rect.height
    );
    return !hitNode;
  }

  private capturePointerSafely(pointerId: number): void {
    try {
      this.setPointerCapture(pointerId);
    } catch {
      // Ignore browsers that reject capture during synthetic or retargeted events.
    }
  }

  private releasePointerSafely(pointerId: number): void {
    try {
      if (this.hasPointerCapture(pointerId)) {
        this.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore capture cleanup failures.
    }
  }

  static styles = css`
    ${unsafeCSS(styles)}
    ${unsafeCSS(dropdownButtonStyles)}
    ${unsafeCSS(visibilityPopoverStyles)}
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-editor-tab': EditorTabComponent;
  }
}
