import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { AnimationAutoSliceDialogService } from '@/services/animation/AnimationAutoSliceDialogService';
import { AnimationEditorService } from '@/services/animation/AnimationEditorService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { DialogService } from '@/services/editor/DialogService';
import { IconService } from '@/services/editor/IconService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { OperationService } from '@/services/core/OperationService';
import {
  StageZoomPanController,
  type StagePoint,
  type StageViewport,
} from '@/ui/shared/stage-zoom-pan';
import { AnimationDocumentController } from '@/ui/sprite-editor/animation-document-controller';
import {
  getDroppedImageFiles,
  getDroppedTextureResources,
  isPotentialTextureDrag,
} from '@/ui/sprite-editor/frame-texture-drop';
import {
  FrameOverlayController,
  renderAnchorOverlay,
  renderBboxOverlay,
  renderPointsOverlay,
  renderPolygonOverlay,
} from '@/ui/sprite-editor/frame-stage-overlays';
import { getFrameImageStyle } from '@/ui/sprite-editor/sprite-timeline';
import '@/ui/sprite-editor/sprite-clips-rail';
import {
  SceneManager,
  collectClipPointNames,
  findAnimationFramePoint,
  type AnimationClip,
  type AnimationFrame,
} from '@pix3/runtime';

import './animation-panel.ts.css';

interface AnchorPreset {
  label: string;
  title: string;
  anchor: StagePoint;
}

const ANCHOR_PRESETS: readonly AnchorPreset[] = [
  { label: '↖', title: 'Top left', anchor: { x: 0, y: 0 } },
  { label: '↑', title: 'Top center', anchor: { x: 0.5, y: 0 } },
  { label: '↗', title: 'Top right', anchor: { x: 1, y: 0 } },
  { label: '←', title: 'Center left', anchor: { x: 0, y: 0.5 } },
  { label: '•', title: 'Center', anchor: { x: 0.5, y: 0.5 } },
  { label: '→', title: 'Center right', anchor: { x: 1, y: 0.5 } },
  { label: '↙', title: 'Bottom left', anchor: { x: 0, y: 1 } },
  { label: '↓', title: 'Bottom center', anchor: { x: 0.5, y: 1 } },
  { label: '↘', title: 'Bottom right', anchor: { x: 1, y: 1 } },
];

/**
 * Render host for the animation editor. The document itself — clips, frames,
 * selection, the preview transport and every mutation — lives in
 * {@link AnimationDocumentController}, and the frame strip (cards, reorder,
 * transport, playback clock) in `<pix3-sprite-timeline>`; what is left here is
 * the stage markup and its pointer/drag machinery.
 */
@customElement('pix3-animation-panel')
export class AnimationPanel extends ComponentBase {
  @property({ type: String, reflect: true, attribute: 'tab-id' })
  tabId = '';

  @property({ type: String, attribute: 'resource-path' })
  resourcePath = '';

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(ProjectStorageService)
  private readonly projectStorage!: ProjectStorageService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(OperationService)
  private readonly operations!: OperationService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(AnimationAutoSliceDialogService)
  private readonly animationAutoSliceDialogService!: AnimationAutoSliceDialogService;

  @inject(AnimationEditorService)
  private readonly animationEditorService!: AnimationEditorService;

  @inject(IconService)
  private readonly iconService!: IconService;

  @state()
  private isTextureDragOver = false;

  @state()
  /**
   * Zoom/pan of the frame stage. Shared with the Sprite Editor's canvas so both
   * surfaces agree on wheel-zoom-to-cursor and pan feel (`src/ui/shared/`).
   */
  private readonly stageView = new StageZoomPanController({
    minZoom: 0.1,
    maxZoom: 16,
    onChange: () => this.requestUpdate(),
  });

  /**
   * Stage overlays (anchor / bbox / polygon / points) and their pointer state
   * machine. Coordinates cross this boundary in frame-pixel space only — the
   * stage's own DOM model stays in {@link toFramePoint} below.
   */
  private readonly overlays = new FrameOverlayController({
    getDocument: () => this.controller,
    toFramePoint: event => this.toFramePoint(event),
  });

