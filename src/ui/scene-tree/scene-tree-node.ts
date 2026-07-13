import type { TemplateResult } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';

import { ComponentBase, customElement, html, property, state, inject } from '@/fw';
import { appState } from '@/state';
import { CommandDispatcher } from '@/services';
import { IconService, IconSize } from '@/services/IconService';
import { ServiceContainer } from '@/fw/di';
import { SceneManager } from '@pix3/runtime';
import { canDropNode } from '@/fw/hierarchy-validation';
import {
  selectObject,
  toggleObjectSelection,
  selectObjectRange,
} from '@/features/selection/SelectObjectCommand';
import { UpdateObjectPropertyCommand } from '@/features/properties/UpdateObjectPropertyCommand';
import {
  classifySceneCreateAssetResource,
  getDroppedAssetResourcePath,
  hasAssetDragData,
} from '@/ui/shared/asset-drag-drop';

import './scene-tree-node.ts.css';

/**
 * View model for scene tree nodes - UI-specific representation.
 */
export interface SceneTreeNode {
  id: string;
  name: string;
  type: string;
  treeColor: string;
  treeIcon: string;
  instancePath: string | null;
  properties: Record<string, unknown>;
  children: SceneTreeNode[];
  isContainer: boolean;
  scripts: string[];
  isPrefabNode?: boolean;
  isPrefabRoot?: boolean;
  isPrefabChild?: boolean;
}

interface ScriptRevealRequestDetail {
  scriptType: string;
  scriptName: string;
  candidatePaths: string[];
  /** When true, the file is opened in a code tab (double-click); otherwise it is only revealed. */
  open?: boolean;
}

interface NodeContextMenuDetail {
  nodeId: string;
  clientX: number;
  clientY: number;
}

interface NodeAssetDropDetail {
  targetNodeId: string;
  position: 'before' | 'inside' | 'after';
  resourcePath: string;
}

@customElement('pix3-scene-tree-node')
export class SceneTreeNodeComponent extends ComponentBase {
  static useShadowDom = false; // Use light DOM for proper nesting

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(IconService)
  private readonly iconService!: IconService;

  @property({ type: Object })
  node!: SceneTreeNode;

  @property({ type: Number })
  level: number = 1;

  @property({ type: Boolean })
  focusable: boolean = false;

  @property({ type: Array })
  selectedNodeIds: string[] = [];

  @property({ type: String })
  primaryNodeId: string | null = null;

  @property({ type: String })
  draggedNodeId: string | null = null;

  @property({ type: String })
  draggedNodeType: string | null = null;

  /** Remote users who have this node selected (from collab awareness) */
  @property({ type: Array })
  collabUsers: Array<{ name: string; color: string }> = [];

  @property({ type: Object })
  remoteSelectionByNodeId: Record<string, Array<{ name: string; color: string }>> = {};

  @property({ type: Object })
  collapsedNodeIds: Set<string> = new Set();

  @state()
  private isCollapsed: boolean = false;

  @state()
  private dragOverPosition: 'top' | 'inside' | 'bottom' | null = null;

  @state()
  private isDragging: boolean = false;

  @state()
  private isVisible: boolean = true;

  @state()
  private isLocked: boolean = false;

  @state()
  private isValidDropTarget: boolean = true;

  private scriptPopoverAnchor: HTMLElement | null = null;
  private scriptPopoverElement: HTMLElement | null = null;

  disconnectedCallback(): void {
    this.closeScriptPopover();
    super.disconnectedCallback();
  }

  willUpdate(changedProperties: Map<string, unknown>): void {
    super.willUpdate(changedProperties as Map<string, unknown>);
    if (changedProperties.has('node') || changedProperties.has('collapsedNodeIds')) {
      this.isCollapsed = this.collapsedNodeIds.has(this.node.id);
    }
    if (changedProperties.has('node')) {
      this.isVisible = (this.node.properties?.visible as boolean) ?? true;
      this.isLocked = (this.node.properties?.locked as boolean) ?? false;
    }
    if (changedProperties.has('node') || changedProperties.has('remoteSelectionByNodeId')) {
      this.collabUsers = this.remoteSelectionByNodeId[this.node.id] ?? [];
    }
  }

