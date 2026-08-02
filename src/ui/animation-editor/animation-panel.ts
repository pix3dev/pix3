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
import { getFrameImageStyle } from '@/ui/sprite-editor/sprite-timeline';
import {
  SceneManager,
  collectClipPointNames,
  findAnimationFramePoint,
  type AnimationClip,
  type AnimationFrame,
} from '@pix3/runtime';

import './animation-panel.ts.css';

type AnimationEditMode = 'anchor' | 'polygon' | 'bbox' | 'points';

interface StageDragState {
  pointerId: number;
  mode: AnimationEditMode;
  origin: StagePoint;
  vertexIndex?: number;
  /** Points mode: name of the point being dragged, and whether it's the angle handle. */
  pointName?: string;
  pointAngleHandle?: boolean;
}

/** Length (frame px) of the direction handle drawn from a point in points mode. */
const POINT_ANGLE_HANDLE_LENGTH = 28;

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

  /** Points mode: the point highlighted on the stage and in the list. */
  @state()
  private selectedPointName: string | null = null;

  @state()
  private isTextureDragOver = false;

  @state()
  private editMode: AnimationEditMode = 'anchor';

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

  private documentController: AnimationDocumentController | null = null;
  private disposeControllerSubscription?: () => void;
  private stageDragState: StageDragState | null = null;
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

                <section class="editor-surface editor-surface--stage">
                    ${this.renderFrameStage(activeClip, previewFrame)}
                </section>

                <section class="editor-surface editor-surface--timeline">
                    <pix3-sprite-timeline .controller=${controller}></pix3-sprite-timeline>
                </section>

                ${this.renderStatusBar(activeClip, clipFrames, previewFrame)}
                </div>
              </div>
            `
          : null}
      </section>
    `;
  }

  private renderEditorToolbar(frameCount: number) {
    const controller = this.controller;
    return html`
      <div class="editor-toolbar" aria-label="Animation editor toolbar">
        ${this.renderToolbarButton(
          'crosshair',
          'Anchor mode',
          () => this.onSetEditMode('anchor'),
          false,
          this.editMode === 'anchor'
        )}
        ${this.renderToolbarButton(
          'pen-tool',
          'Polygon mode',
          () => this.onSetEditMode('polygon'),
          false,
          this.editMode === 'polygon'
        )}
        ${this.renderToolbarButton(
          'crop',
          'Bounding box mode',
          () => this.onSetEditMode('bbox'),
          false,
          this.editMode === 'bbox'
        )}
        ${this.renderToolbarButton(
          'map-pin',
          'Frame points mode (named sockets)',
          () => this.onSetEditMode('points'),
          false,
          this.editMode === 'points'
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
    const polygonPoints = previewFrame.collisionPolygon
      .map(point => `${point.x},${point.y}`)
      .join(' ');
    const imageStyle = getFrameImageStyle(previewFrame);
    const previewTextureUrl = controller.getTexturePreviewUrl(previewFrame);
    const selectedFrame = controller.selectedFrame;

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
                ${previewFrame.boundingBox.width > 0 && previewFrame.boundingBox.height > 0
                  ? html`
                      <rect
                        class="stage-bbox"
                        x=${previewFrame.boundingBox.x}
                        y=${previewFrame.boundingBox.y}
                        width=${previewFrame.boundingBox.width}
                        height=${previewFrame.boundingBox.height}
                      ></rect>
                    `
                  : null}
                ${previewFrame.collisionPolygon.length >= 2
                  ? html`
                      <polyline
                        class="stage-polygon"
                        points=${polygonPoints}
                        ?data-closed=${previewFrame.collisionPolygon.length >= 3}
                      ></polyline>
                    `
                  : null}
                ${previewFrame.collisionPolygon.map(
                  (point, index) => html`
                    <circle
                      class="stage-polygon-vertex ${this.editMode === 'polygon'
                        ? 'is-editable'
                        : ''}"
                      cx=${point.x}
                      cy=${point.y}
                      r="4"
                      data-vertex-index=${index}
                    ></circle>
                  `
                )}
                ${this.renderFramePointOverlay(previewFrame, metrics)}
              </svg>
              <div
                class="stage-anchor ${this.editMode === 'anchor' ? 'is-editable' : ''}"
                style=${`left:${previewFrame.anchor.x * 100}%; top:${previewFrame.anchor.y * 100}%;`}
                aria-hidden="true"
              ></div>
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
    if (this.editMode !== 'points' || !selectedFrame) {
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
                          ?data-selected=${this.selectedPointName === name}
                          @focus=${() => {
                            this.selectedPointName = name;
                          }}
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

  /**
   * Named frame points drawn on the stage: a dot per point plus a direction
   * handle for its angle. The previous frame's points ghost behind them (a
   * mini onion-skin) so a socket can be kept continuous while animating.
   */
  private renderFramePointOverlay(
    frame: AnimationFrame,
    metrics: { frameWidth: number; frameHeight: number }
  ) {
    const points = frame.points ?? [];
    const editable = this.editMode === 'points';
    if (points.length === 0 && !editable) {
      return null;
    }

    const toStage = (point: { x: number; y: number }) => ({
      x: point.x * metrics.frameWidth,
      y: point.y * metrics.frameHeight,
    });

    const controller = this.controller;
    const previousFrame = editable
      ? (controller.activeClip?.frames[controller.previewFrameIndex - 1] ?? null)
      : null;

    return html`
      ${(previousFrame?.points ?? []).map(point => {
        const at = toStage(point);
        return html`<circle
          class="stage-point stage-point--ghost"
          cx=${at.x}
          cy=${at.y}
          r="3"
        ></circle>`;
      })}
      ${points.map(point => {
        const at = toStage(point);
        const angleRadians = ((point.angle ?? 0) * Math.PI) / 180;
        return html`
          <line
            class="stage-point-angle ${editable ? 'is-editable' : ''}"
            x1=${at.x}
            y1=${at.y}
            x2=${at.x + Math.cos(angleRadians) * POINT_ANGLE_HANDLE_LENGTH}
            y2=${at.y + Math.sin(angleRadians) * POINT_ANGLE_HANDLE_LENGTH}
            data-point-angle=${point.name}
          ></line>
          <circle
            class="stage-point ${editable ? 'is-editable' : ''} ${this.selectedPointName ===
            point.name
              ? 'is-selected'
              : ''}"
            cx=${at.x}
            cy=${at.y}
            r="5"
            data-point-name=${point.name}
          ></circle>
        `;
      })}
    `;
  }

  private renderAnchorTools(selectedFrame: AnimationFrame | null) {
    if (this.editMode !== 'anchor' || !selectedFrame) {
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
    if (this.stageDragState && !this.controller.frameDraft) {
      this.stageDragState = null;
    }

    this.requestUpdate();
  }

  private onSetEditMode(mode: AnimationEditMode): void {
    this.editMode = mode;
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
      this.selectedPointName = name;
    }
  }

  private async onRenamePoint(name: string, rawNextName: string): Promise<void> {
    const appliedName = await this.controller.renameFramePoint(name, rawNextName);
    if (!appliedName) {
      // Restore the input to the stored name on an empty/no-op/duplicate edit.
      this.requestUpdate();
      return;
    }

    this.selectedPointName = appliedName;
  }

  private async onRemovePoint(name: string): Promise<void> {
    if (this.selectedPointName === name) {
      this.selectedPointName = null;
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

    const controller = this.controller;
    const frame = controller.selectedFrame;
    if (!frame) {
      return;
    }

    const point = this.getStageLocalPoint(event, frame);
    if (!point) {
      return;
    }

    const target = event.target as HTMLElement | SVGElement;
    if (!controller.beginFrameDraft()) {
      return;
    }

    if (this.editMode === 'points') {
      const angleHandleName = target.getAttribute('data-point-angle');
      const pointName = target.getAttribute('data-point-name') ?? angleHandleName;
      if (!pointName) {
        // Empty stage click in points mode: nothing to grab.
        controller.clearFrameDraft();
        return;
      }
      this.selectedPointName = pointName;
      this.stageDragState = {
        pointerId: event.pointerId,
        mode: 'points',
        origin: point,
        pointName,
        pointAngleHandle: Boolean(angleHandleName),
      };
    } else if (this.editMode === 'anchor') {
      controller.updateFrameDraft(draft => ({
        ...draft,
        anchor: this.toNormalizedAnchor(point, frame),
      }));
      this.stageDragState = {
        pointerId: event.pointerId,
        mode: 'anchor',
        origin: point,
      };
    } else if (this.editMode === 'bbox') {
      controller.updateFrameDraft(draft => ({
        ...draft,
        boundingBox: { x: point.x, y: point.y, width: 0, height: 0 },
      }));
      this.stageDragState = {
        pointerId: event.pointerId,
        mode: 'bbox',
        origin: point,
      };
    } else {
      const vertexIndex = Number(target.getAttribute('data-vertex-index'));
      if (Number.isInteger(vertexIndex) && vertexIndex >= 0) {
        this.stageDragState = {
          pointerId: event.pointerId,
          mode: 'polygon',
          origin: point,
          vertexIndex,
        };
      } else {
        let appendedVertexIndex = 0;
        controller.updateFrameDraft(draft => {
          appendedVertexIndex = draft.collisionPolygon.length;
          return { ...draft, collisionPolygon: [...draft.collisionPolygon, point] };
        });
        this.stageDragState = {
          pointerId: event.pointerId,
          mode: 'polygon',
          origin: point,
          vertexIndex: appendedVertexIndex,
        };
      }
    }

    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  private onStagePointerMove(event: PointerEvent): void {
    if (this.stageView.updatePan(event)) {
      return;
    }

    const controller = this.controller;
    const dragState = this.stageDragState;
    const frame = controller.selectedFrame;
    if (!dragState || !frame || dragState.pointerId !== event.pointerId || !controller.frameDraft) {
      return;
    }

    const point = this.getStageLocalPoint(event, frame);
    if (!point) {
      return;
    }

    if (dragState.mode === 'points') {
      const pointName = dragState.pointName;
      if (!pointName) {
        return;
      }
      const metrics = controller.getFrameMetrics(frame);
      controller.updateFrameDraft(draft => ({
        ...draft,
        points: (draft.points ?? []).map(candidate => {
          if (candidate.name !== pointName) {
            return candidate;
          }
          if (!dragState.pointAngleHandle) {
            return {
              ...candidate,
              x: Number((point.x / metrics.frameWidth).toFixed(4)),
              y: Number((point.y / metrics.frameHeight).toFixed(4)),
            };
          }
          // Dragging the handle rotates the point around itself.
          const originX = candidate.x * metrics.frameWidth;
          const originY = candidate.y * metrics.frameHeight;
          const angle = (Math.atan2(point.y - originY, point.x - originX) * 180) / Math.PI;
          return { ...candidate, angle: Math.round(angle) };
        }),
      }));
      return;
    }

    if (dragState.mode === 'anchor') {
      controller.updateFrameDraft(draft => ({
        ...draft,
        anchor: this.toNormalizedAnchor(point, frame),
      }));
      return;
    }

    if (dragState.mode === 'bbox') {
      const x = Math.min(dragState.origin.x, point.x);
      const y = Math.min(dragState.origin.y, point.y);
      const width = Math.abs(point.x - dragState.origin.x);
      const height = Math.abs(point.y - dragState.origin.y);
      controller.updateFrameDraft(draft => ({
        ...draft,
        boundingBox: { x, y, width, height },
      }));
      return;
    }

    const vertexIndex = dragState.vertexIndex ?? -1;
    if (vertexIndex < 0) {
      return;
    }

    controller.updateFrameDraft(draft => {
      const nextPolygon = [...draft.collisionPolygon];
      nextPolygon[vertexIndex] = point;
      return { ...draft, collisionPolygon: nextPolygon };
    });
  }

  private async onStagePointerUp(event: PointerEvent): Promise<void> {
    if (this.stageView.endPan(event)) {
      return;
    }

    const dragState = this.stageDragState;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    this.stageDragState = null;

    await this.controller.commitFrameDraft(
      `Update frame ${this.editMode}: ${this.controller.activeClipName}`
    );
  }

  private getStageLocalPoint(event: PointerEvent, frame: AnimationFrame): StagePoint | null {
    const target = event.currentTarget as HTMLElement | null;
    if (!target) {
      return null;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const metrics = this.controller.getFrameMetrics(frame);
    const x = Math.min(
      metrics.frameWidth,
      Math.max(0, ((event.clientX - rect.left) / rect.width) * metrics.frameWidth)
    );
    const y = Math.min(
      metrics.frameHeight,
      Math.max(0, ((event.clientY - rect.top) / rect.height) * metrics.frameHeight)
    );
    return {
      x: Math.round(x),
      y: Math.round(y),
    };
  }

  private toNormalizedAnchor(point: StagePoint, frame: AnimationFrame): StagePoint {
    const metrics = this.controller.getFrameMetrics(frame);
    return {
      x: Number((point.x / metrics.frameWidth).toFixed(3)),
      y: Number((point.y / metrics.frameHeight).toFixed(3)),
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
