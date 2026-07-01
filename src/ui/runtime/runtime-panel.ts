import * as THREE from 'three';
import { subscribe } from 'valtio/vanilla';
import { repeat } from 'lit/directives/repeat.js';

import { ComponentBase, customElement, html, state, inject } from '@/fw';
import { appState } from '@/state';
import { getRuntimeSceneRoot, SceneManager } from '@pix3/runtime';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { selectObject } from '@/features/selection/SelectObjectCommand';

import '../shared/pix3-panel';
import './runtime-panel.ts.css';

/**
 * Runtime panel — inspects the **live running game** during play mode.
 *
 * Unlike the Scene Tree (which shows the authored NodeBase graph), play mode
 * runs an isolated *clone* in `SceneRunner`'s own THREE.Scene. This panel walks
 * that live scene root (`getRuntimeSceneRoot()`), so it surfaces the real
 * runtime instances — spawned sprites (droppables), instanced meshes, falling
 * clusters — that the authored tree can never show. Read-only.
 *
 * Selecting a row does two extra things beyond driving the global selection:
 *  - builds a `RuntimeDetail` DTO straight off the raw THREE.Object3D (geometry,
 *    material, world transform, instance count, userData) so *non-NodeBase*
 *    objects — which the schema-driven Inspector cannot render — are still
 *    inspectable; and
 *  - draws a Box3 highlight into the running scene at the object's world bounds,
 *    matching its render layer so 3D objects get a box and 2D-overlay nodes get
 *    a frame. Editor-only: it lives on the runtime scene root but is never part
 *    of the shipped runtime.
 */

/** Minimal structural view of a live THREE.Object3D (no THREE import needed). */
interface LiveObject3D {
  uuid: string;
  name?: string;
  type?: string;
  visible?: boolean;
  renderOrder?: number;
  matrixWorld?: { elements: number[] };
  children?: LiveObject3D[];
  userData?: Record<string, unknown>;
  isInstancedMesh?: boolean;
  count?: number;
}

interface RuntimeNode {
  uuid: string;
  /** Authored node id (from NodeBase.userData.nodeId); null for raw spawned / non-NodeBase objects. */
  nodeId: string | null;
  type: string;
  name: string;
  visible: boolean;
  pos: { x: number; y: number; z: number } | null;
  renderOrder: number;
  instances: number | null;
  droppable: boolean;
  gizmo: boolean;
  childCount: number;
  truncatedChildren: number;
  children: RuntimeNode[];
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface GeometryInfo {
  type: string;
  params?: Record<string, number | string | boolean>;
  vertices?: number;
}

interface MaterialInfo {
  type: string;
  color?: string;
  opacity?: number;
  transparent?: boolean;
  wireframe?: boolean;
  map: boolean;
  side?: string;
}

/** Full inspection detail for one selected raw THREE.Object3D. */
interface RuntimeDetail {
  uuid: string;
  type: string;
  name: string;
  isNodeBase: boolean;
  visible: boolean;
  renderOrder: number;
  layers: number[];
  instances: number | null;
  world: { position: Vec3; rotationDeg: Vec3; scale: Vec3 };
  local: { position: Vec3; rotationDeg: Vec3; scale: Vec3 };
  geometry: GeometryInfo | null;
  materials: MaterialInfo[] | null;
  userData: Record<string, string>;
  childCount: number;
}

/** Narrow structural view of a THREE material (avoids `any`). */
interface MaterialLike {
  type?: string;
  color?: { getHexString?: () => string };
  opacity?: number;
  transparent?: boolean;
  wireframe?: boolean;
  map?: unknown;
  side?: number;
}

type RootTypeFilter = 'all' | '3d' | '2d';

const MAX_DEPTH = 10;
const MAX_CHILDREN_PER_NODE = 250;
const MAX_TOTAL_NODES = 5000;
const REFRESH_INTERVAL_MS = 350;

@customElement('pix3-runtime-panel')
export class RuntimePanel extends ComponentBase {
  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @state()
  private roots: RuntimeNode[] = [];

  @state()
  private isPlaying = appState.ui.isPlaying;

  @state()
  private live = true;

  @state()
  private filter = '';

