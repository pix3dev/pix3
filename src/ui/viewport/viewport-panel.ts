import { ComponentBase, customElement, html, inject, subscribe, state, css, unsafeCSS } from '@/fw';
import { appState, type EditorCameraProjection } from '@/state';
import styles from './viewport-panel.ts.css?raw';
import dropdownButtonStyles from '@/ui/shared/pix3-dropdown-button.ts.css?raw';
import visibilityPopoverStyles from './viewport-visibility-popover.ts.css?raw';
import { ViewportRendererService, type TransformMode } from '@/services/ViewportRenderService';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { IconService } from '@/services/IconService';
import { Navigation2DController } from '@/services/Navigation2DController';
import { SceneManager, Camera3D, Node2D, NodeBase } from '@pix3/runtime';
import { selectObject } from '@/features/selection/SelectObjectCommand';
import { CreatePrefabInstanceCommand } from '@/features/scene/CreatePrefabInstanceCommand';
import { CreateSprite2DCommand } from '@/features/scene/CreateSprite2DCommand';
import { toggleNavigationMode } from '@/features/viewport/ToggleNavigationModeCommand';
import { setEditorCameraProjection } from '@/features/viewport/SetEditorCameraProjectionCommand';
import { setPreviewCamera } from '@/features/viewport/SetPreviewCameraCommand';
import { align2DNodes } from '@/features/alignment/Align2DNodesCommand';
import type { Align2DActionId } from '@/features/alignment/types';
import { renderViewportToolbar } from './viewport-toolbar';
import '../shared/pix3-dropdown-button';
import './viewport-visibility-popover';

@customElement('pix3-viewport-panel')
export class ViewportPanel extends ComponentBase {
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

  @state()
  private transformMode: TransformMode = 'select';

  @state()
  private showGrid = false;

  @state()
  private showLayer2D = false;

  @state()
  private showLayer3D = false;

  @state()
  private showLighting = false;

  @state()
  private navigationMode = appState.ui.navigationMode;

  @state()
  private editorCameraProjection: EditorCameraProjection = appState.ui.editorCameraProjection;

  private readonly resizeObserver = new ResizeObserver(entries => {
    const entry = entries[0];
    if (!entry) {
      return;
    }
    const { width, height } = entry.contentRect;
    if (width <= 0 || height <= 0) {
      return;
    }
    // Observe the host container size (may be different from canvas CSS size when splitters
    // or layout managers change dimensions). Forward the measured size to the renderer.
    this.viewportRenderer.resize(width, height);
  });

  private canvas?: HTMLCanvasElement;
  private disposeSceneSubscription?: () => void;
  private disposeUiSubscription?: () => void;
  private disposeSelectionSubscription?: () => void;
  private pointerDownPos?: { x: number; y: number };
  private pointerDownTime?: number;
  private isDragging = false;
  private readonly dragThreshold = 5; // pixels
  private isAssetDragOver = false;
  @state()
  private has2DSelection = false;

  @state()
  private canAlignToContainer = false;

  @state()
  private canAlignToSelectionBounds = false;

  @state()
  private canDistributeSelection = false;

