export interface AnimationVector2 {
    x: number;
    y: number;
}
export interface AnimationBoundingBox {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface AnimationPolygonPoint {
    x: number;
    y: number;
}
export type AnimationPlaybackMode = 'normal' | 'ping-pong';
/**
 * A signal emitted when a flipbook clip enters this frame during play-driven
 * advance (AnimatedSprite2D/3D). `args` is a raw string parsed at fire time by
 * `parseEventArgs` (same convention as the keyframe event-track).
 */
export interface AnimationFrameEvent {
    signal: string;
    args: string;
}
/** Intrinsic pixel size of a frame's raster. `0×0` means "unknown". */
export interface AnimationSize {
    width: number;
    height: number;
}
/**
 * A named point that lives in frame space and moves (and rotates) across frames —
 * a muzzle on a gun barrel, a hand socket an item follows through a walk cycle.
 * Construct 3 calls these "image points"; the `angle` makes ours a full 2D socket
 * (a direction, not just a position).
 *
 * Coordinates are normalized to the frame rect with y measured from the top, the
 * same convention as {@link AnimationFrame.anchor} (the UI shows pixels). `angle`
 * is in degrees, clockwise, 0 = pointing right.
 */
export interface AnimationFramePoint {
    name: string;
    x: number;
    y: number;
    angle?: number;
}
export interface AnimationFrame {
    textureIndex: number;
    offset: AnimationVector2;
    repeat: AnimationVector2;
    durationMultiplier: number;
    /**
     * The frame's own origin, normalized to the frame rect with **y measured from
     * the top** (same convention as `boundingBox` and `collisionPolygon`; the
     * editor's overlay places its marker at `top: anchor.y * 100%`). This is the
     * point in the — possibly tightly cropped — raster that lands on the node's
     * position, so cropping a frame and moving its anchor keeps the animation
     * visually identical while the PNG shrinks. Composes with the node-level
     * `AnimatedSprite2D.anchor`, which is a separate global offset.
     */
    anchor: AnimationVector2;
    texturePath: string;
    boundingBox: AnimationBoundingBox;
    collisionPolygon: AnimationPolygonPoint[];
    /**
     * Signals fired when the clip enters this frame (play-mode advance only).
     * Optional so existing frame literals stay valid; `normalizeFrame` always
     * materializes it to `[]`, so runtime (loaded) frames always carry the field.
     */
    events?: AnimationFrameEvent[];
    /**
     * Intrinsic pixel size of this frame's raster, stamped by the editor whenever a
     * frame is added / replaced / cropped so `sizeMode: 'native'` layout never has
     * to wait on a texture load. Optional in authored files; `normalizeFrame`
     * materializes it (falling back to the bounding box, then `0×0`). A `0×0` size
     * makes the frame fall back to stretch layout, so legacy files keep working.
     */
    sourceSize?: AnimationSize;
    /**
     * Named sockets in this frame's space. Optional in authored files;
     * `normalizeFrame` materializes `[]` and de-duplicates names within a frame
     * (first occurrence wins), so runtime frames always carry the field.
     */
    points?: AnimationFramePoint[];
}
export interface AnimationClip {
    name: string;
    frames: AnimationFrame[];
    fps: number;
    loop: boolean;
    playbackMode: AnimationPlaybackMode;
}
export interface AnimationResource {
    version: string;
    texturePath: string;
    clips: AnimationClip[];
}
export declare function getAnimationFrameTexturePath(resource: AnimationResource | null | undefined, frame: AnimationFrame | null | undefined): string;
export declare function isSequenceAnimationFrame(frame: AnimationFrame | null | undefined): boolean;
/** Look up a named point on a frame, or `null` when the frame doesn't define it. */
export declare function findAnimationFramePoint(frame: AnimationFrame | null | undefined, name: string): AnimationFramePoint | null;
/** Every point name defined anywhere in a clip, in first-seen order. */
export declare function collectClipPointNames(clip: AnimationClip | null | undefined): string[];
export declare function normalizeAnimationResource(resource: unknown): AnimationResource;
export declare function findAnimationClip(resource: AnimationResource | null | undefined, clipName: string | null | undefined): AnimationClip | null;
