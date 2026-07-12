import { Box3, Matrix4, Object3D, OrthographicCamera, Sphere, Vector3 } from 'three';

/**
 * Pure geometry helpers for the ambient-occlusion baker. Kept free of any WebGL
 * so they can be unit-tested without a GPU context (the bake render passes in
 * {@link ../AOBakeService} build on top of these).
 *
 * AO strategy: sample many directions over the sphere; for each direction render
 * the scene's depth from an orthographic camera looking along it, then per
 * lightmap texel test whether the surface point is the closest hit along that
 * direction (visible) or behind something (occluded), cosine-weighted by the
 * surface normal. These helpers produce the sample directions, the scene bounds,
 * and the per-direction ortho camera fit.
 */

/** Golden-angle increment for the Fibonacci-sphere distribution. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Evenly distributed unit directions on the full sphere (Fibonacci sphere).
 * Deterministic for a given `count` — no RNG, so bakes are reproducible.
 */
export function generateSphereDirections(count: number): Vector3[] {
  const n = Math.max(1, Math.floor(count));
  const dirs: Vector3[] = [];
  for (let i = 0; i < n; i += 1) {
    // y from ~+1 down to ~-1, spread so samples don't cluster at the poles.
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * GOLDEN_ANGLE;
    dirs.push(new Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r).normalize());
  }
  return dirs;
}

/**
 * World-space axis-aligned bounds enclosing all given objects (recursively,
 * including their descendants' geometry). Returns an empty (but valid) box when
 * there is nothing to enclose.
 */
export function computeWorldBounds(objects: readonly Object3D[]): Box3 {
  const bounds = new Box3();
  bounds.makeEmpty();
  const scratch = new Box3();
  for (const object of objects) {
    object.updateWorldMatrix(true, true);
    scratch.setFromObject(object);
    if (!scratch.isEmpty()) {
      bounds.union(scratch);
    }
  }
  return bounds;
}

/**
 * Aim and size an orthographic camera so it looks along `-direction` and fully
 * covers `bounds` (with a little padding). Used to render the occluder depth map
 * for one sample direction. Mutates and returns the camera; safe when the camera
 * frustum needs its `projectionMatrix` rebuilt afterwards (done here).
 */
export function fitOrthoToBounds(
  camera: OrthographicCamera,
  bounds: Box3,
  direction: Vector3,
  padding = 1.05
): OrthographicCamera {
  const center = bounds.getCenter(new Vector3());
  const sphere = bounds.getBoundingSphere(new Sphere());
  const radius = Math.max(1e-4, sphere.radius) * padding;

  const dir = direction.clone().normalize();
  const dist = radius * 2;
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.up.set(0, 1, 0);
  // Avoid a degenerate up vector when looking straight up/down.
  if (Math.abs(dir.y) > 0.999) {
    camera.up.set(0, 0, 1);
  }
  camera.lookAt(center);

  camera.left = -radius;
  camera.right = radius;
  camera.top = radius;
  camera.bottom = -radius;
  camera.near = 0.01;
  camera.far = dist + radius * 2;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

/** View-projection matrix for a fitted camera (world → clip), for depth reprojection. */
export function viewProjectionMatrix(camera: OrthographicCamera): Matrix4 {
  camera.updateMatrixWorld(true);
  return new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
}