  private documentController: AnimationDocumentController | null = null;
  private disposeControllerSubscription?: () => void;
  private disposeOverlaySubscription?: () => void;
  private textureDragDepth = 0;

  /**
   * Created on first use rather than in the constructor: `@inject` is a prototype
   * accessor that resolves through the container on read, so the deps object must
   * not be built before the container is ready (or before a spec has swapped a
   * service out).
   */
  private get controller(): AnimationDocumentController {
    if (!this.documentController) {
      this.documentController = new AnimationDocumentController(
        {
          operations: this.operations,
          commandDispatcher: this.commandDispatcher,
          projectStorage: this.projectStorage,
          animationEditorService: this.animationEditorService,
          autoSliceDialog: this.animationAutoSliceDialogService,
          dialogService: this.dialogService,
          sceneManager: this.sceneManager,
        },
        this.tabId,
        this.resourcePath
      );
    }

    return this.documentController;
  }

  /**
   * A texture dropped on a frame card is inserted by `<pix3-sprite-timeline>`,
   * which stops the event so the editor-level handler below can't *also* append
   * it — and that handler is what normally takes the drop overlay back down.
   * Capture runs before both, so this is the one place that reliably sees the end
   * of a texture drag wherever it landed.
   */
  private readonly onDropCapture = (): void => {
    this.textureDragDepth = 0;
    this.isTextureDragOver = false;
  };

  connectedCallback(): void {
    super.connectedCallback();
    const controller = this.controller;
    controller.setContext(this.tabId, this.resourcePath);
    this.disposeControllerSubscription = controller.subscribe(() => this.onControllerChanged());
    this.disposeOverlaySubscription = this.overlays.subscribe(() => this.requestUpdate());
    controller.attach();
    this.addEventListener('drop', this.onDropCapture, { capture: true });
  }

  protected updated(changedProperties: Map<PropertyKey, unknown>): void {
    if (changedProperties.has('tabId') || changedProperties.has('resourcePath')) {
      this.controller.setContext(this.tabId, this.resourcePath);
    }
  }

  disconnectedCallback(): void {
    this.removeEventListener('drop', this.onDropCapture, { capture: true });
    this.disposeControllerSubscription?.();
    this.disposeControllerSubscription = undefined;
    this.disposeOverlaySubscription?.();
    this.disposeOverlaySubscription = undefined;
    this.documentController?.dispose();
    super.disconnectedCallback();
  }

  protected render() {
    const controller = this.controller;
    const activeClip = controller.activeClip;
    const clipFrames = activeClip?.frames ?? [];
    const previewFrame = controller.previewFrame;

    return html`
      <section
        class="animation-editor ${this.isTextureDragOver ? 'is-texture-dragover' : ''}"
        aria-label="Animation editor"
        @dragenter=${(event: DragEvent) => this.onEditorDragEnter(event)}
        @dragover=${(event: DragEvent) => this.onEditorDragOver(event)}
        @dragleave=${(event: DragEvent) => this.onEditorDragLeave(event)}
        @drop=${(event: DragEvent) => this.onEditorDrop(event)}
      >
        ${controller.errorMessage
          ? html`<div class="error-state">${controller.errorMessage}</div>`
          : null}
        ${!controller.assetPath && !controller.errorMessage
          ? html`<div class="empty-state">
              Open a <code>.pix3anim</code> asset from the Asset Browser or double-click the
              animation resource field in the Inspector.
            </div>`
          : null}
        ${this.isTextureDragOver
          ? html`
              <div class="texture-drop-overlay" aria-hidden="true">
                <div class="texture-drop-overlay__card">
                  <div class="texture-drop-overlay__title">Drop image to add or replace frames</div>
                  <div class="texture-drop-overlay__body">
                    Drag an image asset from the Asset Browser onto the editor to append sequence
                    frames or import from a spritesheet.
                  </div>
                </div>
              </div>
            `
          : null}
        ${controller.assetPath && controller.resource
          ? html`
              <div class="editor-workspace">
                ${this.renderEditorToolbar(clipFrames.length)}

                <div class="editor-main">
                  <section class="editor-surface editor-surface--clips">
                    <pix3-sprite-clips-rail .controller=${controller}></pix3-sprite-clips-rail>
                  </section>

                  <section class="editor-surface editor-surface--stage">
                    ${this.renderFrameStage(activeClip, previewFrame)}
                  </section>
                </div>

                <section class="editor-surface editor-surface--timeline">
                  <pix3-sprite-timeline .controller=${controller}></pix3-sprite-timeline>
                </section>

                ${this.renderStatusBar(activeClip, clipFrames, previewFrame)}
              </div>
            `
          : null}
      </section>
    `;
  }

