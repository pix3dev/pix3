import {
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Uint32BufferAttribute,
  Vector3,
  type Scene,
  type Texture,
} from 'three';
import { LAYER_2D, LAYER_2D_OVERLAY } from '../constants';

/**
 * Paint-order-preserving 2D quad batcher (Phase 3). A classic immediate-mode
 * sprite batcher: every frame it walks the same stamped `renderOrder` order the
 * 2D pass draws in, groups maximal contiguous runs of quads that share one
 * material state (same texture SOURCE + blending + layer band), and emits each
 * run as a single draw call — quads appended in stamped order.
 *
 * Invariant B1 (paint order) holds by construction: blocks (batch runs and
 * single passthrough meshes) inherit the stamped order of their first member as
 * `renderOrder`, so three's transparent-list sort draws blocks in original
 * order; within a batch, quads are appended to the index buffer in stamped
 * order, and a single draw rasterizes primitives in index order.
 *
 * Per-node opacity/tint ride a 4-component vertex color (never mutating a shared
 * batch material), so the existing fade system keeps working. Batched source
 * meshes are hidden via `material.visible = false` (removes them from the render
 * list without touching `Object3D.visible`, which game logic + raycast read).
 */

/** Marker on `mesh.userData`: this mesh's node opted the mesh into batching. */
export const BATCHABLE_2D_KEY = 'pix3Batchable2D';

/** One ordered 2D mesh, produced by the render-order walk (see render-order-2d). */
export interface OrderedMesh2D {
  mesh: Mesh;
  order: number;
  overlay: boolean;
  visible: boolean;
}

export interface Batch2DStats {
  batches: number;
  quads: number;
  passthrough: number;
}

// Unit-quad corners + UVs (match SHARED_UNIT_QUAD_GEOMETRY: 1×1, centered).
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-0.5, 0.5], // top-left
  [0.5, 0.5], // top-right
  [-0.5, -0.5], // bottom-left
  [0.5, -0.5], // bottom-right
];
const BASE_UV: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 1],
  [0, 0],
  [1, 0],
];
// Two triangles per quad (winding irrelevant — DoubleSide): TL,TR,BL / BL,TR,BR.
const QUAD_INDEX = [0, 1, 2, 2, 1, 3];

const scratch = new Vector3();

interface RunPlan {
  members: Mesh[];
  key: string;
  source: Texture | null; // the shared texture (any member's map) or null
  overlay: boolean;
  order: number; // first member's stamped renderOrder
}

/** One pooled batch draw: a Mesh with a growable dynamic geometry. */
class BatchDraw {
  readonly mesh: Mesh;
  private geometry: BufferGeometry;
  private positions: Float32BufferAttribute;
  private uvs: Float32BufferAttribute;
  private colors: Float32BufferAttribute;
  private index: Uint32BufferAttribute;
  private capacity: number;

