import type { Camera, Vector3 } from 'three';
/** A point in canvas backing-store pixels (origin top-left, y down). */
export interface CanvasPoint {
    x: number;
    y: number;
}
export interface SizeLike {
    width: number;
    height: number;
}
/**
 * Inverse of the fixed logical-size pointer mapping in `Node2D.pointerToWorld`:
 * maps a 2D world point (ortho space, origin center, y up) to canvas
 * backing-store pixels. Used for overlay-band (CanvasLayer2D) content — which is
 * pinned by the identity overlay camera — and as the no-camera fallback.
 */
export declare function worldToCanvasLogical(worldX: number, worldY: number, logicalSize: SizeLike, canvasSize: SizeLike): CanvasPoint | null;
/**
 * Project a world-space point through a camera to canvas backing-store pixels —
 * the inverse of the `unproject` branch in `Node2D.pointerToWorld` (and the
 * standard NDC mapping for 3D cameras). The camera's matrices must be current
 * (they are: the runner updates them every rendered frame). Mutates `point`.
 */
export declare function worldToCanvasThroughCamera(point: Vector3, camera: Camera, canvasSize: SizeLike): CanvasPoint | null;