  private renderEditorToolbar(frameCount: number) {
    const controller = this.controller;
    const editMode = this.overlays.editMode;
    return html`
      <div class="editor-toolbar" aria-label="Animation editor toolbar">
        ${this.renderToolbarButton(
          'crosshair',
          'Anchor mode',
          () => this.overlays.setEditMode('anchor'),
          false,
          editMode === 'anchor'
        )}
        ${this.renderToolbarButton(
          'pen-tool',
          'Polygon mode',
          () => this.overlays.setEditMode('polygon'),
          false,
          editMode === 'polygon'
        )}
        ${this.renderToolbarButton(
          'crop',
          'Bounding box mode',
          () => this.overlays.setEditMode('bbox'),
          false,
          editMode === 'bbox'
        )}
        ${this.renderToolbarButton(
          'map-pin',
          'Frame points mode (named sockets)',
          () => this.overlays.setEditMode('points'),
          false,
          editMode === 'points'
        )}

        <span class="editor-toolbar-separator" aria-hidden="true"></span>

        ${this.renderToolbarButton('zoom-out', 'Zoom out', () => this.onAdjustZoom(-1))}
        ${this.renderToolbarButton('zoom-default', 'Reset zoom to 100%', () => this.onResetZoom())}
        ${this.renderToolbarButton('zoom-in', 'Zoom in', () => this.onAdjustZoom(1))}

        <span class="editor-toolbar-separator" aria-hidden="true"></span>

        ${this.renderToolbarButton(
          'trash-2',
          controller.getSelectedFrameIndices().length > 1
            ? 'Delete selected frames'
            : 'Delete selected frame',
          () => void controller.removeSelectedFrames(),
          frameCount === 0 || controller.getSelectedFrameIndices().length === 0
        )}
      </div>
    `;
  }

  private renderToolbarButton(
    iconName: string,
    title: string,
    onClick: () => void,
    disabled = false,
    active = false
  ) {
    return html`
      <button
        class="editor-toolbar-button ${active ? 'is-active' : ''}"
        type="button"
        title=${title}
        aria-label=${title}
        ?disabled=${disabled}
        @click=${onClick}
      >
        <span class="editor-toolbar-button-icon">${this.iconService.getIcon(iconName, 16)}</span>
      </button>
    `;
  }

  private renderStatusBar(
    activeClip: AnimationClip | null,
    clipFrames: AnimationFrame[],
    previewFrame: AnimationFrame | null
  ) {
    const controller = this.controller;
    const metrics = previewFrame ? controller.getFrameMetrics(previewFrame) : null;
    const frameLabel = previewFrame
      ? `Frame ${controller.previewFrameIndex + 1}/${clipFrames.length}`
      : 'No frame';
    const sizeLabel = metrics ? `${metrics.frameWidth} x ${metrics.frameHeight}px` : 'No size';
    const clipLabel = activeClip ? activeClip.name : 'No clip';

    return html`
      <div class="editor-status-row" aria-label="Animation editor status">
        <span>${clipLabel}</span>
        <span>${frameLabel}</span>
        <span>${sizeLabel}</span>
        <span>${Math.round(this.stageView.zoom * 100)}%</span>
        <span>${controller.resource?.clips.length ?? 0} clips</span>
        <span>${clipFrames.length} frames</span>
      </div>
    `;
  }