  private static readonly ASSET_RESOURCE_MIME = 'application/x-pix3-asset-resource';
  private static readonly ASSET_PATH_MIME = 'application/x-pix3-asset-path';
  private static readonly IMAGE_EXTENSIONS = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'bmp',
    'svg',
    'tif',
    'tiff',
    'avif',
  ]);

  // Gesture tracking for 2D navigation
  // Note: We handle wheel events directly without accumulation to ensure responsive
  // 1:1 panning with trackpad gestures which provide their own inertia.

  connectedCallback() {
    super.connectedCallback();
    // ResizeObserver will be set up in firstUpdated when host element is available
    this.disposeSceneSubscription = subscribe(appState.scenes, () => {
      this.syncViewportScene();
      this.syncAlignmentToolbarState();
      this.requestUpdate();
    });
    this.syncViewportScene();
    this.syncAlignmentToolbarState();

    // Initialize state from current appState values
    this.showGrid = appState.ui.showGrid;
    this.showLayer2D = appState.ui.showLayer2D;
    this.showLayer3D = appState.ui.showLayer3D;
    this.showLighting = appState.ui.showLighting;
    this.navigationMode = appState.ui.navigationMode;
    this.editorCameraProjection = appState.ui.editorCameraProjection;

    this.disposeUiSubscription = subscribe(appState.ui, () => {
      this.showGrid = appState.ui.showGrid;
      this.showLayer2D = appState.ui.showLayer2D;
      this.showLayer3D = appState.ui.showLayer3D;
      this.showLighting = appState.ui.showLighting;
      this.navigationMode = appState.ui.navigationMode;
      this.editorCameraProjection = appState.ui.editorCameraProjection;
      this.requestUpdate();
    });

    this.disposeSelectionSubscription = subscribe(appState.selection, () => {
      this.syncAlignmentToolbarState();
      this.requestUpdate();
    });

    // Track focus for context-aware shortcuts
    this.addEventListener('focusin', () => {
      appState.editorContext.focusedArea = 'viewport';
    });

    // Add pointer handlers for object selection (only on tap/click, not drag)
    this.addEventListener('pointerdown', this.handleCanvasPointerDown);
    this.addEventListener('pointermove', this.handleCanvasPointerMove);
    this.addEventListener('pointerup', this.handleCanvasPointerUp);
    this.addEventListener('pointerleave', this.handleCanvasPointerLeave);
    this.addEventListener('dragover', this.handleDragOver);
    this.addEventListener('drop', this.handleDrop);
    this.addEventListener('dragleave', this.handleDragLeave);
  }

  disconnectedCallback() {
    this.viewportRenderer.pause(); // Pause instead of full dispose to handle moves
    super.disconnectedCallback();
    this.resizeObserver.disconnect();
    this.disposeSceneSubscription?.();
    this.disposeSceneSubscription = undefined;
    this.disposeUiSubscription?.();
    this.disposeUiSubscription = undefined;
    this.disposeSelectionSubscription?.();
    this.disposeSelectionSubscription = undefined;
    this.removeEventListener('pointerdown', this.handleCanvasPointerDown);
    this.removeEventListener('pointermove', this.handleCanvasPointerMove);
    this.removeEventListener('pointerup', this.handleCanvasPointerUp);
    this.removeEventListener('pointerleave', this.handleCanvasPointerLeave);
    this.removeEventListener('dragover', this.handleDragOver);
    this.removeEventListener('drop', this.handleDrop);
    this.removeEventListener('dragleave', this.handleDragLeave);
    this.pointerDownPos = undefined;
    this.pointerDownTime = undefined;
    this.isDragging = false;
  }

  protected firstUpdated(): void {
    this.canvas = this.renderRoot.querySelector<HTMLCanvasElement>('.viewport-canvas') ?? undefined;
    if (!this.canvas) {
      console.warn('[ViewportPanel] Missing canvas element for renderer initialization.');
      return;
    }

    // Observe the component host (the element itself) instead of the canvas. When the
    // surrounding layout (Golden Layout splitters or window resizes) changes the host
    // bounding rect, we want to update the renderer to match the visible area.
    try {
      this.resizeObserver.observe(this);
    } catch {
      // Fallback to observing the canvas if observing the host fails in some environments.
      this.resizeObserver.observe(this.canvas);
    }

    this.viewportRenderer.initialize(this.canvas);
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.viewportRenderer.resize(rect.width, rect.height);
    }

    // Sync scene after renderer is fully initialized
    this.syncViewportScene();
  }

  protected render() {
    const {
      items: previewCameraItems,
      label: previewCameraLabel,
      isActive: isPreviewCameraActive,
    } = this.getPreviewCameraDropdownState();

    return html`
      <section
        class="panel ${this.isAssetDragOver ? 'panel--asset-dragover' : ''}"
        role="region"
        aria-label="Scene viewport"
        tabindex="0"
      >
        <div class="viewport-toolbar-shell">
          ${renderViewportToolbar(
            {
              transformMode: this.transformMode,
              showGrid: this.showGrid,
              showLighting: this.showLighting,
              navigationMode: this.navigationMode,
              showLayer3D: this.showLayer3D,
              showLayer2D: this.showLayer2D,
              previewCameraLabel,
              previewCameraItems,
              isPreviewCameraActive,
              editorCameraProjection: this.editorCameraProjection,
              showAlignmentTools: this.has2DSelection,
              canAlignToContainer: this.canAlignToContainer,
              canAlignToSelectionBounds: this.canAlignToSelectionBounds,
              canDistributeSelection: this.canDistributeSelection,
            },
            {
              onTransformModeChange: m => this.handleTransformModeChange(m),
              onToggleNavigationMode: () => this.toggleNavigationMode(),
              onZoomDefault: () => this.zoomDefault(),
              onZoomAll: () => this.zoomAll(),
              onSelectPreviewCamera: itemId => this.handlePreviewCameraSelect(itemId),
              onToggleGrid: () => this.toggleGrid(),
              onToggleLighting: () => this.toggleLighting(),
              onToggleLayer3D: () => this.toggleLayer3D(),
              onToggleLayer2D: () => this.toggleLayer2D(),
              onSetEditorCameraProjection: projection => this.setEditorCameraProjection(projection),
              onRunAlignmentAction: action => this.handleAlignmentAction(action),
            },
            this.iconService
          )}
        </div>
        <canvas class="viewport-canvas" part="canvas" aria-hidden="true"></canvas>
      </section>
    `;
  }

  private handleDragOver = (event: DragEvent): void => {
    const resourcePath = this.getDroppedResourcePath(event.dataTransfer ?? null);
    if (!resourcePath) {
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
    const resourcePath = this.getDroppedResourcePath(event.dataTransfer ?? null);
    this.isAssetDragOver = false;
    if (!resourcePath) {
      return;
    }

    event.preventDefault();
    if (this.isPrefabResource(resourcePath)) {
      const command = new CreatePrefabInstanceCommand({
        prefabPath: resourcePath,
      });
      void this.commandDispatcher.execute(command);
      return;
    }

    if (this.isImageResource(resourcePath)) {
      const command = new CreateSprite2DCommand({
        texturePath: resourcePath,
        spriteName: this.deriveSpriteName(resourcePath),
      });
      void this.commandDispatcher.execute(command);
    }
  };

  private getDroppedResourcePath(dataTransfer: DataTransfer | null): string | null {
    if (!dataTransfer) {
      return null;
    }

    const fromResource = dataTransfer.getData(ViewportPanel.ASSET_RESOURCE_MIME);
    const fromPath = dataTransfer.getData(ViewportPanel.ASSET_PATH_MIME);
    const plain = dataTransfer.getData('text/plain');
    const raw = fromResource || fromPath || plain;
    if (!raw) {
      return null;
    }

    const normalized = raw.trim().replace(/\\/g, '/');
    const resourcePath = normalized.startsWith('res://')
      ? normalized
      : `res://${normalized.replace(/^\/+/, '')}`;

    if (!this.isPrefabResource(resourcePath) && !this.isImageResource(resourcePath)) {
      return null;
    }

    return resourcePath;
  }

  private isPrefabResource(resourcePath: string): boolean {
    return resourcePath.toLowerCase().endsWith('.pix3scene');
  }

  private isImageResource(resourcePath: string): boolean {
    const normalized = resourcePath.toLowerCase().split('?')[0].split('#')[0];
    const extension = normalized.includes('.') ? (normalized.split('.').pop() ?? '') : '';
    return ViewportPanel.IMAGE_EXTENSIONS.has(extension);
  }

  private deriveSpriteName(resourcePath: string): string {
    const normalized = resourcePath.replace(/\\/g, '/');
    const fileName = normalized.split('/').pop() ?? 'Sprite2D';
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex <= 0) {
      return fileName || 'Sprite2D';
    }
    return fileName.slice(0, dotIndex) || 'Sprite2D';
  }

  private syncViewportScene(): void {
    // Renderer now auto-attaches active scene via subscription; nothing to do here
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
    const canAlignToContainer =
      sharesParent && (sharedParent === null || sharedParent instanceof Node2D);

    this.has2DSelection = true;
    this.canAlignToContainer = canAlignToContainer;
    this.canAlignToSelectionBounds = selected2DNodes.length > 1;
    this.canDistributeSelection = selected2DNodes.length > 2;
  }

  private handleAlignmentAction(action: Align2DActionId): void {
    void this.commandDispatcher.execute(align2DNodes(action)).then(didMutate => {
      if (didMutate) {
        this.viewportRenderer.requestRender();
      }
    });
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

  private handleTransformModeChange(mode: TransformMode): void {
    this.transformMode = mode;
    this.viewportRenderer.setTransformMode(mode);
  }

  private toggleGrid(): void {
    void this.commandDispatcher.executeById('view.toggle-grid');
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
    void this.commandDispatcher.execute(toggleNavigationMode());
  }

  private zoomDefault(): void {
    void this.commandDispatcher.executeById('view.zoom-default');
  }

  private zoomAll(): void {
    void this.commandDispatcher.executeById('view.zoom-all');
  }

  private handleCanvasPointerDown = (event: PointerEvent): void => {
    // Ignore pointer events from toolbar
    const isToolbar = event
      .composedPath()
      .some(
        el =>
          el instanceof HTMLElement &&
          (el.classList.contains('top-toolbar') || el.classList.contains('toolbar-button'))
      );
    if (isToolbar) {
      return;
    }

    const isCanvasTarget = (event.target as HTMLElement)?.classList?.contains('viewport-canvas');
    if (event.target !== this && !isCanvasTarget) {
      return;
    }

    // Handle right-click pan in 2D mode
    if (event.button === 2 && appState.ui.navigationMode === '2d') {
      const rect = this.canvas?.getBoundingClientRect() ?? this.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      this.navigation2D.startPan(event.pointerId, screenX, screenY);
      this.isDragging = true;
      return;
    }

    // Use canvas rect, not panel rect, since canvas is offset by toolbar
    const rect = this.canvas?.getBoundingClientRect() ?? this.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    const handleType = this.viewportRenderer.get2DHandleAt?.(screenX, screenY);
    if (handleType && handleType !== 'idle') {
      // Start 2D transform (move, scale, or rotate)
      this.viewportRenderer.start2DTransform?.(screenX, screenY, handleType);
      this.pointerDownPos = { x: event.clientX, y: event.clientY };
      this.pointerDownTime = Date.now();
      this.isDragging = true;
      return;
    }

    // Record the position and time for drag detection
    this.pointerDownPos = { x: event.clientX, y: event.clientY };
    this.pointerDownTime = Date.now();
    this.isDragging = false;
  };

  private handleCanvasPointerMove = (event: PointerEvent): void => {
    // Get screen coordinates relative to canvas
    const rect = this.canvas?.getBoundingClientRect() ?? this.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    // Handle right-click pan in 2D mode
    if (event.buttons === 2 && appState.ui.navigationMode === '2d') {
      this.navigation2D.updatePan(screenX, screenY);
      this.isDragging = true;
      return;
    }

    // Always update hover states for visual feedback (even without pointer down)
    if (!this.pointerDownPos || !this.pointerDownTime) {
      // Update handle hover for selection overlay
      this.viewportRenderer.updateHandleHover?.(screenX, screenY);
      // Update 2D hover preview (shows frame around hovered node before selection)
      this.viewportRenderer.update2DHoverPreview?.(screenX, screenY);
      return;
    }

    // Handle 2D transform updates when a 2D handle is engaged
    const has2DTransform = this.viewportRenderer.has2DTransform?.();
    if (has2DTransform) {
      this.viewportRenderer.update2DTransform?.(screenX, screenY, {
        preserveAspectRatio: event.shiftKey,
        constrainMoveToAxis: event.shiftKey,
      });
      this.isDragging = true;
      return;
    }

    // Calculate distance moved since pointer down
    const dx = event.clientX - this.pointerDownPos.x;
    const dy = event.clientY - this.pointerDownPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // If distance exceeds threshold, mark as dragging (camera manipulation)
    if (distance > this.dragThreshold) {
      this.isDragging = true;
    }
  };

  private handleCanvasPointerUp = (event: PointerEvent): void => {
    // End right-click pan if active
    if (event.button === 2 && appState.ui.navigationMode === '2d') {
      this.navigation2D.endPan();
    }

    // Ignore pointer events from toolbar
    const isToolbar = event
      .composedPath()
      .some(
        el =>
          el instanceof HTMLElement &&
          (el.classList.contains('top-toolbar') || el.classList.contains('toolbar-button'))
      );
    if (isToolbar) {
      this.pointerDownPos = undefined;
      this.pointerDownTime = undefined;
      this.isDragging = false;
      return;
    }

    const isCanvasTarget = (event.target as HTMLElement)?.classList?.contains('viewport-canvas');
    if (event.target !== this && !isCanvasTarget) {
      return;
    }

    // Complete 2D transform if active
    const has2DTransform = this.viewportRenderer.has2DTransform?.();
    if (has2DTransform) {
      this.viewportRenderer.complete2DTransform?.();
      this.pointerDownPos = undefined;
      this.pointerDownTime = undefined;
      this.isDragging = false;
      return;
    }

    if (!this.canvas) {
      this.pointerDownPos = undefined;
      this.pointerDownTime = undefined;
      this.isDragging = false;
      return;
    }

    // Only select if this was a tap (not a drag)
    if (!this.isDragging) {
      // Get canvas position and dimensions
      const rect = this.canvas.getBoundingClientRect();
      const canvasWidth = rect.width;
      const canvasHeight = rect.height;

      // Convert pointer event coordinates to canvas-relative coordinates
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;

      // Normalize to 0-1 range
      const normalizedX = pointerX / canvasWidth;
      const normalizedY = pointerY / canvasHeight;

      // Raycast to find object under pointer
      const hitNode = this.viewportRenderer.raycastObject(normalizedX, normalizedY);

      if (hitNode) {
        // Dispatch SelectObjectCommand with the hit node
        const command = selectObject(hitNode.nodeId);
        this.commandDispatcher.execute(command);
      } else {
        // Pointer up on empty space - deselect all
        const command = selectObject(null);
        this.commandDispatcher.execute(command);
      }
    }

    // Clean up pointer tracking
    this.pointerDownPos = undefined;
    this.pointerDownTime = undefined;
    this.isDragging = false;
  };

  private handleCanvasPointerLeave = (): void => {
    // Clear handle hover state when cursor leaves viewport
    this.viewportRenderer.clearHandleHover?.();
    // Clear 2D hover preview
    this.viewportRenderer.clear2DHoverPreview?.();
  };

  static styles = css`
    ${unsafeCSS(styles)}
    ${unsafeCSS(dropdownButtonStyles)}
    ${unsafeCSS(visibilityPopoverStyles)}
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-viewport-panel': ViewportPanel;
  }
}