  protected render() {
    const hasChildren = this.node.children.length > 0;
    const isSelected = this.selectedNodeIds.includes(this.node.id);
    const isPrimary = this.primaryNodeId === this.node.id;

    const contentClasses = classMap({
      'tree-node__content': true,
      'tree-node__content--selected': isSelected,
      'tree-node__content--primary': isPrimary,
      'tree-node__content--dragging': this.isDragging,
      'tree-node__content--drag-over-top': this.dragOverPosition === 'top' && !this.isDragging,
      'tree-node__content--drag-over-inside':
        this.dragOverPosition === 'inside' && !this.isDragging,
      'tree-node__content--drag-over-bottom':
        this.dragOverPosition === 'bottom' && !this.isDragging,
      'tree-node__content--drop-disabled':
        this.dragOverPosition !== null && !this.isValidDropTarget && !this.isDragging,
      'tree-node__content--prefab': !!this.node.isPrefabNode,
      'tree-node__content--prefab-root': !!this.node.isPrefabRoot,
      'tree-node__content--prefab-child': !!this.node.isPrefabChild,
    });

    const expanderClasses = classMap({
      'tree-node__expander': true,
      'tree-node__expander--visible': hasChildren,
      'tree-node__expander--collapsed': hasChildren && this.isCollapsed,
      'tree-node__expander--button': hasChildren,
    });

    const expanderTemplate = hasChildren
      ? html`<button
          type="button"
          class=${expanderClasses}
          aria-label=${this.getToggleLabel(this.node.name, this.isCollapsed)}
          @click=${(event: Event) => this.onToggleNode(event)}
        ></button>`
      : html`<span class=${expanderClasses} aria-hidden="true"></span>`;

    return html`
      <li
        class="tree-node"
        role="none"
        ?data-dragged=${this.draggedNodeId === this.node.id && this.draggedNodeId !== null}
      >
        <div
          class=${contentClasses}
          role="treeitem"
          aria-level=${this.level}
          aria-selected=${isSelected ? 'true' : 'false'}
          aria-expanded=${ifDefined(
            hasChildren ? (this.isCollapsed ? 'false' : 'true') : undefined
          )}
          tabindex=${this.focusable ? '0' : '-1'}
          data-node-id=${this.node.id}
          title=${this.getNodeTooltip(this.node)}
          @click=${(event: Event) => this.onSelectNode(event)}
          @dblclick=${(event: MouseEvent) => this.onDoubleClick(event)}
          @contextmenu=${(event: MouseEvent) => {
            void this.onContextMenu(event);
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
              this.onSelectNode(event);
              event.preventDefault();
            }
          }}
          @dragstart=${(event: DragEvent) => this.onDragStart(event)}
          @dragend=${(event: DragEvent) => this.onDragEnd(event)}
          @dragover=${(event: DragEvent) => this.onDragOver(event)}
          @dragleave=${(event: DragEvent) => this.onDragLeave(event)}
          @drop=${(event: DragEvent) => this.onDrop(event)}
          draggable="true"
        >
          ${expanderTemplate}
          <span
            class="tree-node__icon"
            title=${this.node.type}
            aria-label=${this.node.type}
            style="color: ${this.node.treeColor};"
          >
            ${this.renderNodeIcon(this.node.treeIcon)}
          </span>
          <span class="tree-node__label">
            <span class="tree-node__header">
              <span class="tree-node__name"> ${this.node.name} </span>
              ${this.node.instancePath
                ? html`<span class="tree-node__instance-inline"
                    >${this.getInstanceFileName(this.node.instancePath)}</span
                  >`
                : null}
              ${this.node.isPrefabRoot
                ? html`<span class="tree-node__prefab-badge" title="Prefab instance root">🔗</span>`
                : null}
              ${this.node.isPrefabChild
                ? html`<span
                    class="tree-node__prefab-lock"
                    title="Part of a prefab instance — open the prefab to edit its structure"
                    aria-hidden="true"
                    >${this.renderToggleIcon('lock')}</span
                  >`
                : null}
              ${this.node.scripts.length > 0
                ? html`
                    <button
                      type="button"
                      class="tree-node__script-indicator"
                      title=${this.getScriptIndicatorTitle()}
                      aria-label=${this.getScriptIndicatorTitle()}
                      @mouseenter=${(event: MouseEvent) => this.onScriptIndicatorMouseEnter(event)}
                      @mouseleave=${() => this.closeScriptPopover()}
                      @focus=${(event: FocusEvent) => this.onScriptIndicatorFocus(event)}
                      @blur=${() => this.closeScriptPopover()}
                      @click=${(event: Event) => this.onScriptIndicatorClick(event)}
                      @dblclick=${(event: Event) => this.onScriptIndicatorDoubleClick(event)}
                    >
                      ${this.renderToggleIcon(this.getScriptIndicatorIconName())}
                    </button>
                  `
                : null}
              ${this.collabUsers.length > 0
                ? html`<span class="tree-node__collab-indicators"
                    >${this.collabUsers.map(
                      u =>
                        html`<span
                          class="tree-node__collab-avatar"
                          title="${u.name}"
                          style="background-color: ${u.color}"
                          >${this.getCollabInitials(u.name)}</span
                        >`
                    )}</span
                  >`
                : null}
            </span>
          </span>
          <div class="tree-node__buttons">
            <button
              type="button"
              class="tree-node__button tree-node__button--visible ${this.isVisible
                ? 'tree-node__button--active'
                : ''}"
              aria-label=${this.isVisible ? `Hide ${this.node.name}` : `Show ${this.node.name}`}
              @click=${(event: Event) => this.onToggleVisibility(event)}
            >
              ${this.renderToggleIcon(this.isVisible ? 'eye' : 'eye-off')}
            </button>
            <button
              type="button"
              class="tree-node__button tree-node__button--lock ${this.isLocked
                ? 'tree-node__button--active'
                : ''}"
              aria-label=${this.isLocked ? `Unlock ${this.node.name}` : `Lock ${this.node.name}`}
              @click=${(event: Event) => this.onToggleLock(event)}
            >
              ${this.renderToggleIcon(this.isLocked ? 'lock' : 'unlock')}
            </button>
          </div>
        </div>
        ${hasChildren && !this.isCollapsed
          ? html`<ul class="tree-children" role="group">
              ${repeat(
                this.node.children,
                child => child.id,
                (child, index) =>
                  html`<li>
                    <pix3-scene-tree-node
                      .node=${child}
                      .level=${this.level + 1}
                      .selectedNodeIds=${this.selectedNodeIds}
                      .primaryNodeId=${this.primaryNodeId}
                      .collapsedNodeIds=${this.collapsedNodeIds}
                      .draggedNodeId=${this.draggedNodeId}
                      .draggedNodeType=${this.draggedNodeType}
                      .remoteSelectionByNodeId=${this.remoteSelectionByNodeId}
                      ?focusable=${index === 0}
                    ></pix3-scene-tree-node>
                  </li>`
              )}
            </ul>`
          : null}
      </li>
    `;
  }

