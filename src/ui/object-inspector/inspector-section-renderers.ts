import { html } from '@/fw';
import type { PropertyDefinition } from '@/fw';
import { appState } from '@/state';
import { MeshInstance, getPropertiesByGroup, isShaderEffectHost } from '@pix3/runtime';
import type { AnimationClip, AnimationFrame, ScriptComponent } from '@pix3/runtime';
import type {
  AnimationInspectorController,
  AnimationInspectorSnapshot,
} from '@/services/animation/AnimationEditorService';
import {
  ANIMATION_CLIP_PROPERTIES,
  ANIMATION_FRAME_PROPERTIES,
  ANIMATION_RESOURCE_PROPERTIES,
  type AnimationClipPropertyTarget,
  type AnimationFramePropertyTarget,
  type AnimationResourcePropertyTarget,
} from './animation-inspector-properties';
import { getNodeVisuals } from '@/ui/scene-tree/node-visuals.helper';
import { isPrefabChildNode, isPrefabNode } from '@/features/scene/prefab-utils';
import { AddNodeToGroupCommand } from '@/features/scene/AddNodeToGroupCommand';
import { RemoveNodeFromGroupCommand } from '@/features/scene/RemoveNodeFromGroupCommand';
import { AddComponentCommand } from '@/features/scripts/AddComponentCommand';
import { RemoveComponentCommand } from '@/features/scripts/RemoveComponentCommand';
import { ToggleScriptEnabledCommand } from '@/features/scripts/ToggleScriptEnabledCommand';
import { AddEffectCommand } from '@/features/effects/AddEffectCommand';
import { RemoveEffectCommand } from '@/features/effects/RemoveEffectCommand';
import type { InspectorPanel } from './inspector-panel';
import type { DetachedPropertyOptions } from './inspector-property-renderers';

/**
 * Per-row overrides for the frame property rows: the bounding-box size takes the
 * W/H chips the Size group uses (X/Y would read as a position), and the override
 * field keeps its "optional" placeholder.
 */
const ANIMATION_FRAME_PROPERTY_OPTIONS: Readonly<Record<string, DetachedPropertyOptions>> = {
  animationFrameTexturePath: { placeholder: 'Optional per-frame texture' },
  animationFrameBoundingBoxSize: { axes: ['w', 'h'] },
};

/**
 * Renders the inspector's top-level sections (animation/asset inspectors,
 * summary + groups, editor flags, animations, scripts, effects) and owns their
 * command-dispatching actions. Reads panel state/services through the host
 * reference and delegates per-property rendering back to the panel.
 */
export class InspectorSectionRenderers {
  constructor(private readonly host: InspectorPanel) {}

  syncActiveAnimationContext(): void {
    const controller = this.host.animationEditorService.getActiveController();
    if (controller !== this.host.activeAnimationController) {
      this.host.disposeAnimationControllerSubscription?.();
      this.host.disposeAnimationControllerSubscription = undefined;
      this.host.activeAnimationController = controller;

      if (controller) {
        this.host.disposeAnimationControllerSubscription = controller.subscribeInspector(() => {
          this.host.activeAnimationState = controller.getInspectorSnapshot();
        });
      }
    }

    this.host.activeAnimationState = controller?.getInspectorSnapshot() ?? null;
  }

  /**
   * Animation Inspector (a `.pix3anim` document bound by the Sprite Editor shell).
   *
   * Built on the same property machinery as a node section: clip/frame editors are
   * {@link PropertyDefinition}s rendered through `renderDetachedProperty`, sections
   * come from `renderPropertySection`, and the current clip/frame carry the
   * accent-token selected treatment the rest of the editor's lists use. The only
   * bespoke rows are read-only identity values (Name/Path) and the action buttons —
   * neither is an editable property.
   */
  renderAnimationProperties() {
    const controller = this.host.activeAnimationController;
    const animationState = this.host.activeAnimationState;
    if (!controller || !animationState) {
      return '';
    }

    const assetPath = animationState.assetPath;
    const activeClip = animationState.activeClip;
    const selectedFrame = animationState.selectedFrame;

    return html`
      <div class="property-section property-section--animation">
        <div class="section-header">
          <h3 class="section-title">Animation Inspector</h3>
          <p class="node-type">PIX3ANIM</p>
        </div>

        ${assetPath ? this.renderAnimationResourceSection(assetPath) : ''}
        ${this.renderAnimationImportSection(controller, animationState)}
        ${this.renderAnimationClipsSection(controller, animationState)}
        ${activeClip
          ? this.renderAnimationClipSection(controller, activeClip)
          : this.host.propertyRenderers.renderPropertySection(
              'Clip',
              html`<div class="asset-text-preview-state">No active clip selected.</div>`,
              { hideTitle: true }
            )}
        ${selectedFrame
          ? this.renderAnimationFrameSection(controller, animationState, selectedFrame)
          : this.host.propertyRenderers.renderPropertySection(
              'Frame',
              html`<div class="asset-text-preview-state">
                Pick a frame in the timeline to edit delay, anchor, bounding box, and polygon data.
              </div>`,
              { hideTitle: true }
            )}
      </div>
    `;
  }

