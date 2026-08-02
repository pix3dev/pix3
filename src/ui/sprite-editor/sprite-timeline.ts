import { ComponentBase, customElement, html, inject, property } from '@/fw';
import { IconService } from '@/services/editor/IconService';
import { FRAME_REORDER_MIME } from '@/ui/shared/asset-drag-drop';
import { isSequenceAnimationFrame, type AnimationClip, type AnimationFrame } from '@pix3/runtime';

import type { AnimationDocumentController } from './animation-document-controller';
import {
  getDroppedImageFiles,
  getDroppedTextureResources,
  isPotentialTextureDrag,
} from './frame-texture-drop';

import './sprite-timeline.ts.css';

/**
 * The frame strip of an animation document: the preview transport, one card per
 * frame of the active clip, frame selection, per-card delete, reorder
 * drag-and-drop and insert-on-drop of dropped textures.
 *
 * Takes an {@link AnimationDocumentController} reference and emits **no** data
 * events: selection, playback state and every mutation are controller state that
 * the shell already observes through `subscribe()`, so an event channel would
 * create a second, driftable source of truth. What this component does own is the
 * rAF ticker that drives preview playback — the clock is a DOM concern, while
 * *when* a frame flips is shared state on the controller (the stage renders
 * `previewFrameIndex` too).
 */
@customElement('pix3-sprite-timeline')
export class SpriteTimeline extends ComponentBase {
  @property({ attribute: false })
  controller: AnimationDocumentController | null = null;

  @inject(IconService)
  private readonly iconService!: IconService;

  private boundController: AnimationDocumentController | null = null;
  private disposeControllerSubscription?: () => void;
  private playbackFrameHandle: number | null = null;
  private playbackLastTimestamp: number | null = null;
  private draggedFrameIndex = -1;
  private dragOverFrameIndex = -1;

  connectedCallback(): void {
    super.connectedCallback();
    this.bindController();
  }

  protected willUpdate(changedProperties: Map<PropertyKey, unknown>): void {
    if (changedProperties.has('controller')) {
      this.bindController();
    }
  }

  disconnectedCallback(): void {
    this.unbindController();
    super.disconnectedCallback();
  }

  protected render() {
    const controller = this.controller;
    if (!controller) {
      return null;
    }

    const activeClip = controller.activeClip;
    const clipFrames = activeClip?.frames ?? [];

    return html`
      ${this.renderTransport(controller, clipFrames.length)}
      ${this.renderFrameStrip(controller, activeClip, clipFrames)}
    `;
  }

  private renderTransport(controller: AnimationDocumentController, frameCount: number) {
    return html`
      <div class="timeline-transport" aria-label="Animation preview transport">
        ${this.renderTransportButton(
          controller.isPreviewPlaying ? 'pause' : 'play',
          controller.isPreviewPlaying ? 'Pause playback' : 'Play preview',
          () => controller.togglePlayback(),
          frameCount === 0
        )}
        ${this.renderTransportButton(
          'stop',
          'Stop playback',
          () => controller.stopPlaybackAndRewind(),
          frameCount === 0
        )}
        ${this.renderClipTiming(controller)}
      </div>
    `;
  }

  /**
   * Clip timing beside the transport: frame rate, looping and ping-pong. The very
   * same controller methods the Inspector's animation section calls, so the two
   * surfaces cannot drift — this one is here because the frame strip is where you
   * are looking while you tune playback.
   */
  private renderClipTiming(controller: AnimationDocumentController) {
    const activeClip = controller.activeClip;
    if (!activeClip) {
      return null;
    }

    const isPingPong = activeClip.playbackMode === 'ping-pong';
    return html`
      <label class="timeline-fps" title="Frames per second">
        <span class="timeline-fps-label">FPS</span>
        <input
          class="timeline-fps-input"
          type="number"
          min="1"
          max="240"
          step="1"
          .value=${String(activeClip.fps)}
          aria-label="Clip frames per second"
          @change=${(event: Event) =>
            void controller.updateClipFps(Number((event.target as HTMLInputElement).value))}
        />
      </label>
      ${this.renderTransportToggle(
        'repeat',
        'Loop the clip',
        activeClip.loop,
        () => void controller.updateClipLoop(!activeClip.loop)
      )}
      ${this.renderTransportToggle(
        'ping-pong',
        'Ping-pong playback',
        isPingPong,
        () => void controller.updateClipPlaybackMode(isPingPong ? 'normal' : 'ping-pong')
      )}
    `;
  }