  constructor(initialQuads = 64) {
    this.capacity = initialQuads;
    this.geometry = new BufferGeometry();
    this.positions = this.makeAttr(this.capacity * 4, 3);
    this.uvs = this.makeAttr(this.capacity * 4, 2);
    this.colors = this.makeAttr(this.capacity * 4, 4);
    this.index = this.makeIndex(this.capacity);
    this.geometry.setAttribute('position', this.positions);
    this.geometry.setAttribute('uv', this.uvs);
    this.geometry.setAttribute('color', this.colors);
    this.geometry.setIndex(this.index);
    this.mesh = new Mesh(this.geometry);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  private makeAttr(count: number, itemSize: number): Float32BufferAttribute {
    const attr = new Float32BufferAttribute(new Float32Array(count * itemSize), itemSize);
    attr.setUsage(DynamicDrawUsage);
    return attr;
  }

  private makeIndex(quads: number): Uint32BufferAttribute {
    const data = new Uint32Array(quads * 6);
    for (let q = 0; q < quads; q++) {
      const base = q * 4;
      for (let k = 0; k < 6; k++) {
        data[q * 6 + k] = base + QUAD_INDEX[k];
      }
    }
    return new Uint32BufferAttribute(data, 1);
  }

  private ensureCapacity(quads: number): void {
    if (quads <= this.capacity) {
      return;
    }
    let next = this.capacity;
    while (next < quads) {
      next *= 2;
    }
    this.capacity = next;
    this.positions = this.makeAttr(next * 4, 3);
    this.uvs = this.makeAttr(next * 4, 2);
    this.colors = this.makeAttr(next * 4, 4);
    this.index = this.makeIndex(next);
    this.geometry.setAttribute('position', this.positions);
    this.geometry.setAttribute('uv', this.uvs);
    this.geometry.setAttribute('color', this.colors);
    this.geometry.setIndex(this.index);
  }

  /** Fill the geometry from a run's members (in stamped order) and set drawRange. */
  fill(members: readonly Mesh[]): void {
    this.ensureCapacity(members.length);
    const pos = this.positions.array as Float32Array;
    const uv = this.uvs.array as Float32Array;
    const col = this.colors.array as Float32Array;
    const color = new Color();

    for (let i = 0; i < members.length; i++) {
      const mesh = members[i];
      const material = mesh.material as MeshBasicMaterial;
      const map = material.map;
      // Effective UV rect = the map's live offset/repeat (Phase 2 already composed
      // any atlas frame + crop into it). Null map (ColorRect) → full [0,1].
      const rx = map ? map.offset.x : 0;
      const ry = map ? map.offset.y : 0;
      const rw = map ? map.repeat.x : 1;
      const rh = map ? map.repeat.y : 1;
      // Per-node tint × computed opacity, baked into vertex rgba.
      color.copy(material.color);
      const alpha = material.opacity;

      const vBase = i * 4;
      for (let c = 0; c < 4; c++) {
        scratch.set(CORNERS[c][0], CORNERS[c][1], 0).applyMatrix4(mesh.matrixWorld);
        const p = (vBase + c) * 3;
        pos[p] = scratch.x;
        pos[p + 1] = scratch.y;
        pos[p + 2] = scratch.z;
        const u = (vBase + c) * 2;
        uv[u] = rx + BASE_UV[c][0] * rw;
        uv[u + 1] = ry + BASE_UV[c][1] * rh;
        const k = (vBase + c) * 4;
        col[k] = color.r;
        col[k + 1] = color.g;
        col[k + 2] = color.b;
        col[k + 3] = alpha;
      }
    }

    this.positions.needsUpdate = true;
    this.uvs.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.geometry.setDrawRange(0, members.length * 6);
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

export class Batch2DSystem {
  private readonly group = new Group();
  private readonly pool: BatchDraw[] = [];
  private readonly materials = new Map<string, MeshBasicMaterial>();
  private readonly batchMaps = new Map<string, Texture>();
  private suppressed = new Set<MeshBasicMaterial>();
  readonly stats: Batch2DStats = { batches: 0, quads: 0, passthrough: 0 };

  constructor(scene: Scene) {
    this.group.matrixAutoUpdate = false;
    this.group.name = 'Pix3Batch2D';
    scene.add(this.group);
  }

  /** Active batch meshes this frame, in pool order (for tests / debugging). */
  get activeBatchMeshes(): Mesh[] {
    return this.pool.filter(draw => draw.mesh.visible).map(draw => draw.mesh);
  }

  /**
   * Rebuild all batches for one frame from the ordered 2D mesh list (already in
   * stamped `renderOrder`). Segments contiguous same-key runs, fills batch
   * geometries, and suppresses/restores source materials by delta.
   */
  update(ordered: readonly OrderedMesh2D[]): void {
    const runs = this.segment(ordered);

    // Suppress newly-batched source materials; restore ones that fell out.
    const nextSuppressed = new Set<MeshBasicMaterial>();
    for (const run of runs) {
      for (const mesh of run.members) {
        nextSuppressed.add(mesh.material as MeshBasicMaterial);
      }
    }
    for (const material of nextSuppressed) {
      material.visible = false;
    }
    for (const material of this.suppressed) {
      if (!nextSuppressed.has(material)) {
        material.visible = true;
      }
    }
    this.suppressed = nextSuppressed;

    // Fill / activate one pooled draw per run.
    let quadTotal = 0;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      let draw = this.pool[i];
      if (!draw) {
        draw = new BatchDraw();
        this.pool[i] = draw;
        this.group.add(draw.mesh);
      }
      draw.fill(run.members);
      draw.mesh.material = this.materialFor(run);
      draw.mesh.renderOrder = run.order;
      draw.mesh.layers.set(run.overlay ? LAYER_2D_OVERLAY : LAYER_2D);
      draw.mesh.visible = true;
      quadTotal += run.members.length;
    }
    for (let i = runs.length; i < this.pool.length; i++) {
      this.pool[i].mesh.visible = false;
    }

    this.stats.batches = runs.length;
    this.stats.quads = quadTotal;
  }

  /** Group the ordered list into maximal contiguous batchable runs of length ≥ 2. */
  private segment(ordered: readonly OrderedMesh2D[]): RunPlan[] {
    const runs: RunPlan[] = [];
    let passthrough = 0;
    let current: RunPlan | null = null;

    const flush = () => {
      if (current) {
        if (current.members.length >= 2) {
          runs.push(current);
        } else {
          passthrough += current.members.length;
        }
        current = null;
      }
    };

    for (const entry of ordered) {
      const key = this.keyFor(entry);
      if (!key) {
        // Not batchable → breaks the run and renders itself.
        flush();
        passthrough++;
        continue;
      }
      if (current && current.key === key) {
        current.members.push(entry.mesh);
        continue;
      }
      flush();
      const material = entry.mesh.material as MeshBasicMaterial;
      current = {
        members: [entry.mesh],
        key,
        source: material.map,
        overlay: entry.overlay,
        order: entry.order,
      };
    }
    flush();

    this.stats.passthrough = passthrough;
    return runs;
  }

  /**
   * Batch key for a mesh, or null if it must not batch. Batchable = opted-in +
   * effectively visible + non-transparent-zero + a stock MeshBasicMaterial with
   * normal blending. Runs group by texture SOURCE (so all views of one atlas
   * sheet — and multiple instances of the same raw texture — merge) + band.
   */
  private keyFor(entry: OrderedMesh2D): string | null {
    if (!entry.visible) {
      return null;
    }
    const mesh = entry.mesh;
    if (!mesh.userData || mesh.userData[BATCHABLE_2D_KEY] !== true) {
      return null;
    }
    const material = mesh.material;
    if (Array.isArray(material) || !(material instanceof MeshBasicMaterial)) {
      return null;
    }
    if (material.opacity <= 0) {
      return null;
    }
    // Only the default blend batches; a script-set custom blend opts out.
    if (material.blending !== NormalBlending) {
      return null;
    }
    const sourceKey = material.map ? material.map.source.uuid : 'nomap';
    return `${entry.overlay ? 'o' : 'm'}:${sourceKey}`;
  }

  private materialFor(run: RunPlan): MeshBasicMaterial {
    let material = this.materials.get(run.key);
    if (!material) {
      material = new MeshBasicMaterial({
        transparent: true,
        depthTest: false,
        vertexColors: true,
        side: DoubleSide,
        color: 0xffffff,
        map: run.source ? this.batchMapFor(run.source) : null,
      });
      this.materials.set(run.key, material);
    }
    return material;
  }

  /**
   * An identity-transform texture sharing the source's GPU image, used as the
   * batch material map so per-quad UVs are sampled raw (the source view carries a
   * non-identity offset/repeat we must not apply globally). One per source,
   * uploaded once (mirrors the Sprite2D.ownedTexture clone pattern).
   */
  private batchMapFor(source: Texture): Texture {
    const uuid = source.source.uuid;
    let map = this.batchMaps.get(uuid);
    if (!map) {
      map = source.clone();
      map.offset.set(0, 0);
      map.repeat.set(1, 1);
      map.needsUpdate = true;
      this.batchMaps.set(uuid, map);
    }
    return map;
  }

  dispose(): void {
    // Restore any source materials we hid so the next scene renders them.
    for (const material of this.suppressed) {
      material.visible = true;
    }
    this.suppressed.clear();
    for (const draw of this.pool) {
      draw.dispose();
    }
    this.pool.length = 0;
    for (const material of this.materials.values()) {
      material.dispose();
    }
    this.materials.clear();
    for (const map of this.batchMaps.values()) {
      map.dispose();
    }
    this.batchMaps.clear();
    this.group.removeFromParent();
  }
}
