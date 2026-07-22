import { html } from '@/fw';
import type { PropertyDefinition } from '@/fw';
import { appState } from '@/state';
import { Group2D, Node2D, Sprite2D, UIControl2D, getPropertiesByGroup } from '@pix3/runtime';
import type { NodeBase, ScriptComponent } from '@pix3/runtime';
import { ResizeGroup2DCommand } from '@/features/properties/ResizeGroup2DCommand';
import { FitGroup2DToContentsCommand } from '@/features/scene/FitGroup2DToContentsCommand';
import { UpdateLocaleEntryCommand } from '@/features/localization/UpdateLocaleEntryCommand';
import {
  findPrefabInstanceRoot,
  getPrefabMetadata,
  isInstancePlacementProperty,
  isPrefabNode,
  type PrefabMetadata,
} from '@/features/scene/prefab-utils';
import type { InspectorPanel } from './inspector-panel';

interface SelectOption {
  value: string;
  label: string;
}

type ReadOnlyValue = boolean | ((target: unknown) => boolean) | undefined;
type PropertySectionOptions = {
  className?: string;
  hideTitle?: boolean;
};

const PROPERTY_GROUP_ORDER = [
  'Transform',
  'Patch',
  'Size',
  'Slice',
  'Tile',
  'Anchor',
  'Style',
  'Sprite',
  'Animation',
];
const PROPERTY_GROUP_ORDER_INDEX = new Map(
  PROPERTY_GROUP_ORDER.map((groupName, index) => [groupName, index])
);

export function getPropertyDisplayValue(target: unknown, prop: PropertyDefinition): string {
  const value = prop.getValue(target);

  if (prop.type === 'number') {
    const num = Number(value);
    if (Number.isNaN(num)) return '0';
    const precision = prop.ui?.precision ?? 2;
    return parseFloat(num.toFixed(precision)).toString();
  }

  if (prop.type === 'boolean') {
    return String(value === true);
  }

  if (
    prop.type === 'vector2' ||
    prop.type === 'vector3' ||
    prop.type === 'vector4' ||
    prop.type === 'euler' ||
    prop.type === 'object'
  ) {
    return JSON.stringify(value);
  }

  return String(value ?? '');
}

export function getComponentPropertyKey(componentId: string, propertyName: string): string {
  return `${componentId}:${propertyName}`;
}

/**
 * Scrub sensitivity (units per pixel) for a property's drag-to-scrub fields.
 * Pixel-space transforms (position/size) scrub far faster than their small
 * keyboard step; scale/opacity stay fine. `0` lets the field derive from step.
 */
export function getScrubSensitivity(prop: PropertyDefinition): number {
  switch (prop.name) {
    case 'position':
    case 'width':
    case 'height':
      return 0.5;
    case 'rotation':
      return 0.5;
    case 'scale':
      return 0.01;
    default:
      return 0;
  }
}

/**
 * Renders the inspector's per-node property editors: the grouped property list,
 * transform/size/anchor groups, component + effect property inputs, the
 * localization-key editor, and prefab-override affordances. Reads panel
 * state/services and routes every edit back through the panel's mutation
 * handlers via the host reference.
 */
export class InspectorPropertyRenderers {
  constructor(private readonly host: InspectorPanel) {}

  renderProperties() {
    if (!this.host.primaryNode || !this.host.propertySchema) {
      return '';
    }

    const groupedProps = getPropertiesByGroup(this.host.propertySchema);
    const baseProps = groupedProps.get('Base') ?? [];
    const editorProps = groupedProps.get('Editor') ?? [];
    const summaryPropertyNames = new Set(['id', 'name', 'type', 'groups']);
    const editorFlagNames = new Set(['visible', 'locked']);

    const supplementaryProps = [...baseProps, ...editorProps].filter(
      prop =>
        !summaryPropertyNames.has(prop.name) && !editorFlagNames.has(prop.name) && !prop.ui?.hidden
    );

    const sortedGroups = Array.from(groupedProps.entries())
      // 'Effect: *' groups come from the instance schema and are rendered as
      // cards by renderEffectsSection, not as plain property groups.
      .filter(
        ([groupName]) =>
          groupName !== 'Base' && groupName !== 'Editor' && !groupName.startsWith('Effect: ')
      )
      .sort(([nameA], [nameB]) => {
        const orderA = PROPERTY_GROUP_ORDER_INDEX.get(nameA) ?? PROPERTY_GROUP_ORDER.length;
        const orderB = PROPERTY_GROUP_ORDER_INDEX.get(nameB) ?? PROPERTY_GROUP_ORDER.length;

        if (orderA !== orderB) {
          return orderA - orderB;
        }

        return nameA.localeCompare(nameB);
      });

    return html`
      <div class="property-section property-section--object">
        ${this.host.sectionRenderers.renderInspectorSummary()}
        ${this.host.sectionRenderers.renderEditorFlagsRow()}
        ${supplementaryProps.length > 0
          ? html`
              <div class="property-group-section property-group-section--compact">
                ${supplementaryProps.map(prop => this.renderPropertyInput(prop))}
              </div>
            `
          : ''}
        ${sortedGroups.map(([groupName, props]) => this.renderPropertyGroup(groupName, props))}
        ${this.host.sectionRenderers.renderAnimationsSection()}
        ${this.host.sectionRenderers.renderEffectsSection()}
        ${this.host.sectionRenderers.renderScriptsSection()}
      </div>
    `;
  }

  renderPropertyGroup(groupName: string, props: PropertyDefinition[]) {
    const groupDef = this.host.propertySchema?.groups?.[groupName];
    const label = groupDef?.label || groupName;

    const visibleProps = props.filter(p => !p.ui?.hidden);

    if (visibleProps.length === 0) {
      return '';
    }

    if (groupName === 'Transform') {
      return this.renderTransformGroup(label, visibleProps);
    }

    if (groupName === 'Anchor' && this.host.primaryNode instanceof Node2D) {
      return this.renderAnchorGroup('Align', visibleProps);
    }

    if (groupName === 'Size') {
      return this.renderSizeGroup(label, visibleProps);
    }

    return this.renderPropertySection(
      label,
      visibleProps.map(prop => this.renderPropertyInput(prop)),
      {
        hideTitle: groupName === 'Style' && visibleProps.length === 1,
      }
    );
  }