  private renderAnimationResourceSection(assetPath: string) {
    return this.host.propertyRenderers.renderPropertySection(
      'Resource',
      html`
        <div class="property-group">
          <span class="property-label">Name</span>
          <span class="asset-value">${this.getAnimationAssetTitle(assetPath)}</span>
        </div>
        <div class="property-group">
          <span class="property-label">Path</span>
          <span class="asset-value asset-path">${assetPath}</span>
        </div>
      `
    );
  }

  private renderAnimationImportSection(
    controller: AnimationInspectorController,
    animationState: AnimationInspectorSnapshot
  ) {
    const texturePath = animationState.resource?.texturePath?.trim() ?? '';
    const target: AnimationResourcePropertyTarget = { controller, texturePath };

    return this.host.propertyRenderers.renderPropertySection(
      'Spritesheet Import',
      html`
        <div class="group-header">
          <h4 class="group-title">Spritesheet Import</h4>
          ${texturePath ? html`<span class="animation-chip">Source</span>` : ''}
        </div>
        ${ANIMATION_RESOURCE_PROPERTIES.map(prop =>
          this.host.propertyRenderers.renderDetachedProperty(prop, target, {
            placeholder: 'res://textures/spritesheet.png',
          })
        )}
        <div class="inspector-button-row">
          <button
            class="inspector-button inspector-button--primary"
            type="button"
            ?disabled=${texturePath.length === 0 || !animationState.activeClipName}
            @click=${() => void controller.openTextureSlicer()}
          >
            ${this.host.iconService.getIcon('grid', 13)}
            <span>Generate Frames</span>
          </button>
          <button
            class="inspector-button"
            type="button"
            ?disabled=${texturePath.length === 0}
            @click=${() => void controller.updateTexturePath('')}
          >
            ${this.host.iconService.getIcon('x', 13)}
            <span>Clear Texture</span>
          </button>
        </div>
        <p class="panel-note">
          Use this only as a one-time import source. The editor stores sequence frames as separate
          files after slicing.
        </p>
      `,
      { hideTitle: true }
    );
  }

  private renderAnimationClipsSection(
    controller: AnimationInspectorController,
    animationState: AnimationInspectorSnapshot
  ) {
    const clips = animationState.clips;

    return this.host.propertyRenderers.renderPropertySection(
      'Clips',
      html`
        <div class="group-header">
          <h4 class="group-title">Clips</h4>
          <div class="animation-clip-actions">
            <button
              class="btn-icon"
              type="button"
              title="Add Clip"
              aria-label="Add clip"
              @click=${() => void controller.addClip()}
            >
              ${this.host.iconService.getIcon('plus', 14)}
            </button>
            <button
              class="btn-icon"
              type="button"
              title="Remove"
              aria-label="Remove active clip"
              ?disabled=${!animationState.activeClip}
              @click=${() => void controller.removeClip()}
            >
              ${this.host.iconService.getIcon('trash-2', 14)}
            </button>
          </div>
        </div>
        <div class="animation-clip-list">
          ${clips.map(clip => {
            const isSelected = clip.name === animationState.activeClipName;
            return html`
              <button
                class="animation-clip-button ${isSelected ? 'is-selected' : ''}"
                type="button"
                data-clip-name=${clip.name}
                aria-current=${isSelected ? 'true' : 'false'}
                @click=${() => void controller.selectClip(clip.name)}
              >
                <span class="animation-clip-marker" aria-hidden="true">
                  ${isSelected ? this.host.iconService.getIcon('check', 12) : ''}
                </span>
                <span class="animation-clip-name">${clip.name}</span>
                <span class="animation-clip-meta"
                  >${clip.frames.length} ${clip.frames.length === 1 ? 'frame' : 'frames'}</span
                >
              </button>
            `;
          })}
          ${clips.length === 0
            ? html`<div class="asset-text-preview-state">No clips in this resource yet.</div>`
            : ''}
        </div>
      `,
      { hideTitle: true }
    );
  }

