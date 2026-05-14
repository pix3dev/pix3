import { html, type TemplateResult } from 'lit';
import type { DropdownItem } from '@/ui/shared/pix3-dropdown-button';
import type { Align2DActionId } from '@/features/alignment/types';

import type { EditorCameraProjection, NavigationMode } from '@/state';
import type { IconService } from '@/services/IconService';
import type { TransformMode } from '@/services/ViewportRenderService';

export interface ViewportToolbarState {
  readonly transformMode: TransformMode | null;
  readonly showGrid: boolean;
  readonly showLighting: boolean;
  readonly navigationMode: NavigationMode | null;
  readonly showLayer3D: boolean;
  readonly showLayer2D: boolean;
  readonly previewCameraLabel: string;
  readonly previewCameraItems: DropdownItem[];
  readonly isPreviewCameraActive: boolean;
  readonly editorCameraProjection: EditorCameraProjection;
  readonly showAlignmentTools: boolean;
  readonly canAlignToContainer: boolean;
  readonly canAlignToSelectionBounds: boolean;
  readonly canDistributeSelection: boolean;
}

export interface ViewportToolbarHandlers {
  readonly onTransformModeChange?: (mode: TransformMode) => void;
  readonly onToggleNavigationMode?: () => void;
  readonly onZoomDefault: () => void;
  readonly onZoomAll: () => void;
  readonly onSelectPreviewCamera: (itemId: string) => void;
  readonly onToggleGrid: () => void;
  readonly onToggleLighting: () => void;
  readonly onToggleLayer3D: () => void;
  readonly onToggleLayer2D: () => void;
  readonly onSetEditorCameraProjection: (projection: EditorCameraProjection) => void;
  readonly onRunAlignmentAction?: (action: Align2DActionId) => void;
}

export interface AlignmentToolbarState {
  readonly showAlignmentTools: boolean;
  readonly canAlignToContainer: boolean;
  readonly canAlignToSelectionBounds: boolean;
  readonly canDistributeSelection: boolean;
}

export interface AlignmentToolbarHandlers {
  readonly onRunAlignmentAction?: (action: Align2DActionId) => void;
}

interface ToolbarButtonConfig {
  readonly ariaLabel: string;
  readonly title: string;
  readonly iconName?: string;
  readonly text?: string;
  readonly isPressed?: boolean;
  readonly isActive?: boolean;
  readonly isDisabled?: boolean;
  readonly onClick: () => void;
  readonly extraClass?: string;
}

const TRANSFORM_MODES: readonly {
  readonly mode: TransformMode;
  readonly iconName: string;
  readonly label: string;
}[] = [
  { mode: 'select', iconName: 'mouse-pointer', label: 'Select (Q)' },
  { mode: 'translate', iconName: 'move', label: 'Move (W)' },
  { mode: 'rotate', iconName: 'rotate-cw', label: 'Rotate (E)' },
  { mode: 'scale', iconName: 'maximize-2', label: 'Scale (R)' },
];

const CONTAINER_ALIGNMENT_ACTIONS: readonly {
  readonly action: Align2DActionId;
  readonly iconName: string;
  readonly label: string;
}[] = [
  { action: 'container-left', iconName: 'align-selection-left', label: 'Align Left to Container' },
  {
    action: 'container-center-x',
    iconName: 'align-selection-center-x',
    label: 'Align Horizontal Center to Container',
  },
  {
    action: 'container-right',
    iconName: 'align-selection-right',
    label: 'Align Right to Container',
  },
  { action: 'container-top', iconName: 'align-selection-top', label: 'Align Top to Container' },
  {
    action: 'container-center-y',
    iconName: 'align-selection-center-y',
    label: 'Align Vertical Center to Container',
  },
  {
    action: 'container-bottom',
    iconName: 'align-selection-bottom',
    label: 'Align Bottom to Container',
  },
];