  renderAnchorGroup(label: string, _props: PropertyDefinition[]) {
    if (!this.host.primaryNode || !(this.host.primaryNode instanceof Node2D)) {
      return '';
    }

    const enabled =
      this.host.propertyValues['layoutEnabled']?.value === 'true' ||
      this.host.primaryNode.layoutEnabled;
    // Play mode is a read-only live mirror — gate the anchor toggle/edges/mode
    // buttons so they can't silently mutate the authored node during play.
    const readOnly = appState.collaboration.isReadOnly || appState.ui.isPlaying;
    const horizontal =
      this.host.propertyValues['horizontalAlign']?.value ?? this.host.primaryNode.horizontalAlign;
    const vertical =
      this.host.propertyValues['verticalAlign']?.value ?? this.host.primaryNode.verticalAlign;
    const previewClass = `anchor-preview anchor-preview--h-${horizontal} anchor-preview--v-${vertical}`;

    return this.renderPropertySection(
      label,
      html`
        <div class="anchor-section-header">
          <h4 class="group-title">${label}</h4>
          <button
            class=${`anchor-toggle-button ${enabled ? 'is-active' : ''}`}
            type="button"
            title=${enabled ? 'Disable anchor layout' : 'Enable anchor layout'}
            aria-label=${enabled ? 'Disable anchor layout' : 'Enable anchor layout'}
            ?disabled=${readOnly}
            @click=${() => this.host.applyPropertyChange('layoutEnabled', !enabled)}
          >
            ${this.host.iconService.getIcon('anchor', 14)}
            <span>${enabled ? 'Enabled' : 'Disabled'}</span>
          </button>
        </div>
        ${enabled
          ? html`
              <div class="anchor-visual-editor">
                <div class="anchor-preview-shell">
                  <div class="anchor-preview-frame">
                    <div class=${previewClass}></div>
                    ${this.renderAnchorPreviewEdge('left', horizontal, vertical, readOnly)}
                    ${this.renderAnchorPreviewEdge('right', horizontal, vertical, readOnly)}
                    ${this.renderAnchorPreviewEdge('top', horizontal, vertical, readOnly)}
                    ${this.renderAnchorPreviewEdge('bottom', horizontal, vertical, readOnly)}
                    ${this.renderAnchorPreviewEdge('center', horizontal, vertical, readOnly)}
                  </div>
                </div>
                <div class="anchor-controls">
                  <div class="anchor-control-row">
                    <span class="anchor-axis-label">H</span>
                    <div class="anchor-mode-group">
                      ${['left', 'center', 'right', 'stretch'].map(option =>
                        this.renderAnchorModeButton(
                          'horizontal',
                          option,
                          horizontal,
                          enabled,
                          readOnly
                        )
                      )}
                    </div>
                  </div>
                  <div class="anchor-control-row">
                    <span class="anchor-axis-label">V</span>
                    <div class="anchor-mode-group">
                      ${['top', 'center', 'bottom', 'stretch'].map(option =>
                        this.renderAnchorModeButton('vertical', option, vertical, enabled, readOnly)
                      )}
                    </div>
                  </div>
                </div>
              </div>
            `
          : ''}
      `,
      {
        className: 'anchor-section anchor-section--visual',
        hideTitle: true,
      }
    );
  }

  renderTransformGroup(label: string, props: PropertyDefinition[]) {
    if (!this.host.primaryNode) {
      return '';
    }

    return this.renderPropertySection(
      label,
      props.map(prop => this.renderTransformProperty(prop)),
      {
        className: 'transform-section',
      }
    );
  }

  renderTransformProperty(prop: PropertyDefinition) {
    if (
      this.host.primaryNode instanceof Node2D &&
      prop.name === 'rotation' &&
      prop.type === 'number'
    ) {
      const state = this.host.propertyValues[prop.name];
      if (!state) {
        return '';
      }

      const label = prop.ui?.label || prop.name;
      const readOnly = this.isPropertyReadOnly(prop.ui?.readOnly, this.host.primaryNode);
      const isOverridden = this.isPropertyOverriddenForPrimaryNode(prop);

      return html`
        <div class="property-group property-group--transform-single-axis">
          ${this.renderPropertyLabel(
            prop,
            `${label}${prop.ui?.unit ? ` (${prop.ui.unit})` : ''}`,
            isOverridden
          )}
          <div class="transform-single-axis-editor">
            <pix3-number-field
              axis="z"
              .value=${Number.parseFloat(state.value) || 0}
              .step=${prop.ui?.step ?? 0.1}
              .precision=${prop.ui?.precision ?? 1}
              .sensitivity=${getScrubSensitivity(prop)}
              ?disabled=${readOnly}
              @preview-change=${(e: CustomEvent<{ value: number }>) =>
                this.host.previewPropertyChange(prop.name, e.detail.value)}
              @commit-change=${(e: CustomEvent<{ value: number }>) =>
                this.host.commitPropertyChange(prop.name, e.detail.value)}
            ></pix3-number-field>
          </div>
        </div>
      `;
    }

    return this.renderPropertyInput(prop);
  }

