import {
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Vector3,
  type Camera,
} from 'three';
import type { NodeBase } from '../nodes/NodeBase';
import { Node2D } from '../nodes/Node2D';
import { Node3D } from '../nodes/Node3D';
import type { RuntimeRenderer } from './RuntimeRenderer';

/** Which layer's nodes an overlay pass draws axes for. */
export type DirectionAxesKind = 'node2d' | 'node3d';

/** Axis colours follow the universal editor convention (X→red, Y→green, Z→blue). */
const AXIS_X_COLOR = [1, 0.23, 0.23] as const;
const AXIS_Y_COLOR = [0.35, 0.92, 0.35] as const;
const AXIS_Z_COLOR = [0.32, 0.55, 1] as const;

/**
 * Axis length as a fraction of the visible viewport height. Screen-constant so a
 * gizmo stays readable at any camera distance / 2D zoom, and its size never
 * misleads about the object's actual scale — only its orientation matters here.
 */
const SCREEN_FRACTION = 0.05;
/** Fallback length when the camera type is unrecognised. */
const FALLBACK_LENGTH = 1;
/** Arrowhead barb length as a fraction of the axis length. */
const HEAD_LENGTH_RATIO = 0.28;
/** Arrowhead half-width as a fraction of the axis length. */
const HEAD_HALF_WIDTH_RATIO = 0.14;

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
export class DirectionAxesOverlay {
  private readonly geometry = new BufferGeometry();
  private readonly material = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly lines = new LineSegments(this.geometry, this.material);
  private readonly overlayScene = new Scene();
  private positionAttr: Float32BufferAttribute | null = null;
  private colorAttr: Float32BufferAttribute | null = null;

  private readonly positions: number[] = [];
  private readonly colors: number[] = [];

  // Reused per-node scratch to avoid per-frame allocation.
  private readonly origin = new Vector3();
  private readonly axis = new Vector3();
  private readonly perp = new Vector3();
  private readonly cameraPosition = new Vector3();

  constructor() {
    this.overlayScene.background = null;
    this.lines.frustumCulled = false;
    // Render under ANY camera regardless of its layer mask. The runtime's cameras
    // are layer-filtered (the 2D ortho camera renders only LAYER_2D, the 3D camera
    // only LAYER_3D); a debug object on the default layer would be culled by the
    // 2D camera. enableAll() makes the gizmos visible to whichever camera a pass
    // hands us. The per-call geometry only ever holds that pass's own axes.
    this.lines.layers.enableAll();
    // Debug geometry must never participate in raycasting/picking.
    this.lines.raycast = () => {};
    this.overlayScene.add(this.lines);
  }

  /**
   * Draw axis gizmos for every visible node of `kind` reachable from
   * `rootNodes`, using `camera` (which must be the same camera the matching
   * render pass used, so world-space endpoints project correctly).
   */
  render(
    renderer: RuntimeRenderer,
    camera: Camera,
    rootNodes: readonly NodeBase[],
    kind: DirectionAxesKind
  ): void {
    this.positions.length = 0;
    this.colors.length = 0;

    // Perspective length is per-node (distance-based); ortho length is constant
    // for the frame. Precompute the constant parts once.
    const perspective = camera instanceof PerspectiveCamera ? camera : null;
    const tanHalfFov = perspective ? Math.tan(MathUtils.degToRad(perspective.fov) / 2) : 0;
    if (perspective) {
      this.cameraPosition.setFromMatrixPosition(perspective.matrixWorld);
    }
    const orthoLength =
      camera instanceof OrthographicCamera
        ? ((camera.top - camera.bottom) / camera.zoom) * SCREEN_FRACTION
        : null;

    this.collect(rootNodes, kind, perspective, tanHalfFov, orthoLength);

    const floatCount = this.positions.length;
    if (floatCount < 6) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    if (!this.positionAttr || this.positionAttr.array.length < floatCount) {
      this.positionAttr = new Float32BufferAttribute(new Float32Array(floatCount), 3);
      this.positionAttr.setUsage(DynamicDrawUsage);
      this.geometry.setAttribute('position', this.positionAttr);
      this.colorAttr = new Float32BufferAttribute(new Float32Array(floatCount), 3);
      this.colorAttr.setUsage(DynamicDrawUsage);
      this.geometry.setAttribute('color', this.colorAttr);
    }
    (this.positionAttr.array as Float32Array).set(this.positions);
    this.positionAttr.needsUpdate = true;
    (this.colorAttr!.array as Float32Array).set(this.colors);
    this.colorAttr!.needsUpdate = true;

    this.geometry.setDrawRange(0, Math.floor(floatCount / 3));
    renderer.render(this.overlayScene, camera);
  }