const SELECTION_ALIGNMENT_ACTIONS: readonly {
  readonly action: Align2DActionId;
  readonly iconName: string;
  readonly label: string;
}[] = [
  {
    action: 'selection-left',
    iconName: 'align-container-left',
    label: 'Align Left to Selection Bounds',
  },
  {
    action: 'selection-center-x',
    iconName: 'align-container-center-x',
    label: 'Align Horizontal Center to Selection Bounds',
  },
  {
    action: 'selection-right',
    iconName: 'align-container-right',
    label: 'Align Right to Selection Bounds',
  },
  {
    action: 'selection-top',
    iconName: 'align-container-top',
    label: 'Align Top to Selection Bounds',
  },
  {
    action: 'selection-center-y',
    iconName: 'align-container-center-y',
    label: 'Align Vertical Center to Selection Bounds',
  },
  {
    action: 'selection-bottom',
    iconName: 'align-container-bottom',
    label: 'Align Bottom to Selection Bounds',
  },
];

const DISTRIBUTION_ACTIONS: readonly {
  readonly action: Align2DActionId;
  readonly iconName: string;
  readonly label: string;
}[] = [
  {
    action: 'distribute-gap-x',
    iconName: 'distribute-gap-x',
    label: 'Distribute Horizontal Gaps',
  },
  {
    action: 'distribute-center-x',
    iconName: 'distribute-center-x',
    label: 'Distribute Centers Horizontally',
  },
  {
    action: 'distribute-gap-y',
    iconName: 'distribute-gap-y',
    label: 'Distribute Vertical Gaps',
  },
  {
    action: 'distribute-center-y',
    iconName: 'distribute-center-y',
    label: 'Distribute Centers Vertically',
  },
];

export function renderViewportToolbar(
  state: ViewportToolbarState,
  handlers: ViewportToolbarHandlers,
  iconService: IconService
): TemplateResult {
  return html`
    <div
      class="top-toolbar"
      @click=${(e: Event) => e.stopPropagation()}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @pointerup=${(e: Event) => e.stopPropagation()}
    >
      ${state.transformMode !== null && handlers.onTransformModeChange
        ? html`
            <div class="toolbar-group" role="toolbar" aria-label="Transform tools">
              ${TRANSFORM_MODES.map(({ mode, iconName, label }) =>
                renderToolbarButton(
                  {
                    ariaLabel: label,
                    title: label,
                    iconName,
                    isPressed: state.transformMode === mode,
                    isActive: state.transformMode === mode,
                    onClick: () => handlers.onTransformModeChange?.(mode),
                  },
                  iconService
                )
              )}
            </div>
          `
        : null}

      <div class="toolbar-group" role="toolbar" aria-label="Viewport controls">
        ${handlers.onToggleNavigationMode && state.navigationMode
          ? renderToolbarButton(
              {
                ariaLabel: 'Toggle navigation mode',
                title: 'Toggle Navigation Mode (N)',
                text: state.navigationMode === '3d' ? '3D' : '2D',
                isPressed: state.navigationMode === '2d',
                onClick: handlers.onToggleNavigationMode,
                extraClass: 'toolbar-button--mode',
              },
              iconService
            )
          : null}
      </div>

      <div class="toolbar-group" role="toolbar" aria-label="Viewport framing">
        <pix3-dropdown-button
          class="toolbar-dropdown-button ${state.isPreviewCameraActive
            ? 'toolbar-dropdown-button--active'
            : ''}"
          icon="camera"
          aria-label="Camera preview"
          title=${`Camera Preview: ${state.previewCameraLabel}`}
          .items=${state.previewCameraItems}
          @item-select=${(e: CustomEvent<DropdownItem>) => {
            e.stopPropagation();
            handlers.onSelectPreviewCamera(e.detail.id);
          }}
        ></pix3-dropdown-button>
        ${renderToolbarButton(
          {
            ariaLabel: 'Reset zoom',
            title: 'Reset Zoom (Home)',
            iconName: 'zoom-default',
            onClick: handlers.onZoomDefault,
          },
          iconService
        )}
        ${renderToolbarButton(
          {
            ariaLabel: 'Show all',
            title: 'Show All (F)',
            iconName: 'zoom-all',
            onClick: handlers.onZoomAll,
          },
          iconService
        )}
      </div>

      <div class="toolbar-spacer"></div>

      <div class="toolbar-group" role="toolbar" aria-label="Viewport visibility settings">
        <pix3-viewport-visibility-popover
          .showGrid=${state.showGrid}
          .showLighting=${state.showLighting}
          .showLayer2D=${state.showLayer2D}
          .showLayer3D=${state.showLayer3D}
          .editorCameraProjection=${state.editorCameraProjection}
          @toggle-grid=${() => handlers.onToggleGrid()}
          @toggle-lighting=${() => handlers.onToggleLighting()}
          @toggle-layer-2d=${() => handlers.onToggleLayer2D()}
          @toggle-layer-3d=${() => handlers.onToggleLayer3D()}
          @projection-change=${(e: CustomEvent<{ projection: EditorCameraProjection }>) =>
            handlers.onSetEditorCameraProjection(e.detail.projection)}
        ></pix3-viewport-visibility-popover>
      </div>
    </div>
  `;
}