  renderSizeGroup(label: string, props: PropertyDefinition[]) {
    if (!this.host.primaryNode) {
      return '';
    }

    const widthProp = props.find(p => p.name === 'width');
    const heightProp = props.find(p => p.name === 'height');
    const remainingProps = props.filter(p => p.name !== 'width' && p.name !== 'height');

    if (!widthProp || !heightProp) {
      return this.renderPropertySection(
        label,
        props.map(prop => this.renderPropertyInput(prop))
      );
    }

    const widthState = this.host.propertyValues[widthProp.name];
    const heightState = this.host.propertyValues[heightProp.name];
    const readOnly = this.isPropertyReadOnly(widthProp.ui?.readOnly, this.host.primaryNode);

    const width = widthState ? parseFloat(widthState.value) : 64;
    const height = heightState ? parseFloat(heightState.value) : 64;

    if (this.host.primaryNode instanceof Group2D) {
      return this.renderGroup2DSizeGroup(label, widthProp, heightProp, width, height, readOnly);
    }

    if (!(this.host.primaryNode instanceof Sprite2D)) {
      return this.renderPropertySection(
        label,
        props.map(prop => this.renderPropertyInput(prop))
      );
    }

    const node = this.host.primaryNode;
    const aspectRatioLocked = node.aspectRatioLocked;
    const textureAspectRatio = node.textureAspectRatio;
    const originalWidth = node.originalWidth;
    const originalHeight = node.originalHeight;
    const hasOriginalRatio = textureAspectRatio !== null && textureAspectRatio > 0;
    const hasOriginalSize =
      typeof originalWidth === 'number' &&
      originalWidth > 0 &&
      typeof originalHeight === 'number' &&
      originalHeight > 0;

    const handleWidthChange = (newWidth: number) => {
      if (!Number.isFinite(newWidth) || newWidth <= 0) {
        return;
      }
      if (aspectRatioLocked && hasOriginalRatio) {
        const newHeight = newWidth / textureAspectRatio!;
        void this.host.applySpriteSizeChange(newWidth, newHeight, aspectRatioLocked);
      } else {
        void this.host.applySpriteSizeChange(newWidth, height, aspectRatioLocked);
      }
    };

    const handleHeightChange = (newHeight: number) => {
      if (!Number.isFinite(newHeight) || newHeight <= 0) {
        return;
      }
      if (aspectRatioLocked && hasOriginalRatio) {
        const newWidth = newHeight * textureAspectRatio!;
        void this.host.applySpriteSizeChange(newWidth, newHeight, aspectRatioLocked);
      } else {
        void this.host.applySpriteSizeChange(width, newHeight, aspectRatioLocked);
      }
    };

    const handleResetToOriginal = () => {
      if (hasOriginalSize) {
        void this.host.applySpriteSizeChange(originalWidth, originalHeight, aspectRatioLocked);
      }
    };

    const handleToggleAspectRatio = () => {
      const newLocked = !aspectRatioLocked;
      void this.host.applyPropertyChange('aspectRatioLocked', newLocked);
    };

    return this.renderPropertySection(
      label,
      html`
        <div class="property-group property-group--size-inline">
          ${this.renderPropertyLabel(
            widthProp,
            'Size',
            this.isPropertyOverriddenForPrimaryNode(widthProp)
          )}
          <div class="size-inline-editor">
            <pix3-number-field
              axis="w"
              class="size-inline-input"
              .value=${width}
              .step=${widthProp.ui?.step ?? 1}
              .precision=${widthProp.ui?.precision ?? 0}
              .min=${1}
              .sensitivity=${0.5}
              ?disabled=${readOnly}
              @commit-change=${(e: CustomEvent<{ value: number }>) =>
                handleWidthChange(e.detail.value)}
            ></pix3-number-field>
            <pix3-number-field
              axis="h"
              class="size-inline-input"
              .value=${height}
              .step=${heightProp.ui?.step ?? 1}
              .precision=${heightProp.ui?.precision ?? 0}
              .min=${1}
              .sensitivity=${0.5}
              ?disabled=${readOnly}
              @commit-change=${(e: CustomEvent<{ value: number }>) =>
                handleHeightChange(e.detail.value)}
            ></pix3-number-field>
            ${widthProp.ui?.unit || heightProp.ui?.unit
              ? html`
                  <span class="size-inline-unit">${widthProp.ui?.unit ?? heightProp.ui?.unit}</span>
                `
              : ''}
            ${hasOriginalRatio
              ? html`
                  <button
                    class="size-lock-button ${aspectRatioLocked ? 'locked' : ''}"
                    type="button"
                    title=${aspectRatioLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                    @click=${handleToggleAspectRatio}
                  >
                    ${this.host.iconService.getIcon(aspectRatioLocked ? 'lock' : 'unlock', 14)}
                  </button>
                `
              : ''}
            ${hasOriginalSize
              ? html`
                  <button
                    class="size-reset-button"
                    type="button"
                    title=${`Reset to original texture size (${originalWidth} x ${originalHeight})`}
                    @click=${handleResetToOriginal}
                  >
                    ${this.host.iconService.getIcon('refresh-cw', 14)}
                  </button>
                `
              : ''}
          </div>
        </div>
        ${remainingProps.map(prop => this.renderPropertyInput(prop))}
      `,
      {
        className: 'size-section',
        hideTitle: true,
      }
    );
  }

  getSelectOptions(prop: PropertyDefinition): SelectOption[] {
    const options = prop.ui?.options;
    if (!options) {
      return [];
    }

    if (Array.isArray(options)) {
      return options.map(option => ({
        value: String(option),
        label: String(option),
      }));
    }

    if (typeof options === 'object') {
      return Object.entries(options).map(([label, value]) => ({
        label,
        value: String(value),
      }));
    }

    return [];
  }

  isPropertyReadOnly(
    readOnly: ReadOnlyValue,
    target: NodeBase | ScriptComponent | null | undefined
  ): boolean {
    // Play mode shows a read-only LIVE mirror of the running game; editing the
    // authored node mid-play (two-way edit) is out of scope for Phase 0.
    if (appState.collaboration.isReadOnly || appState.ui.isPlaying) {
      return true;
    }

    if (typeof readOnly === 'function') {
      return Boolean(target ? readOnly(target) : false);
    }

    return Boolean(readOnly);
  }

  renderComponentPropertyInput(component: ScriptComponent, prop: PropertyDefinition) {
    const key = getComponentPropertyKey(component.id, prop.name);
    const state = this.host.componentPropertyValues[key];
    if (!state) {
      return '';
    }

    const label = prop.ui?.label || prop.name;
    // Component config on a prefab instance node is not serialized as an
    // override, so edits would be silently lost on save. Render the editors
    // read-only for every instance node (matching the disabled Add/Remove/Toggle
    // actions); the value can be changed by opening the prefab itself.
    const readOnly =
      this.isPropertyReadOnly(prop.ui?.readOnly, component) ||
      (this.host.primaryNode ? isPrefabNode(this.host.primaryNode) : false);

    if (prop.type === 'string' && prop.ui?.editor === 'audio-resource') {
      const audioPreview = this.host.resourcePreview.getAudioPreview(state.value);
      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <pix3-audio-resource-editor
            .resourceUrl=${state.value}
            .previewUrl=${audioPreview.previewUrl}
            .waveformUrl=${audioPreview.waveformUrl}
            .durationSeconds=${audioPreview.durationSeconds ?? 0}
            .channelCount=${audioPreview.channelCount ?? 0}
            .sampleRate=${audioPreview.sampleRate ?? 0}
            .fileSize=${audioPreview.size}
            ?disabled=${readOnly}
            @change=${(event: CustomEvent<{ url: string }>) =>
              this.host.applyComponentPropertyChange(component.id, prop, event.detail.url.trim())}
            @audio-drop=${(event: CustomEvent<{ event: DragEvent }>) =>
              this.host.onComponentAudioResourceDrop(component.id, prop, event.detail.event)}
          ></pix3-audio-resource-editor>
        </div>
      `;
    }

    if (prop.type === 'string' && prop.ui?.editor === 'model-resource') {
      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <pix3-model-resource-editor
            .resourceUrl=${state.value}
            ?disabled=${readOnly}
            @change=${(event: CustomEvent<{ url: string }>) =>
              this.host.applyComponentPropertyChange(component.id, prop, event.detail.url.trim())}
            @model-drop=${(event: CustomEvent<{ event: DragEvent }>) =>
              this.host.onComponentModelResourceDrop(component.id, prop, event.detail.event)}
          ></pix3-model-resource-editor>
        </div>
      `;
    }

    if (prop.type === 'boolean') {
      return html`
        <div class="property-group property-group--checkbox component-property-group">
          <label class="property-label property-label--checkbox">
            <input
              type="checkbox"
              class="property-checkbox"
              .checked=${state.value === 'true'}
              ?disabled=${readOnly}
              @change=${(e: Event) =>
                this.host.applyComponentPropertyChange(
                  component.id,
                  prop,
                  (e.target as HTMLInputElement).checked
                )}
            />
            <span class="property-label-text">${label}</span>
          </label>
        </div>
      `;
    }

    if (prop.type === 'vector2') {
      let value = { x: 0, y: 0 };
      try {
        value = typeof state.value === 'string' ? JSON.parse(state.value) : state.value;
      } catch {
        console.warn(`Failed to parse vector2 component value for ${prop.name}:`, state.value);
      }
      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <pix3-vector2-editor
            .x=${value.x}
            .y=${value.y}
            .step=${prop.ui?.step ?? 0.01}
            .precision=${prop.ui?.precision ?? 2}
            .sensitivity=${getScrubSensitivity(prop)}
            ?disabled=${readOnly}
            @preview-change=${(e: CustomEvent) =>
              this.host.previewComponentPropertyChange(component.id, prop, e.detail)}
            @commit-change=${(e: CustomEvent) =>
              this.host.commitComponentPropertyChange(component.id, prop, e.detail)}
          ></pix3-vector2-editor>
        </div>
      `;
    }

    if (prop.type === 'vector3') {
      let value = { x: 0, y: 0, z: 0 };
      try {
        value = typeof state.value === 'string' ? JSON.parse(state.value) : state.value;
      } catch {
        console.warn(`Failed to parse vector3 component value for ${prop.name}:`, state.value);
      }
      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <pix3-vector3-editor
            .x=${value.x}
            .y=${value.y}
            .z=${value.z}
            .step=${prop.ui?.step ?? 0.01}
            .precision=${prop.ui?.precision ?? 2}
            .sensitivity=${getScrubSensitivity(prop)}
            ?disabled=${readOnly}
            @preview-change=${(e: CustomEvent) =>
              this.host.previewComponentPropertyChange(component.id, prop, e.detail)}
            @commit-change=${(e: CustomEvent) =>
              this.host.commitComponentPropertyChange(component.id, prop, e.detail)}
          ></pix3-vector3-editor>
        </div>
      `;
    }

    if (prop.type === 'euler') {
      let value = { x: 0, y: 0, z: 0 };
      try {
        value = typeof state.value === 'string' ? JSON.parse(state.value) : state.value;
      } catch {
        console.warn(`Failed to parse euler component value for ${prop.name}:`, state.value);
      }
      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <pix3-euler-editor
            .x=${value.x}
            .y=${value.y}
            .z=${value.z}
            .step=${prop.ui?.step ?? 0.1}
            .precision=${prop.ui?.precision ?? 1}
            ?disabled=${readOnly}
            @preview-change=${(e: CustomEvent) =>
              this.host.previewComponentPropertyChange(component.id, prop, e.detail)}
            @commit-change=${(e: CustomEvent) =>
              this.host.commitComponentPropertyChange(component.id, prop, e.detail)}
          ></pix3-euler-editor>
        </div>
      `;
    }

    if (prop.type === 'node') {
      const activeScene = this.host.sceneManager.getActiveSceneGraph();
      if (!activeScene) {
        return html`<div class="property-group component-property-group">
          <span class="property-label">${label}</span
          ><span class="error-text">No active scene</span>
        </div>`;
      }

      const allowedTypes = prop.ui?.nodeTypes;
      const nodes = Array.from(activeScene.nodeMap.values()).filter(n => {
        if (!allowedTypes || allowedTypes.length === 0) return true;
        return allowedTypes.includes(n.type);
      });

      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <select
            class="property-select"
            ?disabled=${readOnly}
            @change=${(e: Event) =>
              this.host.applyComponentPropertyChange(
                component.id,
                prop,
                (e.target as HTMLSelectElement).value
              )}
          >
            <option value="" ?selected=${!state.value}>[None]</option>
            ${nodes.map(
              n =>
                html`<option value=${n.nodeId} ?selected=${n.nodeId === state.value}>
                  ${n.name} (${n.type})
                </option>`
            )}
          </select>
        </div>
      `;
    }

    if (prop.type === 'select' || prop.type === 'enum') {
      const options = this.getSelectOptions(prop);
      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <select
            class="property-select"
            ?disabled=${readOnly}
            @change=${(e: Event) =>
              this.host.applyComponentPropertyChange(
                component.id,
                prop,
                (e.target as HTMLSelectElement).value
              )}
          >
            ${options.map(
              option =>
                html`<option value=${option.value} ?selected=${option.value === state.value}>
                  ${option.label}
                </option>`
            )}
          </select>
        </div>
      `;
    }

    if (prop.type === 'number') {
      const hasSlider =
        prop.ui?.slider === true &&
        typeof prop.ui?.min === 'number' &&
        typeof prop.ui?.max === 'number' &&
        Number.isFinite(prop.ui.min) &&
        Number.isFinite(prop.ui.max);

      if (hasSlider) {
        const numericValue = Number.parseFloat(state.value);
        const safeValue = Number.isFinite(numericValue) ? numericValue : Number(prop.ui?.min);

        return html`
          <div class="property-group component-property-group">
            <span class="property-label">${label}${prop.ui?.unit ? ` (${prop.ui.unit})` : ''}</span>
            <pix3-slider-number-editor
              .value=${safeValue}
              .min=${Number(prop.ui?.min)}
              .max=${Number(prop.ui?.max)}
              .step=${prop.ui?.step ?? 0.01}
              .precision=${prop.ui?.precision ?? 2}
              ?disabled=${readOnly}
              @preview-change=${(e: CustomEvent<{ value: number }>) =>
                this.host.handleComponentSliderPreview(component.id, prop, e.detail.value)}
              @commit-change=${(e: CustomEvent<{ value: number }>) =>
                this.host.handleComponentSliderCommit(component.id, prop, e.detail.value)}
            ></pix3-slider-number-editor>
          </div>
        `;
      }

      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}${prop.ui?.unit ? ` (${prop.ui.unit})` : ''}</span>
          <input
            type="number"
            step=${prop.ui?.step ?? 0.01}
            class="property-input property-input--number ${state.isValid
              ? ''
              : 'property-input--invalid'}"
            .value=${state.value}
            ?disabled=${readOnly}
            @input=${(e: Event) => this.host.handleComponentPropertyInput(component.id, prop, e)}
            @blur=${(e: Event) => this.host.handleComponentPropertyBlur(component.id, prop, e)}
          />
        </div>
      `;
    }

    if (prop.type === 'color') {
      const pickerValue = this.host.getColorPickerValue(state.value);

      return html`
        <div class="property-group component-property-group">
          <span class="property-label">${label}</span>
          <div class="property-color-editor">
            <input
              type="color"
              class="property-color-picker"
              .value=${pickerValue}
              ?disabled=${readOnly}
              @input=${(e: Event) =>
                this.host.handleComponentColorPickerInput(
                  component.id,
                  prop,
                  (e.target as HTMLInputElement).value
                )}
              @change=${async (e: Event) => {
                const input = e.target as HTMLInputElement;
                await this.host.handleComponentColorPickerCommit(component.id, prop, input.value);
                input.blur();
              }}
            />
            <input
              type="text"
              maxlength="9"
              class="property-input property-input--text property-input--color-text ${state.isValid
                ? ''
                : 'property-input--invalid'}"
              .value=${state.value}
              ?disabled=${readOnly}
              @input=${(e: Event) => this.host.handleComponentPropertyInput(component.id, prop, e)}
              @blur=${(e: Event) => this.host.handleComponentPropertyBlur(component.id, prop, e)}
            />
          </div>
        </div>
      `;
    }

    return html`
      <div class="property-group component-property-group">
        <span class="property-label">${label}</span>
        <input
          type="text"
          class="property-input property-input--text"
          .value=${state.value}
          ?disabled=${readOnly}
          @input=${(e: Event) => this.host.handleComponentPropertyInput(component.id, prop, e)}
          @blur=${(e: Event) => this.host.handleComponentPropertyBlur(component.id, prop, e)}
        />
      </div>
    `;
  }

  /**
   * Inspector editor for a `labelKey` (or any `editor: 'localization-key'` string
   * property): a key text input with autocomplete over known keys, a status glyph
   * showing whether the key resolves in the preview locale, a live preview of the
   * translation, and an "Extract" action that lifts the node's literal `label`
   * into the default-locale table. The key itself is set through the normal
   * property-change path (UpdateObjectPropertyCommand); Extract additionally
   * writes the default-locale entry via UpdateLocaleEntryCommand.
   */
  renderLocalizationKeyEditor(
    propertyName: string,
    value: string,
    readOnly: boolean,
    labelTemplate: unknown
  ) {
    const service = this.host.localizationEditorService;
    const active = service.isActive();
    const key = value.trim();
    const node = this.host.primaryNode instanceof UIControl2D ? this.host.primaryNode : null;
    const literal = node?.label?.trim() ?? '';
    const resolves = key ? service.keyResolvesInPreview(key) : false;
    const preview = key ? service.resolveInPreview(key) : '';
    const canExtract = active && !readOnly && !key && literal.length > 0;
    const keys = active ? service.getAllKeys() : [];
    const listId = `loc-keys-${propertyName}`;
    const previewLocale = service.getPreviewLocale();

    const status = key
      ? html`<span
          class="localization-key-status ${resolves ? 'is-ok' : 'is-missing'}"
          title=${resolves
            ? `Resolves in "${previewLocale}": ${preview}`
            : `No "${previewLocale}" translation — the literal label is shown as fallback`}
        >
          ${this.host.iconService.getIcon(resolves ? 'check' : 'alert-triangle', 14)}
        </span>`
      : '';

    return html`
      <div class="property-group">
        ${labelTemplate}
        <div class="localization-key-editor">
          <div class="localization-key-row">
            <input
              type="text"
              class="property-input property-input--text"
              list=${listId}
              .value=${value}
              ?disabled=${readOnly}
              placeholder=${active ? 'translation key — e.g. menu.play' : 'no locales in project'}
              @change=${(e: Event) =>
                void this.host.applyPropertyChange(
                  propertyName,
                  (e.target as HTMLInputElement).value.trim()
                )}
            />
            ${status}
            ${canExtract
              ? html`<button
                  type="button"
                  class="localization-extract-button"
                  title="Create a '${service.getDefaultLocale()}' key from the literal label"
                  @click=${() => void this.extractLocalizationKey(propertyName, node!)}
                >
                  Extract
                </button>`
              : ''}
          </div>
          <datalist id=${listId}>${keys.map(k => html`<option value=${k}></option>`)}</datalist>
          ${key && resolves
            ? html`<div class="localization-key-preview" title="Preview-locale translation">
                ${preview}
              </div>`
            : ''}
        </div>
      </div>
    `;
  }

  /** Lift a UIControl2D's literal `label` into the default locale and bind its key. */
  async extractLocalizationKey(propertyName: string, node: UIControl2D): Promise<void> {
    const service = this.host.localizationEditorService;
    const literal = node.label?.trim();
    const defaultLocale = service.getDefaultLocale();
    if (!literal || !defaultLocale) return;
    const key = this.suggestLocalizationKey(node);
    await this.host.commandDispatcher.execute(
      new UpdateLocaleEntryCommand({ locale: defaultLocale, key, value: literal })
    );
    await this.host.applyPropertyChange(propertyName, key);
  }

  /** Derive a dot-namespaced key suggestion from a node's name (e.g. "Play Button" → "play.button"). */
  suggestLocalizationKey(node: UIControl2D): string {
    const slug = node.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '.')
      .replace(/^\.+|\.+$/g, '');
    return slug || 'label';
  }

