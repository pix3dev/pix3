import * as THREE from 'three';

/**
 * Pure geometric/numeric helpers backing the camera framing/zoom methods of
 * `ViewportRendererService`. These are deliberately free of `this`, THREE.js
 * side effects on their inputs, and any service/DOM/appState dependency, so the
 * framing math can be reasoned about and unit-tested in isolation. The stateful
 * camera-mutating methods stay on the service and call into these.
 */

/**
 * Resolve the view DIRECTION to preserve when framing a 3D camera. Returns a NEW
 * normalized vector pointing from the orbit target toward the camera; falls back
 * to the default diagonal (1,1,1) only when the camera sits exactly on its
 * target. Inputs are never mutated.
 */
export function resolvePreservedViewDirection(
  cameraPosition: THREE.Vector3,
  target: THREE.Vector3
): THREE.Vector3 {
  const direction = cameraPosition.clone().sub(target);
  if (direction.lengthSq() < 1e-8) {
    direction.set(1, 1, 1);
  }
  return direction.normalize();
}

/**
 * Distance a perspective camera must sit from a bounding sphere so it fills the
 * viewport with `paddingMultiplier` margin. Fits to the narrower of the vertical
 * and horizontal FOV, and clamps to `near * 2` so the near plane never clips.
 */
export function computePerspectiveFitDistance(
  sphereRadius: number,
  paddingMultiplier: number,
  fovDeg: number,
  aspect: number,
  near: number
): number {
  const vFov = (fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const fitFov = Math.max(Math.min(vFov, hFov), 1e-3);
  let distance = (sphereRadius * paddingMultiplier) / Math.sin(fitFov / 2);
  distance = Math.max(distance, near * 2);
  return distance;
}

/**
 * Orthographic `zoom` that fits a 3D bounding-box footprint (`sizeX`/`sizeY`)
 * into the editor-orthographic frustum with `paddingMultiplier` margin. The
 * frustum height is a viewport-service constant passed in by the caller.
 */
export function computeOrtho3DFitZoom(
  sizeX: number,
  sizeY: number,
  paddingMultiplier: number,
  viewportWidth: number,
  viewportHeight: number,
  frustumHeight: number
): number {
  const viewHeight = frustumHeight;
  const viewWidth = viewHeight * Math.max(viewportWidth / viewportHeight, 1);
  return (
    Math.max(0.1, Math.min(viewWidth / Math.max(sizeX, 1), viewHeight / Math.max(sizeY, 1))) /
    paddingMultiplier
  );
}

/**
 * Orthographic (2D) `zoom` that fits `size` into the camera's base frustum
 * (`cameraLeft/right/top/bottom`) with `paddingMultiplier` margin. Padded target
 * dimensions and the base frustom extents are floored at 1 to avoid NaN/blow-up
 * on degenerate inputs, and the result is floored at 0.1.
 */
export function computeOrtho2DFitZoom(
  size: THREE.Vector3,
  paddingMultiplier: number,
  cameraLeft: number,
  cameraRight: number,
  cameraTop: number,
  cameraBottom: number
): number {
  const paddedWidth = Math.max(size.x * paddingMultiplier, 1);
  const paddedHeight = Math.max(size.y * paddingMultiplier, 1);
  const baseWidth = Math.max(Math.abs(cameraRight - cameraLeft), 1);
  const baseHeight = Math.max(Math.abs(cameraTop - cameraBottom), 1);
  return Math.max(0.1, Math.min(baseWidth / paddedWidth, baseHeight / paddedHeight));
}

/**
 * Fixed fallback framing box centered on `anchor`, used when the real content
 * bounds are empty or degenerate (empty groups, cameras, lights) so focusing
 * them still produces a sensible view instead of a NaN zoom. Returns a new Box3.
 */
export function computeFallbackFramingBounds(
  anchor: THREE.Vector3,
  dim: '2d' | '3d',
  halfExtent2D: number,
  halfExtent3D: number
): THREE.Box3 {
  const half = dim === '2d' ? halfExtent2D : halfExtent3D;
  return new THREE.Box3().setFromCenterAndSize(
    anchor,
    new THREE.Vector3(half * 2, half * 2, half * 2)
  );
}
