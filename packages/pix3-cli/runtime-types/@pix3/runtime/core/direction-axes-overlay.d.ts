import { type Camera } from 'three';
import type { NodeBase } from '../nodes/NodeBase';
import type { RuntimeRenderer } from './RuntimeRenderer';
/** Which layer's nodes an overlay pass draws axes for. */
export type DirectionAxesKind = 'node2d' | 'node3d';
/**
 * Renders per-node local-axis gizmos over the running scene so orientation is
 * visible — X (red), Y (green) and, for 3D nodes, Z (blue) drawn from each
 * node's world origin along its world basis. The point is diagnostic: a flat
 * screenshot can't reveal that a moving sprite is facing the wrong way; these
 * arrows can.
 *
 * 2D and 3D nodes render through different cameras (the ortho 2D pass vs. the
 * active Camera3D), so a pass draws exactly one `kind` with the matching camera.
 * Lines draw with depth testing disabled so gizmos stay visible through
 * geometry. Scratch arrays are reused frame-to-frame and the GPU attributes only
 * grow, so the steady state is a cheap re-upload rather than per-frame GC.
 */
export declare class DirectionAxesOverlay {
    private readonly geometry;
    private readonly material;
    private readonly lines;
    private readonly overlayScene;
    private positionAttr;
    private colorAttr;
    private readonly positions;
    private readonly colors;
    private readonly origin;
    private readonly axis;
    private readonly perp;
    private readonly cameraPosition;
    constructor();
    /**
     * Draw axis gizmos for every visible node of `kind` reachable from
     * `rootNodes`, using `camera` (which must be the same camera the matching
     * render pass used, so world-space endpoints project correctly).
     */
    render(renderer: RuntimeRenderer, camera: Camera, rootNodes: readonly NodeBase[], kind: DirectionAxesKind): void;
    /** DFS the graph, emitting arrows for matching visible nodes. */
    private collect;
    private emitForNode;
    /**
     * Emit one arrow (shaft + two barbs) for the current `this.axis` direction,
     * starting at `this.origin`. `this.axis` need not be normalised on entry.
     */
    private emitArrow;
    private pushSegment;
    /** A unit vector perpendicular to `dir` (assumed normalised), written to `out`. */
    private perpendicular3;
    dispose(): void;
}