  private renderAnimationClipSection(
    controller: AnimationInspectorController,
    activeClip: AnimationClip
  ) {
    const target: AnimationClipPropertyTarget = { controller, clip: activeClip };

    return this.host.propertyRenderers.renderPropertySection(
      'Clip',
      html`
        <div class="group-header">
          <h4 class="group-title">Clip</h4>
          <span class="animation-chip animation-chip--selected">${activeClip.name}</span>
        </div>
        ${ANIMATION_CLIP_PROPERTIES.map(prop =>
          this.host.propertyRenderers.renderDetachedProperty(prop, target)
        )}
      `,
      { className: 'animation-clip-section', hideTitle: true }
    );
  }

  private renderAnimationFrameSection(
    controller: AnimationInspectorController,
    animationState: AnimationInspectorSnapshot,
    selectedFrame: AnimationFrame
  ) {
    const target: AnimationFramePropertyTarget = { controller, frame: selectedFrame };
    const frameNumber = animationState.selectedFrameIndex + 1;
    const frameCount = animationState.activeClip?.frames.length ?? 0;
    const vertexCount = selectedFrame.collisionPolygon.length;

    return this.host.propertyRenderers.renderPropertySection(
      'Frame',
      html`
        <div
          class="animation-frame-indicator"
          data-frame-index=${animationState.selectedFrameIndex}
        >
          <span class="animation-frame-indicator-text">
            <span class="animation-frame-indicator-title"
              >Frame ${frameNumber} of ${frameCount}</span
            >
            <span class="animation-frame-indicator-sub">${animationState.activeClipName}</span>
          </span>
        </div>
        ${ANIMATION_FRAME_PROPERTIES.map(prop =>
          this.host.propertyRenderers.renderDetachedProperty(
            prop,
            target,
            ANIMATION_FRAME_PROPERTY_OPTIONS[prop.name] ?? {}
          )
        )}
        <div class="group-header group-header--sub">
          <h5 class="group-subtitle">Collision Polygon</h5>
          <span class="animation-clip-meta">
            ${vertexCount ? `${vertexCount} vertices` : 'none authored'}
          </span>
        </div>
        <div class="inspector-button-row">
          <button
            class="inspector-button"
            type="button"
            @click=${() => void controller.addPolygonVertex()}
          >
            ${this.host.iconService.getIcon('plus', 13)}
            <span>Add Vertex</span>
          </button>
          <button
            class="inspector-button"
            type="button"
            ?disabled=${vertexCount === 0}
            @click=${() => void controller.clearPolygon()}
          >
            ${this.host.iconService.getIcon('x', 13)}
            <span>Clear Polygon</span>
          </button>
          <button
            class="inspector-button"
            type="button"
            @click=${() => void controller.resetBoundingBox()}
          >
            ${this.host.iconService.getIcon('refresh-cw', 13)}
            <span>Reset Box</span>
          </button>
        </div>
      `,
      { className: 'animation-frame-section', hideTitle: true }
    );
  }

  getAnimationAssetTitle(assetPath: string): string {
    const segments = assetPath.replace(/\\/g, '/').split('/').filter(Boolean);
    return segments[segments.length - 1] ?? assetPath;
  }

