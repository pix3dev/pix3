import { html, type TemplateResult } from 'lit';
import type { DropdownItem } from '@/ui/shared/pix3-dropdown-button';
import { ALIGN_2D_ACTION_LABELS, type Align2DActionId } from '@/features/alignment/types';
import type { Align2DCapabilities } from '@/features/alignment/align-2d-capabilities';

import type { EditorCameraProjection, NavigationMode } from '@/state';
import type { IconService } from '@/services/editor/IconService';
import type { TransformMode } from '@/services/viewport/ViewportRenderService';

export interface ViewportToolbarState {
  readonly transformMode: TransformMode | null;
  readonly showGrid: boolean;
  readonly showAxisGizmo: boolean;
  readonly snapToGrid: boolean;
  readonly showLighting: boolean;
  readonly showCollisionShapes: boolean;
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
  /**
   * Which alignment actions the selection admits. Computed by
   * `computeAlign2DCapabilities` — the same helper the `Node > Align` / `Node > Distribute`
   * commands run in their `preconditions()`, so a hidden group here and a greyed menu row there
   * can never disagree.
   */
  readonly alignment: Align2DCapabilities;
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
  readonly onToggleAxisGizmo: () => void;
  readonly onToggleSnapToGrid: () => void;
  readonly onToggleLighting: () => void;
  readonly onToggleCollisionShapes: () => void;
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
  readonly alignment: Align2DCapabilities;
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

/**
 * The three alignment groups, in toolbar order. Labels are not repeated here: they come from
 * `ALIGN_2D_ACTION_LABELS`, shared with the `Node > Align` / `Node > Distribute` menu rows so the
 * button and the row that run the same operation always read the same.
 */
interface AlignmentToolbarAction {
  readonly action: Align2DActionId;
  readonly iconName: string;
}

const CONTAINER_ALIGNMENT_ACTIONS: readonly AlignmentToolbarAction[] = [
  { action: 'container-left', iconName: 'align-selection-left' },
  { action: 'container-center-x', iconName: 'align-selection-center-x' },
  { action: 'container-right', iconName: 'align-selection-right' },
  { action: 'container-top', iconName: 'align-selection-top' },
  { action: 'container-center-y', iconName: 'align-selection-center-y' },
  { action: 'container-bottom', iconName: 'align-selection-bottom' },
];

const SELECTION_ALIGNMENT_ACTIONS: readonly AlignmentToolbarAction[] = [
  { action: 'selection-left', iconName: 'align-container-left' },
  { action: 'selection-center-x', iconName: 'align-container-center-x' },
  { action: 'selection-right', iconName: 'align-container-right' },
  { action: 'selection-top', iconName: 'align-container-top' },
  { action: 'selection-center-y', iconName: 'align-container-center-y' },
  { action: 'selection-bottom', iconName: 'align-container-bottom' },
];

const DISTRIBUTION_ACTIONS: readonly AlignmentToolbarAction[] = [
  { action: 'distribute-gap-x', iconName: 'distribute-gap-x' },
  { action: 'distribute-center-x', iconName: 'distribute-center-x' },
  { action: 'distribute-gap-y', iconName: 'distribute-gap-y' },
  { action: 'distribute-center-y', iconName: 'distribute-center-y' },
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
          alignment: state.alignment,
        },
        {
          onRunAlignmentAction: handlers.onRunAlignmentAction,
        },
        iconService
      )}

      <div class="toolbar-spacer"></div>

      ${state.canToggleLayerVisibility
        ? html`
            <div class="toolbar-group" role="group" aria-label="Dimension filter">
              ${renderToolbarButton(
                {
                  ariaLabel: 'Show 2D content',
                  title: `2D content: ${state.showLayer2D ? 'Shown' : 'Hidden'} (2)`,
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
                  ariaLabel: 'Show 3D content',
                  title: `3D content: ${state.showLayer3D ? 'Shown' : 'Hidden'} (3)`,
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
          .showAxisGizmo=${state.showAxisGizmo}
          .showLighting=${state.showLighting}
          .showCollisionShapes=${state.showCollisionShapes}
          @toggle-grid=${() => handlers.onToggleGrid()}
          @toggle-axis-gizmo=${() => handlers.onToggleAxisGizmo()}
          @toggle-lighting=${() => handlers.onToggleLighting()}
          @toggle-collision-shapes=${() => handlers.onToggleCollisionShapes()}
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
  const canRun = state.showAlignmentTools && Boolean(handlers.onRunAlignmentAction);
  const showContainerAlignment = canRun && state.alignment.canAlignToContainer;
  const showSelectionAlignment = canRun && state.alignment.canAlignToSelectionBounds;
  const showDistribution = canRun && state.alignment.canDistributeSelection;

  if (!showContainerAlignment && !showSelectionAlignment && !showDistribution) {
    return null;
  }

  return html`
    <div class="toolbar-alignment-strip" role="toolbar" aria-label="2D alignment tools">
      ${showSelectionAlignment
        ? html`
            <div class="toolbar-group" role="group" aria-label="Align to selection bounds">
              ${SELECTION_ALIGNMENT_ACTIONS.map(({ action, iconName }) =>
                renderToolbarButton(
                  {
                    ariaLabel: ALIGN_2D_ACTION_LABELS[action],
                    title: ALIGN_2D_ACTION_LABELS[action],
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
              ${CONTAINER_ALIGNMENT_ACTIONS.map(({ action, iconName }) =>
                renderToolbarButton(
                  {
                    ariaLabel: ALIGN_2D_ACTION_LABELS[action],
                    title: ALIGN_2D_ACTION_LABELS[action],
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
              ${DISTRIBUTION_ACTIONS.map(({ action, iconName }) =>
                renderToolbarButton(
                  {
                    ariaLabel: ALIGN_2D_ACTION_LABELS[action],
                    title: ALIGN_2D_ACTION_LABELS[action],
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
