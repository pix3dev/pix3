import * as THREE from 'three';
import type { NodeBase, Point2D, SceneGraph } from '@pix3/runtime';
import { transformPolygon } from '@pix3/runtime';
import { appState } from '@/state';
import { collectColliderShapes, type ColliderShape } from '@/features/scene/collider-shapes';

/**
 * Collider outlines and the polygon vertex handles, drawn into the editor
 * viewport's 2D band.
 *
 * This exists because the editor renders **proxy** meshes, not the runtime nodes
 * (see CLAUDE.md "2D overlay rendering"), so `core:Hitbox2D`'s own `debugDraw` —
 * a child mesh of the runtime node — never appears while authoring. Godot calls
 * the equivalent "Visible Collision Shapes"; here it is on for selected nodes
 * always, and for the whole scene behind `appState.ui.showCollisionShapes`.
 *
 * Sizing: outlines are world-space (they scale with the content, which is the
 * point), while vertex handles are drawn at a constant CSS-pixel size by
 * rebuilding them per camera zoom — the same trick `TransformTool2d` uses for
 * its own handles, and the reason `update()` has to run again after a zoom.
 */

const LAYER_2D = 1;
/** Above content and the hover frame, below the transform manipulator (1000). */
const OUTLINE_RENDER_ORDER = 960;
const HANDLE_RENDER_ORDER = 1200;

const OUTLINE_COLOR = 0x1ebde3;
const OUTLINE_COLOR_SELECTED = 0x7df9ff;
/** Sensors detect but never block, so they read as a different kind of shape. */
const OUTLINE_COLOR_SENSOR = 0x9ae66e;
const HANDLE_COLOR = 0xf5ae39;
const HANDLE_COLOR_HOVER = 0xffffff;
const EDGE_HANDLE_COLOR = 0x7df9ff;

const HANDLE_SIZE_CSS_PX = 9;
const EDGE_HANDLE_SIZE_CSS_PX = 6;
/** Extra CSS-pixel slack around a handle when hit-testing a pointer. */
const HANDLE_HIT_MARGIN_CSS_PX = 5;

export interface ViewportColliderGizmosDeps {
  getScene(): THREE.Scene | undefined;
  getActiveSceneGraph(): SceneGraph | null;
  getOrthographicCamera(): THREE.OrthographicCamera | undefined;
  getViewportSize(): { width: number; height: number };
}

/** What the pointer is over, in the polygon tool's terms. */
export type PolygonHandleHit =
  | { kind: 'vertex'; index: number }
  /** The midpoint of edge `index` → `index + 1`; clicking it inserts a vertex there. */
  | { kind: 'edge'; index: number };

/** The polygon currently open for editing, as the tool and the gizmos both see it. */
export interface PolygonEditTarget {
  nodeId: string;
  componentId: string;
}

export class ViewportColliderGizmos {
  private root?: THREE.Group;
  /** Live world-space vertices of the polygon being edited, for hit-testing. */
  private editedWorldVertices: Point2D[] = [];
  private editedShape: ColliderShape | null = null;
  private hoveredHandle: PolygonHandleHit | null = null;
  private editTarget: PolygonEditTarget | null = null;
  /** What the last built visuals encode; a match skips the rebuild entirely. */
  private signature = '';

  constructor(private readonly deps: ViewportColliderGizmosDeps) {}

  /** The polygon open for editing, or null. */
  getEditTarget(): PolygonEditTarget | null {
    return this.editTarget;
  }

  setEditTarget(target: PolygonEditTarget | null): void {
    this.editTarget = target;
    this.hoveredHandle = null;
    this.signature = '';
  }

  /** The shape resolved for the current edit target on the last {@link update}. */
  getEditedShape(): ColliderShape | null {
    return this.editedShape;
  }

