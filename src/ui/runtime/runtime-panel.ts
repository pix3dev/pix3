import { subscribe } from 'valtio/vanilla';
import { repeat } from 'lit/directives/repeat.js';

import { ComponentBase, customElement, html, state } from '@/fw';
import { appState } from '@/state';
import { getRuntimeSceneRoot } from '@pix3/runtime';

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

type RootTypeFilter = 'all' | '3d' | '2d';

const MAX_DEPTH = 10;
const MAX_CHILDREN_PER_NODE = 250;
const MAX_TOTAL_NODES = 5000;
const REFRESH_INTERVAL_MS = 350;

@customElement('pix3-runtime-panel')
export class RuntimePanel extends ComponentBase {
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
  private nodeCount = 0;

  private refreshTimer: number | null = null;
  private disposeUiSubscription?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeUiSubscription = subscribe(appState.ui, () => {
      if (this.isPlaying !== appState.ui.isPlaying) {
        this.isPlaying = appState.ui.isPlaying;
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
      .slice(0, MAX_CHILDREN_PER_NODE)
      .map(child => this.toNode(child, MAX_DEPTH, counter));
    this.nodeCount = counter.n;
  }

  private toNode(obj: LiveObject3D, depth: number, counter: { n: number }): RuntimeNode {
    counter.n += 1;
    const m = obj.matrixWorld?.elements;
    const pos =
      m && m.length >= 15
        ? { x: round2(m[12]), y: round2(m[13]), z: round2(m[14]) }
        : null;
    const ud = obj.userData ?? {};
    const rawChildren = Array.isArray(obj.children) ? obj.children : [];

    let children: RuntimeNode[] = [];
    let truncated = 0;
    if (rawChildren.length > 0 && depth > 0 && counter.n < MAX_TOTAL_NODES) {
      const slice = rawChildren.slice(0, MAX_CHILDREN_PER_NODE);
      truncated = rawChildren.length - slice.length;
      children = slice.map(child => this.toNode(child, depth - 1, counter));
    }

    return {
      uuid: obj.uuid,
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
    // Log full detail for deeper inspection (positions, flags) via console.
    console.log('[Runtime]', node.type, node.name || '(unnamed)', {
      pos: node.pos,
      visible: node.visible,
      renderOrder: node.renderOrder,
      instances: node.instances,
      droppable: node.droppable,
      childCount: node.childCount,
    });
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

        ${this.renderBody()}
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
      return html`<p class="runtime-placeholder">No root objects for “${this.rootTypeFilter.toUpperCase()}”.</p>`;
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
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-runtime-panel': RuntimePanel;
  }
}
