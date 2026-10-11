import { Quaternion, type Object3D } from 'three';
import type { ShapeTransform2D } from './collision-shapes-2d';
export declare function readWorldTransform2D(object: Object3D, out?: ShapeTransform2D): ShapeTransform2D;
/** Z-axis angle of a quaternion, in radians, CCW. */
export declare function quaternionToRotationZ(q: Quaternion): number;