  renderPropertyInput(prop: PropertyDefinition) {
    if (!this.host.primaryNode || !this.host.propertyValues[prop.name]) {
      return '';
    }

    const state = this.host.propertyValues[prop.name];
    const label = prop.ui?.label || prop.name;
    const readOnly = this.isPropertyReadOnly(prop.ui?.readOnly, this.host.primaryNode);
    const isOverridden = this.isPropertyOverriddenForPrimaryNode(prop);
    const labelTemplate = this.renderPropertyLabel(prop, label, isOverridden);

    if (prop.type === 'string' && prop.ui?.editor === 'localization-key') {
      return this.renderLocalizationKeyEditor(
        prop.name,
        String(state.value ?? ''),
        readOnly,
        labelTemplate
      );
    }

    if (prop.type === 'object' && prop.ui?.editor === 'texture-resource') {
      const textureValue = this.host.resourcePreview.toTextureResourceValue(state.value);
      const previewUrl = this.host.resourcePreview.getTexturePreviewUrl(textureValue.url);
      const metadata = this.host.resourcePreview.getTextureMetadata(textureValue.url);

      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-texture-resource-editor
            .resourceUrl=${textureValue.url}
            .previewUrl=${previewUrl}
            .originalWidth=${metadata?.width ?? 0}
            .originalHeight=${metadata?.height ?? 0}
            .fileSize=${metadata?.size ?? 0}
            ?disabled=${readOnly}
            @change=${(event: CustomEvent<{ url: string }>) =>
              this.host.applyPropertyChange(prop.name, {
                type: 'texture',
                url: event.detail.url.trim(),
              })}
            @texture-drop=${(event: CustomEvent<{ event: DragEvent }>) =>
              this.host.onTextureResourceDrop(prop.name, event.detail.event)}
          ></pix3-texture-resource-editor>
        </div>
      `;
    }

    if (prop.type === 'string' && prop.ui?.editor === 'audio-resource') {
      const audioPreview = this.host.resourcePreview.getAudioPreview(state.value);
      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-audio-resource-editor
            .resourceUrl=${state.value}
            .previewUrl=${audioPreview.previewUrl}
            .waveformUrl=${audioPreview.waveformUrl}
            .durationSeconds=${audioPreview.durationSeconds ?? 0}
            .channelCount=${audioPreview.channelCount ?? 0}
            .sampleRate=${audioPreview.sampleRate ?? 0}
            .fileSize=${audioPreview.size}
            ?disabled=${readOnly}
            @change=${(event: CustomEvent<{ url: string }>) =>
              this.host.applyPropertyChange(prop.name, event.detail.url.trim())}
            @audio-drop=${(event: CustomEvent<{ event: DragEvent }>) =>
              this.host.onAudioResourceDrop(prop.name, event.detail.event)}
          ></pix3-audio-resource-editor>
        </div>
      `;
    }

    if (prop.type === 'string' && prop.ui?.editor === 'model-resource') {
      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-model-resource-editor
            .resourceUrl=${state.value}
            ?disabled=${readOnly}
            @change=${(event: CustomEvent<{ url: string }>) =>
              this.host.applyPropertyChange(prop.name, event.detail.url.trim())}
            @model-drop=${(event: CustomEvent<{ event: DragEvent }>) =>
              this.host.onModelResourceDrop(prop.name, event.detail.event)}
          ></pix3-model-resource-editor>
        </div>
      `;
    }

    if (prop.type === 'string' && prop.ui?.editor === 'animation-resource') {
      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-animation-resource-editor
            .resourceUrl=${state.value}
            .showCreateButton=${this.host.canCreateAnimationResource(
              prop.name,
              state.value,
              readOnly
            )}
            .isCreating=${this.host.creatingAnimationPropertyName === prop.name}
            ?disabled=${readOnly}
            @change=${(event: CustomEvent<{ url: string }>) =>
              this.host.applyPropertyChange(prop.name, event.detail.url.trim())}
            @animation-drop=${(event: CustomEvent<{ event: DragEvent }>) =>
              this.host.onAnimationResourceDrop(prop.name, event.detail.event)}
            @open-request=${(event: CustomEvent<{ url: string }>) =>
              this.host.onOpenAnimationResource(event.detail.url)}
            @create-request=${() => this.host.onCreateAnimationResource(prop.name)}
          ></pix3-animation-resource-editor>
        </div>
      `;
    }

    if (prop.type === 'boolean') {
      return html`
        <div class="property-group property-group--checkbox">
          <label class="property-label property-label--checkbox">
            <input
              type="checkbox"
              class="property-checkbox"
              .checked=${state.value === 'true'}
              ?disabled=${readOnly}
              @change=${(e: Event) =>
                this.host.applyPropertyChange(prop.name, (e.target as HTMLInputElement).checked)}
            />
            <span class=${`property-label-text ${isOverridden ? 'property-label--overridden' : ''}`}
              >${label}</span
            >
            ${isOverridden
              ? html`
                  <button
                    class="property-revert-button"
                    type="button"
                    title="Revert prefab override"
                    @click=${(e: Event) => this.onRevertPropertyClick(e, prop)}
                  >
                    ${this.host.iconService.getIcon('rotate-ccw', 12)}
                  </button>
                `
              : null}
          </label>
        </div>
      `;
    }

    if (prop.type === 'vector2') {
      let value = { x: 0, y: 0 };
      try {
        value = typeof state.value === 'string' ? JSON.parse(state.value) : state.value;
      } catch {
        console.warn(`Failed to parse vector2 value for ${prop.name}:`, state.value);
      }
      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-vector2-editor
            .x=${value.x}
            .y=${value.y}
            .step=${prop.ui?.step ?? 0.01}
            .precision=${prop.ui?.precision ?? 2}
            .sensitivity=${getScrubSensitivity(prop)}
            ?disabled=${readOnly}
            @preview-change=${(e: CustomEvent) =>
              this.host.previewPropertyChange(prop.name, e.detail)}
            @commit-change=${(e: CustomEvent) =>
              this.host.commitPropertyChange(prop.name, e.detail)}
          ></pix3-vector2-editor>
        </div>
      `;
    }

    if (prop.type === 'vector3') {
      let value = { x: 0, y: 0, z: 0 };
      try {
        value = typeof state.value === 'string' ? JSON.parse(state.value) : state.value;
      } catch {
        console.warn(`Failed to parse vector3 value for ${prop.name}:`, state.value);
      }
      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-vector3-editor
            .x=${value.x}
            .y=${value.y}
            .z=${value.z}
            .step=${prop.ui?.step ?? 0.01}
            .precision=${prop.ui?.precision ?? 2}
            .sensitivity=${getScrubSensitivity(prop)}
            ?disabled=${readOnly}
            @preview-change=${(e: CustomEvent) =>
              this.host.previewPropertyChange(prop.name, e.detail)}
            @commit-change=${(e: CustomEvent) =>
              this.host.commitPropertyChange(prop.name, e.detail)}
          ></pix3-vector3-editor>
        </div>
      `;
    }

    if (prop.type === 'euler') {
      let value = { x: 0, y: 0, z: 0 };
      try {
        value = typeof state.value === 'string' ? JSON.parse(state.value) : state.value;
      } catch {
        console.warn(`Failed to parse euler value for ${prop.name}:`, state.value);
      }
      return html`
        <div class="property-group">
          ${labelTemplate}
          <pix3-euler-editor
            .x=${value.x}
            .y=${value.y}
            .z=${value.z}
            .step=${prop.ui?.step ?? 0.1}
            .precision=${prop.ui?.precision ?? 1}
            ?disabled=${readOnly}
            @preview-change=${(e: CustomEvent) =>
              this.host.previewPropertyChange(prop.name, e.detail)}
            @commit-change=${(e: CustomEvent) =>
              this.host.commitPropertyChange(prop.name, e.detail)}
          ></pix3-euler-editor>
        </div>
      `;
    }

    if (prop.type === 'number' && prop.ui?.editor === 'sprite-size') {
      // Only render size editor for width property to avoid duplicates
      if (prop.name !== 'width') {
        return '';
      }

      // Handle sprite size editor (combines width and height)
      const heightState = this.host.propertyValues['height'];
      const widthVal = Number.parseFloat(state.value);
      const heightVal = Number.parseFloat(heightState?.value ?? '64');

      const node = this.host.primaryNode instanceof Sprite2D ? this.host.primaryNode : null;
      const originalWidth = node?.originalWidth ?? null;
      const originalHeight = node?.originalHeight ?? null;
      const aspectRatioLocked = node?.aspectRatioLocked ?? false;
      const hasOriginalSize = Boolean(
        typeof originalWidth === 'number' &&
          originalWidth > 0 &&
          typeof originalHeight === 'number' &&
          originalHeight > 0
      );

      return html`
        <div class="property-group">
          ${this.renderPropertyLabel(prop, 'Size', isOverridden)}
          <pix3-size-editor
            .width=${Number.isFinite(widthVal) && widthVal > 0 ? widthVal : 64}
            .height=${Number.isFinite(heightVal) && heightVal > 0 ? heightVal : 64}
            .aspectRatioLocked=${aspectRatioLocked}
            .hasOriginalSize=${hasOriginalSize}
            .originalWidth=${originalWidth}
            .originalHeight=${originalHeight}
            ?disabled=${readOnly}
            @change=${(
              e: CustomEvent<{ width: number; height: number; aspectRatioLocked: boolean }>
            ) => {
              const { width, height, aspectRatioLocked } = e.detail;
              this.host.applySpriteSizeChange(width, height, aspectRatioLocked);
            }}
            @reset-size=${() => this.handleSizeReset()}
          ></pix3-size-editor>
        </div>
      `;
    }

    if (prop.type === 'node') {
      const activeScene = this.host.sceneManager.getActiveSceneGraph();
      if (!activeScene) {
        return html`<div class="property-group">
          <span class="property-label">${label}</span
          ><span class="error-text">No active scene</span>
        </div>`;
      }

      const allowedTypes = prop.ui?.nodeTypes;
      const nodes = Array.from(activeScene.nodeMap.values()).filter(n => {
        if (!allowedTypes || allowedTypes.length === 0) return true;
        return allowedTypes.includes(n.type);
      });

      return html`
        <div class="property-group">
          ${labelTemplate}
          <select
            class="property-select"
            ?disabled=${readOnly}
            @change=${(e: Event) =>
              this.host.applyPropertyChange(prop.name, (e.target as HTMLSelectElement).value)}
          >
            <option value="" ?selected=${!state.value}>[None]</option>
            ${nodes.map(
              n =>
                html`<option value=${n.nodeId} ?selected=${n.nodeId === state.value}>
                  ${n.name} (${n.type})
                </option>`
            )}
          </select>
        </div>
      `;
    }

    if (prop.type === 'select' || prop.type === 'enum') {
      const options = this.getSelectOptions(prop);
      return html`
        <div class="property-group">
          ${labelTemplate}
          <select
            class="property-select"
            ?disabled=${readOnly}
            @change=${(e: Event) =>
              this.host.applyPropertyChange(prop.name, (e.target as HTMLSelectElement).value)}
          >
            ${options.map(
              option =>
                html`<option value=${option.value} ?selected=${option.value === state.value}>
                  ${option.label}
                </option>`
            )}
          </select>
        </div>
      `;
    }

    if (prop.type === 'number') {
      if (prop.name === 'opacity') {
        const numericValue = Number.parseFloat(state.value);
        const safeValue = Number.isFinite(numericValue)
          ? Math.min(Math.max(numericValue, 0), 1)
          : 1;

        return html`
          <div class="property-group property-group--opacity">
            ${labelTemplate}
            <pix3-slider-number-editor
              .value=${safeValue * 100}
              .min=${0}
              .max=${100}
              .step=${1}
              .precision=${0}
              ?disabled=${readOnly}
              @preview-change=${(e: CustomEvent<{ value: number }>) =>
                this.host.handleSliderPreview(prop.name, e.detail.value / 100)}
              @commit-change=${(e: CustomEvent<{ value: number }>) =>
                this.host.handleSliderCommit(prop.name, e.detail.value / 100)}
            ></pix3-slider-number-editor>
          </div>
        `;
      }

      const hasSlider =
        prop.ui?.slider === true &&
        typeof prop.ui?.min === 'number' &&
        typeof prop.ui?.max === 'number' &&
        Number.isFinite(prop.ui.min) &&
        Number.isFinite(prop.ui.max);

      if (hasSlider) {
        const numericValue = Number.parseFloat(state.value);
        const safeValue = Number.isFinite(numericValue) ? numericValue : Number(prop.ui?.min);

        return html`
          <div class="property-group">
            ${this.renderPropertyLabel(
              prop,
              `${label}${prop.ui?.unit ? ` (${prop.ui.unit})` : ''}`,
              isOverridden
            )}
            <pix3-slider-number-editor
              .value=${safeValue}
              .min=${Number(prop.ui?.min)}
              .max=${Number(prop.ui?.max)}
              .step=${prop.ui?.step ?? 0.01}
              .precision=${prop.ui?.precision ?? 2}
              ?disabled=${readOnly}
              @preview-change=${(e: CustomEvent<{ value: number }>) =>
                this.host.handleSliderPreview(prop.name, e.detail.value)}
              @commit-change=${(e: CustomEvent<{ value: number }>) =>
                this.host.handleSliderCommit(prop.name, e.detail.value)}
            ></pix3-slider-number-editor>
          </div>
        `;
      }

      return html`
        <div class="property-group">
          ${this.renderPropertyLabel(
            prop,
            `${label}${prop.ui?.unit ? ` (${prop.ui.unit})` : ''}`,
            isOverridden
          )}
          <input
            type="number"
            step=${prop.ui?.step ?? 0.01}
            class="property-input property-input--number ${state.isValid
              ? ''
              : 'property-input--invalid'}"
            .value=${state.value}
            ?disabled=${readOnly}
            @input=${(e: Event) => this.host.handlePropertyInput(prop.name, e)}
            @blur=${(e: Event) => this.host.handlePropertyBlur(prop.name, e)}
          />
        </div>
      `;
    }

    if (prop.type === 'color') {
      const pickerValue = this.host.getColorPickerValue(state.value);

      return html`
        <div class="property-group">
          ${labelTemplate}
          <div class="property-color-editor">
            <input
              type="color"
              class="property-color-picker"
              .value=${pickerValue}
              ?disabled=${readOnly}
              @input=${(e: Event) =>
                this.host.handleColorPickerInput(prop.name, (e.target as HTMLInputElement).value)}
              @change=${async (e: Event) => {
                const input = e.target as HTMLInputElement;
                await this.host.handleColorPickerCommit(prop.name, input.value);
                input.blur();
              }}
            />
            <input
              type="text"
              maxlength="9"
              class="property-input property-input--text property-input--color-text ${state.isValid
                ? ''
                : 'property-input--invalid'}"
              .value=${state.value}
              ?disabled=${readOnly}
              @input=${(e: Event) => this.host.handlePropertyInput(prop.name, e)}
              @blur=${(e: Event) => this.host.handlePropertyBlur(prop.name, e)}
            />
          </div>
        </div>
      `;
    }

    if (prop.type === 'string') {
      return html`
        <div class="property-group">
          ${labelTemplate}
          <input
            type="text"
            class="property-input property-input--text"
            .value=${state.value}
            ?disabled=${readOnly}
            @input=${(e: Event) => this.host.handlePropertyInput(prop.name, e)}
            @blur=${(e: Event) => this.host.handlePropertyBlur(prop.name, e)}
          />
        </div>
      `;
    }

    // Default fallback for other types
    return html`
      <div class="property-group">
        ${labelTemplate}
        <input
          type="text"
          class="property-input property-input--text"
          .value=${state.value}
          ?disabled=${readOnly}
          @input=${(e: Event) => this.host.handlePropertyInput(prop.name, e)}
        />
      </div>
    `;
  }

