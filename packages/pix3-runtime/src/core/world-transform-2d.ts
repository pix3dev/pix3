import { Matrix4, Quaternion, Vector3, type Object3D } from 'three';
import type { ShapeTransform2D } from './collision-shapes-2d';

/**
 * Read an `Object3D`'s world transform as the flat 2D triple the collision math
 * speaks: position, z-rotation in radians, and signed non-uniform scale.
 *
 * Why a decompose and not `getWorldPosition` + `getWorldScale`: the query tier
 * historically ignored rotation (`Collision2DService`'s v1 contract), and a
 * polygon collider cannot — a rotated ship's outline *is* the shape. `decompose`
 * is also the only way to get the sign right: three puts the mirror on `scale.x`
 * when the matrix determinant is negative, which is exactly the flag
 * `transformPolygon` needs to keep a loop counter-clockwise.
 *
 * The z-rotation is extracted from the quaternion the way a 2D scene means it
 * (rotation about z only). A node that has been rotated about x or y — legal in
 * a 3D subtree, meaningless for a 2D collider — yields the z component of the
 * equivalent yaw, which is the closest thing to an answer this contract has.
 */

const scratchMatrix = new Matrix4();
const scratchPosition = new Vector3();
const scratchQuaternion = new Quaternion();
const scratchScale = new Vector3();

export function readWorldTransform2D(object: Object3D, out?: ShapeTransform2D): ShapeTransform2D {
  const target: ShapeTransform2D = out ?? { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };

  // Matches what `getWorldPosition` does internally: refresh the ancestor chain
  // so a mid-frame query sees the transforms scripts have just written.
  object.updateWorldMatrix(true, false);
  scratchMatrix.copy(object.matrixWorld);
  scratchMatrix.decompose(scratchPosition, scratchQuaternion, scratchScale);

  target.x = scratchPosition.x;
  target.y = scratchPosition.y;
  target.rotation = quaternionToRotationZ(scratchQuaternion);
  target.scaleX = scratchScale.x || 1;
  target.scaleY = scratchScale.y || 1;
  return target;
}

/** Z-axis angle of a quaternion, in radians, CCW. */
export function quaternionToRotationZ(q: Quaternion): number {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
}
