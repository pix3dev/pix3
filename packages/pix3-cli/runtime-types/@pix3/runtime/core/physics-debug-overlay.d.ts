import { type Camera } from 'three';
import { type PhysicsDebugBuffers } from './game-debug';
import type { RuntimeRenderer } from './RuntimeRenderer';
/**
 * Renders physics collider wireframes over the running scene.
 *
 * Physics lives in the game (e.g. a Rapier `World`), opaque to the runtime; a
 * game publishes its collider line-segment buffers through
 * `registerPhysicsDebugSource`. This overlay pulls those buffers each frame and
 * draws them as world-space `LineSegments`, layered on top of the 3D pass.
 *
 * Buffer layout mirrors Rapier's `World.debugRender()`: `vertices` is 3 floats
 * per point (2 points per segment); optional `colors` is 4 floats (RGBA) per
 * point. Lines draw with depth testing disabled so every collider stays visible
 * even when occluded by geometry — the whole point of a debug overlay.
 *
 * Attributes are reused frame-to-frame and only reallocated when the collider
 * set grows, so the steady state is a cheap re-upload rather than per-frame GC.
 */
export declare class PhysicsDebugOverlay {
    private readonly geometry;
    private readonly material;
    private readonly lines;
    private readonly overlayScene;
    private positionAttr;
    private colorAttr;
    constructor();
    /**
     * Pull the latest collider buffers and upload them to the GPU. Returns true
     * when there is geometry to draw this frame.
     */
    private sync;
    /** Upload one set of buffers. Returns true when there is geometry to draw. */
    private upload;
    /** Draw the overlay if a source is registered and producing geometry. */
    render(renderer: RuntimeRenderer, camera: Camera): void;
    /**
     * Draw buffers the caller already has, bypassing the registered source.
     *
     * The pull-based source is a *game's* physics world, drawn with the 3D camera.
     * The engine's own 2D solver works in design pixels and has to be drawn with
     * the orthographic camera instead — same geometry pipeline, different band.
     */
    renderBuffers(renderer: RuntimeRenderer, camera: Camera, buffers: PhysicsDebugBuffers | null): void;
    dispose(): void;
}