  /**
   * Rebuild every outline and handle. Runs per painted frame, so it first
   * resolves the shapes and compares a signature: an idle viewport (or one being
   * orbited in the 3D band) must not churn a geometry per collider 60 times a
   * second. The signature covers world vertices, hover, and the zoom the handle
   * size is baked at — everything that can change what is drawn.
   */
  update(selectedNodeIds: readonly string[]): void {
    const scene = this.deps.getScene();
    if (!scene) {
      return;
    }

    const graph = this.deps.getActiveSceneGraph();
    const showAll = appState.ui.showCollisionShapes;
    const nodes = !graph
      ? []
      : showAll
        ? collectAllNodes(graph)
        : selectedNodeIds.flatMap(id => {
            const node = graph.nodeMap.get(id);
            return node ? [node] : [];
          });

    const selected = new Set(selectedNodeIds);
    const drawn: { shape: ColliderShape; world: Point2D[]; isEditTarget: boolean }[] = [];
    for (const node of nodes) {
      for (const shape of collectColliderShapes(node)) {
        const isEditTarget =
          this.editTarget?.nodeId === shape.nodeId &&
          this.editTarget?.componentId === shape.componentId;
        drawn.push({
          shape,
          world: transformPolygon(shape.outline, shape.transform),
          isEditTarget,
        });
      }
    }

    // Hit-testing must stay live even when the visuals are reused unchanged.
    this.editedShape = null;
    this.editedWorldVertices = [];
    for (const entry of drawn) {
      if (entry.isEditTarget && entry.shape.editable) {
        this.editedShape = entry.shape;
        this.editedWorldVertices = entry.world;
      }
    }

    const signature = this.buildSignature(drawn, selected);
    if (this.root && signature === this.signature) {
      return;
    }
    this.signature = signature;
    this.clear();

    if (drawn.length === 0) {
      return;
    }

    const root = new THREE.Group();
    root.name = 'pix3-collider-gizmos';
    root.renderOrder = OUTLINE_RENDER_ORDER;
    root.layers.set(LAYER_2D);

    for (const entry of drawn) {
      root.add(
        this.createOutline(
          entry.world,
          entry.shape.sensor
            ? OUTLINE_COLOR_SENSOR
            : selected.has(entry.shape.nodeId)
              ? OUTLINE_COLOR_SELECTED
              : OUTLINE_COLOR
        )
      );
      if (entry.isEditTarget && entry.shape.editable) {
        this.addPolygonHandles(root, entry.world);
      }
    }

    scene.add(root);
    this.root = root;
  }

