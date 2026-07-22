import { html, type TemplateResult } from 'lit';
import type { DropdownItem } from '@/ui/shared/pix3-dropdown-button';
import type { Align2DActionId } from '@/features/alignment/types';

import type { EditorCameraProjection, NavigationMode } from '@/state';
import type { IconService } from '@/services/editor/IconService';
import type { TransformMode } from '@/services/viewport/ViewportRenderService';

export interface ViewportToolbarState {
  readonly transformMode: TransformMode | null;
  readonly showGrid: boolean;
  readonly snapToGrid: boolean;
  readonly showLighting: boolean;
  readonly navigationMode: NavigationMode | null;
  readonly showLayer3D: boolean;
  readonly showLayer2D: boolean;
  /**
   * Scene mixes 2D and 3D content — the layer-visibility buttons are shown only
   * then. With a single layer there is nothing to reveal by hiding it.
   */
  readonly canToggleLayerVisibility: boolean;
  /** Both navigation modes are usable — the mode toggle is shown only when true. */
  readonly canToggleNavigationMode: boolean;
  readonly previewCameraLabel: string;
  readonly previewCameraItems: DropdownItem[];
  readonly isPreviewCameraActive: boolean;
  readonly editorCameraProjection: EditorCameraProjection;
  readonly showAlignmentTools: boolean;
  readonly canAlignToContainer: boolean;
  readonly canAlignToSelectionBounds: boolean;
  readonly canDistributeSelection: boolean;
  /** Localization is configured for the project — show the preview-locale switch. */
  readonly showLocalePreview: boolean;
  readonly previewLocaleLabel: string;
  readonly previewLocaleItems: DropdownItem[];
}

export interface ViewportToolbarHandlers {
  readonly onTransformModeChange?: (mode: TransformMode) => void;
  readonly onToggleNavigationMode?: () => void;
  readonly onSelectPreviewCamera: (itemId: string) => void;
  readonly onToggleGrid: () => void;
  readonly onToggleSnapToGrid: () => void;
  readonly onToggleLighting: () => void;
  readonly onToggleLayer3D: () => void;
  readonly onToggleLayer2D: () => void;
  readonly onSetEditorCameraProjection: (projection: EditorCameraProjection) => void;
  readonly onRunAlignmentAction?: (action: Align2DActionId) => void;
  readonly onSelectPreviewLocale?: (localeId: string) => void;
}

