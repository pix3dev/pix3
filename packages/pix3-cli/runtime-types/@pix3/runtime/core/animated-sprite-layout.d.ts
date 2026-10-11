import type { AnimationFrame, AnimationFramePoint, AnimationSize } from './AnimationResource';
/**
 * How a frame's raster fills the node's box.
 *
 * - `stretch` (default, and what every pre-existing scene assumes): every frame
 *   is scaled to exactly `width × height`.
 * - `native`: each frame renders at its own `sourceSize` scaled by a per-clip
 *   factor derived from the clip's first frame, so tightly-cropped frames of
 *   differing sizes keep their relative proportions and, with per-frame anchors,
 *   stay aligned. Resizing the node scales the whole animation uniformly.
 */
export type AnimatedSpriteSizeMode = 'stretch' | 'native';
/** Normalized pivot in local sprite space, matching `Sprite2D`'s (y is up). */
export interface AnimatedSpriteAnchor2D {
    x: number;
    y: number;
}
export interface AnimatedSpriteLayoutInput {
    nodeWidth: number;
    nodeHeight: number;
    /** Node-level pivot (y up). */
    anchor: AnimatedSpriteAnchor2D;
    sizeMode: AnimatedSpriteSizeMode;
    /** The frame being displayed, or `null` when the clip has none. */
    frame: AnimationFrame | null;
    /** Native pixel size of {@link frame}, or `null` when unknown. */
    frameSourceSize: AnimationSize | null;
    /** Native pixel size of the clip's FIRST frame — the `native` scale reference. */
    clipFirstFrameSourceSize: AnimationSize | null;
}
export interface AnimatedSpriteFrameLayout {
    /** Quad size in node-local units. */
    width: number;
    height: number;
    /** Quad centre offset from the node origin, in node-local units (y up). */
    offsetX: number;
    offsetY: number;
}
/**
 * Resolve the displayed quad for one animation frame.
 *
 * Two anchors are in play and they mean different things:
 *
 * - the **node anchor** is a global pivot inside the node's own `width × height`
 *   box, y up, identical in meaning to `Sprite2D.anchor`;
 * - the **frame anchor** is the frame's own origin inside its — possibly tightly
 *   cropped — raster, normalized to the frame rect with y measured from the TOP
 *   (the image convention shared with `boundingBox`/`collisionPolygon`, and what
 *   the editor's overlay draws at `top: anchor.y * 100%`).
 *
 * They compose: the quad is placed so the frame anchor lands on the node origin,
 * then shifted by the node pivot. Cropping a frame tighter and moving its anchor
 * to the old visual centre therefore leaves the animation pixel-identical while
 * the PNG (and later the atlas) shrinks.
 *
 * This lives in one shared module because the editor viewport draws SEPARATE
 * proxy meshes rather than the runtime nodes — both callers must apply exactly
 * this math or the editor and the game disagree about where a frame sits.
 */
export declare function resolveAnimatedSpriteFrameLayout(input: AnimatedSpriteLayoutInput): AnimatedSpriteFrameLayout;
/** A frame point resolved into node-local space. */
export interface ResolvedFramePoint {
    x: number;
    y: number;
    /** Degrees, clockwise, 0 = pointing right. */
    angle: number;
}
/**
 * Map a frame point's normalized frame-space coordinates onto the laid-out quad,
 * yielding node-local coordinates directly usable as a child node's position.
 * Composed through the same layout as the visible pixels, so a point stays glued
 * to the art through `sizeMode`, per-clip scaling, and both anchors.
 */
export declare function resolveFramePointToLocal(point: AnimationFramePoint, layout: AnimatedSpriteFrameLayout): ResolvedFramePoint;
/**
 * Map a frame's authored collision polygon onto the laid-out quad, yielding
 * node-local vertices (y up) a collider can use directly.
 *
 * The two coordinate spaces differ in both origin and axis: `collisionPolygon`
 * is in **absolute frame pixels** with y measured from the top of the frame's
 * raster (what the sprite editor's overlay SVG draws over, and what
 * `traceCollisionPolygon` produces), while node-local space is centred on the
 * quad with y up. Normalizing by the frame's own pixel size is the step that
 * makes a traced outline survive `sizeMode: 'native'`, per-clip scaling and both
 * anchors — exactly like {@link resolveFramePointToLocal}, which takes its input
 * already normalized.
 *
 * Returns `[]` when the frame size is unknown (`0x0`), because without it there
 * is no way to place the vertices and a guessed scale would put the collider
 * somewhere plausible but wrong.
 */
export declare function resolveFramePolygonToLocal(polygon: readonly {
    x: number;
    y: number;
}[], layout: AnimatedSpriteFrameLayout, frameSize: AnimationSize | null): {
    x: number;
    y: number;
}[];