  /** DFS the graph, emitting arrows for matching visible nodes. */
  private collect(
    nodes: readonly NodeBase[],
    kind: DirectionAxesKind,
    perspective: PerspectiveCamera | null,
    tanHalfFov: number,
    orthoLength: number | null
  ): void {
    for (const node of nodes) {
      // An invisible subtree isn't rendered, so it gets no gizmos either.
      if (!node.visible) {
        continue;
      }

      const matches = kind === 'node2d' ? node instanceof Node2D : node instanceof Node3D;
      if (matches) {
        this.emitForNode(node, kind, perspective, tanHalfFov, orthoLength);
      }

      if (node.children.length > 0) {
        this.collect(node.children, kind, perspective, tanHalfFov, orthoLength);
      }
    }
  }

  private emitForNode(
    node: NodeBase,
    kind: DirectionAxesKind,
    perspective: PerspectiveCamera | null,
    tanHalfFov: number,
    orthoLength: number | null
  ): void {
    const m = node.matrixWorld.elements;
    this.origin.set(m[12], m[13], m[14]);

    let length: number;
    if (perspective) {
      const distance = this.cameraPosition.distanceTo(this.origin);
      length = 2 * distance * tanHalfFov * SCREEN_FRACTION;
    } else {
      length = orthoLength ?? FALLBACK_LENGTH;
    }
    if (length <= 0) {
      return;
    }

    // X axis (basis column 0).
    this.axis.set(m[0], m[1], m[2]);
    this.emitArrow(kind, length, AXIS_X_COLOR);

    // Y axis (basis column 1).
    this.axis.set(m[4], m[5], m[6]);
    this.emitArrow(kind, length, AXIS_Y_COLOR);

    if (kind === 'node3d') {
      // Z axis (basis column 2) — depth is meaningless for the flat 2D pass.
      this.axis.set(m[8], m[9], m[10]);
      this.emitArrow(kind, length, AXIS_Z_COLOR);
    }
  }

  /**
   * Emit one arrow (shaft + two barbs) for the current `this.axis` direction,
   * starting at `this.origin`. `this.axis` need not be normalised on entry.
   */
  private emitArrow(
    kind: DirectionAxesKind,
    length: number,
    color: readonly [number, number, number]
  ): void {
    if (this.axis.lengthSq() < 1e-12) {
      return;
    }
    this.axis.normalize();

    const ox = this.origin.x;
    const oy = this.origin.y;
    const oz = this.origin.z;
    const tipX = ox + this.axis.x * length;
    const tipY = oy + this.axis.y * length;
    const tipZ = oz + this.axis.z * length;

    const headLength = length * HEAD_LENGTH_RATIO;
    const headHalfWidth = length * HEAD_HALF_WIDTH_RATIO;
    const backX = tipX - this.axis.x * headLength;
    const backY = tipY - this.axis.y * headLength;
    const backZ = tipZ - this.axis.z * headLength;

    // In-plane barb direction for 2D (rotate 90° in XY); robust perpendicular for 3D.
    if (kind === 'node2d') {
      this.perp.set(-this.axis.y, this.axis.x, 0);
    } else {
      this.perpendicular3(this.axis, this.perp);
    }
    const px = this.perp.x * headHalfWidth;
    const py = this.perp.y * headHalfWidth;
    const pz = this.perp.z * headHalfWidth;

    // Shaft.
    this.pushSegment(ox, oy, oz, tipX, tipY, tipZ, color);
    // Barbs.
    this.pushSegment(tipX, tipY, tipZ, backX + px, backY + py, backZ + pz, color);
    this.pushSegment(tipX, tipY, tipZ, backX - px, backY - py, backZ - pz, color);
  }

  private pushSegment(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    color: readonly [number, number, number]
  ): void {
    this.positions.push(ax, ay, az, bx, by, bz);
    this.colors.push(color[0], color[1], color[2], color[0], color[1], color[2]);
  }

  /** A unit vector perpendicular to `dir` (assumed normalised), written to `out`. */
  private perpendicular3(dir: Vector3, out: Vector3): void {
    const ax = Math.abs(dir.x);
    const ay = Math.abs(dir.y);
    const az = Math.abs(dir.z);
    if (ax <= ay && ax <= az) {
      out.set(1, 0, 0);
    } else if (ay <= az) {
      out.set(0, 1, 0);
    } else {
      out.set(0, 0, 1);
    }
    out.cross(dir).normalize();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
