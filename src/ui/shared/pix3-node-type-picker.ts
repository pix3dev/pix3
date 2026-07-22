import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { IconService } from '@/services/editor/IconService';
import { NodeRegistry, type NodeTypeInfo } from '@/services/scene/NodeRegistry';
import './pix3-node-type-picker.ts.css';

interface NodeTypeGroup {
  label: string;
  items: NodeTypeInfo[];
}

@customElement('pix3-node-type-picker')
export class Pix3NodeTypePicker extends ComponentBase {
  @inject(NodeRegistry)
  private readonly nodeRegistry!: NodeRegistry;

  @inject(IconService)
  private readonly iconService!: IconService;

  @state()
  private searchQuery = '';

  @state()
  private selectedNodeTypeId: string | null = null;

  @property({ type: String, reflect: true })
  public pickerId: string = '';

  protected render() {
    const allTypes = this.nodeRegistry.getAllNodeTypes();
    const filteredTypes = this.searchQuery.trim().length
      ? this.nodeRegistry.searchNodeTypes(this.searchQuery)
      : allTypes;
    const groupedTypes = this.groupNodeTypes(filteredTypes);
    const selectedNodeType = filteredTypes.find(
      nodeType => nodeType.id === this.selectedNodeTypeId
    );

    return html`
      <div class="dialog-backdrop" @click=${this.onBackdropClick}>
        <div
          class="dialog-content node-type-picker-content"
          role="dialog"
          aria-modal="true"
          aria-label="Create node"
          @click=${(event: Event) => event.stopPropagation()}
          @keydown=${this.onDialogKeyDown}
        >
          <div class="picker-header">
            <h2 class="dialog-title">Create Node</h2>
            <div class="search-box">
              ${this.iconService.getIcon('search', 14)}
              <input
                type="text"
                placeholder="Search node types..."
                .value=${this.searchQuery}
                @input=${this.onSearchInput}
                autofocus
              />
            </div>
          </div>

          <div class="picker-body">
            <div class="node-type-list" role="listbox" aria-label="Available node types">
              ${groupedTypes.map(
                group => html`
                  <div class="category-section">
                    <h3 class="category-title">${group.label}</h3>
                    <div class="category-grid">
                      ${group.items.map(nodeType => this.renderNodeTypeItem(nodeType))}
                    </div>
                  </div>
                `
              )}
              ${filteredTypes.length === 0
                ? html`<div class="no-results">No node types found for "${this.searchQuery}".</div>`
                : null}
            </div>

            <div class="selected-description-panel">
              ${selectedNodeType
                ? html`
                    <div class="description-title">${selectedNodeType.displayName}</div>
                    <div class="description-text">${selectedNodeType.description}</div>
                  `
                : html`<div class="description-empty">
                    Select a node type to see its description.
                  </div>`}
            </div>
          </div>

          <div class="dialog-actions">
            <button class="btn-secondary" @click=${this.dispatchCancel}>Cancel</button>
            <button
              class="btn-primary"
              ?disabled=${!this.selectedNodeTypeId}
              @click=${this.dispatchSelectedNodeType}
            >
              Create
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderNodeTypeItem(nodeType: NodeTypeInfo) {
    const isSelected = this.selectedNodeTypeId === nodeType.id;
    return html`
      <button
        class="node-type-item ${isSelected ? 'selected' : ''}"
        role="option"
        aria-selected=${String(isSelected)}
        @click=${() => {
          this.selectedNodeTypeId = nodeType.id;
        }}
        @dblclick=${() => {
          this.dispatchNodeTypeSelected(nodeType.id);
        }}
      >
        <span class="node-type-icon" style=${`color: ${nodeType.color};`}>
          ${this.iconService.getIcon(nodeType.icon, 18)}
        </span>
        <span class="node-type-name">${nodeType.displayName}</span>
      </button>
    `;
  }

  private groupNodeTypes(nodeTypes: NodeTypeInfo[]): NodeTypeGroup[] {
    const groups: NodeTypeGroup[] = [];
    const twoD = nodeTypes.filter(nodeType => nodeType.category === '2D');
    const twoDNonUi = twoD.filter(nodeType => nodeType.subcategory !== 'UI');
    const twoDUi = twoD.filter(nodeType => nodeType.subcategory === 'UI');
    const threeD = nodeTypes.filter(nodeType => nodeType.category === '3D');
    const audio = nodeTypes.filter(nodeType => nodeType.category === 'Audio');

    if (twoDNonUi.length > 0) {
      groups.push({ label: '2D Nodes', items: twoDNonUi });
    }
    if (twoDUi.length > 0) {
      groups.push({ label: 'UI Controls', items: twoDUi });
    }
    if (threeD.length > 0) {
      groups.push({ label: '3D Nodes', items: threeD });
    }
    if (audio.length > 0) {
      groups.push({ label: 'Audio Nodes', items: audio });
    }

    return groups;
  }

  private onSearchInput(event: InputEvent): void {
    const query = (event.target as HTMLInputElement).value;
    this.searchQuery = query;
    const filteredTypes = this.nodeRegistry.searchNodeTypes(query);
    if (
      this.selectedNodeTypeId &&
      !filteredTypes.some(nodeType => nodeType.id === this.selectedNodeTypeId)
    ) {
      this.selectedNodeTypeId = null;
    }
  }

  private onDialogKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.dispatchCancel();
      return;
    }

    if (event.key === 'Enter' && this.selectedNodeTypeId) {
      event.preventDefault();
      this.dispatchNodeTypeSelected(this.selectedNodeTypeId);
    }
  }

  private onBackdropClick(): void {
    this.dispatchCancel();
  }

  private dispatchSelectedNodeType = (): void => {
    if (!this.selectedNodeTypeId) {
      return;
    }

    this.dispatchNodeTypeSelected(this.selectedNodeTypeId);
  };

  private dispatchNodeTypeSelected(nodeTypeId: string): void {
    this.dispatchEvent(
      new CustomEvent('node-type-selected', {
        detail: { pickerId: this.pickerId, nodeTypeId },
        bubbles: true,
        composed: true,
      })
    );
  }

  private dispatchCancel = (): void => {
    this.dispatchEvent(
      new CustomEvent('node-type-picker-cancelled', {
        detail: { pickerId: this.pickerId },
        bubbles: true,
        composed: true,
      })
    );
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-node-type-picker': Pix3NodeTypePicker;
  }
}