  renderAssetProperties() {
    if (!this.host.selectedAssetItem) {
      return '';
    }

    const asset = this.host.selectedAssetItem;
    const isImage = asset.previewType === 'image' && asset.thumbnailUrl !== null;
    const isModel = asset.previewType === 'model';
    const isAudio = asset.previewType === 'audio';
    const isText = asset.previewType === 'text';
    const textPreview = isText
      ? this.host.resourcePreview.getTextAssetPreview(asset.path, asset.previewText)
      : null;
    const resourceUrl = asset.path === '.' ? 'res://' : `res://${asset.path}`;

    return html`
      <div class="property-section">
        <div class="section-header">
          <h3 class="section-title">Asset Inspector</h3>
          <p class="node-type">${asset.extension ? asset.extension.toUpperCase() : 'FILE'}</p>
        </div>

        <div class="property-group-section asset-section">
          <h4 class="group-title">Preview</h4>
          ${isModel
            ? html`
                <pix3-model-asset-preview
                  .resourcePath=${resourceUrl}
                  .assetName=${asset.name}
                  .fallbackImageUrl=${asset.thumbnailUrl ?? ''}
                  .thumbnailStatus=${asset.thumbnailStatus}
                ></pix3-model-asset-preview>
              `
            : isAudio
              ? html`
                  <pix3-audio-resource-editor
                    .resourceUrl=${resourceUrl}
                    .previewUrl=${asset.previewUrl ?? ''}
                    .waveformUrl=${asset.thumbnailUrl ?? ''}
                    .durationSeconds=${asset.durationSeconds ?? 0}
                    .channelCount=${asset.channelCount ?? 0}
                    .sampleRate=${asset.sampleRate ?? 0}
                    .fileSize=${asset.sizeBytes ?? 0}
                    .showResourceControls=${false}
                  ></pix3-audio-resource-editor>
                `
              : isText
                ? html`
                    <div class="asset-text-preview-shell">
                      ${textPreview?.isLoading && !textPreview.content
                        ? html`<div class="asset-text-preview-state">Loading content...</div>`
                        : textPreview?.error
                          ? html`<div
                              class="asset-text-preview-state asset-text-preview-state--error"
                            >
                              ${textPreview.error}
                            </div>`
                          : html`<pre class="asset-text-preview">
${textPreview?.content || 'Empty file'}</pre
                            >`}
                    </div>
                  `
                : isImage
                  ? html`
                      <div class="asset-image-preview checker-bg">
                        <img src=${asset.thumbnailUrl!} alt=${asset.name} />
                      </div>
                    `
                  : html`
                      <div class="asset-file-icon">
                        ${this.host.iconService.getIcon(asset.iconName, 42)}
                      </div>
                    `}
        </div>

        <div class="property-group-section asset-section">
          <h4 class="group-title">Properties</h4>
          <div class="property-group">
            <span class="property-label">Name</span>
            <span class="asset-value">${asset.name}</span>
          </div>

          <div class="property-group">
            <span class="property-label" title="Resource URL (res://)">Resource</span>
            <div class="asset-value-wrapper">
              <span class="asset-value asset-path">${resourceUrl}</span>
              <button
                class="btn-copy-resource"
                title="Copy Resource URL"
                @click=${() => this.host.handleCopyResourceUrl(resourceUrl)}
              >
                ${this.host.iconService.getIcon('copy', 14)}
              </button>
            </div>
          </div>

          <div class="property-group">
            <span class="property-label">Path</span>
            <span class="asset-value asset-path">${asset.path}</span>
          </div>
          ${asset.width !== null && asset.height !== null
            ? html`
                <div class="property-group">
                  <span class="property-label">Resolution</span>
                  <span class="asset-value">${asset.width} x ${asset.height}</span>
                </div>
              `
            : ''}
          ${isAudio && asset.durationSeconds !== null
            ? html`
                <div class="property-group">
                  <span class="property-label">Duration</span>
                  <span class="asset-value">${this.formatDuration(asset.durationSeconds)}</span>
                </div>
              `
            : ''}
          ${isAudio && asset.channelCount !== null
            ? html`
                <div class="property-group">
                  <span class="property-label">Channels</span>
                  <span class="asset-value">${asset.channelCount}</span>
                </div>
              `
            : ''}
          ${isAudio && asset.sampleRate !== null
            ? html`
                <div class="property-group">
                  <span class="property-label">Sample Rate</span>
                  <span class="asset-value">${this.formatSampleRate(asset.sampleRate)}</span>
                </div>
              `
            : ''}
          ${isText && textPreview !== null && textPreview.lineCount !== null
            ? html`
                <div class="property-group">
                  <span class="property-label">Lines</span>
                  <span class="asset-value">${textPreview.lineCount}</span>
                </div>
              `
            : ''}
          <div class="property-group">
            <span class="property-label">Size</span>
            <span class="asset-value">${this.formatFileSize(asset.sizeBytes)}</span>
          </div>
        </div>
      </div>
    `;
  }

  formatFileSize(sizeBytes: number | null): string {
    if (sizeBytes === null) {
      return '-';
    }
    if (sizeBytes < 1024) {
      return `${sizeBytes} B`;
    }
    const kb = sizeBytes / 1024;
    if (kb < 1024) {
      return `${kb.toFixed(1)} KB`;
    }
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  }

  formatDuration(durationSeconds: number | null): string {
    if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
      return '-';
    }