  private renderFrameStage(activeClip: AnimationClip | null, previewFrame: AnimationFrame | null) {
    if (!activeClip || !previewFrame) {
      return html`
        <div class="empty-state empty-state--inline">
          Select a clip with frames to inspect the current frame, its anchor, collision polygon, and
          bounding box.
        </div>
      `;
    }

    const controller = this.controller;
    const metrics = controller.getFrameMetrics(previewFrame);
    const zoom = this.stageView.zoom;
    const zoomedWidth = metrics.frameWidth * zoom;
    const zoomedHeight = metrics.frameHeight * zoom;
    const imageStyle = getFrameImageStyle(previewFrame);
    const previewTextureUrl = controller.getTexturePreviewUrl(previewFrame);
    const selectedFrame = controller.selectedFrame;
    const previousFrame = controller.activeClip?.frames[controller.previewFrameIndex - 1] ?? null;

    return html`
      <div class="stage-shell">
        <div class="stage-scroll" @wheel=${(event: WheelEvent) => this.onStageWheel(event)}>
          <div
            class="stage-artboard ${this.stageView.isPanning ? 'is-panning' : ''}"
            style=${`transform: translate(${this.stageView.panX}px, ${this.stageView.panY}px);`}
          >
            <div
              class="stage-frame"
              style=${`width:${zoomedWidth}px; height:${zoomedHeight}px;`}
              @pointerdown=${(event: PointerEvent) => this.onStagePointerDown(event)}
              @pointermove=${(event: PointerEvent) => this.onStagePointerMove(event)}
              @pointerup=${(event: PointerEvent) => this.onStagePointerUp(event)}
              @pointercancel=${(event: PointerEvent) => this.onStagePointerUp(event)}
            >
              ${previewTextureUrl
                ? html`
                    <img
                      class="stage-image"
                      src=${previewTextureUrl}
                      alt="Preview frame ${controller.previewFrameIndex + 1}"
                      style=${imageStyle}
                    />
                  `
                : null}
              <svg
                class="stage-overlay"
                viewBox=${`0 0 ${metrics.frameWidth} ${metrics.frameHeight}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                ${renderBboxOverlay(previewFrame)}
                ${renderPolygonOverlay(previewFrame, {
                  editable: this.overlays.canEdit('polygon'),
                })}
                ${renderPointsOverlay({
                  frame: previewFrame,
                  previousFrame,
                  metrics,
                  editable: this.overlays.canEdit('points'),
                  selectedPointName: this.overlays.selectedPointName,
                })}
              </svg>
              ${renderAnchorOverlay(previewFrame, { editable: this.overlays.canEdit('anchor') })}
            </div>
          </div>
        </div>
        ${this.renderAnchorTools(selectedFrame)} ${this.renderPointTools(selectedFrame)}
      </div>
    `;
  }

  /**
   * Points-mode side panel: the union of point names across the clip, so adding
   * one seeds it into every frame and the list doesn't flicker as you scrub.
   */
  private renderPointTools(selectedFrame: AnimationFrame | null) {
    if (this.overlays.editMode !== 'points' || !selectedFrame) {
      return null;
    }

    const names = collectClipPointNames(this.controller.activeClip);
    return html`
      <div class="anchor-tools" aria-label="Frame point tools">
        <div class="anchor-tools-header">
          <span class="anchor-tools-title">Points</span>
          <span class="anchor-tools-value">${names.length}</span>
        </div>
        <div class="anchor-tools-body">
          ${names.length === 0
            ? html`<p class="point-tools-hint">
                Add a named socket (muzzle, hand) and drag it per frame. Scripts read it with
                <code>getFramePoint()</code>.
              </p>`
            : html`
                <ul class="point-list">
                  ${names.map(name => {
                    const point = findAnimationFramePoint(selectedFrame, name);
                    return html`
                      <li class="point-list-item ${point ? '' : 'is-missing'}">
                        <input
                          class="point-list-name"
                          type="text"
                          .value=${name}
                          aria-label=${`Point name: ${name}`}
                          title=${point
                            ? `${(point.x * 100).toFixed(0)}%, ${(point.y * 100).toFixed(0)}%, ${Math.round(point.angle ?? 0)}°`
                            : 'Not defined on this frame'}
                          ?data-selected=${this.overlays.selectedPointName === name}
                          @focus=${() => this.overlays.setSelectedPointName(name)}
                          @change=${(event: Event) =>
                            void this.onRenamePoint(name, (event.target as HTMLInputElement).value)}
                        />
                        <button
                          type="button"
                          class="point-list-action"
                          title="Copy this frame's position to every frame of the clip"
                          @click=${() => void this.controller.copyFramePointToClip(name)}
                        >
                          ${this.iconService.getIcon('copy', 12)}
                        </button>
                        <button
                          type="button"
                          class="point-list-action is-danger"
                          title="Remove from every frame of the clip"
                          @click=${() => void this.onRemovePoint(name)}
                        >
                          ${this.iconService.getIcon('trash-2', 12)}
                        </button>
                      </li>
                    `;
                  })}
                </ul>
              `}
          <button
            type="button"
            class="anchor-action-button"
            title="Add a named point to every frame of this clip"
            @click=${() => void this.onAddPoint()}
          >
            Add point
          </button>
        </div>
      </div>
    `;
  }

  private renderAnchorTools(selectedFrame: AnimationFrame | null) {
    if (this.overlays.editMode !== 'anchor' || !selectedFrame) {
      return null;
    }

    return html`
      <div class="anchor-tools" aria-label="Anchor point tools">
        <div class="anchor-tools-header">
          <span class="anchor-tools-title">Anchor presets</span>
          <span class="anchor-tools-value">
            ${selectedFrame.anchor.x.toFixed(2)}, ${selectedFrame.anchor.y.toFixed(2)}
          </span>
        </div>
        <div class="anchor-tools-body">
          <div class="anchor-preset-grid">
            ${ANCHOR_PRESETS.map(
              preset => html`
                <button
                  class="anchor-preset-button ${this.isAnchorPresetActive(
                    selectedFrame.anchor,
                    preset.anchor
                  )
                    ? 'is-active'
                    : ''}"
                  type="button"
                  title=${preset.title}
                  aria-label=${preset.title}
                  @click=${() => void this.controller.applyAnchorPreset(preset.anchor)}
                >
                  ${preset.label}
                </button>
              `
            )}
          </div>
          <button
            type="button"
            class="anchor-action-button"
            title="Apply anchor to all frames in current clip"
            @click=${() => void this.controller.applySelectedAnchorToActiveClip()}
          >
            Clip
          </button>
          <button
            type="button"
            class="anchor-action-button"
            title="Apply anchor to all frames in all clips"
            @click=${() => void this.controller.applySelectedAnchorToAllClips()}
          >
            All
          </button>
        </div>
      </div>
    `;
  }

  private onControllerChanged(): void {
    // A document reload drops the transient draft under an in-flight stage drag;
    // the drag has nothing left to edit, so end it rather than leave a pointer
    // gesture bound to a frame that no longer exists.
    this.overlays.handleDocumentChanged();
    this.requestUpdate();
  }

  private onAdjustZoom(direction: -1 | 1): void {
    this.stageView.adjustZoom(direction * 2);
  }

  private onResetZoom(): void {
    this.stageView.reset();
  }

  /**
   * Wheel over the stage zooms around the cursor. The stage frame is *sized* by
   * zoom (so percentage-positioned overlays keep working), and the pan lives on
   * the artboard's transform — so the untranslated content origin the controller
   * expects is the frame rect minus the current pan.
   */
  private onStageWheel(event: WheelEvent): void {
    const viewport = this.getStageViewport();
    if (!viewport) {
      return;
    }
    event.preventDefault();
    this.stageView.zoomAtPointer(event, viewport);
  }

  private getStageViewport(): StageViewport | null {
    const frameElement = this.querySelector('.stage-frame');
    const frame = this.controller.selectedFrame;
    if (!frameElement || !frame) {
      return null;
    }

    const rect = frameElement.getBoundingClientRect();
    const metrics = this.controller.getFrameMetrics(frame);
    return {
      rect: new DOMRect(
        rect.left - this.stageView.panX,
        rect.top - this.stageView.panY,
        rect.width,
        rect.height
      ),
      contentWidth: metrics.frameWidth,
      contentHeight: metrics.frameHeight,
    };
  }

  private isAnchorPresetActive(currentAnchor: StagePoint, presetAnchor: StagePoint): boolean {
    return currentAnchor.x === presetAnchor.x && currentAnchor.y === presetAnchor.y;
  }

  private async onAddPoint(): Promise<void> {
    const name = await this.controller.addFramePoint();
    if (name) {
      this.overlays.setSelectedPointName(name);
    }
  }

  private async onRenamePoint(name: string, rawNextName: string): Promise<void> {
    const appliedName = await this.controller.renameFramePoint(name, rawNextName);
    if (!appliedName) {
      // Restore the input to the stored name on an empty/no-op/duplicate edit.
      this.requestUpdate();
      return;
    }

    this.overlays.setSelectedPointName(appliedName);
  }

  private async onRemovePoint(name: string): Promise<void> {
    if (this.overlays.selectedPointName === name) {
      this.overlays.setSelectedPointName(null);
    }

    await this.controller.removeFramePoint(name);
  }

  private onStagePointerDown(event: PointerEvent): void {
    // Middle-drag (or Alt+left) pans instead of editing — the tool keeps plain
    // left-drag.
    if (this.stageView.beginPan(event)) {
      event.preventDefault();
      return;
    }

    this.overlays.handlePointerDown(event);
  }

  private onStagePointerMove(event: PointerEvent): void {
    if (this.stageView.updatePan(event)) {
      return;
    }

    this.overlays.handlePointerMove(event);
  }

  private async onStagePointerUp(event: PointerEvent): Promise<void> {
    if (this.stageView.endPan(event)) {
      return;
    }

    await this.overlays.handlePointerUp(event);
  }

  /**
   * The stage's half of the overlay coordinate contract: a pointer event in
   * frame-pixel space, unclamped (the overlay controller clamps and rounds).
   * This stage *sizes* its frame element by zoom, so the proportion of the
   * element rect is already the proportion of the frame — the unified canvas will
   * instead go through `StageZoomPanController.toStageCoords`, which is exactly
   * why this lives in the host and not in the overlay module.
   *
   * Metrics come from the *selected* frame while the element is sized by the
   * *preview* frame; the two only differ mid-playback, and this preserves the
   * pre-extraction behaviour.
   */
  private toFramePoint(event: PointerEvent): StagePoint | null {
    const target = event.currentTarget as HTMLElement | null;
    const frame = this.controller.selectedFrame;
    if (!target || !frame) {
      return null;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const metrics = this.controller.getFrameMetrics(frame);
    return {
      x: ((event.clientX - rect.left) / rect.width) * metrics.frameWidth,
      y: ((event.clientY - rect.top) / rect.height) * metrics.frameHeight,
    };
  }

  /**
   * Editor-level texture drop: appends frames. A drop that lands on a frame card
   * inserts instead and stops propagation, so it never reaches this handler —
   * and a frame *reorder* is filtered out by {@link isPotentialTextureDrag}
   * through the shared `FRAME_REORDER_MIME`, which is why that constant is not
   * private to the frame strip.
   */
  private onEditorDragEnter(event: DragEvent): void {
    if (!isPotentialTextureDrag(event.dataTransfer)) {
      return;
    }

    this.textureDragDepth += 1;
    this.isTextureDragOver = true;
  }

  private onEditorDragOver(event: DragEvent): void {
    if (!isPotentialTextureDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    this.isTextureDragOver = true;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  private onEditorDragLeave(event: DragEvent): void {
    if (!isPotentialTextureDrag(event.dataTransfer)) {
      return;
    }

    this.textureDragDepth = Math.max(0, this.textureDragDepth - 1);
    if (this.textureDragDepth === 0) {
      this.isTextureDragOver = false;
    }
  }

  private async onEditorDrop(event: DragEvent): Promise<void> {
    if (!isPotentialTextureDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    this.textureDragDepth = 0;
    this.isTextureDragOver = false;

    const droppedFiles = getDroppedImageFiles(event.dataTransfer);
    const texturePaths =
      droppedFiles.length > 0
        ? await this.controller.importOsFiles(droppedFiles)
        : getDroppedTextureResources(event.dataTransfer);
    if (texturePaths.length === 0) {
      return;
    }

    await this.controller.addFrameTextures(texturePaths);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-animation-panel': AnimationPanel;
  }
}