  private getNodeTooltip(node: SceneTreeNode): string {
    const base = node.instancePath
      ? `${node.name} · ${node.type} · ${node.instancePath}`
      : `${node.name} · ${node.type}`;
    if (node.isPrefabChild) {
      return `${base} · part of prefab instance — open prefab to edit structure`;
    }
    return base;
  }

  private getToggleLabel(nodeName: string, isCollapsed: boolean): string {
    return isCollapsed ? `Expand ${nodeName}` : `Collapse ${nodeName}`;
  }

  private renderNodeIcon(iconName: string): TemplateResult {
    return this.iconService.getIcon(iconName, IconSize.MEDIUM);
  }

  private renderToggleIcon(iconName: string): TemplateResult {
    return this.iconService.getIcon(iconName, IconSize.SMALL);
  }

  private getCollabInitials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (words.length === 0) {
      return '?';
    }

    return words.map(word => word.charAt(0).toUpperCase()).join('');
  }

  private onScriptIndicatorMouseEnter(event: MouseEvent): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    this.openScriptPopover(target);
  }

  private onScriptIndicatorFocus(event: FocusEvent): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    this.openScriptPopover(target);
  }

  private openScriptPopover(anchor: HTMLElement): void {
    this.scriptPopoverAnchor = anchor;
    if (!this.scriptPopoverElement) {
      this.scriptPopoverElement = this.createScriptPopoverElement();
      document.body.appendChild(this.scriptPopoverElement);
    }
    this.updateScriptPopoverPosition();
    window.addEventListener('scroll', this.handleViewportChange, true);
    window.addEventListener('resize', this.handleViewportChange);
  }

  private closeScriptPopover(): void {
    this.scriptPopoverAnchor = null;
    if (this.scriptPopoverElement) {
      this.scriptPopoverElement.remove();
      this.scriptPopoverElement = null;
    }
    window.removeEventListener('scroll', this.handleViewportChange, true);
    window.removeEventListener('resize', this.handleViewportChange);
  }

  private readonly handleViewportChange = (): void => {
    if (!this.scriptPopoverAnchor || !this.scriptPopoverElement) {
      return;
    }
    this.updateScriptPopoverPosition();
  };

  private createScriptPopoverElement(): HTMLElement {
    const popover = document.createElement('div');
    popover.className = 'script-popover script-popover--portal';
    popover.setAttribute('role', 'tooltip');

    const title = document.createElement('div');
    title.className = 'script-popover__title';
    title.textContent = 'Attached Scripts';
    popover.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'script-popover__list';
    for (const script of this.node.scripts) {
      const item = document.createElement('li');
      item.className = 'script-popover__item';
      const icon = document.createElement('span');
      icon.className = 'script-popover__item-icon';
      icon.textContent = this.isUserScriptType(script) ? '<>' : '⚡';
      icon.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.className = 'script-popover__item-label';
      label.textContent = script;

      item.appendChild(icon);
      item.appendChild(label);
      list.appendChild(item);
    }
    popover.appendChild(list);

    return popover;
  }

  private updateScriptPopoverPosition(): void {
    if (!this.scriptPopoverAnchor || !this.scriptPopoverElement) {
      return;
    }

    const rect = this.scriptPopoverAnchor.getBoundingClientRect();
    const popover = this.scriptPopoverElement;
    const margin = 8;
    let left = rect.right + 10;
    let top = rect.top + rect.height / 2;

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;

    const popoverRect = popover.getBoundingClientRect();

    if (left + popoverRect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - popoverRect.width - margin);
    }
    if (left < margin) {
      left = margin;
    }

    if (top + popoverRect.height / 2 > window.innerHeight - margin) {
      top = Math.max(
        margin + popoverRect.height / 2,
        window.innerHeight - margin - popoverRect.height / 2
      );
    }
    if (top - popoverRect.height / 2 < margin) {
      top = margin + popoverRect.height / 2;
    }

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  private getScriptIndicatorIconName(): string {
    const hasCoreScript = this.node.scripts.some(script => this.isCoreScriptType(script));
    const hasUserScript = this.node.scripts.some(script => this.isUserScriptType(script));

    if (hasCoreScript && !hasUserScript) {
      return 'zap';
    }

    return 'code';
  }

  private getScriptIndicatorTitle(): string {
    const hasUserScript = this.node.scripts.some(script => this.isUserScriptType(script));
    if (hasUserScript) {
      return 'Reveal user script in Asset Browser';
    }
    return 'Attached scripts';
  }

  private isCoreScriptType(scriptType: string): boolean {
    return scriptType.startsWith('core:');
  }

  private isUserScriptType(scriptType: string): boolean {
    return scriptType.startsWith('user:');
  }

  private onScriptIndicatorClick(event: Event): void {
    event.stopPropagation();
    this.dispatchScriptFileRevealRequest(false);
  }

  private onScriptIndicatorDoubleClick(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    // Single-click reveals the script in the Asset Browser; double-click also opens it in a code tab.
    this.dispatchScriptFileRevealRequest(true);
  }

  private dispatchScriptFileRevealRequest(open: boolean): void {
    const userScriptType = this.node.scripts.find(scriptType => scriptType.startsWith('user:'));
    if (!userScriptType) {
      return;
    }

    const scriptName = userScriptType.slice('user:'.length).trim();
    if (!scriptName) {
      return;
    }

    const fileName = `${scriptName}.ts`;
    const detail: ScriptRevealRequestDetail = {
      scriptType: userScriptType,
      scriptName,
      candidatePaths: [`scripts/${fileName}`, `src/scripts/${fileName}`],
      open,
    };

    window.dispatchEvent(
      new CustomEvent<ScriptRevealRequestDetail>('script-file-reveal-request', { detail })
    );
  }

  private onDoubleClick(event: MouseEvent): void {
    // Double-clicking a prefab instance node (root or child) opens its source
    // prefab in a dedicated tab. Non-prefab nodes keep their default behavior.
    if (!this.node.isPrefabNode) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('node-open-prefab', {
        detail: { nodeId: this.node.id },
        bubbles: true,
        composed: true,
      })
    );
  }

  private onToggleNode(event: Event): void {
    event.stopPropagation();
    const nextCollapsedState = !this.isCollapsed;
    this.dispatchEvent(
      new CustomEvent('toggle-node', {
        detail: { nodeId: this.node.id, isCollapsed: nextCollapsedState },
        bubbles: true,
        composed: true,
      })
    );
  }

  private async onSelectNode(event: Event): Promise<void> {
    event.stopPropagation();

    // Determine selection behavior based on modifier keys
    const mouseEvent = event as MouseEvent;
    const isAdditive = mouseEvent.ctrlKey || mouseEvent.metaKey;
    const isRange = mouseEvent.shiftKey;

    // Execute selection command via dispatcher
    const command = isRange
      ? selectObjectRange(this.node.id)
      : isAdditive
        ? toggleObjectSelection(this.node.id)
        : selectObject(this.node.id);

    try {
      const didMutate = await this.commandDispatcher.execute(command);
      // Selection state will be automatically updated via subscription
      if (didMutate) {
        console.log(`Selected node: ${this.node.id}`, {
          additive: isAdditive,
          range: isRange,
          selectedCount: appState.selection.nodeIds.length,
        });
      }
    } catch (error) {
      console.error('[SceneTreeNode] Failed to execute selection command', error);
    }
  }

  private getInstanceFileName(instancePath: string): string {
    const normalized = instancePath.replace(/\\/g, '/');
    const slashIndex = normalized.lastIndexOf('/');
    if (slashIndex < 0) {
      return normalized;
    }
    return normalized.slice(slashIndex + 1);
  }

  private async onContextMenu(event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();

    if (!this.selectedNodeIds.includes(this.node.id)) {
      try {
        await this.commandDispatcher.execute(selectObject(this.node.id));
      } catch (error) {
        console.error('[SceneTreeNode] Failed to select node for context menu', error);
      }
    }

    const detail: NodeContextMenuDetail = {
      nodeId: this.node.id,
      clientX: event.clientX,
      clientY: event.clientY,
    };

    this.dispatchEvent(
      new CustomEvent<NodeContextMenuDetail>('node-context-menu', {
        detail,
        bubbles: true,
        composed: true,
      })
    );
  }

  private onDragStart(event: DragEvent): void {
    // Prefab instance children are structurally locked — they cannot be moved out
    // of or within their instance (the change would be lost on save). Refuse the
    // drag outright so the user gets immediate feedback.
    if (this.node.isPrefabChild) {
      event.preventDefault();
      return;
    }

    event.stopPropagation();
    this.isDragging = true;

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-scene-tree-node', this.node.id);
      const img = new Image();
      img.src =
        'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="16"%3E%3Crect width="16" height="16" fill="%235ec2ff" opacity="0.3"/%3E%3C/svg%3E';
      event.dataTransfer.setDragImage(img, 0, 0);
    }

    this.dispatchEvent(
      new CustomEvent('node-drag-start', {
        detail: {
          nodeId: this.node.id,
          nodeType: this.node.type,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  private onDragEnd(event: DragEvent): void {
    event.stopPropagation();
    this.isDragging = false;
    this.dragOverPosition = null;
    this.isValidDropTarget = true;

    this.dispatchEvent(
      new CustomEvent('node-drag-end', {
        detail: {},
        bubbles: true,
        composed: true,
      })
    );
  }

  private onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const hasAssetResource = hasAssetDragData(event.dataTransfer ?? null);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = hasAssetResource ? 'copy' : 'move';
    }

    const element = event.currentTarget as HTMLElement;
    const rect = element.getBoundingClientRect();
    const relativeY = event.clientY - rect.top;
    const thresholdPercent = 0.33;

    let nextPosition: 'top' | 'inside' | 'bottom' | null = null;

    if (this.node.isContainer) {
      if (relativeY < rect.height * thresholdPercent) {
        nextPosition = 'top';
      } else if (relativeY > rect.height * (1 - thresholdPercent)) {
        nextPosition = 'bottom';
      } else {
        nextPosition = 'inside';
      }
    } else {
      nextPosition = relativeY < rect.height * 0.5 ? 'top' : 'bottom';
    }

    // Validate the drop target for the current hover position
    if (this.draggedNodeId && this.draggedNodeId !== this.node.id && !this.isDragging) {
      const isValid = this.validateDropTarget(this.draggedNodeId, this.node.id, nextPosition);
      // Set isValidDropTarget: true = valid/bright, false = invalid/faded
      this.isValidDropTarget = isValid;
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = isValid ? (hasAssetResource ? 'copy' : 'move') : 'none';
      }
    } else if (hasAssetResource) {
      // Asset drags (from the asset browser) create a node at the drop site.
      // Reject anything that would land inside a prefab instance subtree.
      const isValid = !this.targetsPrefabInterior(nextPosition);
      this.isValidDropTarget = isValid;
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = isValid ? 'copy' : 'none';
      }
    }

    if (this.dragOverPosition !== nextPosition) {
      this.dragOverPosition = nextPosition;
    }
  }

  /**
   * True when dropping at `position` relative to this node would place a new node
   * inside a prefab instance subtree (dropping "inside" any instance node, or as
   * a sibling of a prefab child). Instance roots accept before/after (sibling
   * placement outside the instance).
   */
  private targetsPrefabInterior(position: 'top' | 'inside' | 'bottom' | null): boolean {
    if (position === 'inside') {
      return !!this.node.isPrefabNode;
    }
    return !!this.node.isPrefabChild;
  }

  private onDragLeave(event: DragEvent): void {
    event.stopPropagation();
    // Clear both position and validity when leaving - will restore fade via CSS
    this.dragOverPosition = null;
    this.isValidDropTarget = true;
  }

  private async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();

    const draggedNodeId = event.dataTransfer?.getData('application/x-scene-tree-node');
    const droppedResourcePath = this.getDroppedResourcePath(event.dataTransfer ?? null);

    const dropPosition = this.dragOverPosition;
    // Capture validity BEFORE resetting it — the reset below must not defeat the
    // invalid-target guard.
    const wasValidDropTarget = this.isValidDropTarget;
    this.dragOverPosition = null;
    this.isValidDropTarget = true;

    if (!draggedNodeId && !droppedResourcePath) {
      return;
    }

    if (draggedNodeId && draggedNodeId === this.node.id) {
      return;
    }

    if (!wasValidDropTarget) {
      console.log('[SceneTreeNode] Drop prevented: invalid target');
      return;
    }

    try {
      if (droppedResourcePath) {
        const normalizedPosition: 'before' | 'inside' | 'after' =
          dropPosition === 'top' ? 'before' : dropPosition === 'bottom' ? 'after' : 'inside';
        const detail: NodeAssetDropDetail = {
          targetNodeId: this.node.id,
          position: normalizedPosition,
          resourcePath: droppedResourcePath,
        };
        this.dispatchEvent(
          new CustomEvent<NodeAssetDropDetail>('node-asset-drop', {
            detail,
            bubbles: true,
            composed: true,
          })
        );
        return;
      }

      const draggedId = draggedNodeId ?? '';
      if (!draggedId) {
        return;
      }

      if (dropPosition === 'inside' || dropPosition === null) {
        if (this.node.isContainer) {
          await this.performReparent(draggedId, this.node.id, -1);
        } else {
          await this.performReparent(draggedId, this.node.id, 'after');
        }
      } else if (dropPosition === 'top') {
        await this.performReparent(draggedId, this.node.id, 'before');
      } else if (dropPosition === 'bottom') {
        await this.performReparent(draggedId, this.node.id, 'after');
      }
    } catch (error) {
      console.error('[SceneTreeNode] Failed to reparent node:', error);
    }
  }

  private getDroppedResourcePath(dataTransfer: DataTransfer | null): string | null {
    const resourcePath = getDroppedAssetResourcePath(dataTransfer);
    if (!resourcePath || !classifySceneCreateAssetResource(resourcePath)) {
      return null;
    }

    return resourcePath;
  }

  private async performReparent(
    draggedNodeId: string,
    targetNodeId: string,
    position: 'before' | 'after' | number
  ): Promise<void> {
    // This will be handled by the parent panel to access the scene graph
    this.dispatchEvent(
      new CustomEvent('node-drop', {
        detail: {
          draggedNodeId,
          targetNodeId,
          position,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  private async onToggleVisibility(event: Event): Promise<void> {
    event.stopPropagation();

    const newVisibleState = !this.isVisible;
    try {
      const command = new UpdateObjectPropertyCommand({
        nodeId: this.node.id,
        propertyPath: 'visible',
        value: newVisibleState,
      });

      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[SceneTreeNode] Failed to toggle visibility:', error);
    }
  }

  private async onToggleLock(event: Event): Promise<void> {
    event.stopPropagation();

    const newLockedState = !this.isLocked;
    try {
      const command = new UpdateObjectPropertyCommand({
        nodeId: this.node.id,
        propertyPath: 'locked',
        value: newLockedState,
      });

      await this.commandDispatcher.execute(command);
    } catch (error) {
      console.error('[SceneTreeNode] Failed to toggle lock:', error);
    }
  }

  private validateDropTarget(
    draggedNodeId: string,
    targetNodeId: string,
    position: 'top' | 'inside' | 'bottom' | null
  ): boolean {
    if (!position) return true;

    const container = ServiceContainer.getInstance();
    const sceneManager = container.getService<SceneManager>(
      container.getOrCreateToken(SceneManager)
    );

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) return true;

    const sceneGraph = sceneManager.getSceneGraph(activeSceneId);
    if (!sceneGraph) return true;

    const mappedPosition: 'inside' | 'before' | 'after' =
      position === 'inside' ? 'inside' : position === 'top' ? 'before' : 'after';

    return canDropNode(draggedNodeId, targetNodeId, sceneGraph, mappedPosition);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-scene-tree-node': SceneTreeNodeComponent;
  }
}