    const totalSeconds = Math.round(durationSeconds);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  formatSampleRate(sampleRate: number | null): string {
    if (sampleRate === null || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      return '-';
    }

    const khz = sampleRate / 1000;
    return `${khz % 1 === 0 ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
  }

  renderInspectorSummary() {
    if (!this.host.primaryNode) {
      return '';
    }

    const { icon, color } = getNodeVisuals(this.host.primaryNode);
    const nameState = this.host.propertyValues['name'];
    const groups = Array.from(this.host.primaryNode.groups).sort((a, b) => a.localeCompare(b));
    const nameProp = this.host.propertySchema?.properties.find(prop => prop.name === 'name');
    // Renaming a prefab instance child breaks the effectiveLocalId keys that
    // property overrides are stored under, so lock it. The instance root keeps an
    // editable name (it is serialized on the `instance:` definition).
    const nameReadOnly =
      this.host.propertyRenderers.isPropertyReadOnly(
        nameProp?.ui?.readOnly,
        this.host.primaryNode
      ) || isPrefabChildNode(this.host.primaryNode);

    return html`
      <div class="inspector-summary">
        <div class="inspector-summary-main">
          <div class="inspector-type-icon" style=${`--node-type-color: ${color};`}>
            ${this.host.iconService.getIcon(icon, 18)}
          </div>
          <div class="inspector-summary-text">
            <input
              type="text"
              class="property-input property-input--text inspector-name-input ${nameState?.isValid ===
              false
                ? 'property-input--invalid'
                : ''}"
              .value=${nameState?.value ?? this.host.primaryNode.name}
              ?disabled=${nameReadOnly}
              @input=${(e: Event) => this.host.handlePropertyInput('name', e)}
              @blur=${(e: Event) => this.host.handlePropertyBlur('name', e)}
            />
            <div class="inspector-summary-meta">
              <span class="inspector-summary-type">${this.host.primaryNode.type}</span>
              <span class="inspector-summary-meta-separator"></span>
              <span class="inspector-summary-id">${this.host.primaryNode.nodeId}</span>
              ${this.host.isPlaying
                ? html`
                    <span class="inspector-summary-meta-separator"></span>
                    <span
                      class="inspector-live-badge ${this.host.isLivePlayMode
                        ? ''
                        : 'inspector-live-badge--static'}"
                      title=${this.host.isLivePlayMode
                        ? 'Read-only live values from the running game (play mode)'
                        : 'Read-only during play mode — no live runtime counterpart for this node'}
                      >${this.host.isLivePlayMode ? 'PLAY · LIVE' : 'PLAY · READ-ONLY'}</span
                    >
                  `
                : ''}
              ${this.host.selectedNodes.length > 1
                ? html`
                    <span class="inspector-summary-meta-separator"></span>
                    <span class="selection-info">
                      ${this.host.selectedNodes.length} objects selected
                    </span>
                  `
                : ''}
            </div>
            ${groups.length > 0
              ? html`
                  <div class="group-chip-list group-chip-list--summary">
                    ${groups.map(
                      group => html`<span class="group-chip group-chip--readonly">${group}</span>`
                    )}
                  </div>
                `
              : ''}
          </div>
        </div>