  private renderTransportToggle(
    iconName: string,
    title: string,
    active: boolean,
    onClick: () => void
  ) {
    return html`
      <button
        class="editor-toolbar-button ${active ? 'is-active' : ''}"
        type="button"
        title=${title}
        aria-label=${title}
        aria-pressed=${active ? 'true' : 'false'}
        @click=${onClick}
      >
        <span class="editor-toolbar-button-icon">${this.iconService.getIcon(iconName, 16)}</span>
      </button>
    `;
  }

  private renderTransportButton(
    iconName: string,
    title: string,
    onClick: () => void,
    disabled = false
  ) {
    return html`
      <button
        class="editor-toolbar-button"
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

  private renderFrameStrip(
    controller: AnimationDocumentController,
    activeClip: AnimationClip | null,
    clipFrames: AnimationFrame[]
  ) {
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
        ${clipFrames.map((frame, index) => this.renderFrameCard(controller, frame, index))}
      </div>
    `;
  }

  private renderFrameCard(
    controller: AnimationDocumentController,
    frame: AnimationFrame,
    index: number
  ) {
    const imageStyle = getFrameImageStyle(frame);
    const previewTextureUrl = controller.getTexturePreviewUrl(frame);
    const isSelected = controller.selectedFrameIndices.includes(index);
    const isPreviewFrame = index === controller.previewFrameIndex;
    const isDropTarget = index === this.dragOverFrameIndex && this.draggedFrameIndex !== index;

    return html`
      <button
        class="frame-card ${isSelected ? 'is-selected' : ''} ${isPreviewFrame
          ? 'is-preview'
          : ''} ${isDropTarget ? 'is-drop-target' : ''}"
        type="button"
        title=${`Frame ${index + 1} · ${this.getFrameDurationLabel(controller, frame)}`}
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

  private getFrameDurationLabel(
    controller: AnimationDocumentController,
    frame: AnimationFrame
  ): string {
    const activeClip = controller.activeClip;
    if (!activeClip) {
      return 'No timing';
    }

    return `${controller.getFrameDurationSeconds(activeClip, frame).toFixed(3)}s`;
  }

  // --- controller binding ----------------------------------------------------

  /**
   * Subscribe to the controller handed in as a property. Called from
   * `connectedCallback` as well as on property change so a Golden Layout re-dock
   * (disconnect → reconnect with the same controller) rebinds.
   */
  private bindController(): void {
    if (this.boundController === this.controller && this.disposeControllerSubscription) {
      return;
    }

    this.unbindController();
    const controller = this.controller;
    if (!controller) {
      return;
    }

    this.boundController = controller;
    this.disposeControllerSubscription = controller.subscribe(() => this.onControllerChanged());
    this.syncPlaybackTicker();
  }

  private unbindController(): void {
    this.stopPlaybackTicker();
    this.disposeControllerSubscription?.();
    this.disposeControllerSubscription = undefined;
    this.boundController = null;
  }

  private onControllerChanged(): void {
    this.syncPlaybackTicker();
    this.requestUpdate();
  }

  // --- preview playback clock ------------------------------------------------

  private syncPlaybackTicker(): void {
    if (this.controller?.isPreviewPlaying) {
      this.startPlaybackTicker();
      return;
    }

    this.stopPlaybackTicker();
  }

  private startPlaybackTicker(): void {
    if (this.playbackFrameHandle !== null) {
      return;
    }

    this.playbackLastTimestamp = null;

    const tick = (timestamp: number) => {
      const controller = this.controller;
      if (!controller?.isPreviewPlaying) {
        return;
      }

      this.playbackFrameHandle = requestAnimationFrame(tick);
      if (!controller.activeClip || !controller.previewFrame) {
        return;
      }

      if (this.playbackLastTimestamp === null) {
        this.playbackLastTimestamp = timestamp;
        return;
      }

      const deltaSeconds = (timestamp - this.playbackLastTimestamp) / 1000;
      this.playbackLastTimestamp = timestamp;
      controller.advancePlayback(deltaSeconds);
    };

    this.playbackFrameHandle = requestAnimationFrame(tick);
  }

  private stopPlaybackTicker(): void {
    if (this.playbackFrameHandle !== null) {
      cancelAnimationFrame(this.playbackFrameHandle);
      this.playbackFrameHandle = null;
    }

    this.playbackLastTimestamp = null;
  }

  // --- selection, delete, drag & drop ----------------------------------------

  private onSelectFrame(event: MouseEvent, index: number): void {
    this.controller?.selectFrame(index, {
      shift: event.shiftKey,
      ctrl: event.ctrlKey || event.metaKey,
    });
  }

  private onFrameDragStart(event: DragEvent, frameIndex: number): void {
    if (!event.dataTransfer) {
      return;
    }

    this.controller?.selectFrameForDrag(frameIndex);

    this.draggedFrameIndex = frameIndex;
    this.dragOverFrameIndex = frameIndex;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(FRAME_REORDER_MIME, String(frameIndex));
    event.dataTransfer.setData('text/plain', String(frameIndex));
  }

  private onFrameDragOver(event: DragEvent, frameIndex: number): void {
    const isReorder = this.draggedFrameIndex >= 0;
    if (!isReorder && !isPotentialTextureDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = isReorder ? 'move' : 'copy';
    }
    this.dragOverFrameIndex = frameIndex;
  }

  private onFrameDragLeave(frameIndex: number): void {
    if (this.dragOverFrameIndex === frameIndex) {
      this.dragOverFrameIndex = -1;
    }
  }

  private async onFrameDrop(event: DragEvent, frameIndex: number): Promise<void> {
    const controller = this.controller;
    if (!controller) {
      return;
    }

    if (this.draggedFrameIndex >= 0) {
      event.preventDefault();
      const fromIndex = this.draggedFrameIndex;
      this.draggedFrameIndex = -1;
      this.dragOverFrameIndex = -1;
      await controller.reorderFrame(fromIndex, frameIndex);
      return;
    }

    // Not a reorder: an asset or OS file dropped onto a card inserts new frames before it.
    if (!isPotentialTextureDrag(event.dataTransfer)) {
      return;
    }

    // The editor shell listens for drops too (they append); a card drop inserts,
    // so it must not also bubble.
    event.preventDefault();
    event.stopPropagation();
    this.dragOverFrameIndex = -1;

    const droppedFiles = getDroppedImageFiles(event.dataTransfer);
    const texturePaths =
      droppedFiles.length > 0
        ? await controller.importOsFiles(droppedFiles)
        : getDroppedTextureResources(event.dataTransfer);
    if (texturePaths.length === 0) {
      return;
    }

    await controller.addFrameTextures(texturePaths, frameIndex);
  }

  private onFrameDragEnd(): void {
    this.draggedFrameIndex = -1;
    this.dragOverFrameIndex = -1;
  }

  private async onDeleteFrameClick(event: Event, frameIndex: number): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    await this.controller?.removeFrames([frameIndex]);
  }

  private async onDeleteFrameKeyDown(event: KeyboardEvent, frameIndex: number): Promise<void> {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    await this.controller?.removeFrames([frameIndex]);
  }
}

/**
 * Window a frame's texture into its card/stage box. Sequence frames fill it; a
 * UV-window frame (`offset`/`repeat`) scales and shifts the raster so only its
 * cell shows. Shared with the animation stage, which windows the same way — until
 * C4 gives it a home next to the other stage view helpers.
 */
export function getFrameImageStyle(frame: AnimationFrame): string {
  if (isSequenceAnimationFrame(frame)) {
    return 'width:100%; height:100%; left:0; top:0;';
  }

  const scaleX = frame.repeat.x > 0 ? 100 / frame.repeat.x : 100;
  const scaleY = frame.repeat.y > 0 ? 100 / frame.repeat.y : 100;
  const left = frame.repeat.x > 0 ? -(frame.offset.x / frame.repeat.x) * 100 : 0;
  const top = frame.repeat.y > 0 ? -(frame.offset.y / frame.repeat.y) * 100 : 0;
  return `width:${scaleX}%; height:${scaleY}%; left:${left}%; top:${top}%;`;
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-sprite-timeline': SpriteTimeline;
  }
}