export function renderAlignmentToolbarOverlay(
  state: AlignmentToolbarState,
  handlers: AlignmentToolbarHandlers,
  iconService: IconService
): TemplateResult | null {
  const showContainerAlignment =
    state.showAlignmentTools && state.canAlignToContainer && Boolean(handlers.onRunAlignmentAction);
  const showSelectionAlignment =
    state.showAlignmentTools &&
    state.canAlignToSelectionBounds &&
    Boolean(handlers.onRunAlignmentAction);
  const showDistribution =
    state.showAlignmentTools &&
    state.canDistributeSelection &&
    Boolean(handlers.onRunAlignmentAction);

  if (!showContainerAlignment && !showSelectionAlignment && !showDistribution) {
    return null;
  }

  return html`
    <div
      class="alignment-overlay-shell"
      @click=${(e: Event) => e.stopPropagation()}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @pointerup=${(e: Event) => e.stopPropagation()}
      @wheel=${(e: Event) => e.stopPropagation()}
    >
      <div class="alignment-overlay" role="toolbar" aria-label="2D alignment tools">
        ${showSelectionAlignment
          ? html`
              <div class="toolbar-group" role="group" aria-label="Align to selection bounds">
                ${SELECTION_ALIGNMENT_ACTIONS.map(({ action, iconName, label }) =>
                  renderToolbarButton(
                    {
                      ariaLabel: label,
                      title: label,
                      iconName,
                      onClick: () => handlers.onRunAlignmentAction?.(action),
                    },
                    iconService
                  )
                )}
              </div>
            `
          : null}
        ${showContainerAlignment
          ? html`
              <div class="toolbar-group" role="group" aria-label="Align to container">
                ${CONTAINER_ALIGNMENT_ACTIONS.map(({ action, iconName, label }) =>
                  renderToolbarButton(
                    {
                      ariaLabel: label,
                      title: label,
                      iconName,
                      onClick: () => handlers.onRunAlignmentAction?.(action),
                    },
                    iconService
                  )
                )}
              </div>
            `
          : null}
        ${showDistribution
          ? html`
              <div class="toolbar-group" role="group" aria-label="Distribute selection">
                ${DISTRIBUTION_ACTIONS.map(({ action, iconName, label }) =>
                  renderToolbarButton(
                    {
                      ariaLabel: label,
                      title: label,
                      iconName,
                      onClick: () => handlers.onRunAlignmentAction?.(action),
                    },
                    iconService
                  )
                )}
              </div>
            `
          : null}
      </div>
    </div>
  `;
}

function renderToolbarButton(
  config: ToolbarButtonConfig,
  iconService: IconService
): TemplateResult {
  return html`
    <button
      class="toolbar-button ${config.isActive
        ? 'toolbar-button--active'
        : ''} ${config.extraClass ?? ''}"
      aria-label=${config.ariaLabel}
      aria-pressed=${String(Boolean(config.isPressed))}
      ?disabled=${Boolean(config.isDisabled)}
      title=${config.title}
      @click=${(e: Event) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (config.isDisabled) {
          return;
        }
        config.onClick();
      }}
    >
      ${config.iconName
        ? html`<span class="toolbar-icon">${iconService.getIcon(config.iconName)}</span>`
        : null}
      ${config.text ? html`<span class="toolbar-label">${config.text}</span>` : null}
    </button>
  `;
}
