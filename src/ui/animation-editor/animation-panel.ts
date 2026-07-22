import { subscribe } from 'valtio/vanilla';

import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { UpdateAnimationDocumentOperation } from '@/features/properties/UpdateAnimationDocumentOperation';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import {
  buildAnimationFrameResourcePath,
  deriveAnimationDocumentId,
  normalizeAnimationAssetPath,
} from '@/features/scene/animation-asset-utils';
import { appState } from '@/state';
import { AnimationAutoSliceDialogService } from '@/services/animation/AnimationAutoSliceDialogService';
import { AnimationEditorService } from '@/services/animation/AnimationEditorService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { DialogService } from '@/services/editor/DialogService';
import { IconService } from '@/services/editor/IconService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { OperationService } from '@/services/core/OperationService';
import type {
  AnimationInspectorController,
  AnimationInspectorSnapshot,
} from '@/services/animation/AnimationEditorService';
import {
  AnimatedSprite2D,
  SceneManager,
  getAnimationFrameTexturePath,
  isSequenceAnimationFrame,
  normalizeAnimationResource,
  type AnimationClip,
  type AnimationFrame,
  type AnimationPlaybackMode,
  type AnimationResource,
} from '@pix3/runtime';

import './animation-panel.ts.css';

const ASSET_RESOURCE_MIME = 'application/x-pix3-asset-resource';
const ASSET_PATH_MIME = 'application/x-pix3-asset-path';
const ASSET_RESOURCE_LIST_MIME = 'application/x-pix3-asset-resource-list';
const ASSET_PATH_LIST_MIME = 'application/x-pix3-asset-path-list';
const FRAME_REORDER_MIME = 'application/x-pix3-animation-frame-reorder';
const IMAGE_EXTENSIONS = new Set([
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

type AnimationEditMode = 'anchor' | 'polygon' | 'bbox';

interface TextureDimensions {
  width: number;
  height: number;
}

interface StagePoint {
  x: number;
  y: number;
}

interface StageDragState {
  pointerId: number;
  mode: AnimationEditMode;
  origin: StagePoint;
  vertexIndex?: number;
}

interface AnchorPreset {
  label: string;
  title: string;
  anchor: StagePoint;
}

const DEFAULT_FRAME_ANCHOR: StagePoint = { x: 0.5, y: 0.5 };

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

@customElement('pix3-animation-panel')
export class AnimationPanel extends ComponentBase implements AnimationInspectorController {
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
  private assetPath: string | null = null;

  @state()
  private resource: AnimationResource | null = null;

  @state()
  private activeClipName = '';

  @state()
  private texturePreviewUrl = '';

  @state()
  private errorMessage: string | null = null;

  @state()
  private slicerColumns = 1;

  @state()
  private slicerRows = 1;

  @state()
  private isTextureDragOver = false;

  @state()
  private selectedFrameIndex = -1;

  @state()
  private selectedFrameIndices: number[] = [];

  @state()
  private previewFrameIndex = -1;

  @state()
  private isPreviewPlaying = false;

  @state()
  private editMode: AnimationEditMode = 'anchor';

  @state()
  private stageZoom = 1;

  @state()
  private textureDimensions: TextureDimensions = { width: 0, height: 0 };

  @state()
  private frameDraft: AnimationFrame | null = null;

  private disposeTabsSubscription?: () => void;
  private disposeProjectSubscription?: () => void;
  private disposeAnimationsSubscription?: () => void;
  private animationId: string | null = null;
  private loadToken = 0;
  private playbackFrameHandle: number | null = null;
  private playbackLastTimestamp: number | null = null;
  private previewElapsedSeconds = 0;
  private previewDirection = 1;
  private stageDragState: StageDragState | null = null;
  private textureDragDepth = 0;
  private draggedFrameIndex = -1;
  private dragOverFrameIndex = -1;
  private selectionAnchorFrameIndex = -1;
  private previewTexturePath = '';
  private readonly texturePreviewCache = new Map<string, string>();
  private readonly textureDimensionsCache = new Map<string, TextureDimensions>();
  private readonly texturePreviewLoads = new Map<string, Promise<void>>();
  private readonly inspectorListeners = new Set<() => void>();

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeTabsSubscription = subscribe(appState.tabs, () => {
      void this.syncFromResourceContext(true);
    });
    this.disposeProjectSubscription = subscribe(appState.project, () => {
      void this.syncFromResourceContext(true);
    });
    this.disposeAnimationsSubscription = subscribe(appState.animations, () => {
      void this.syncFromDocumentState(true);
    });
    void this.syncFromResourceContext(false);
  }

  protected updated(changedProperties: Map<PropertyKey, unknown>): void {
    if (changedProperties.has('tabId') || changedProperties.has('resourcePath')) {
      void this.syncFromResourceContext(false);
    }

    if (
      changedProperties.has('assetPath') ||
      changedProperties.has('resource') ||
      changedProperties.has('activeClipName') ||
      changedProperties.has('selectedFrameIndex')
    ) {
      this.notifyInspectorListeners();
    }

    if (
      changedProperties.has('resource') ||
      changedProperties.has('activeClipName') ||
      changedProperties.has('selectedFrameIndex') ||
      changedProperties.has('previewFrameIndex')
    ) {
      void this.syncPreviewTexture();
    }
  }

  disconnectedCallback(): void {
    this.stopPreviewPlayback();
    this.disposeTabsSubscription?.();
    this.disposeProjectSubscription?.();
    this.disposeAnimationsSubscription?.();
    this.disposeTabsSubscription = undefined;
    this.disposeProjectSubscription = undefined;
    this.disposeAnimationsSubscription = undefined;
    if (this.animationEditorService.getActiveController() === this) {
      this.animationEditorService.setActiveController(null);
    }
    this.clearTexturePreviewCache();
    super.disconnectedCallback();
  }

  protected render() {
    const activeClip = this.getActiveClip();
    const clipFrames = activeClip?.frames ?? [];
    const previewFrame = this.getPreviewFrame(activeClip);

    return html`
      <section
        class="animation-editor ${this.isTextureDragOver ? 'is-texture-dragover' : ''}"
        aria-label="Animation editor"
        @dragenter=${(event: DragEvent) => this.onEditorDragEnter(event)}
        @dragover=${(event: DragEvent) => this.onEditorDragOver(event)}
        @dragleave=${(event: DragEvent) => this.onEditorDragLeave(event)}
        @drop=${(event: DragEvent) => this.onEditorDrop(event)}
      >
        ${this.errorMessage ? html`<div class="error-state">${this.errorMessage}</div>` : null}
        ${!this.assetPath && !this.errorMessage
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
        ${this.assetPath && this.resource
          ? html`
              <div class="editor-workspace">
                ${this.renderEditorToolbar(clipFrames.length)}

                <section class="editor-surface editor-surface--stage">
                    ${this.renderFrameStage(activeClip, previewFrame)}
                </section>

                <section class="editor-surface editor-surface--timeline">
                    ${this.renderTimeline(activeClip, clipFrames)}
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
    return html`
      <div class="editor-toolbar" aria-label="Animation editor toolbar">
        ${this.renderToolbarButton(
          this.isPreviewPlaying ? 'pause' : 'play',
          this.isPreviewPlaying ? 'Pause playback' : 'Play preview',
          () => this.onTogglePlayback(),
          frameCount === 0
        )}
        ${this.renderToolbarButton(
          'square',
          'Stop playback',
          () => this.onStopPlayback(),
          frameCount === 0
        )}

        <span class="editor-toolbar-separator" aria-hidden="true"></span>

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

        <span class="editor-toolbar-separator" aria-hidden="true"></span>

        ${this.renderToolbarButton('zoom-out', 'Zoom out', () => this.onAdjustZoom(-1))}
        ${this.renderToolbarButton('zoom-default', 'Reset zoom to 100%', () => this.onResetZoom())}
        ${this.renderToolbarButton('zoom-in', 'Zoom in', () => this.onAdjustZoom(1))}

        <span class="editor-toolbar-separator" aria-hidden="true"></span>

        ${this.renderToolbarButton(
          'trash-2',
          this.getSelectedFrameIndices().length > 1
            ? 'Delete selected frames'
            : 'Delete selected frame',
          () => void this.onRemoveSelectedFrame(),
          frameCount === 0 || this.getSelectedFrameIndices().length === 0
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
    const metrics = previewFrame ? this.getFrameMetrics(previewFrame) : null;
    const frameLabel = previewFrame
      ? `Frame ${this.previewFrameIndex + 1}/${clipFrames.length}`
      : 'No frame';
    const sizeLabel = metrics ? `${metrics.frameWidth} x ${metrics.frameHeight}px` : 'No size';
    const clipLabel = activeClip ? activeClip.name : 'No clip';

    return html`
      <div class="editor-status-row" aria-label="Animation editor status">
        <span>${clipLabel}</span>
        <span>${frameLabel}</span>
        <span>${sizeLabel}</span>
        <span>${Math.round(this.stageZoom * 100)}%</span>
        <span>${this.resource?.clips.length ?? 0} clips</span>
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

    const metrics = this.getFrameMetrics(previewFrame);
    const zoomedWidth = metrics.frameWidth * this.stageZoom;
    const zoomedHeight = metrics.frameHeight * this.stageZoom;
    const polygonPoints = previewFrame.collisionPolygon
      .map(point => `${point.x},${point.y}`)
      .join(' ');
    const imageStyle = this.getFrameImageStyle(previewFrame);
    const previewTextureUrl = this.getTexturePreviewUrl(previewFrame);
    const selectedFrame = this.getSelectedFrame(activeClip);

    return html`
      <div class="stage-shell">
        <div class="stage-scroll">
          <div class="stage-artboard">
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
                      alt="Preview frame ${this.previewFrameIndex + 1}"
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
              </svg>
              <div
                class="stage-anchor ${this.editMode === 'anchor' ? 'is-editable' : ''}"
                style=${`left:${previewFrame.anchor.x * 100}%; top:${previewFrame.anchor.y * 100}%;`}
                aria-hidden="true"
              ></div>
            </div>
          </div>
        </div>
        ${this.renderAnchorTools(selectedFrame)}
      </div>
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
                  @click=${() => void this.onApplyAnchorPreset(preset.anchor)}
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
            @click=${() => void this.onApplySelectedAnchorToActiveClip()}
          >
            Clip
          </button>
          <button
            type="button"
            class="anchor-action-button"
            title="Apply anchor to all frames in all clips"
            @click=${() => void this.onApplySelectedAnchorToAllClips()}
          >
            All
          </button>
        </div>
      </div>
    `;
  }

  private renderTimeline(activeClip: AnimationClip | null, clipFrames: AnimationFrame[]) {
    if (!activeClip || clipFrames.length === 0) {
      return html`
        <div class="empty-state empty-state--inline">
          This clip has no frames yet. Drop images to append sequence frames or import a spritesheet
          once via <strong>Slice Frames...</strong>.
        </div>
      `;
    }

    return html`
      <div class="timeline">
        ${clipFrames.map((frame, index) => this.renderFrameCard(frame, index))}
      </div>
    `;
  }

  private renderFrameCard(frame: AnimationFrame, index: number) {
    const imageStyle = this.getFrameImageStyle(frame);
    const previewTextureUrl = this.getTexturePreviewUrl(frame);
    const isSelected = this.selectedFrameIndices.includes(index);
    const isPreviewFrame = index === this.previewFrameIndex;
    const isDropTarget = index === this.dragOverFrameIndex && this.draggedFrameIndex !== index;

    return html`
      <button
        class="frame-card ${isSelected ? 'is-selected' : ''} ${isPreviewFrame
          ? 'is-preview'
          : ''} ${isDropTarget ? 'is-drop-target' : ''}"
        type="button"
        title=${`Frame ${index + 1} · ${this.getFrameDurationLabel(frame)}`}
        draggable="true"
        @click=${(event: MouseEvent) => this.onSelectFrame(event, index)}
        @dragstart=${(event: DragEvent) => this.onFrameDragStart(event, index)}
        @dragover=${(event: DragEvent) => this.onFrameDragOver(event, index)}
        @dragleave=${() => this.onFrameDragLeave(index)}
        @drop=${(event: DragEvent) => void this.onFrameDrop(event, index)}
        @dragend=${() => this.onFrameDragEnd()}
      >
        <div class="frame-thumb">
          <span
            class="frame-delete-button"
            role="button"
            tabindex="0"
            title="Delete frame ${index + 1}"
            aria-label=${`Delete frame ${index + 1}`}
            @click=${(event: Event) => void this.onDeleteFrameClick(event, index)}
            @keydown=${(event: KeyboardEvent) => void this.onDeleteFrameKeyDown(event, index)}
          >
            ${this.iconService.getIcon('trash-2', 12)}
          </span>
          ${previewTextureUrl
            ? html` <img src=${previewTextureUrl} alt="Frame ${index + 1}" style=${imageStyle} /> `
            : null}
          <div
            class="frame-thumb-anchor"
            style=${`left:${frame.anchor.x * 100}%; top:${frame.anchor.y * 100}%;`}
          ></div>
        </div>
      </button>
    `;
  }

  private getSelectedFrame(
    activeClip: AnimationClip | null = this.getActiveClip()
  ): AnimationFrame | null {
    if (!activeClip || activeClip.frames.length === 0) {
      return null;
    }

    const frame = activeClip.frames[this.selectedFrameIndex] ?? null;
    if (!frame) {
      return null;
    }

    return this.frameDraft ?? frame;
  }

  private getPreviewFrame(
    activeClip: AnimationClip | null = this.getActiveClip()
  ): AnimationFrame | null {
    if (!activeClip || activeClip.frames.length === 0) {
      return null;
    }

    const frame = activeClip.frames[this.previewFrameIndex] ?? activeClip.frames[0] ?? null;
    if (!frame) {
      return null;
    }

    return this.frameDraft && this.previewFrameIndex === this.selectedFrameIndex
      ? this.frameDraft
      : frame;
  }

  private getFrameImageStyle(frame: AnimationFrame): string {
    if (isSequenceAnimationFrame(frame)) {
      return 'width:100%; height:100%; left:0; top:0;';
    }

    const scaleX = frame.repeat.x > 0 ? 100 / frame.repeat.x : 100;
    const scaleY = frame.repeat.y > 0 ? 100 / frame.repeat.y : 100;
    const left = frame.repeat.x > 0 ? -(frame.offset.x / frame.repeat.x) * 100 : 0;
    const top = frame.repeat.y > 0 ? -(frame.offset.y / frame.repeat.y) * 100 : 0;
    return `width:${scaleX}%; height:${scaleY}%; left:${left}%; top:${top}%;`;
  }

  private getFrameMetrics(frame: AnimationFrame): { frameWidth: number; frameHeight: number } {
    const resolvedTexturePath = this.getResolvedFrameTexturePath(frame);
    const cachedDimensions = resolvedTexturePath
      ? (this.textureDimensionsCache.get(resolvedTexturePath) ?? null)
      : null;
    const textureWidth = cachedDimensions?.width || this.textureDimensions.width || 256;
    const textureHeight = cachedDimensions?.height || this.textureDimensions.height || 256;

    if (isSequenceAnimationFrame(frame)) {
      return {
        frameWidth: Math.max(24, Math.round(textureWidth)),
        frameHeight: Math.max(24, Math.round(textureHeight)),
      };
    }

    return {
      frameWidth: Math.max(24, Math.round(textureWidth * Math.max(frame.repeat.x, 0.05))),
      frameHeight: Math.max(24, Math.round(textureHeight * Math.max(frame.repeat.y, 0.05))),
    };
  }

  private getResolvedFrameTexturePath(frame: AnimationFrame | null): string {
    return getAnimationFrameTexturePath(this.resource, frame);
  }

  private getTexturePreviewUrl(frame: AnimationFrame | null): string {
    const texturePath = this.getResolvedFrameTexturePath(frame);
    if (!texturePath) {
      return '';
    }

    if (texturePath === this.previewTexturePath && this.texturePreviewUrl) {
      return this.texturePreviewUrl;
    }

    const cachedTextureUrl = this.texturePreviewCache.get(texturePath);
    if (cachedTextureUrl) {
      return cachedTextureUrl;
    }

    void this.ensureTexturePreviewLoaded(texturePath);
    return '';
  }

  private getFrameDurationLabel(frame: AnimationFrame): string {
    const activeClip = this.getActiveClip();
    if (!activeClip) {
      return 'No timing';
    }

    return `${this.getFrameDurationSeconds(activeClip, frame).toFixed(3)}s`;
  }

  private getFrameDurationSeconds(clip: AnimationClip, frame: AnimationFrame): number {
    const fps = Math.max(1, clip.fps);
    const multiplier = Math.max(0.001, frame.durationMultiplier);
    return (1 / fps) * multiplier;
  }

  private onSetEditMode(mode: AnimationEditMode): void {
    this.editMode = mode;
  }

  private onAdjustZoom(direction: -1 | 1): void {
    const nextZoom = this.stageZoom + direction * 0.25;
    this.stageZoom = Math.min(8, Math.max(0.5, Number(nextZoom.toFixed(2))));
  }

  private onResetZoom(): void {
    this.stageZoom = 1;
  }

  private onSelectFrame(event: MouseEvent, index: number): void {
    const currentSelection = this.getSelectedFrameIndices();
    let nextSelectedFrameIndices: number[];
    let nextPrimaryIndex = index;

    if (event.shiftKey && this.selectionAnchorFrameIndex >= 0) {
      const [rangeStart, rangeEnd] =
        this.selectionAnchorFrameIndex <= index
          ? [this.selectionAnchorFrameIndex, index]
          : [index, this.selectionAnchorFrameIndex];
      nextSelectedFrameIndices = [];
      for (let frameIndex = rangeStart; frameIndex <= rangeEnd; frameIndex += 1) {
        nextSelectedFrameIndices.push(frameIndex);
      }
    } else if (event.ctrlKey || event.metaKey) {
      const nextSelection = new Set(currentSelection);
      if (nextSelection.has(index) && nextSelection.size > 1) {
        nextSelection.delete(index);
      } else {
        nextSelection.add(index);
      }
      nextSelectedFrameIndices = [...nextSelection].sort((left, right) => left - right);
      if (!nextSelectedFrameIndices.includes(index)) {
        nextPrimaryIndex = nextSelectedFrameIndices.at(-1) ?? -1;
      }
    } else {
      nextSelectedFrameIndices = [index];
    }

    this.frameDraft = null;
    this.selectedFrameIndices = nextSelectedFrameIndices;
    this.selectedFrameIndex = nextPrimaryIndex;
    this.previewFrameIndex = nextPrimaryIndex;
    this.previewElapsedSeconds = 0;
    this.selectionAnchorFrameIndex = index;
    this.persistSelectedFrameIndex(nextPrimaryIndex);
  }

  private onTogglePlayback(): void {
    if (this.isPreviewPlaying) {
      this.stopPreviewPlayback();
      return;
    }

    this.startPreviewPlayback();
  }

  private onStopPlayback(): void {
    this.stopPreviewPlayback();
    const activeClip = this.getActiveClip();
    if (!activeClip || activeClip.frames.length === 0) {
      this.previewFrameIndex = -1;
      return;
    }

    const fallbackIndex = this.selectedFrameIndex >= 0 ? this.selectedFrameIndex : 0;
    this.previewFrameIndex = Math.min(fallbackIndex, activeClip.frames.length - 1);
    this.previewElapsedSeconds = 0;
  }

  private startPreviewPlayback(): void {
    const activeClip = this.getActiveClip();
    if (!activeClip || activeClip.frames.length === 0 || this.playbackFrameHandle !== null) {
      return;
    }

    this.isPreviewPlaying = true;
    this.previewDirection = 1;
    this.playbackLastTimestamp = null;

    const tick = (timestamp: number) => {
      if (!this.isPreviewPlaying) {
        return;
      }

      this.playbackFrameHandle = requestAnimationFrame(tick);
      const clip = this.getActiveClip();
      const frame = this.getPreviewFrame(clip);
      if (!clip || !frame) {
        return;
      }

      if (this.playbackLastTimestamp === null) {
        this.playbackLastTimestamp = timestamp;
        return;
      }

      let deltaSeconds = (timestamp - this.playbackLastTimestamp) / 1000;
      this.playbackLastTimestamp = timestamp;

      while (deltaSeconds > 0) {
        const currentClip = this.getActiveClip();
        const currentFrame = this.getPreviewFrame(currentClip);
        if (!currentClip || !currentFrame) {
          break;
        }

        const frameDuration = this.getFrameDurationSeconds(currentClip, currentFrame);
        const remaining = frameDuration - this.previewElapsedSeconds;
        if (deltaSeconds < remaining) {
          this.previewElapsedSeconds += deltaSeconds;
          deltaSeconds = 0;
          break;
        }

        deltaSeconds -= remaining;
        this.previewElapsedSeconds = 0;
        if (!this.stepPreviewFrame(currentClip)) {
          this.stopPreviewPlayback();
          break;
        }
      }
    };

    this.playbackFrameHandle = requestAnimationFrame(tick);
  }

  private stopPreviewPlayback(): void {
    if (this.playbackFrameHandle !== null) {
      cancelAnimationFrame(this.playbackFrameHandle);
      this.playbackFrameHandle = null;
    }

    this.isPreviewPlaying = false;
    this.playbackLastTimestamp = null;
    this.previewElapsedSeconds = 0;
  }

  private stepPreviewFrame(activeClip: AnimationClip): boolean {
    if (activeClip.frames.length === 0) {
      return false;
    }

    if (activeClip.playbackMode === 'ping-pong') {
      const nextIndex = this.previewFrameIndex + this.previewDirection;
      if (nextIndex >= 0 && nextIndex < activeClip.frames.length) {
        this.previewFrameIndex = nextIndex;
        return true;
      }

      if (activeClip.frames.length === 1) {
        return activeClip.loop;
      }

      this.previewDirection *= -1;
      const bouncedIndex = this.previewFrameIndex + this.previewDirection;
      if (bouncedIndex >= 0 && bouncedIndex < activeClip.frames.length) {
        this.previewFrameIndex = bouncedIndex;
        if (!activeClip.loop && bouncedIndex === 0) {
          return false;
        }
        return true;
      }

      return false;
    }

    const nextIndex = this.previewFrameIndex + 1;
    if (nextIndex < activeClip.frames.length) {
      this.previewFrameIndex = nextIndex;
      return true;
    }

    if (!activeClip.loop) {
      this.previewFrameIndex = activeClip.frames.length - 1;
      return false;
    }

    this.previewFrameIndex = 0;
    return true;
  }

  private async applyClipUpdate(
    updater: (clip: AnimationClip) => AnimationClip,
    label: string
  ): Promise<void> {
    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(clip =>
          clip.name === this.activeClipName ? updater(clip) : clip
        ),
      }),
      label
    );
  }

  private async applySelectedFrameUpdate(
    updater: (frame: AnimationFrame) => AnimationFrame,
    label: string
  ): Promise<void> {
    const frameIndex = this.selectedFrameIndex;
    if (frameIndex < 0) {
      return;
    }

    this.frameDraft = null;
    await this.applyClipUpdate(
      clip => ({
        ...clip,
        frames: clip.frames.map((frame, index) => (index === frameIndex ? updater(frame) : frame)),
      }),
      label
    );
  }

  private async onUpdateClipPlaybackMode(mode: AnimationPlaybackMode): Promise<void> {
    await this.applyClipUpdate(
      clip => ({ ...clip, playbackMode: mode }),
      `Update clip playback mode: ${this.activeClipName}`
    );
  }

  private async onUpdateSelectedFrameDurationMultiplier(value: number): Promise<void> {
    if (!Number.isFinite(value) || value <= 0) {
      return;
    }

    await this.applySelectedFrameUpdate(
      frame => ({ ...frame, durationMultiplier: Math.max(0.05, value) }),
      `Update frame duration multiplier: ${this.activeClipName}`
    );
  }

  private async onUpdateSelectedFrameTexturePath(value: string): Promise<void> {
    await this.applySelectedFrameUpdate(
      frame => ({ ...frame, texturePath: value }),
      `Update frame texture override: ${this.activeClipName}`
    );
  }

  private async onUpdateSelectedFrameAnchor(axis: 'x' | 'y', value: number): Promise<void> {
    if (!Number.isFinite(value)) {
      return;
    }

    const clampedValue = Math.min(1, Math.max(0, value));
    await this.applySelectedFrameUpdate(
      frame => ({
        ...frame,
        anchor: { ...frame.anchor, [axis]: clampedValue },
      }),
      `Update frame anchor: ${this.activeClipName}`
    );
  }

  private isAnchorPresetActive(currentAnchor: StagePoint, presetAnchor: StagePoint): boolean {
    return currentAnchor.x === presetAnchor.x && currentAnchor.y === presetAnchor.y;
  }

  private getSelectedAnchor(): StagePoint | null {
    const selectedFrame = this.getSelectedFrame();
    if (!selectedFrame) {
      return null;
    }

    return {
      x: selectedFrame.anchor.x,
      y: selectedFrame.anchor.y,
    };
  }

  private async onApplyAnchorPreset(anchor: StagePoint): Promise<void> {
    await this.applySelectedFrameUpdate(
      frame => ({
        ...frame,
        anchor: { x: anchor.x, y: anchor.y },
      }),
      `Set frame anchor preset: ${this.activeClipName}`
    );
  }

  private async onApplySelectedAnchorToActiveClip(): Promise<void> {
    const anchor = this.getSelectedAnchor();
    if (!anchor) {
      return;
    }

    this.frameDraft = null;
    await this.applyClipUpdate(
      clip => ({
        ...clip,
        frames: clip.frames.map(frame => ({
          ...frame,
          anchor: { x: anchor.x, y: anchor.y },
        })),
      }),
      `Apply frame anchor to clip: ${this.activeClipName}`
    );
  }

  private async onApplySelectedAnchorToAllClips(): Promise<void> {
    const anchor = this.getSelectedAnchor();
    if (!anchor) {
      return;
    }

    this.frameDraft = null;
    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(clip => ({
          ...clip,
          frames: clip.frames.map(frame => ({
            ...frame,
            anchor: { x: anchor.x, y: anchor.y },
          })),
        })),
      }),
      `Apply frame anchor to all clips: ${this.activeClipName}`,
      this.activeClipName
    );
  }

  private async onUpdateSelectedFrameBoundingBox(
    field: 'x' | 'y' | 'width' | 'height',
    value: number
  ): Promise<void> {
    if (!Number.isFinite(value)) {
      return;
    }

    await this.applySelectedFrameUpdate(
      frame => ({
        ...frame,
        boundingBox: {
          ...frame.boundingBox,
          [field]:
            field === 'width' || field === 'height'
              ? Math.max(0, Math.round(value))
              : Math.round(value),
        },
      }),
      `Update frame bounding box: ${this.activeClipName}`
    );
  }

  private async onAddPolygonVertex(): Promise<void> {
    const selectedFrame = this.getSelectedFrame();
    if (!selectedFrame) {
      return;
    }

    const metrics = this.getFrameMetrics(selectedFrame);
    await this.applySelectedFrameUpdate(
      frame => ({
        ...frame,
        collisionPolygon: [
          ...frame.collisionPolygon,
          { x: Math.round(metrics.frameWidth / 2), y: Math.round(metrics.frameHeight / 2) },
        ],
      }),
      `Add frame polygon vertex: ${this.activeClipName}`
    );
  }

  private async onClearPolygon(): Promise<void> {
    await this.applySelectedFrameUpdate(
      frame => ({ ...frame, collisionPolygon: [] }),
      `Clear frame polygon: ${this.activeClipName}`
    );
  }

  private async onResetBoundingBox(): Promise<void> {
    await this.applySelectedFrameUpdate(
      frame => ({
        ...frame,
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      }),
      `Reset frame bounding box: ${this.activeClipName}`
    );
  }

  private onStagePointerDown(event: PointerEvent): void {
    const frame = this.getSelectedFrame();
    if (!frame) {
      return;
    }

    const point = this.getStageLocalPoint(event, frame);
    if (!point) {
      return;
    }

    const target = event.target as HTMLElement | SVGElement;
    const draft = this.cloneFrame(frame);
    this.frameDraft = draft;

    if (this.editMode === 'anchor') {
      draft.anchor = this.toNormalizedAnchor(point, frame);
      this.stageDragState = {
        pointerId: event.pointerId,
        mode: 'anchor',
        origin: point,
      };
    } else if (this.editMode === 'bbox') {
      draft.boundingBox = { x: point.x, y: point.y, width: 0, height: 0 };
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
        draft.collisionPolygon = [...draft.collisionPolygon, point];
        this.stageDragState = {
          pointerId: event.pointerId,
          mode: 'polygon',
          origin: point,
          vertexIndex: draft.collisionPolygon.length - 1,
        };
      }
    }

    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  private onStagePointerMove(event: PointerEvent): void {
    const dragState = this.stageDragState;
    const frame = this.getSelectedFrame();
    if (!dragState || !frame || dragState.pointerId !== event.pointerId || !this.frameDraft) {
      return;
    }

    const point = this.getStageLocalPoint(event, frame);
    if (!point) {
      return;
    }

    if (dragState.mode === 'anchor') {
      this.frameDraft = {
        ...this.frameDraft,
        anchor: this.toNormalizedAnchor(point, frame),
      };
      return;
    }

    if (dragState.mode === 'bbox') {
      const x = Math.min(dragState.origin.x, point.x);
      const y = Math.min(dragState.origin.y, point.y);
      const width = Math.abs(point.x - dragState.origin.x);
      const height = Math.abs(point.y - dragState.origin.y);
      this.frameDraft = {
        ...this.frameDraft,
        boundingBox: { x, y, width, height },
      };
      return;
    }

    const vertexIndex = dragState.vertexIndex ?? -1;
    if (vertexIndex < 0) {
      return;
    }

    const nextPolygon = [...this.frameDraft.collisionPolygon];
    nextPolygon[vertexIndex] = point;
    this.frameDraft = {
      ...this.frameDraft,
      collisionPolygon: nextPolygon,
    };
  }

  private async onStagePointerUp(event: PointerEvent): Promise<void> {
    const dragState = this.stageDragState;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    const draft = this.frameDraft;
    this.stageDragState = null;
    this.frameDraft = null;

    if (!draft) {
      return;
    }

    await this.applySelectedFrameUpdate(
      () => draft,
      `Update frame ${this.editMode}: ${this.activeClipName}`
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

    const metrics = this.getFrameMetrics(frame);
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
    const metrics = this.getFrameMetrics(frame);
    return {
      x: Number((point.x / metrics.frameWidth).toFixed(3)),
      y: Number((point.y / metrics.frameHeight).toFixed(3)),
    };
  }

  private cloneFrame(frame: AnimationFrame): AnimationFrame {
    return {
      ...frame,
      offset: { ...frame.offset },
      repeat: { ...frame.repeat },
      anchor: { ...frame.anchor },
      boundingBox: { ...frame.boundingBox },
      collisionPolygon: frame.collisionPolygon.map(point => ({ ...point })),
    };
  }

  private getSelectedAnimatedSprite(): AnimatedSprite2D | null {
    const primaryNodeId = appState.selection.primaryNodeId;
    if (!primaryNodeId) {
      return null;
    }

    const graph = this.sceneManager.getActiveSceneGraph();
    const node = graph?.nodeMap.get(primaryNodeId);
    return node instanceof AnimatedSprite2D ? node : null;
  }

  private getActiveClip() {
    return this.resource?.clips.find(clip => clip.name === this.activeClipName) ?? null;
  }

  private syncFrameStateToActiveClip(preferFirstFrame = false): void {
    const activeClip = this.getActiveClip();
    const frameCount = activeClip?.frames.length ?? 0;
    const storedFrameIndex = this.getStoredSelectedFrameIndex();
    this.frameDraft = null;
    this.stageDragState = null;

    if (frameCount === 0) {
      this.selectedFrameIndex = -1;
      this.selectedFrameIndices = [];
      this.previewFrameIndex = -1;
      this.previewElapsedSeconds = 0;
      this.selectionAnchorFrameIndex = -1;
      this.persistSelectedFrameIndex(-1);
      return;
    }

    const fallbackIndex = preferFirstFrame
      ? 0
      : this.selectedFrameIndex >= 0
        ? Math.min(this.selectedFrameIndex, frameCount - 1)
        : storedFrameIndex >= 0
          ? Math.min(storedFrameIndex, frameCount - 1)
          : 0;

    this.selectedFrameIndex = fallbackIndex;
    this.selectedFrameIndices = [fallbackIndex];
    this.previewFrameIndex = this.isPreviewPlaying
      ? Math.min(
          this.previewFrameIndex >= 0 ? this.previewFrameIndex : fallbackIndex,
          frameCount - 1
        )
      : fallbackIndex;
    this.previewElapsedSeconds = 0;
    this.selectionAnchorFrameIndex = fallbackIndex;
    this.persistSelectedFrameIndex(fallbackIndex);
  }

  private hasSupportedImageExtension(path: string): boolean {
    const cleaned = path.split('?')[0].split('#')[0];
    const extension = cleaned.includes('.') ? (cleaned.split('.').pop()?.toLowerCase() ?? '') : '';
    return IMAGE_EXTENSIONS.has(extension);
  }

  private resolveAssetPath(): string | null {
    const directResourcePath = this.resourcePath.trim();
    if (directResourcePath) {
      return directResourcePath;
    }

    const tab = this.tabId
      ? appState.tabs.tabs.find(
          candidate => candidate.id === this.tabId && candidate.type === 'animation'
        )
      : null;

    return tab?.resourceId ?? null;
  }

  private normalizeDroppedTextureResource(rawValue: string): string | null {
    const value = rawValue.trim();
    if (!value) {
      return null;
    }

    if (value.startsWith('res://') || value.startsWith('http://') || value.startsWith('https://')) {
      return this.hasSupportedImageExtension(value) ? value : null;
    }

    if (value.includes('://')) {
      return null;
    }

    const normalized = value.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\\+/g, '/');
    const resourcePath = `res://${normalized}`;
    return this.hasSupportedImageExtension(resourcePath) ? resourcePath : null;
  }

  private getDroppedTextureResource(event: DragEvent): string | null {
    const transfer = event.dataTransfer;
    if (!transfer) {
      return null;
    }

    return (
      this.normalizeDroppedTextureResource(transfer.getData(ASSET_RESOURCE_MIME)) ??
      this.normalizeDroppedTextureResource(transfer.getData(ASSET_PATH_MIME)) ??
      this.normalizeDroppedTextureResource(transfer.getData('text/uri-list')) ??
      this.normalizeDroppedTextureResource(transfer.getData('text/plain'))
    );
  }

  private isPotentialTextureDrag(event: DragEvent): boolean {
    const transfer = event.dataTransfer;
    if (!transfer) {
      return false;
    }

    const types = new Set(Array.from(transfer.types));
    if (types.has(FRAME_REORDER_MIME)) {
      return false;
    }

    return (
      types.has(ASSET_RESOURCE_LIST_MIME) ||
      types.has(ASSET_PATH_LIST_MIME) ||
      types.has(ASSET_RESOURCE_MIME) ||
      types.has(ASSET_PATH_MIME) ||
      types.has('text/uri-list') ||
      types.has('text/plain')
    );
  }

  private async syncFromResourceContext(preserveClip: boolean): Promise<void> {
    const nextAssetPath = this.resolveAssetPath();
    const assetChanged = nextAssetPath !== this.assetPath;
    const nextAnimationId = nextAssetPath ? deriveAnimationDocumentId(nextAssetPath) : null;
    const animationChanged = nextAnimationId !== this.animationId;

    this.assetPath = nextAssetPath;
    this.animationId = nextAnimationId;
    this.syncActiveInspectorController();
    await this.syncFromDocumentState(preserveClip && !assetChanged && !animationChanged);
  }

  private async syncFromDocumentState(preserveClip: boolean): Promise<void> {
    const assetPath = this.assetPath;
    const animationId = this.animationId;

    if (!assetPath || !animationId) {
      this.stopPreviewPlayback();
      this.resource = null;
      this.activeClipName = '';
      this.errorMessage = null;
      this.resetCurrentTexturePreview();
      this.syncFrameStateToActiveClip();
      this.syncActiveInspectorController();
      return;
    }

    const resource = appState.animations.resources[animationId] ?? null;
    const isActiveLoadError =
      appState.animations.activeAnimationId === animationId &&
      appState.animations.loadState === 'error';

    this.errorMessage = isActiveLoadError ? appState.animations.loadError : null;

    if (!resource) {
      this.stopPreviewPlayback();
      this.resource = null;
      this.activeClipName = '';
      this.resetCurrentTexturePreview();
      this.syncFrameStateToActiveClip();
      this.syncActiveInspectorController();
      return;
    }

    this.resource = resource;

    const clipNames = new Set(resource.clips.map(clip => clip.name));
    const selectedSprite = this.getSelectedAnimatedSprite();
    const selectedClipName =
      selectedSprite?.animationResourcePath === assetPath ? selectedSprite.currentClip : '';
    const storedClipName = this.getStoredActiveClipName();
    const preferredClipName =
      preserveClip && clipNames.has(this.activeClipName)
        ? this.activeClipName
        : storedClipName && clipNames.has(storedClipName)
          ? storedClipName
          : selectedClipName && clipNames.has(selectedClipName)
            ? selectedClipName
            : (resource.clips[0]?.name ?? '');

    this.activeClipName = preferredClipName;
    this.persistActiveClipName(preferredClipName);
    this.syncFrameStateToActiveClip(!preserveClip);

    await this.syncPreviewTexture();

    this.syncActiveInspectorController();
  }

  private async syncPreviewTexture(): Promise<void> {
    const previewFrame = this.getPreviewFrame();
    const texturePath = this.getResolvedFrameTexturePath(previewFrame);
    this.previewTexturePath = texturePath;
    if (!texturePath) {
      this.resetCurrentTexturePreview();
      return;
    }

    const token = ++this.loadToken;
    const cachedTextureUrl = this.texturePreviewCache.get(texturePath) ?? '';
    const cachedDimensions = this.textureDimensionsCache.get(texturePath) ?? {
      width: 0,
      height: 0,
    };

    if (cachedTextureUrl) {
      this.texturePreviewUrl = cachedTextureUrl;
      this.textureDimensions = cachedDimensions;
      return;
    }

    this.resetCurrentTexturePreview();
    await this.ensureTexturePreviewLoaded(texturePath, token);
  }

  private async ensureTexturePreviewLoaded(
    texturePath: string,
    token = this.loadToken
  ): Promise<void> {
    if (!texturePath) {
      return;
    }

    const inFlight = this.texturePreviewLoads.get(texturePath);
    if (inFlight) {
      await inFlight;
      if (texturePath === this.previewTexturePath && token === this.loadToken) {
        this.texturePreviewUrl = this.texturePreviewCache.get(texturePath) ?? '';
        this.textureDimensions = this.textureDimensionsCache.get(texturePath) ?? {
          width: 0,
          height: 0,
        };
      }
      return;
    }

    const loadPromise = (async () => {
      try {
        const blob = await this.projectStorage.readBlob(texturePath);
        const textureUrl = URL.createObjectURL(blob);
        const dimensions = await this.readTextureDimensions(textureUrl);
        this.texturePreviewCache.set(texturePath, textureUrl);
        this.textureDimensionsCache.set(texturePath, dimensions);

        if (texturePath === this.previewTexturePath && token === this.loadToken) {
          this.texturePreviewUrl = textureUrl;
          this.textureDimensions = dimensions;
        }

        this.requestUpdate();
      } catch {
        if (texturePath === this.previewTexturePath && token === this.loadToken) {
          this.resetCurrentTexturePreview();
        }
      } finally {
        this.texturePreviewLoads.delete(texturePath);
      }
    })();

    this.texturePreviewLoads.set(texturePath, loadPromise);
    await loadPromise;
  }

  private resetCurrentTexturePreview(): void {
    this.texturePreviewUrl = '';
    this.textureDimensions = { width: 0, height: 0 };
  }

  private clearTexturePreviewCache(): void {
    for (const textureUrl of this.texturePreviewCache.values()) {
      if (textureUrl.startsWith('blob:')) {
        URL.revokeObjectURL(textureUrl);
      }
    }

    this.texturePreviewCache.clear();
    this.textureDimensionsCache.clear();
    this.texturePreviewLoads.clear();
    this.previewTexturePath = '';
    this.resetCurrentTexturePreview();
  }

  private readTextureDimensions(textureUrl: string): Promise<TextureDimensions> {
    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => {
        resolve({
          width: image.naturalWidth || image.width || 0,
          height: image.naturalHeight || image.height || 0,
        });
      };
      image.onerror = () => resolve({ width: 0, height: 0 });
      image.src = textureUrl;
    });
  }

  private async applyResourceUpdate(
    updater: (resource: AnimationResource) => AnimationResource,
    label: string,
    nextActiveClipName?: string
  ): Promise<boolean> {
    if (!this.assetPath || !this.resource || !this.animationId) {
      return false;
    }

    const nextResource = updater(this.resource);
    const pushed = await this.operations.invokeAndPush(
      new UpdateAnimationDocumentOperation({
        animationId: this.animationId,
        nextResource,
        label,
      })
    );
    if (!pushed) {
      return false;
    }

    this.resource = normalizeAnimationResource(nextResource);
    const preservedActiveClipName =
      nextActiveClipName ??
      (this.activeClipName && nextResource.clips.some(clip => clip.name === this.activeClipName)
        ? this.activeClipName
        : (nextResource.clips[0]?.name ?? ''));
    this.activeClipName = preservedActiveClipName;
    this.persistActiveClipName(this.activeClipName);
    this.syncFrameStateToActiveClip(Boolean(nextActiveClipName));

    await this.syncPreviewTexture();

    const selectedSprite = this.getSelectedAnimatedSprite();
    if (
      selectedSprite &&
      selectedSprite.animationResourcePath === this.assetPath &&
      this.activeClipName &&
      selectedSprite.currentClip !== this.activeClipName
    ) {
      await this.commandDispatcher.execute(
        new UpdateObjectPropertyCommand({
          nodeId: selectedSprite.nodeId,
          propertyPath: 'currentClip',
          value: this.activeClipName,
        })
      );
    }

    return true;
  }

  private async onSelectClip(clipName: string): Promise<void> {
    this.activeClipName = clipName;
    this.persistActiveClipName(clipName);
    this.syncFrameStateToActiveClip(true);
    const selectedSprite = this.getSelectedAnimatedSprite();
    if (
      selectedSprite &&
      selectedSprite.animationResourcePath === this.assetPath &&
      selectedSprite.currentClip !== clipName
    ) {
      await this.commandDispatcher.execute(
        new UpdateObjectPropertyCommand({
          nodeId: selectedSprite.nodeId,
          propertyPath: 'currentClip',
          value: clipName,
        })
      );
    }
  }

  private async onAddClip(): Promise<void> {
    if (!this.resource) {
      return;
    }

    const existingNames = new Set(this.resource.clips.map(clip => clip.name));
    let index = this.resource.clips.length + 1;
    let nextName = `clip-${index}`;
    while (existingNames.has(nextName)) {
      index += 1;
      nextName = `clip-${index}`;
    }

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: [
          ...resource.clips,
          {
            name: nextName,
            fps: 12,
            loop: true,
            playbackMode: 'normal',
            frames: [],
          },
        ],
      }),
      `Add clip: ${nextName}`,
      nextName
    );
  }

  private async onRemoveClip(): Promise<void> {
    if (!this.resource || !this.activeClipName || this.resource.clips.length === 0) {
      return;
    }

    const confirmed = await this.dialogService.showConfirmation({
      title: 'Delete clip?',
      message: `Remove clip "${this.activeClipName}" from this animation?`,
      confirmLabel: 'Delete clip',
      cancelLabel: 'Cancel',
      isDangerous: true,
    });
    if (!confirmed) {
      return;
    }

    const remainingClips = this.resource.clips.filter(clip => clip.name !== this.activeClipName);
    const nextActiveClipName = remainingClips[0]?.name ?? '';

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.filter(clip => clip.name !== this.activeClipName),
      }),
      `Remove clip: ${this.activeClipName}`,
      nextActiveClipName
    );
  }

  private async onRenameClip(nextName: string): Promise<void> {
    if (!this.resource || !this.activeClipName || !nextName) {
      return;
    }

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(clip =>
          clip.name === this.activeClipName ? { ...clip, name: nextName } : clip
        ),
      }),
      `Rename clip: ${this.activeClipName} -> ${nextName}`,
      nextName
    );
  }

  private async onUpdateClipFps(nextFps: number): Promise<void> {
    if (!Number.isFinite(nextFps) || nextFps <= 0) {
      return;
    }

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(clip =>
          clip.name === this.activeClipName ? { ...clip, fps: Math.round(nextFps) } : clip
        ),
      }),
      `Update clip fps: ${this.activeClipName}`
    );
  }

  private async onUpdateClipLoop(nextLoop: boolean): Promise<void> {
    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(clip =>
          clip.name === this.activeClipName ? { ...clip, loop: nextLoop } : clip
        ),
      }),
      `Update clip loop: ${this.activeClipName}`
    );
  }

  private hasAnyFrames(resource: AnimationResource): boolean {
    return resource.clips.some(clip => clip.frames.length > 0);
  }

  private async onRemoveSelectedFrame(): Promise<void> {
    await this.removeFramesAtIndices(this.getSelectedFrameIndices());
  }

  private async removeFrameAtIndex(frameIndex: number): Promise<void> {
    await this.removeFramesAtIndices([frameIndex]);
  }

  private async removeFramesAtIndices(frameIndices: number[]): Promise<void> {
    const clip = this.getActiveClip();
    const normalizedFrameIndices = [...new Set(frameIndices)]
      .filter(frameIndex => frameIndex >= 0 && frameIndex < (clip?.frames.length ?? 0))
      .sort((left, right) => left - right);

    if (!clip || normalizedFrameIndices.length === 0) {
      return;
    }

    const indexSet = new Set(normalizedFrameIndices);
    const firstRemovedIndex = normalizedFrameIndices[0] ?? -1;
    const isBatchDelete = normalizedFrameIndices.length > 1;

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(existingClip =>
          existingClip.name === this.activeClipName
            ? {
                ...existingClip,
                frames: existingClip.frames.filter((_, index) => !indexSet.has(index)),
              }
            : existingClip
        ),
      }),
      isBatchDelete
        ? `Delete ${normalizedFrameIndices.length} frames: ${this.activeClipName}`
        : `Delete frame ${firstRemovedIndex + 1}: ${this.activeClipName}`,
      this.activeClipName
    );

    const nextClip = this.getActiveClip();
    const nextFrameCount = nextClip?.frames.length ?? 0;
    const nextSelectedIndex =
      nextFrameCount === 0 ? -1 : Math.min(firstRemovedIndex, nextFrameCount - 1);
    this.selectedFrameIndex = nextSelectedIndex;
    this.selectedFrameIndices = nextSelectedIndex >= 0 ? [nextSelectedIndex] : [];
    this.previewFrameIndex = nextSelectedIndex;
    this.selectionAnchorFrameIndex = nextSelectedIndex;
    this.persistSelectedFrameIndex(nextSelectedIndex);
  }

  private async reorderFrame(fromIndex: number, toIndex: number): Promise<void> {
    const clip = this.getActiveClip();
    if (
      !clip ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= clip.frames.length ||
      toIndex >= clip.frames.length ||
      fromIndex === toIndex
    ) {
      return;
    }

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(existingClip => {
          if (existingClip.name !== this.activeClipName) {
            return existingClip;
          }

          const nextFrames = [...existingClip.frames];
          const [movedFrame] = nextFrames.splice(fromIndex, 1);
          if (!movedFrame) {
            return existingClip;
          }
          nextFrames.splice(toIndex, 0, movedFrame);
          return { ...existingClip, frames: nextFrames };
        }),
      }),
      `Reorder frame ${fromIndex + 1} -> ${toIndex + 1}: ${this.activeClipName}`,
      this.activeClipName
    );

    this.selectedFrameIndex = toIndex;
    this.selectedFrameIndices = [toIndex];
    this.previewFrameIndex = toIndex;
    this.selectionAnchorFrameIndex = toIndex;
    this.persistSelectedFrameIndex(toIndex);
  }

  private getSelectedFrameIndices(): number[] {
    if (this.selectedFrameIndices.length > 0) {
      return this.selectedFrameIndices;
    }

    return this.selectedFrameIndex >= 0 ? [this.selectedFrameIndex] : [];
  }

  private async onAddFrameTextures(texturePaths: string[]): Promise<void> {
    if (!this.resource || !this.activeClipName) {
      return;
    }

    const normalizedTexturePaths = texturePaths.map(path => path.trim()).filter(Boolean);
    if (normalizedTexturePaths.length === 0) {
      return;
    }

    const generatedFrames: AnimationFrame[] = normalizedTexturePaths.map(texturePath => ({
      textureIndex: 0,
      offset: { x: 0, y: 0 },
      repeat: { x: 1, y: 1 },
      durationMultiplier: 1,
      anchor: { ...DEFAULT_FRAME_ANCHOR },
      texturePath,
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      collisionPolygon: [],
    }));

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        clips: resource.clips.map(existingClip =>
          existingClip.name === this.activeClipName
            ? { ...existingClip, frames: [...existingClip.frames, ...generatedFrames] }
            : existingClip
        ),
      }),
      `Add ${generatedFrames.length} frame texture${generatedFrames.length === 1 ? '' : 's'}: ${this.activeClipName}`,
      this.activeClipName
    );
  }

  private parseDroppedTextureResources(rawValue: string): string[] | null {
    if (!rawValue.trim()) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (!Array.isArray(parsed)) {
        return null;
      }

      const texturePaths = parsed
        .map(value =>
          typeof value === 'string' ? this.normalizeDroppedTextureResource(value) : null
        )
        .filter((value): value is string => Boolean(value));

      return texturePaths.length > 0 ? texturePaths : null;
    } catch {
      return null;
    }
  }

  private getDroppedTextureResources(event: DragEvent): string[] {
    const transfer = event.dataTransfer;
    if (!transfer) {
      return [];
    }

    const parsedResources =
      this.parseDroppedTextureResources(transfer.getData(ASSET_RESOURCE_LIST_MIME)) ??
      this.parseDroppedTextureResources(transfer.getData(ASSET_PATH_LIST_MIME));
    if (parsedResources && parsedResources.length > 0) {
      return parsedResources;
    }

    const singleResource = this.getDroppedTextureResource(event);
    return singleResource ? [singleResource] : [];
  }

  private async onAddFramesFromGrid(
    columns: number = this.slicerColumns,
    rows: number = this.slicerRows
  ): Promise<void> {
    const clip = this.getActiveClip();
    const texturePath = this.resource?.texturePath?.trim() ?? '';
    if (!clip || columns <= 0 || rows <= 0 || !texturePath) {
      return;
    }

    const generatedTexturePaths = await this.sliceSpritesheetIntoFrameFiles(
      texturePath,
      columns,
      rows,
      clip.frames.length + 1
    );
    const generatedFrames: AnimationFrame[] = generatedTexturePaths.map(textureResourcePath => ({
      textureIndex: 0,
      offset: { x: 0, y: 0 },
      repeat: { x: 1, y: 1 },
      durationMultiplier: 1,
      anchor: { ...DEFAULT_FRAME_ANCHOR },
      texturePath: textureResourcePath,
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      collisionPolygon: [],
    }));

    await this.applyResourceUpdate(
      resource => ({
        ...resource,
        texturePath: '',
        clips: resource.clips.map(existingClip =>
          existingClip.name === this.activeClipName
            ? { ...existingClip, frames: [...existingClip.frames, ...generatedFrames] }
            : existingClip
        ),
      }),
      `Slice spritesheet into ${generatedFrames.length} frames`
    );
  }

  private async sliceSpritesheetIntoFrameFiles(
    texturePath: string,
    columns: number,
    rows: number,
    startFrameNumber: number
  ): Promise<string[]> {
    const assetPath = this.assetPath ? normalizeAnimationAssetPath(this.assetPath) : '';
    if (!assetPath) {
      return [];
    }

    const sourceBlob = await this.projectStorage.readBlob(texturePath);
    const sourceUrl = URL.createObjectURL(sourceBlob);

    try {
      const image = await this.loadImageElement(sourceUrl);
      const cellWidth = image.naturalWidth / columns;
      const cellHeight = image.naturalHeight / rows;
      const generatedPaths: string[] = [];

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const frameCanvas = document.createElement('canvas');
          frameCanvas.width = Math.max(1, Math.round(cellWidth));
          frameCanvas.height = Math.max(1, Math.round(cellHeight));

          const context = frameCanvas.getContext('2d');
          if (!context) {
            throw new Error('Failed to create 2D canvas context while slicing spritesheet.');
          }

          context.clearRect(0, 0, frameCanvas.width, frameCanvas.height);
          context.drawImage(
            image,
            column * cellWidth,
            row * cellHeight,
            cellWidth,
            cellHeight,
            0,
            0,
            frameCanvas.width,
            frameCanvas.height
          );

          const frameBlob = await this.canvasToBlob(frameCanvas);
          const framePath = buildAnimationFrameResourcePath(
            assetPath,
            startFrameNumber + generatedPaths.length
          );
          await this.projectStorage.writeBinaryFile(framePath, await frameBlob.arrayBuffer());
          generatedPaths.push(framePath);
        }
      }

      return generatedPaths;
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  }

  private loadImageElement(sourceUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Failed to load image from ${sourceUrl}`));
      image.src = sourceUrl;
    });
  }

  private canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error('Failed to encode sliced frame to PNG.'));
      }, 'image/png');
    });
  }

  private async onUpdateTexturePath(nextTexturePath: string): Promise<void> {
    const trimmedTexturePath = nextTexturePath.trim();
    const currentResource = this.resource;
    const shouldPromptForAutoSlice =
      Boolean(trimmedTexturePath) &&
      currentResource !== null &&
      !this.hasAnyFrames(currentResource);

    const didMutate = await this.applyResourceUpdate(
      resource => ({
        ...resource,
        texturePath: trimmedTexturePath,
      }),
      trimmedTexturePath ? `Update spritesheet: ${trimmedTexturePath}` : 'Clear spritesheet texture'
    );

    if (!didMutate || !trimmedTexturePath || !shouldPromptForAutoSlice) {
      return;
    }

    await this.openSlicerDialog(trimmedTexturePath);
  }

  private async openSlicerDialog(texturePath: string): Promise<void> {
    const clipName = this.activeClipName || this.resource?.clips[0]?.name || 'idle';
    const result = await this.animationAutoSliceDialogService.showDialog({
      texturePath,
      clipName,
      defaultColumns: this.slicerColumns,
      defaultRows: this.slicerRows,
    });

    if (!result) {
      return;
    }

    this.slicerColumns = result.columns;
    this.slicerRows = result.rows;
    await this.onAddFramesFromGrid(result.columns, result.rows);
  }

  private getStoredActiveClipName(): string {
    if (!this.tabId) {
      return '';
    }

    const tab = appState.tabs.tabs.find(candidate => candidate.id === this.tabId);
    const storedClipName = tab?.contextState?.activeClipName;
    return typeof storedClipName === 'string' ? storedClipName : '';
  }

  private getStoredSelectedFrameIndex(): number {
    if (!this.tabId) {
      return -1;
    }

    const tab = appState.tabs.tabs.find(candidate => candidate.id === this.tabId);
    const storedFrameIndex = tab?.contextState?.selectedFrameIndex;
    return typeof storedFrameIndex === 'number' && Number.isInteger(storedFrameIndex)
      ? storedFrameIndex
      : -1;
  }

  private persistActiveClipName(clipName: string): void {
    if (!this.tabId) {
      return;
    }

    const tab = appState.tabs.tabs.find(candidate => candidate.id === this.tabId);
    if (!tab) {
      return;
    }

    const currentClipName = tab.contextState?.activeClipName;
    if (currentClipName === clipName) {
      return;
    }

    tab.contextState = {
      ...(tab.contextState ?? {}),
      activeClipName: clipName,
    };
  }

  private persistSelectedFrameIndex(selectedFrameIndex: number): void {
    if (!this.tabId) {
      return;
    }

    const tab = appState.tabs.tabs.find(candidate => candidate.id === this.tabId);
    if (!tab) {
      return;
    }

    if (tab.contextState?.selectedFrameIndex === selectedFrameIndex) {
      return;
    }

    tab.contextState = {
      ...(tab.contextState ?? {}),
      selectedFrameIndex,
    };
  }

  private syncActiveInspectorController(): void {
    const isActiveAnimationTab =
      Boolean(this.assetPath) && Boolean(this.tabId) && appState.tabs.activeTabId === this.tabId;

    if (isActiveAnimationTab) {
      this.animationEditorService.setActiveController(this);
      return;
    }

    if (this.animationEditorService.getActiveController() === this) {
      this.animationEditorService.setActiveController(null);
    }
  }

  private notifyInspectorListeners(): void {
    for (const listener of this.inspectorListeners) {
      listener();
    }
  }

  getInspectorSnapshot(): AnimationInspectorSnapshot {
    const activeClip = this.getActiveClip();
    return {
      assetPath: this.assetPath,
      resource: this.resource,
      clips: this.resource?.clips ?? [],
      activeClip,
      activeClipName: this.activeClipName,
      selectedFrame: this.getSelectedFrame(activeClip),
      selectedFrameIndex: this.selectedFrameIndex,
    };
  }

  subscribeInspector(listener: () => void): () => void {
    this.inspectorListeners.add(listener);
    return () => this.inspectorListeners.delete(listener);
  }

  async updateTexturePath(value: string): Promise<void> {
    await this.onUpdateTexturePath(value);
  }

  async openTextureSlicer(): Promise<void> {
    const texturePath = this.resource?.texturePath?.trim() ?? '';
    if (!texturePath) {
      return;
    }

    await this.openSlicerDialog(texturePath);
  }

  async selectClip(clipName: string): Promise<void> {
    await this.onSelectClip(clipName);
  }

  async addClip(): Promise<void> {
    await this.onAddClip();
  }

  async removeClip(): Promise<void> {
    await this.onRemoveClip();
  }

  async renameClip(nextName: string): Promise<void> {
    await this.onRenameClip(nextName);
  }

  async updateClipFps(nextFps: number): Promise<void> {
    await this.onUpdateClipFps(nextFps);
  }

  async updateClipPlaybackMode(mode: AnimationPlaybackMode): Promise<void> {
    await this.onUpdateClipPlaybackMode(mode);
  }

  async updateClipLoop(nextLoop: boolean): Promise<void> {
    await this.onUpdateClipLoop(nextLoop);
  }

  async updateSelectedFrameDurationMultiplier(value: number): Promise<void> {
    await this.onUpdateSelectedFrameDurationMultiplier(value);
  }

  async updateSelectedFrameTexturePath(value: string): Promise<void> {
    await this.onUpdateSelectedFrameTexturePath(value);
  }

  async updateSelectedFrameAnchor(axis: 'x' | 'y', value: number): Promise<void> {
    await this.onUpdateSelectedFrameAnchor(axis, value);
  }

  async updateSelectedFrameBoundingBox(
    field: 'x' | 'y' | 'width' | 'height',
    value: number
  ): Promise<void> {
    await this.onUpdateSelectedFrameBoundingBox(field, value);
  }

  async addPolygonVertex(): Promise<void> {
    await this.onAddPolygonVertex();
  }

  async clearPolygon(): Promise<void> {
    await this.onClearPolygon();
  }

  async resetBoundingBox(): Promise<void> {
    await this.onResetBoundingBox();
  }

  private onEditorDragEnter(event: DragEvent): void {
    if (!this.isPotentialTextureDrag(event)) {
      return;
    }

    this.textureDragDepth += 1;
    this.isTextureDragOver = true;
  }

  private onEditorDragOver(event: DragEvent): void {
    if (!this.isPotentialTextureDrag(event)) {
      return;
    }

    event.preventDefault();
    this.isTextureDragOver = true;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  private onEditorDragLeave(event: DragEvent): void {
    if (!this.isPotentialTextureDrag(event)) {
      return;
    }

    this.textureDragDepth = Math.max(0, this.textureDragDepth - 1);
    if (this.textureDragDepth === 0) {
      this.isTextureDragOver = false;
    }
  }

  private async onEditorDrop(event: DragEvent): Promise<void> {
    if (!this.isPotentialTextureDrag(event)) {
      return;
    }

    event.preventDefault();
    this.textureDragDepth = 0;
    this.isTextureDragOver = false;

    const texturePaths = this.getDroppedTextureResources(event);
    if (texturePaths.length === 0) {
      return;
    }

    await this.onAddFrameTextures(texturePaths);
  }

  private onFrameDragStart(event: DragEvent, frameIndex: number): void {
    if (!event.dataTransfer) {
      return;
    }

    if (!this.selectedFrameIndices.includes(frameIndex) || this.selectedFrameIndices.length > 1) {
      this.selectedFrameIndices = [frameIndex];
      this.selectedFrameIndex = frameIndex;
      this.previewFrameIndex = frameIndex;
      this.selectionAnchorFrameIndex = frameIndex;
      this.persistSelectedFrameIndex(frameIndex);
    }

    this.draggedFrameIndex = frameIndex;
    this.dragOverFrameIndex = frameIndex;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(FRAME_REORDER_MIME, String(frameIndex));
    event.dataTransfer.setData('text/plain', String(frameIndex));
  }

  private onFrameDragOver(event: DragEvent, frameIndex: number): void {
    if (this.draggedFrameIndex < 0) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.dragOverFrameIndex = frameIndex;
  }

  private onFrameDragLeave(frameIndex: number): void {
    if (this.dragOverFrameIndex === frameIndex) {
      this.dragOverFrameIndex = -1;
    }
  }

  private async onFrameDrop(event: DragEvent, frameIndex: number): Promise<void> {
    if (this.draggedFrameIndex < 0) {
      return;
    }

    event.preventDefault();
    const fromIndex = this.draggedFrameIndex;
    this.draggedFrameIndex = -1;
    this.dragOverFrameIndex = -1;
    await this.reorderFrame(fromIndex, frameIndex);
  }

  private onFrameDragEnd(): void {
    this.draggedFrameIndex = -1;
    this.dragOverFrameIndex = -1;
  }

  private async onDeleteFrameClick(event: Event, frameIndex: number): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    await this.removeFrameAtIndex(frameIndex);
  }

  private async onDeleteFrameKeyDown(event: KeyboardEvent, frameIndex: number): Promise<void> {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    await this.removeFrameAtIndex(frameIndex);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-animation-panel': AnimationPanel;
  }
}