  renderAnchorModeButton(
    axis: 'horizontal' | 'vertical',
    option: string,
    currentValue: string,
    enabled: boolean,
    readOnly: boolean
  ) {
    const label =
      axis === 'horizontal'
        ? {
            left: 'L',
            center: 'C',
            right: 'R',
            stretch: 'S',
          }[option]
        : {
            top: 'T',
            center: 'C',
            bottom: 'B',
            stretch: 'S',
          }[option];

    return html`
      <button
        class="anchor-mode-button ${enabled && currentValue === option ? 'is-active' : ''}"
        type="button"
        ?disabled=${readOnly}
        title=${option}
        aria-label=${`${axis} ${option}`}
        @click=${() => this.applyAnchorMode(axis, option)}
      >
        ${this.renderAnchorModeIcon(axis, option, label ?? option)}
      </button>
    `;
  }

  renderAnchorModeIcon(axis: 'horizontal' | 'vertical', option: string, fallback: string) {
    if (axis === 'horizontal') {
      switch (option) {
        case 'left':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2v10"></path>
            <rect x="3.5" y="4" width="6" height="6"></rect>
          </svg>`;
        case 'center':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M7 2v10"></path>
            <rect x="4" y="4" width="6" height="6"></rect>
          </svg>`;
        case 'right':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M12 2v10"></path>
            <rect x="4.5" y="4" width="6" height="6"></rect>
          </svg>`;
        case 'stretch':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2v10M12 2v10"></path>
            <rect x="3" y="4" width="8" height="6"></rect>
          </svg>`;
      }
    }

    if (axis === 'vertical') {
      switch (option) {
        case 'top':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2h10"></path>
            <rect x="4" y="3.5" width="6" height="6"></rect>
          </svg>`;
        case 'center':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 7h10"></path>
            <rect x="4" y="4" width="6" height="6"></rect>
          </svg>`;
        case 'bottom':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 12h10"></path>
            <rect x="4" y="4.5" width="6" height="6"></rect>
          </svg>`;
        case 'stretch':
          return html`<svg viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2h10M2 12h10"></path>
            <rect x="4" y="3" width="6" height="8"></rect>
          </svg>`;
      }
    }

    return fallback;
  }

  renderAnchorPreviewEdge(
    edge: 'left' | 'right' | 'top' | 'bottom' | 'center',
    horizontal: string,
    vertical: string,
    readOnly: boolean
  ) {
    const isActive =
      (edge === 'left' && horizontal === 'left') ||
      (edge === 'right' && horizontal === 'right') ||
      (edge === 'top' && vertical === 'top') ||
      (edge === 'bottom' && vertical === 'bottom') ||
      (edge === 'center' && horizontal === 'center' && vertical === 'center');

    return html`
      <button
        class="anchor-preview-edge anchor-preview-edge--${edge} ${isActive ? 'is-active' : ''}"
        type="button"
        ?disabled=${readOnly}
        title=${edge === 'center' ? 'Center both axes' : `Set ${edge} alignment`}
        @click=${() => this.applyAnchorPreviewEdge(edge)}
      ></button>
    `;
  }

  async applyAnchorMode(axis: 'horizontal' | 'vertical', value: string): Promise<void> {
    if (!this.host.primaryNode || !(this.host.primaryNode instanceof Node2D)) {
      return;
    }

    if (
      !(
        this.host.propertyValues['layoutEnabled']?.value === 'true' ||
        this.host.primaryNode.layoutEnabled
      )
    ) {
      await this.host.applyPropertyChange('layoutEnabled', true);
    }

    await this.host.applyPropertyChange(
      axis === 'horizontal' ? 'horizontalAlign' : 'verticalAlign',
      value
    );
  }

  async applyAnchorPreviewEdge(
    edge: 'left' | 'right' | 'top' | 'bottom' | 'center'
  ): Promise<void> {
    if (edge === 'center') {
      await this.applyAnchorPreset({ horizontal: 'center', vertical: 'center' });
      return;
    }

    if (edge === 'left' || edge === 'right') {
      await this.applyAnchorMode('horizontal', edge);
      return;
    }

    await this.applyAnchorMode('vertical', edge);
  }

  async applyAnchorPreset(preset: {
    horizontal?: 'left' | 'center' | 'right' | 'stretch';
    vertical?: 'top' | 'center' | 'bottom' | 'stretch';
  }): Promise<void> {
    if (!this.host.primaryNode || !(this.host.primaryNode instanceof Node2D)) {
      return;
    }

    if (
      !(
        this.host.propertyValues['layoutEnabled']?.value === 'true' ||
        this.host.primaryNode.layoutEnabled
      )
    ) {
      await this.host.applyPropertyChange('layoutEnabled', true);
    }

    if (preset.horizontal) {
      await this.host.applyPropertyChange('horizontalAlign', preset.horizontal);
    }

    if (preset.vertical) {
      await this.host.applyPropertyChange('verticalAlign', preset.vertical);
    }
  }

  renderPropertySection(label: string, content: unknown, options: PropertySectionOptions = {}) {
    const classes = [
      'property-group-section',
      options.className,
      options.hideTitle ? 'property-group-section--titleless' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return html`
      <div class=${classes}>
        ${options.hideTitle ? '' : html`<h4 class="group-title">${label}</h4>`} ${content}
      </div>
    `;
  }

  renderPropertyLabel(prop: PropertyDefinition, label: string, isOverridden: boolean) {
    return html`
      <span class="property-label ${isOverridden ? 'property-label--overridden' : ''}">
        ${label}
        ${isOverridden
          ? html`
              <button
                class="property-revert-button"
                type="button"
                title="Revert prefab override"
                @click=${(e: Event) => this.onRevertPropertyClick(e, prop)}
              >
                ${this.host.iconService.getIcon('rotate-ccw', 12)}
              </button>
            `
          : null}
      </span>
    `;
  }

  onRevertPropertyClick(event: Event, prop: PropertyDefinition): void {
    event.stopPropagation();
    event.preventDefault();
    const baseValue = this.getPrefabBaseValueForProperty(prop);
    if (baseValue === undefined) {
      return;
    }
    void this.host.applyPropertyChange(prop.name, baseValue);
  }

  isPropertyOverriddenForPrimaryNode(prop: PropertyDefinition): boolean {
    if (!this.host.primaryNode) {
      return false;
    }
    // Placement properties of an instance root (position/rotation/scale/name +
    // 2D anchors) are where-it-sits-in-the-scene, not prefab-content overrides.
    // Don't flag them or offer a Revert. See INSTANCE_PLACEMENT_PROPERTY_NAMES.
    if (isInstancePlacementProperty(this.host.primaryNode, prop.name)) {
      return false;
    }
    const baseValue = this.getPrefabBaseValueForProperty(prop);
    if (baseValue === undefined) {
      return false;
    }
    const currentValue = prop.getValue(this.host.primaryNode);
    return JSON.stringify(currentValue) !== JSON.stringify(baseValue);
  }

  getPrefabBaseValueForProperty(prop: PropertyDefinition): unknown {
    if (!this.host.primaryNode) {
      return undefined;
    }

    const nodeMarker = getPrefabMetadata(this.host.primaryNode);
    if (!nodeMarker) {
      return undefined;
    }

    const instanceRoot = findPrefabInstanceRoot(this.host.primaryNode);
    if (!instanceRoot) {
      return undefined;
    }

    const rootMarker: PrefabMetadata | null = getPrefabMetadata(instanceRoot);
    const baseMap = rootMarker?.basePropertiesByLocalId;
    if (!baseMap) {
      return undefined;
    }

    const baseValue = baseMap[nodeMarker.effectiveLocalId]?.[prop.name];
    return baseValue === undefined ? undefined : JSON.parse(JSON.stringify(baseValue));
  }

  async handleSizeReset() {
    if (!(this.host.primaryNode instanceof Sprite2D)) {
      return;
    }

    const originalWidth = this.host.primaryNode.originalWidth;
    const originalHeight = this.host.primaryNode.originalHeight;
    if (
      typeof originalWidth === 'number' &&
      originalWidth > 0 &&
      typeof originalHeight === 'number' &&
      originalHeight > 0
    ) {
      await this.host.applySpriteSizeChange(
        originalWidth,
        originalHeight,
        this.host.primaryNode.aspectRatioLocked
      );
    }
  }

  renderGroup2DSizeGroup(
    label: string,
    widthProp: PropertyDefinition,
    heightProp: PropertyDefinition,
    width: number,
    height: number,
    readOnly: boolean
  ) {
    const hasChildren = this.group2DHasNode2DChildren();
    return this.renderPropertySection(
      label,
      html`
        <div class="property-group property-group--size-inline">
          ${this.renderPropertyLabel(
            widthProp,
            'Size',
            this.isPropertyOverriddenForPrimaryNode(widthProp)
          )}
          <div class="size-inline-editor">
            <pix3-number-field
              axis="w"
              class="size-inline-input"
              .value=${width}
              .step=${widthProp.ui?.step ?? 1}
              .precision=${widthProp.ui?.precision ?? 0}
              .min=${1}
              .sensitivity=${0.5}
              ?disabled=${readOnly}
              @commit-change=${(e: CustomEvent<{ value: number }>) =>
                this.applyGroup2DSizeChange(e.detail.value, height)}
            ></pix3-number-field>
            <pix3-number-field
              axis="h"
              class="size-inline-input"
              .value=${height}
              .step=${heightProp.ui?.step ?? 1}
              .precision=${heightProp.ui?.precision ?? 0}
              .min=${1}
              .sensitivity=${0.5}
              ?disabled=${readOnly}
              @commit-change=${(e: CustomEvent<{ value: number }>) =>
                this.applyGroup2DSizeChange(width, e.detail.value)}
            ></pix3-number-field>
          </div>
          <button
            class="group-fit-button"
            type="button"
            title="Fit to contents — resize this group to wrap its children (without moving them)"
            aria-label="Fit to contents"
            ?disabled=${readOnly || !hasChildren}
            @click=${() => this.fitGroup2DToContents()}
          >
            ${this.host.iconService.getIcon('minimize-2', 14)}
          </button>
        </div>
      `,
      {
        className: 'size-section',
        hideTitle: true,
      }
    );
  }

  group2DHasNode2DChildren(): boolean {
    const node = this.host.primaryNode;
    if (!(node instanceof Group2D)) {
      return false;
    }
    return node.children.some(child => child instanceof Node2D);
  }

  /**
   * Resize a Group2D from the inspector, proportionally scaling its children (Figma-style). Routed
   * through a dedicated command so the child-scaling stays an explicit editor gesture.
   */
  async applyGroup2DSizeChange(width: number, height: number): Promise<void> {
    if (!(this.host.primaryNode instanceof Group2D)) {
      return;
    }
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      this.host.syncValuesFromNode();
      this.host.requestUpdate();
      return;
    }
    const command = new ResizeGroup2DCommand({
      nodeId: this.host.primaryNode.nodeId,
      width,
      height,
    });
    try {
      await this.host.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[InspectorPanel] Failed to resize Group2D', error);
      this.host.syncValuesFromNode();
      this.host.requestUpdate();
    }
  }

  async fitGroup2DToContents(): Promise<void> {
    if (!(this.host.primaryNode instanceof Group2D)) {
      return;
    }
    const command = new FitGroup2DToContentsCommand({ nodeId: this.host.primaryNode.nodeId });
    try {
      await this.host.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[InspectorPanel] Failed to fit Group2D to contents', error);
    }
  }
}
