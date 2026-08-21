import { describe, it, expect } from 'vitest';
import { getAxisGizmoRect, isPointInAxisGizmo } from '@/services/viewport/ViewportAxisGizmo';

/**
 * The hit box has to agree with where the gizmo actually draws itself. It does
 * not, on its own, know the renderer's units — `render()` scales this CSS-pixel
 * box into the renderer's logical space — so a mismatch here is what makes
 * clicks near the gizmo fall through to picking and clear the selection.
 */
describe('axis gizmo hit box', () => {
  const SIZE = 104;
  const MARGIN = 12;

  it('sits in the bottom-right corner, inset by the margin', () => {
    const rect = getAxisGizmoRect(1000, 600);

    expect(rect).toEqual({
      x: 1000 - SIZE - MARGIN,
      y: 600 - SIZE - MARGIN,
      width: SIZE,
      height: SIZE,
    });
  });

  it('accepts points inside the box and rejects the rest of the canvas', () => {
    const width = 1000;
    const height = 600;
    const right = width - MARGIN;
    const bottom = height - MARGIN;

    // Centre of the gizmo, then its two extreme corners.
    expect(isPointInAxisGizmo(right - SIZE / 2, bottom - SIZE / 2, width, height)).toBe(true);
    expect(isPointInAxisGizmo(right - SIZE, bottom - SIZE, width, height)).toBe(true);
    expect(isPointInAxisGizmo(right, bottom, width, height)).toBe(true);

    // One pixel outside on each side.
    expect(isPointInAxisGizmo(right - SIZE - 1, bottom - SIZE / 2, width, height)).toBe(false);
    expect(isPointInAxisGizmo(right - SIZE / 2, bottom - SIZE - 1, width, height)).toBe(false);
    expect(isPointInAxisGizmo(right + 1, bottom - SIZE / 2, width, height)).toBe(false);
    expect(isPointInAxisGizmo(right - SIZE / 2, bottom + 1, width, height)).toBe(false);

    // Scene surface: viewport centre and the opposite corner.
    expect(isPointInAxisGizmo(width / 2, height / 2, width, height)).toBe(false);
    expect(isPointInAxisGizmo(0, 0, width, height)).toBe(false);
  });

  it('follows the canvas as it resizes', () => {
    expect(getAxisGizmoRect(300, 200).x).toBe(300 - SIZE - MARGIN);
    expect(getAxisGizmoRect(1920, 1080).x).toBe(1920 - SIZE - MARGIN);

    // The same point is over the gizmo on a large canvas and nowhere near it on
    // a small one — the box is anchored, never absolute.
    expect(isPointInAxisGizmo(1920 - MARGIN - 20, 1080 - MARGIN - 20, 1920, 1080)).toBe(true);
    expect(isPointInAxisGizmo(1920 - MARGIN - 20, 1080 - MARGIN - 20, 300, 200)).toBe(false);
  });
});