        <div class="inspector-summary-actions">
          <button
            class="summary-toolbar-button ${this.host.isGroupsEditorOpen ? 'is-open' : ''}"
            type="button"
            title="Edit groups"
            aria-expanded=${String(this.host.isGroupsEditorOpen)}
            @click=${(event: Event) => this.toggleGroupsEditor(event)}
          >
            ${this.host.iconService.getIcon('grid', 14)}
            <span>Groups</span>
            ${this.host.iconService.getIcon('chevron-down-caret', 12)}
          </button>
          ${this.host.isGroupsEditorOpen ? this.renderGroupsPopover() : ''}
        </div>
      </div>
    `;
  }

  renderGroupsPopover() {
    if (!this.host.primaryNode) {
      return '';
    }

    const groups = Array.from(this.host.primaryNode.groups).sort((a, b) => a.localeCompare(b));
    return html`
      <div class="groups-popover" @click=${(event: Event) => event.stopPropagation()}>
        <div class="groups-popover-list">
          ${groups.length === 0
            ? html`<div class="groups-empty">No groups assigned</div>`
            : groups.map(
                group => html`
                  <div class="groups-popover-item">
                    <span class="group-chip group-chip--readonly">${group}</span>
                    <button
                      class="btn-icon"
                      type="button"
                      title="Remove from group"
                      @click=${() => this.removeFromGroup(group)}
                    >
                      ${this.host.iconService.getIcon('x', 14)}
                    </button>
                  </div>
                `
              )}
        </div>
        <div class="group-add-row group-add-row--popover">
          <input
            class="property-input property-input--text group-input"
            .value=${this.host.newGroupName}
            placeholder="group_name"
            @input=${(e: Event) => this.onGroupNameInput(e)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void this.addToGroup();
              }
            }}
          />
          <button class="btn-add-group" type="button" @click=${() => this.addToGroup()}>Add</button>
        </div>
        ${this.host.newGroupError
          ? html`<div class="groups-error">${this.host.newGroupError}</div>`
          : ''}
      </div>
    `;
  }

  toggleGroupsEditor(event: Event): void {
    event.stopPropagation();
    this.host.isGroupsEditorOpen = !this.host.isGroupsEditorOpen;
  }

  renderEditorFlagsRow() {
    if (!this.host.primaryNode) {
      return '';
    }

    const visible = this.host.propertyValues['visible']?.value === 'true';
    const locked = this.host.propertyValues['locked']?.value === 'true';
    // Play mode is a read-only live mirror — gate these flags like every other
    // property editor so they can't silently mutate the authored node.
    const readOnly = appState.collaboration.isReadOnly || appState.ui.isPlaying;

    return html`
      <div class="property-group-section property-group-section--flags">
        <div class="editor-flags-row">
          <button
            class="editor-flag-button ${visible ? 'is-active' : ''}"
            type="button"
            ?disabled=${readOnly}
            aria-pressed=${String(visible)}
            @click=${() => this.host.applyPropertyChange('visible', !visible)}
          >
            ${this.host.iconService.getIcon('eye', 14)}
            <span>Visible</span>
          </button>
          <button
            class="editor-flag-button ${locked ? 'is-active' : ''}"
            type="button"
            ?disabled=${readOnly}
            aria-pressed=${String(locked)}
            @click=${() => this.host.applyPropertyChange('locked', !locked)}
          >
            ${this.host.iconService.getIcon(locked ? 'lock' : 'unlock', 14)}
            <span>Locked</span>
          </button>
        </div>
      </div>
    `;
  }

  renderAnimationsSection() {
    if (!(this.host.primaryNode instanceof MeshInstance)) return '';
    const clips = this.host.primaryNode.animations;
    if (clips.length === 0) return '';
    const initialAnimation = this.host.primaryNode.initialAnimation;

    return html`
      <div class="property-group-section animations-section">
        <h4 class="group-title">Animations</h4>
        <div class="animation-list">
          ${clips.map(clip => {
            const isActive = this.host.activePreviewAnimation === clip.name;
            const isDefault = initialAnimation === clip.name;
            return html`
              <div class="animation-item ${isActive ? 'animation-item--active' : ''}">
                <button
                  class="animation-preview-btn"
                  @click=${() => this.toggleAnimation(clip.name)}
                  title=${isActive ? 'Stop preview animation' : 'Play preview animation'}
                >
                  <span class="animation-play-icon"
                    >${this.host.iconService.getIcon(isActive ? 'stop' : 'play', 12)}</span
                  >
                  <span class="animation-name">${clip.name}</span>
                  <span class="animation-duration">${clip.duration.toFixed(2)}s</span>
                </button>
                <button
                  class="animation-default-btn ${isDefault ? 'animation-default-btn--active' : ''}"
                  @click=${() => this.setInitialAnimation(clip.name)}
                  title=${isDefault
                    ? 'Default startup animation'
                    : 'Set as default startup animation'}
                >
                  ${isDefault ? 'Default' : 'Set Default'}
                </button>
              </div>
            `;
          })}
        </div>
        <div class="animation-default-row">
          <button
            class="animation-default-clear"
            @click=${() => this.setInitialAnimation(null)}
            ?disabled=${initialAnimation === null}
            title="Clear default startup animation (fallback to first clip)"
          >
            Clear Default
          </button>
        </div>
      </div>
    `;
  }

  setInitialAnimation(name: string | null): void {
    const value = name ?? '';
    void this.host.applyPropertyChange('initialAnimation', value);
  }

  toggleAnimation(name: string) {
    if (!this.host.primaryNode) return;
    const next = this.host.activePreviewAnimation === name ? null : name;
    this.host.activePreviewAnimation = next;
    this.host.viewportService.setPreviewAnimation(this.host.primaryNode.nodeId, next);
  }

  onGroupNameInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.host.newGroupName = input.value;
    this.host.newGroupError = null;
  }

  async addToGroup(): Promise<void> {
    if (!this.host.primaryNode) {
      return;
    }

    const groupName = this.host.newGroupName.trim();
    if (!/^[A-Za-z0-9_]+$/.test(groupName)) {
      this.host.newGroupError = 'Use letters, numbers, and underscores only.';
      return;
    }

    const command = new AddNodeToGroupCommand({
      nodeId: this.host.primaryNode.nodeId,
      group: groupName,
    });
    const didMutate = await this.host.commandDispatcher.execute(command);
    if (!didMutate) {
      this.host.newGroupError =
        'Group update failed. Check project/scene state and duplicate names.';
      return;
    }

    this.host.newGroupName = '';
    this.host.newGroupError = null;
  }

  async removeFromGroup(group: string): Promise<void> {
    if (!this.host.primaryNode) {
      return;
    }
    const command = new RemoveNodeFromGroupCommand({
      nodeId: this.host.primaryNode.nodeId,
      group,
    });
    await this.host.commandDispatcher.execute(command);
  }

  renderScriptsSection() {
    if (!this.host.primaryNode) return '';

    const components = this.host.primaryNode.components || [];
    // Components on a prefab instance node are not serialized as overrides, so
    // adding/removing/toggling them here would be silently lost on save. Lock the
    // structural actions on every node of an instance (root included).
    const structureLocked = isPrefabNode(this.host.primaryNode);
    const lockedTitle = 'Managed by the prefab — open the prefab to edit its components';

    return html`
      <div class="property-group-section scripts-section">
        <div class="group-header">
          <h4 class="group-title">Components</h4>
          <div class="group-actions">
            <button
              class="btn-add-behavior"
              @click=${() => this.onAddBehavior()}
              ?disabled=${structureLocked}
              title=${structureLocked ? lockedTitle : 'Add Component'}
            >
              ${this.host.iconService.getIcon('plus', 14)}
              <span>Add</span>
            </button>
          </div>
        </div>

        <div class="scripts-list">
          ${components.map(component => {
            const isUserScript = component.type.startsWith('user:');
            return html`
              <div class="component-block ${component.enabled ? '' : 'component-block--disabled'}">
                <div
                  class="script-item component-item ${isUserScript
                    ? 'component-item--openable'
                    : ''}"
                  title=${isUserScript ? 'Double-click to open script file' : ''}
                  @dblclick=${isUserScript
                    ? () => this.onOpenComponentScript(component.type)
                    : null}
                >
                  <div class="script-icon">
                    ${this.host.iconService.getIcon(this.getComponentIconName(component.type), 16)}
                  </div>
                  <div class="script-info">
                    <div class="script-name">${component.type}</div>
                  </div>
                  <div class="script-actions">
                    <button
                      class="component-action-link"
                      type="button"
                      ?disabled=${structureLocked}
                      title=${structureLocked ? lockedTitle : ''}
                      @click=${() => this.onToggleComponent(component.id, !component.enabled)}
                    >
                      ${component.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      class="component-action-link component-action-link--danger"
                      type="button"
                      ?disabled=${structureLocked}
                      title=${structureLocked ? lockedTitle : ''}
                      @click=${() => this.onRemoveComponent(component.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                ${this.renderComponentProperties(component)}
              </div>
            `;
          })}
          ${components.length === 0
            ? html`<div class="no-scripts">No components attached</div>`
            : ''}
        </div>
      </div>
    `;
  }

  renderComponentProperties(component: ScriptComponent) {
    const schema = this.host.scriptRegistry.getComponentPropertySchema(component.type);
    if (!schema || schema.properties.length === 0) {
      return html`<div class="script-props-empty">No editable properties</div>`;
    }

    const groupedProps = getPropertiesByGroup(schema);
    const sortedGroups = Array.from(groupedProps.entries()).sort(([groupA], [groupB]) =>
      groupA.localeCompare(groupB)
    );

    return html`
      <div class="script-props">
        ${sortedGroups.map(([groupName, props]) => {
          const groupDef = schema.groups?.[groupName];
          const label = groupDef?.label ?? groupName;
          const visibleProps = props.filter(prop => !prop.ui?.hidden);
          if (visibleProps.length === 0) {
            return '';
          }
          return html`
            <div class="script-prop-group">
              <div class="script-prop-group-title">${label}</div>
              ${visibleProps.map(prop =>
                this.host.propertyRenderers.renderComponentPropertyInput(component, prop)
              )}
            </div>
          `;
        })}
      </div>
    `;
  }

  getComponentIconName(componentType: string): string {
    if (componentType.startsWith('user:')) {
      return 'code';
    }
    return 'zap';
  }

  async onAddBehavior() {
    if (!this.host.primaryNode) return;

    const component = await this.host.behaviorPickerService.showPicker();
    if (component) {
      const componentId = `${component.id}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const command = new AddComponentCommand({
        nodeId: this.host.primaryNode.nodeId,
        componentType: component.id,
        componentId,
      });
      void this.host.commandDispatcher.execute(command);
    }
  }

  /**
   * Double-clicking a user script component opens its source file in a code tab.
   * Core (`core:`) components are engine built-ins with no project file, so they no-op.
   */
  onOpenComponentScript(componentType: string): void {
    if (!componentType.startsWith('user:')) return;

    const scriptName = componentType.slice('user:'.length).trim();
    if (!scriptName) return;

    void this.host.editorTabService.focusOrOpenCode(`res://scripts/${scriptName}.ts`);
  }

  onRemoveComponent(componentId: string) {
    if (!this.host.primaryNode) return;

    const command = new RemoveComponentCommand({
      nodeId: this.host.primaryNode.nodeId,
      componentId,
    });
    void this.host.commandDispatcher.execute(command);
  }

  onToggleComponent(componentId: string, enabled: boolean) {
    if (!this.host.primaryNode) return;

    const command = new ToggleScriptEnabledCommand({
      nodeId: this.host.primaryNode.nodeId,
      componentId,
      enabled,
    });
    void this.host.commandDispatcher.execute(command);
  }

  renderEffectsSection() {
    const node = this.host.primaryNode;
    if (!node || !isShaderEffectHost(node)) return '';

    const effects = node.getShaderEffectStack().getAttached();
    // Effect attach/remove/toggle on a prefab instance is not serialized as an
    // override, so lock the structural actions (mirrors the components section).
    const structureLocked = isPrefabNode(node);
    const lockedTitle = 'Managed by the prefab — open the prefab to edit its effects';
    const groupedProps = this.host.propertySchema
      ? getPropertiesByGroup(this.host.propertySchema)
      : new Map<string, PropertyDefinition[]>();

    return html`
      <div class="property-group-section scripts-section">
        <div class="group-header">
          <h4 class="group-title">Effects</h4>
          <div class="group-actions">
            <button
              class="btn-add-behavior"
              @click=${() => this.onAddEffect()}
              ?disabled=${structureLocked}
              title=${structureLocked ? lockedTitle : 'Add Effect'}
            >
              ${this.host.iconService.getIcon('plus', 14)}
              <span>Add</span>
            </button>
          </div>
        </div>

        <div class="scripts-list">
          ${effects.map(effect => {
            const group = `Effect: ${effect.info.displayName}`;
            const params = (groupedProps.get(group) ?? []).filter(
              p => p.name !== `fx.${effect.info.key}.enabled` && !p.ui?.hidden
            );
            return html`
              <div class="component-block ${effect.enabled ? '' : 'component-block--disabled'}">
                <div class="script-item component-item">
                  <div class="script-icon">${this.host.iconService.getIcon('zap', 16)}</div>
                  <div class="script-info">
                    <div class="script-name">${effect.info.displayName}</div>
                  </div>
                  <div class="script-actions">
                    <button
                      class="component-action-link"
                      type="button"
                      ?disabled=${structureLocked}
                      title=${structureLocked ? lockedTitle : ''}
                      @click=${() => this.onToggleEffect(effect.type, !effect.enabled)}
                    >
                      ${effect.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      class="component-action-link component-action-link--danger"
                      type="button"
                      ?disabled=${structureLocked}
                      title=${structureLocked ? lockedTitle : ''}
                      @click=${() => this.onRemoveEffect(effect.type)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                ${params.length > 0
                  ? html`<div class="script-props">
                      ${params.map(p => this.host.propertyRenderers.renderPropertyInput(p))}
                    </div>`
                  : html`<div class="script-props-empty">No editable properties</div>`}
              </div>
            `;
          })}
          ${effects.length === 0 ? html`<div class="no-scripts">No effects attached</div>` : ''}
        </div>
      </div>
    `;
  }

  async onAddEffect() {
    const node = this.host.primaryNode;
    if (!node || !isShaderEffectHost(node)) return;
    const stack = node.getShaderEffectStack();
    const exclude = stack.getAttached().map(e => e.type);
    const effectType = await this.host.effectPickerService.showPicker(
      exclude,
      stack.materialTarget
    );
    if (effectType) {
      void this.host.commandDispatcher.execute(
        new AddEffectCommand({ nodeId: node.nodeId, effectType })
      );
    }
  }

  onRemoveEffect(effectType: string) {
    if (!this.host.primaryNode) return;
    void this.host.commandDispatcher.execute(
      new RemoveEffectCommand({ nodeId: this.host.primaryNode.nodeId, effectType })
    );
  }

  onToggleEffect(effectType: string, enabled: boolean) {
    const node = this.host.primaryNode;
    if (!node || !isShaderEffectHost(node)) return;
    const effect = node
      .getShaderEffectStack()
      .getAttached()
      .find(e => e.type === effectType);
    if (!effect) return;
    void this.host.applyPropertyChange(`fx.${effect.info.key}.enabled`, enabled);
  }
}
