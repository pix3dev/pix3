export type Align2DActionId =
  | 'container-left'
  | 'container-center-x'
  | 'container-right'
  | 'container-top'
  | 'container-center-y'
  | 'container-bottom'
  | 'selection-left'
  | 'selection-center-x'
  | 'selection-right'
  | 'selection-top'
  | 'selection-center-y'
  | 'selection-bottom'
  | 'distribute-gap-x'
  | 'distribute-gap-y'
  | 'distribute-center-x'
  | 'distribute-center-y';

/**
 * Display name of each alignment action — the single source for the viewport toolbar's
 * `aria-label`/`title` and for the `Node ▸ Align` / `Node ▸ Distribute` menu rows. One table so a
 * row and the button that runs the same operation can never read differently.
 */
export const ALIGN_2D_ACTION_LABELS: Record<Align2DActionId, string> = {
  'container-left': 'Align Left to Container',
  'container-center-x': 'Align Horizontal Center to Container',
  'container-right': 'Align Right to Container',
  'container-top': 'Align Top to Container',
  'container-center-y': 'Align Vertical Center to Container',
  'container-bottom': 'Align Bottom to Container',
  'selection-left': 'Align Left to Selection Bounds',
  'selection-center-x': 'Align Horizontal Center to Selection Bounds',
  'selection-right': 'Align Right to Selection Bounds',
  'selection-top': 'Align Top to Selection Bounds',
  'selection-center-y': 'Align Vertical Center to Selection Bounds',
  'selection-bottom': 'Align Bottom to Selection Bounds',
  'distribute-gap-x': 'Distribute Horizontal Gaps',
  'distribute-center-x': 'Distribute Centers Horizontally',
  'distribute-gap-y': 'Distribute Vertical Gaps',
  'distribute-center-y': 'Distribute Centers Vertically',
};