export interface ViewportZoomOverlayHandlers {
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onZoomAll: () => void;
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
      <div class="toolbar-group" role="toolbar" aria-label="Viewport controls">
        ${handlers.onToggleNavigationMode && state.navigationMode && state.canToggleNavigationMode
          ? renderToolbarButton(
              {
                ariaLabel: 'Toggle navigation mode',
                title: 'Toggle Navigation Mode (N)',
                text: state.navigationMode === '3d' ? '3D' : '2D',
                isPressed: true,
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
      </div>

      ${state.showLocalePreview && handlers.onSelectPreviewLocale
        ? html`
            <div class="toolbar-group" role="group" aria-label="Preview locale">
              <pix3-dropdown-button
                class="toolbar-dropdown-button"
                icon="globe"
                aria-label="Preview locale"
                title=${`Preview Locale: ${state.previewLocaleLabel}`}
                .items=${state.previewLocaleItems}
                @item-select=${(e: CustomEvent<DropdownItem>) => {
                  e.stopPropagation();
                  handlers.onSelectPreviewLocale?.(e.detail.id);
                }}
              ></pix3-dropdown-button>
            </div>
          `
        : null}
      ${renderAlignmentToolbarGroups(
        {
          showAlignmentTools: state.showAlignmentTools,
          canAlignToContainer: state.canAlignToContainer,
          canAlignToSelectionBounds: state.canAlignToSelectionBounds,
          canDistributeSelection: state.canDistributeSelection,
        },
        {
          onRunAlignmentAction: handlers.onRunAlignmentAction,
        },
        iconService
      )}

      <div class="toolbar-spacer"></div>

      ${state.canToggleLayerVisibility
        ? html`
            <div class="toolbar-group" role="group" aria-label="Layer visibility">
              ${renderToolbarButton(
                {
                  ariaLabel: 'Toggle 2D layer visibility',
                  title: `2D Layer: ${state.showLayer2D ? 'Visible' : 'Hidden'} (2)`,
                  iconName: 'layer-2d',
                  isPressed: state.showLayer2D,
                  isActive: state.showLayer2D,
                  onClick: handlers.onToggleLayer2D,
                  extraClass: 'toolbar-button--layer',
                },
                iconService
              )}
              ${renderToolbarButton(
                {
                  ariaLabel: 'Toggle 3D layer visibility',
                  title: `3D Layer: ${state.showLayer3D ? 'Visible' : 'Hidden'} (3)`,
                  iconName: 'layer-3d',
                  isPressed: state.showLayer3D,
                  isActive: state.showLayer3D,
                  onClick: handlers.onToggleLayer3D,
                  extraClass: 'toolbar-button--layer',
                },
                iconService
              )}
            </div>
          `
        : null}

      <div class="toolbar-group" role="toolbar" aria-label="Viewport visibility settings">
        ${renderToolbarButton(
          {
            ariaLabel: 'Toggle snap to grid',
            title: `Snap to Grid: ${state.snapToGrid ? 'On' : 'Off'} (Shift+G)`,
            iconName: 'snap',
            isPressed: state.snapToGrid,
            isActive: state.snapToGrid,
            onClick: handlers.onToggleSnapToGrid,
            extraClass: 'toolbar-button--snap',
          },
          iconService
        )}
        ${renderToolbarButton(
          {
            ariaLabel: `Editor camera projection: ${formatEditorCameraProjection(
              state.editorCameraProjection
            )}`,
            title: `Switch editor camera to ${formatEditorCameraProjection(
              getNextEditorCameraProjection(state.editorCameraProjection)
            )}`,
            iconName:
              state.editorCameraProjection === 'perspective'
                ? 'camera-projection-perspective'
                : 'camera-projection-orthographic',
            isPressed: state.editorCameraProjection === 'orthographic',
            onClick: () =>
              handlers.onSetEditorCameraProjection(
                getNextEditorCameraProjection(state.editorCameraProjection)
              ),
            extraClass: 'toolbar-button--camera-projection',
          },
          iconService
        )}
        <pix3-viewport-visibility-popover
          .showGrid=${state.showGrid}
          .showLighting=${state.showLighting}
          @toggle-grid=${() => handlers.onToggleGrid()}
          @toggle-lighting=${() => handlers.onToggleLighting()}
        ></pix3-viewport-visibility-popover>
      </div>
    </div>
  `;
}

function getNextEditorCameraProjection(projection: EditorCameraProjection): EditorCameraProjection {
  return projection === 'perspective' ? 'orthographic' : 'perspective';
}

function formatEditorCameraProjection(projection: EditorCameraProjection): string {
  return projection === 'perspective' ? 'Perspective' : 'Orthographic';
}

function renderAlignmentToolbarGroups(
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
    <div class="toolbar-alignment-strip" role="toolbar" aria-label="2D alignment tools">
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
  `;
}

const ZOOM_OVERLAY_BUTTONS: readonly {
  readonly key: 'in' | 'out' | 'all';
  readonly iconName: string;
  readonly ariaLabel: string;
  readonly title: string;
}[] = [
  { key: 'in', iconName: 'zoom-in', ariaLabel: 'Zoom in', title: 'Zoom In (=)' },
  { key: 'out', iconName: 'zoom-out', ariaLabel: 'Zoom out', title: 'Zoom Out (-)' },
  { key: 'all', iconName: 'zoom-fit', ariaLabel: 'Show all', title: 'Show All (F)' },
];

export function renderViewportZoomOverlay(
  handlers: ViewportZoomOverlayHandlers,
  iconService: IconService
): TemplateResult {
  const onClickByKey: Record<'in' | 'out' | 'all', () => void> = {
    in: handlers.onZoomIn,
    out: handlers.onZoomOut,
    all: handlers.onZoomAll,
  };

  return html`
    <div
      class="zoom-overlay-shell"
      @click=${(e: Event) => e.stopPropagation()}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @pointerup=${(e: Event) => e.stopPropagation()}
      @wheel=${(e: Event) => e.stopPropagation()}
    >
      <div class="zoom-overlay" role="toolbar" aria-label="Viewport zoom">
        ${ZOOM_OVERLAY_BUTTONS.map(({ key, iconName, ariaLabel, title }) =>
          renderToolbarButton(
            {
              ariaLabel,
              title,
              iconName,
              onClick: onClickByKey[key],
            },
            iconService
          )
        )}
      </div>
    </div>
  `;
}

export interface TransformToolbarState {
  readonly transformMode: TransformMode | null;
}

export interface TransformToolbarHandlers {
  readonly onTransformModeChange?: (mode: TransformMode) => void;
}

export function renderTransformToolbarOverlay(
  state: TransformToolbarState,
  handlers: TransformToolbarHandlers,
  iconService: IconService
): TemplateResult | null {
  if (state.transformMode === null || !handlers.onTransformModeChange) {
    return null;
  }

  return html`
    <div
      class="transform-overlay-shell"
      @click=${(e: Event) => e.stopPropagation()}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @pointerup=${(e: Event) => e.stopPropagation()}
      @wheel=${(e: Event) => e.stopPropagation()}
    >
      <div class="transform-overlay" role="toolbar" aria-label="Transform tools">
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