  @state()
  private rootTypeFilter: RootTypeFilter = 'all';

  @state()
  private collapsed = new Set<string>();

  @state()
  private selectedUuid: string | null = null;

  @state()
  private selectedDetail: RuntimeDetail | null = null;

  @state()
  private nodeCount = 0;

  private refreshTimer: number | null = null;
  private disposeUiSubscription?: () => void;

  /** Box3 highlight drawn into the running scene for the selected object. */
  private highlight?: THREE.Box3Helper;
  private readonly highlightBox = new THREE.Box3();

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeUiSubscription = subscribe(appState.ui, () => {
      if (this.isPlaying !== appState.ui.isPlaying) {
        this.isPlaying = appState.ui.isPlaying;
        // Runtime objects (and their scene) only exist during play; drop any
        // stale selection/highlight when play stops so we don't dangle a
        // reference into a torn-down scene.
        if (!this.isPlaying) {
          this.clearSelection();
        }
        this.refreshTree();
      }
    });
    this.startTimer();
    this.refreshTree();
  }

  disconnectedCallback(): void {
    this.stopTimer();
    this.disposeUiSubscription?.();
    this.disposeUiSubscription = undefined;
    this.clearHighlight();
    super.disconnectedCallback();
  }

  private startTimer(): void {
    if (this.refreshTimer !== null) {
      return;
    }
    this.refreshTimer = window.setInterval(() => {
      if (this.live && this.isPlaying) {
        this.refreshTree();
      }
    }, REFRESH_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private refreshTree(): void {
    const root = getRuntimeSceneRoot() as LiveObject3D | null;
    if (!root) {
      this.roots = [];
      this.nodeCount = 0;
      return;
    }
    const counter = { n: 0 };
    // Show the scene root's children as top-level rows (the root itself is just a Scene).
    const children = Array.isArray(root.children) ? root.children : [];
    this.roots = children
      .filter(child => !isHelperObject(child))
      .slice(0, MAX_CHILDREN_PER_NODE)
      .map(child => this.toNode(child, MAX_DEPTH, counter));
    this.nodeCount = counter.n;

    // Keep the detail + highlight in sync with the live object (it may have
    // moved, or the scene may have been re-cloned since the last tick).
    if (this.selectedUuid) {
      this.refreshSelection(this.selectedUuid);
    }
  }

  private toNode(obj: LiveObject3D, depth: number, counter: { n: number }): RuntimeNode {
    counter.n += 1;
    const m = obj.matrixWorld?.elements;
    const pos =
      m && m.length >= 15 ? { x: round2(m[12]), y: round2(m[13]), z: round2(m[14]) } : null;
    const ud = obj.userData ?? {};
    const rawChildren = Array.isArray(obj.children)
      ? obj.children.filter(child => !isHelperObject(child))
      : [];

    let children: RuntimeNode[] = [];
    let truncated = 0;
    if (rawChildren.length > 0 && depth > 0 && counter.n < MAX_TOTAL_NODES) {
      const slice = rawChildren.slice(0, MAX_CHILDREN_PER_NODE);
      truncated = rawChildren.length - slice.length;
      children = slice.map(child => this.toNode(child, depth - 1, counter));
    }

    return {
      uuid: obj.uuid,
      nodeId: typeof ud.nodeId === 'string' ? ud.nodeId : null,
      type: obj.type || 'Object3D',
      name: obj.name || '',
      visible: obj.visible !== false,
      pos,
      renderOrder: obj.renderOrder ?? 0,
      instances: obj.isInstancedMesh ? (obj.count ?? null) : null,
      droppable: !!ud && 'droppableItemRef' in ud,
      gizmo: !!ud && ud.isGizmo === true,
      childCount: rawChildren.length,
      truncatedChildren: truncated,
      children,
    };
  }

  private onFilterInput(event: Event): void {
    this.filter = (event.target as HTMLInputElement).value.trim().toLowerCase();
  }

  private toggleLive(): void {
    this.live = !this.live;
    if (this.live) {
      this.refreshTree();
    }
  }

  private setRootTypeFilter(filter: RootTypeFilter): void {
    this.rootTypeFilter = filter;
  }

  private toggleCollapse(uuid: string): void {
    const next = new Set(this.collapsed);
    if (next.has(uuid)) {
      next.delete(uuid);
    } else {
      next.add(uuid);
    }
    this.collapsed = next;
  }

  private collapseAll(): void {
    const next = new Set<string>();
    const stack = [...this.roots];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      if (node.children.length > 0) {
        next.add(node.uuid);
        stack.push(...node.children);
      }
    }
    this.collapsed = next;
  }

  private onRowClick(node: RuntimeNode): void {
    this.selectedUuid = node.uuid;
    // Authored NodeBase clones carry their nodeId; selecting it drives the global
    // selection so the Inspector mirrors this node's LIVE runtime values. Only
    // dispatch when the id resolves in the authored scene graph — raw spawned
    // objects (no nodeId) and runtime-only nodes (e.g. prefab-remapped ids) keep
    // just the local highlight, so a click never blanks an unrelated selection.
    if (node.nodeId && this.sceneManager.getActiveSceneGraph()?.nodeMap.has(node.nodeId)) {
      void this.commandDispatcher.execute(selectObject(node.nodeId));
    }
    // Raw THREE detail + viewport highlight — works for every object, not just
    // NodeBase clones the Inspector can render.
    this.refreshSelection(node.uuid);
  }

  private clearSelection(): void {
    this.selectedUuid = null;
    this.selectedDetail = null;
    this.clearHighlight();
  }

  /** Look up the live object by uuid, rebuild its detail DTO, and move the highlight. */
  private refreshSelection(uuid: string): void {
    const target = this.findLiveObject(uuid);
    if (!target) {
      this.selectedDetail = null;
      this.clearHighlight();
      return;
    }
    this.selectedDetail = buildDetail(target);
    this.updateHighlight(target);
  }

  private findLiveObject(uuid: string): THREE.Object3D | null {
    const root = getRuntimeSceneRoot() as unknown as THREE.Object3D | null;
    if (!root) {
      return null;
    }
    return root.getObjectByProperty('uuid', uuid) ?? null;
  }

  /** Draw / move the Box3 highlight around `target` in the running scene. */
  private updateHighlight(target: THREE.Object3D): void {
    const root = getRuntimeSceneRoot() as unknown as THREE.Object3D | null;
    if (!root || !this.isPlaying) {
      this.clearHighlight();
      return;
    }

    target.updateWorldMatrix(true, false);
    this.highlightBox.setFromObject(target);
    const size = this.highlightBox.getSize(new THREE.Vector3());
    if (this.highlightBox.isEmpty() || Math.max(size.x, size.y, size.z) < 1e-3) {
      // No spatial extent — cameras/empty groups (no geometry) or a resting
      // instanced pool with every instance collapsed at the origin. Box a small
      // marker at the object's origin so selecting it still shows *where* it is.
      const origin = target.getWorldPosition(new THREE.Vector3());
      this.highlightBox.setFromCenterAndSize(origin, new THREE.Vector3(0.5, 0.5, 0.5));
    }

    if (!this.highlight) {
      this.highlight = new THREE.Box3Helper(this.highlightBox, new THREE.Color(accentColor()));
      const material = this.highlight.material as THREE.LineBasicMaterial;
      material.depthTest = false; // show through geometry (and above the 2D pass)
      material.transparent = true;
      this.highlight.renderOrder = 100000;
      this.highlight.userData.isRuntimeHighlight = true;
      // Never let the highlight interfere with the game's own raycast/picking.
      this.highlight.raycast = () => {};
    }
    // Match the target's render pass: 3D objects draw on the 3D camera's layers,
    // 2D-overlay nodes on the ortho camera's LAYER_2D — copying the mask picks
    // the right pass automatically, so 3D gets a box and 2D gets a flat frame.
    this.highlight.layers.mask = target.layers.mask;

    if (this.highlight.parent !== root) {
      root.add(this.highlight);
    }
  }

  private clearHighlight(): void {
    if (this.highlight?.parent) {
      this.highlight.parent.remove(this.highlight);
    }
    this.highlight = undefined;
  }

  /** A node matches the filter if its own type/name/flag matches. */
  private nodeMatches(node: RuntimeNode): boolean {
    const f = this.filter;
    if (!f) return true;
    if (f === 'droppable' || f === 'droppables') return node.droppable;
    return node.type.toLowerCase().includes(f) || node.name.toLowerCase().includes(f);
  }

  /** A node is shown if it or any descendant matches. */
  private subtreeMatches(node: RuntimeNode): boolean {
    if (this.nodeMatches(node)) return true;
    return node.children.some(child => this.subtreeMatches(child));
  }

  /** Root type filter applies only to top-level runtime nodes. */
  private rootMatchesType(node: RuntimeNode): boolean {
    if (this.rootTypeFilter === 'all') {
      return true;
    }
    return node.type.toLowerCase().includes(this.rootTypeFilter);
  }

  protected render() {
    return html`
      <pix3-panel
        panel-description="Inspect the live runtime object tree of the running game."
        actions-label="Runtime inspector controls"
      >
        <div slot="toolbar" class="runtime-toolbar">
          <div class="runtime-toolbar-main">
            <input
              class="runtime-filter"
              type="text"
              placeholder="Filter type / name / 'droppable'"
              .value=${this.filter}
              @input=${this.onFilterInput}
              aria-label="Filter runtime objects"
            />
            <button
              type="button"
              class="runtime-live-toggle ${this.live ? 'is-live' : ''}"
              @click=${this.toggleLive}
              title=${this.live ? 'Live updates on' : 'Live updates paused'}
            >
              ${this.live ? '● Live' : '⏸ Paused'}
            </button>
            <button type="button" class="runtime-refresh" @click=${() => this.refreshTree()}>
              ↻
            </button>
            <span class="runtime-count">${this.nodeCount} objs</span>
            <button
              type="button"
              class="runtime-collapse-all"
              @click=${this.collapseAll}
              title="Collapse all"
              aria-label="Collapse all runtime nodes"
            >
              <svg viewBox="0 0 2000 2000" aria-hidden="true" focusable="false">
                <path
                  d="M3425 19984 c-93 -20 -235 -91 -312 -154 -197 -163 -292 -440 -238 -695 18 -87 77 -211 138 -290 72 -95 6040 -6052 6127 -6117 353 -261 795 -350 1210 -243 199 51 374 137 534 262 77 60 5939 5913 6062 6052 208 235 252 533 119 802 -73 148 -186 258 -339 329 -151 71 -339 88 -486 44 -60 -18 -173 -71 -223 -105 -18 -12 -1379 -1368 -3024 -3013 l-2993 -2991 -2992 2991 c-1646 1645 -3007 3001 -3025 3013 -50 34 -163 87 -223 105 -79 24 -248 29 -335 10z"
                  transform="matrix(.1 0 0 -.1 0 2000)"
                ></path>
                <path
                  d="M9795 7545 c-247 -39 -458 -127 -655 -273 -87 -65 -6055 -6022 -6127 -6117 -202 -265 -203 -613 -3 -879 93 -123 268 -230 430 -262 98 -19 232 -15 320 12 60 18 173 71 223 105 18 12 1379 1368 3025 3013 l2992 2991 2993 -2991 c1645 -1645 3006 -3001 3024 -3013 50 -34 163 -87 223 -105 251 -75 563 23 733 231 233 285 222 662 -27 944 -41 46 -1410 1419 -3042 3050 -2063 2061 -2994 2984 -3052 3027 -300 222 -703 323 -1057 267z"
                  transform="matrix(.1 0 0 -.1 0 2000)"
                ></path>
              </svg>
            </button>
          </div>

          <div class="runtime-root-filter" role="group" aria-label="Root node type filter">
            <button
              type="button"
              class="runtime-root-filter-btn ${this.rootTypeFilter === 'all' ? 'is-active' : ''}"
              aria-pressed=${this.rootTypeFilter === 'all'}
              @click=${() => this.setRootTypeFilter('all')}
            >
              All
            </button>
            <button
              type="button"
              class="runtime-root-filter-btn ${this.rootTypeFilter === '3d' ? 'is-active' : ''}"
              aria-pressed=${this.rootTypeFilter === '3d'}
              @click=${() => this.setRootTypeFilter('3d')}
            >
              3D
            </button>
            <button
              type="button"
              class="runtime-root-filter-btn ${this.rootTypeFilter === '2d' ? 'is-active' : ''}"
              aria-pressed=${this.rootTypeFilter === '2d'}
              @click=${() => this.setRootTypeFilter('2d')}
            >
              2D
            </button>
          </div>
        </div>

        <div class="runtime-body">${this.renderBody()} ${this.renderDetail()}</div>
      </pix3-panel>
    `;
  }

  private renderBody() {
    if (!this.isPlaying) {
      return html`<p class="runtime-placeholder">
        Start <strong>Play</strong> mode to inspect the live runtime instances.
      </p>`;
    }
    if (this.roots.length === 0) {
      return html`<p class="runtime-placeholder">
        Waiting for the runtime scene… (no objects yet)
      </p>`;
    }

    const rootsByType = this.roots.filter(node => this.rootMatchesType(node));
    const visibleRoots = this.filter
      ? rootsByType.filter(node => this.subtreeMatches(node))
      : rootsByType;

    if (visibleRoots.length === 0) {
      if (this.filter) {
        return html`<p class="runtime-placeholder">No objects match “${this.filter}”.</p>`;
      }
      return html`<p class="runtime-placeholder">
        No root objects for “${this.rootTypeFilter.toUpperCase()}”.
      </p>`;
    }

    return html`<div class="runtime-tree" role="tree">
      ${repeat(
        visibleRoots,
        node => node.uuid,
        node => this.renderNode(node, 0)
      )}
    </div>`;
  }

  private renderNode(node: RuntimeNode, level: number): unknown {
    if (this.filter && !this.subtreeMatches(node)) {
      return null;
    }

    const isCollapsed = this.collapsed.has(node.uuid);
    const hasChildren = node.children.length > 0;
    const matched = this.filter !== '' && this.nodeMatches(node);

    return html`
      <div class="runtime-node">
        <div
          class="runtime-row ${this.selectedUuid === node.uuid ? 'is-selected' : ''} ${matched
            ? 'is-match'
            : ''}"
          style=${`padding-left: ${level * 14 + 6}px`}
          role="treeitem"
          @click=${() => this.onRowClick(node)}
        >
          <button
            type="button"
            class="runtime-twisty ${hasChildren ? '' : 'is-leaf'}"
            @click=${(e: Event) => {
              e.stopPropagation();
              if (hasChildren) this.toggleCollapse(node.uuid);
            }}
            aria-label=${isCollapsed ? 'Expand' : 'Collapse'}
          >
            ${hasChildren ? (isCollapsed ? '▶' : '▼') : ''}
          </button>
          <span class="runtime-type">${node.type}</span>
          ${node.name ? html`<span class="runtime-name">${node.name}</span>` : null}
          ${node.droppable ? html`<span class="runtime-badge badge-drop">drop</span>` : null}
          ${node.instances !== null
            ? html`<span class="runtime-badge badge-inst">×${node.instances}</span>`
            : null}
          ${node.gizmo ? html`<span class="runtime-badge badge-gizmo">gizmo</span>` : null}
          ${!node.visible ? html`<span class="runtime-badge badge-hidden">hidden</span>` : null}
          ${node.pos
            ? html`<span class="runtime-pos">${node.pos.x}, ${node.pos.y}, ${node.pos.z}</span>`
            : null}
        </div>
        ${hasChildren && !isCollapsed
          ? html`<div class="runtime-children">
              ${repeat(
                node.children,
                child => child.uuid,
                child => this.renderNode(child, level + 1)
              )}
              ${node.truncatedChildren > 0
                ? html`<div
                    class="runtime-row runtime-more"
                    style=${`padding-left: ${(level + 1) * 14 + 6}px`}
                  >
                    +${node.truncatedChildren} more…
                  </div>`
                : null}
            </div>`
          : null}
      </div>
    `;
  }

  private renderDetail() {
    const d = this.selectedDetail;
    if (!this.isPlaying || !d) {
      return null;
    }
    return html`
      <div class="runtime-detail">
        <div class="runtime-detail-head">
          <span class="runtime-detail-type">${d.type}</span>
          ${d.name ? html`<span class="runtime-detail-name">${d.name}</span>` : null}
          ${d.isNodeBase ? html`<span class="runtime-badge badge-node">node</span>` : null}
          ${d.instances !== null
            ? html`<span class="runtime-badge badge-inst">×${d.instances}</span>`
            : null}
          <button
            type="button"
            class="runtime-detail-close"
            @click=${this.clearSelection}
            aria-label="Clear selection"
            title="Clear selection"
          >
            ✕
          </button>
        </div>

        <div class="runtime-detail-body">
          ${this.detailSection('World', [
            this.vecRow('position', d.world.position),
            this.vecRow('rotation°', d.world.rotationDeg),
            this.vecRow('scale', d.world.scale),
          ])}
          ${this.detailSection('Render', [
            this.kvRow('visible', String(d.visible)),
            this.kvRow('renderOrder', String(d.renderOrder)),
            this.kvRow('layers', d.layers.join(', ')),
            this.kvRow('children', String(d.childCount)),
          ])}
          ${d.geometry
            ? this.detailSection('Geometry', [
                this.kvRow('type', d.geometry.type),
                d.geometry.vertices !== undefined
                  ? this.kvRow('vertices', String(d.geometry.vertices))
                  : null,
                ...(d.geometry.params
                  ? Object.entries(d.geometry.params).map(([k, v]) => this.kvRow(k, String(v)))
                  : []),
              ])
            : null}
          ${d.materials && d.materials.length > 0
            ? this.detailSection(
                d.materials.length > 1 ? `Materials (${d.materials.length})` : 'Material',
                d.materials.flatMap((mat, i) => this.materialRows(mat, i, d.materials!.length))
              )
            : null}
          ${Object.keys(d.userData).length > 0
            ? this.detailSection(
                'userData',
                Object.entries(d.userData).map(([k, v]) => this.kvRow(k, v))
              )
            : null}
        </div>
      </div>
    `;
  }

  private detailSection(title: string, rows: unknown[]) {
    const filtered = rows.filter(r => r !== null);
    if (filtered.length === 0) {
      return null;
    }
    return html`<div class="runtime-detail-section">
      <div class="runtime-detail-section-title">${title}</div>
      ${filtered}
    </div>`;
  }

  private kvRow(key: string, value: string) {
    return html`<div class="runtime-kv">
      <span class="runtime-kv-key">${key}</span>
      <span class="runtime-kv-val">${value}</span>
    </div>`;
  }

  private vecRow(key: string, v: Vec3) {
    return html`<div class="runtime-kv">
      <span class="runtime-kv-key">${key}</span>
      <span class="runtime-kv-val runtime-kv-vec">${v.x}, ${v.y}, ${v.z}</span>
    </div>`;
  }

  private materialRows(mat: MaterialInfo, index: number, total: number) {
    const prefix = total > 1 ? `[${index}] ` : '';
    const rows = [
      this.kvRow(`${prefix}type`, mat.type),
      mat.color ? this.colorRow(`${prefix}color`, mat.color) : null,
      mat.opacity !== undefined ? this.kvRow(`${prefix}opacity`, String(mat.opacity)) : null,
      mat.transparent ? this.kvRow(`${prefix}transparent`, 'true') : null,
      mat.wireframe ? this.kvRow(`${prefix}wireframe`, 'true') : null,
      this.kvRow(`${prefix}map`, mat.map ? 'yes' : 'no'),
      mat.side ? this.kvRow(`${prefix}side`, mat.side) : null,
    ];
    return rows.filter(r => r !== null);
  }

  private colorRow(key: string, color: string) {
    return html`<div class="runtime-kv">
      <span class="runtime-kv-key">${key}</span>
      <span class="runtime-kv-val">
        <span class="runtime-swatch" style=${`background:${color}`}></span>${color}
      </span>
    </div>`;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (no component state)
// ---------------------------------------------------------------------------

/** True for objects the panel injects itself (the selection highlight). */
function isHelperObject(obj: LiveObject3D): boolean {
  return obj.userData?.isRuntimeHighlight === true;
}

function accentColor(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--pix3-accent-color')
    .trim();
  return value || '#ffcf33';
}

/** Build a full inspection DTO straight off the raw live THREE object. */
function buildDetail(obj: THREE.Object3D): RuntimeDetail {
  const wp = new THREE.Vector3();
  const wq = new THREE.Quaternion();
  const ws = new THREE.Vector3();
  obj.updateWorldMatrix(true, false);
  obj.matrixWorld.decompose(wp, wq, ws);
  const we = new THREE.Euler().setFromQuaternion(wq);

  const mesh = obj as THREE.Mesh;
  let geometry: GeometryInfo | null = null;
  if (mesh.geometry) {
    const g = mesh.geometry as THREE.BufferGeometry & { parameters?: Record<string, unknown> };
    geometry = {
      type: g.type,
      params: g.parameters ? shallowScalars(g.parameters) : undefined,
      vertices: g.attributes?.position?.count,
    };
  }

  let materials: MaterialInfo[] | null = null;
  const mat = mesh.material;
  if (mat) {
    const arr = Array.isArray(mat) ? mat : [mat];
    materials = arr.map(m => materialInfo(m as unknown as MaterialLike));
  }

  const instanced = obj as THREE.InstancedMesh;
  const nodeId = (obj.userData ?? {}).nodeId;

  return {
    uuid: obj.uuid,
    type: obj.type || (obj as { constructor?: { name?: string } }).constructor?.name || 'Object3D',
    name: obj.name || '',
    isNodeBase: typeof nodeId === 'string',
    visible: obj.visible,
    renderOrder: obj.renderOrder ?? 0,
    layers: enabledLayers(obj.layers.mask),
    instances: instanced.isInstancedMesh ? instanced.count : null,
    world: { position: vec(wp), rotationDeg: eulerDeg(we), scale: vec(ws) },
    local: {
      position: vec(obj.position),
      rotationDeg: eulerDeg(obj.rotation),
      scale: vec(obj.scale),
    },
    geometry,
    materials,
    userData: previewUserData(obj.userData ?? {}),
    childCount: obj.children.length,
  };
}

function materialInfo(m: MaterialLike): MaterialInfo {
  return {
    type: m.type ?? 'Material',
    color: m.color?.getHexString ? `#${m.color.getHexString()}` : undefined,
    opacity: typeof m.opacity === 'number' ? round2(m.opacity) : undefined,
    transparent: m.transparent === true || undefined,
    wireframe: m.wireframe === true || undefined,
    map: !!m.map,
    side: sideName(m.side),
  };
}

function sideName(side: number | undefined): string | undefined {
  if (side === THREE.DoubleSide) return 'Double';
  if (side === THREE.BackSide) return 'Back';
  if (side === THREE.FrontSide) return 'Front';
  return undefined;
}

function shallowScalars(
  source: Record<string, unknown>
): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function previewUserData(ud: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(ud)) {
    if (key.startsWith('_')) continue;
    const value = ud[key];
    const t = typeof value;
    if (value === null) out[key] = 'null';
    else if (t === 'number' || t === 'boolean' || t === 'string') out[key] = String(value);
    else if (Array.isArray(value)) out[key] = `Array(${value.length})`;
    else if (t === 'object')
      out[key] = (value as { constructor?: { name?: string } }).constructor?.name ?? 'object';
    else out[key] = t;
  }
  return out;
}

/** Enabled layer indices decoded from a THREE.Layers mask. */
function enabledLayers(mask: number): number[] {
  const layers: number[] = [];
  for (let i = 0; i < 32; i++) {
    if ((mask & (1 << i)) !== 0) layers.push(i);
  }
  return layers;
}

function vec(v: { x: number; y: number; z: number }): Vec3 {
  return { x: round3(v.x), y: round3(v.y), z: round3(v.z) };
}

function eulerDeg(e: THREE.Euler): Vec3 {
  const d = 180 / Math.PI;
  return { x: round1(e.x * d), y: round1(e.y * d), z: round1(e.z * d) };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-runtime-panel': RuntimePanel;
  }
}