  private buildSignature(
    drawn: readonly { shape: ColliderShape; world: Point2D[]; isEditTarget: boolean }[],
    selected: ReadonlySet<string>
  ): string {
    const camera = this.deps.getOrthographicCamera();
    const parts: string[] = [
      `z:${camera?.zoom ?? 0}`,
      `v:${this.deps.getViewportSize().width}x${this.deps.getViewportSize().height}`,
      `h:${this.hoveredHandle?.kind ?? ''}${this.hoveredHandle?.index ?? ''}`,
    ];
    for (const entry of drawn) {
      parts.push(
        `${entry.shape.nodeId}/${entry.shape.componentId}/${entry.shape.sensor ? 's' : ''}${selected.has(entry.shape.nodeId) ? 1 : 0}/${
          entry.isEditTarget && entry.shape.editable ? 1 : 0
        }/${entry.world.map(p => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`).join(' ')}`
      );
    }
    return parts.join('|');
  }

  /**
   * The handle under a CSS-pixel pointer position, preferring vertices over edge
   * midpoints — a vertex sits on top of two edge midpoints' slack, and dragging
   * the vertex is the far more common intent.
   */
  getHandleAt(screenX: number, screenY: number): PolygonHandleHit | null {
    const camera = this.deps.getOrthographicCamera();
    const size = this.deps.getViewportSize();
    if (!camera || this.editedWorldVertices.length < 3) {
      return null;
    }

    const vertexRadius = (HANDLE_SIZE_CSS_PX + HANDLE_HIT_MARGIN_CSS_PX) / 2;
    const edgeRadius = (EDGE_HANDLE_SIZE_CSS_PX + HANDLE_HIT_MARGIN_CSS_PX) / 2;

    let best: { hit: PolygonHandleHit; distSq: number } | null = null;
    const consider = (hit: PolygonHandleHit, world: Point2D, radius: number): void => {
      const projected = this.projectToScreen(world, camera, size);
      if (!projected) {
        return;
      }
      const dx = projected.x - screenX;
      const dy = projected.y - screenY;
      const distSq = dx * dx + dy * dy;
      if (distSq <= radius * radius && (!best || distSq < best.distSq)) {
        best = { hit, distSq };
      }
    };

    const n = this.editedWorldVertices.length;
    for (let i = 0; i < n; i++) {
      consider({ kind: 'vertex', index: i }, this.editedWorldVertices[i], vertexRadius);
    }
    if (best) {
      return (best as { hit: PolygonHandleHit }).hit;
    }
    for (let i = 0; i < n; i++) {
      const a = this.editedWorldVertices[i];
      const b = this.editedWorldVertices[(i + 1) % n];
      consider({ kind: 'edge', index: i }, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, edgeRadius);
    }
    return best ? (best as { hit: PolygonHandleHit }).hit : null;
  }

  /** Record the hovered handle. Returns true when it changed (i.e. repaint). */
  setHoveredHandle(hit: PolygonHandleHit | null): boolean {
    const same = this.hoveredHandle?.kind === hit?.kind && this.hoveredHandle?.index === hit?.index;
    if (same) {
      return false;
    }
    this.hoveredHandle = hit;
    return true;
  }

  getHoveredHandle(): PolygonHandleHit | null {
    return this.hoveredHandle;
  }

  clear(): void {
    if (!this.root) {
      return;
    }
    this.root.removeFromParent();
    disposeTree(this.root);
    this.root = undefined;
  }

  /** Force the next {@link update} to rebuild even if nothing visibly changed. */
  invalidate(): void {
    this.signature = '';
  }

  dispose(): void {
    this.clear();
    this.editedWorldVertices = [];
    this.editedShape = null;
    this.editTarget = null;
    this.signature = '';
  }

  // --- drawing ---

  private createOutline(world: readonly Point2D[], color: number): THREE.LineLoop {
    const positions = new Float32Array(world.length * 3);
    for (let i = 0; i < world.length; i++) {
      positions[i * 3] = world[i].x;
      positions[i * 3 + 1] = world[i].y;
      positions[i * 3 + 2] = 0;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    const line = new THREE.LineLoop(geometry, material);
    line.renderOrder = OUTLINE_RENDER_ORDER;
    line.layers.set(LAYER_2D);
    return line;
  }

  private addPolygonHandles(root: THREE.Group, world: readonly Point2D[]): void {
    const camera = this.deps.getOrthographicCamera();
    const size = this.deps.getViewportSize();
    if (!camera) {
      return;
    }
    const unit = worldUnitsPerCssPixel(camera, size);

    const n = world.length;
    for (let i = 0; i < n; i++) {
      const hovered = this.hoveredHandle?.kind === 'vertex' && this.hoveredHandle.index === i;
      root.add(
        this.createHandle(
          world[i],
          HANDLE_SIZE_CSS_PX,
          unit,
          hovered ? HANDLE_COLOR_HOVER : HANDLE_COLOR
        )
      );
    }
    for (let i = 0; i < n; i++) {
      const a = world[i];
      const b = world[(i + 1) % n];
      const hovered = this.hoveredHandle?.kind === 'edge' && this.hoveredHandle.index === i;
      root.add(
        this.createHandle(
          { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          EDGE_HANDLE_SIZE_CSS_PX,
          unit,
          hovered ? HANDLE_COLOR_HOVER : EDGE_HANDLE_COLOR
        )
      );
    }
  }

  private createHandle(
    world: Point2D,
    sizeCssPx: number,
    unit: { x: number; y: number },
    color: number
  ): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(sizeCssPx * unit.x, sizeCssPx * unit.y);
    const material = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(world.x, world.y, 0);
    mesh.renderOrder = HANDLE_RENDER_ORDER;
    mesh.layers.set(LAYER_2D);
    return mesh;
  }

  private projectToScreen(
    world: Point2D,
    camera: THREE.OrthographicCamera,
    size: { width: number; height: number }
  ): { x: number; y: number } | null {
    if (size.width <= 0 || size.height <= 0) {
      return null;
    }
    const projected = new THREE.Vector3(world.x, world.y, 0).project(camera);
    return {
      x: ((projected.x + 1) / 2) * size.width,
      y: ((1 - projected.y) / 2) * size.height,
    };
  }
}

function worldUnitsPerCssPixel(
  camera: THREE.OrthographicCamera,
  size: { width: number; height: number }
): { x: number; y: number } {
  const zoom = Math.max(0.0001, camera.zoom || 1);
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  return {
    x: Math.abs(camera.right - camera.left) / zoom / width,
    y: Math.abs(camera.top - camera.bottom) / zoom / height,
  };
}

function collectAllNodes(graph: SceneGraph): NodeBase[] {
  return [...graph.nodeMap.values()];
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse(object => {
    const withGeometry = object as THREE.Mesh;
    withGeometry.geometry?.dispose?.();
    const material = withGeometry.material;
    if (Array.isArray(material)) {
      for (const entry of material) {
        entry.dispose();
      }
    } else {
      material?.dispose?.();
    }
  });
}
