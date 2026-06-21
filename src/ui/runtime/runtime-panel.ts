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

  private toggleCollapse(uuid: string): void {
    const next = new Set(this.collapsed);
    if (next.has(uuid)) {
      next.delete(uuid);
    } else {
      next.add(uuid);
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

  protected render() {
    return html`
      <pix3-panel
        panel-description="Inspect the live runtime object tree of the running game."
        actions-label="Runtime inspector controls"
      >
        <div slot="toolbar" class="runtime-toolbar">
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

    const visibleRoots = this.filter
      ? this.roots.filter(node => this.subtreeMatches(node))
      : this.roots;

    if (visibleRoots.length === 0) {
      return html`<p class="runtime-placeholder">No objects match “${this.filter}”.</p>`;
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
