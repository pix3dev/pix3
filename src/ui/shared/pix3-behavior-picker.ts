import { ComponentBase, customElement, html, property, state, inject } from '@/fw';
import { ScriptRegistry, type ComponentTypeInfo } from '@pix3/runtime';
import { IconService } from '@/services/editor/IconService';
import { appState } from '@/state';
import { subscribe } from 'valtio/vanilla';
import './pix3-behavior-picker.ts.css';

type ScriptTypeInfo = ComponentTypeInfo;

@customElement('pix3-behavior-picker')
export class BehaviorPicker extends ComponentBase {
  @inject(ScriptRegistry)
  private readonly scriptRegistry!: ScriptRegistry;

  @inject(IconService)
  private readonly iconService!: IconService;

  @property({ type: String, reflect: true })
  public pickerId: string = '';

  @state()
  private searchQuery: string = '';

  @state()
  private selectedScriptId: string | null = null;

  private disposeSubscription?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this.disposeSubscription = subscribe(appState.project, () => {
      this.requestUpdate();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disposeSubscription?.();
  }

  protected render() {
    const scripts: ScriptTypeInfo[] = this.scriptRegistry.getAllComponentTypes();

    const filteredScripts = scripts.filter(
      s =>
        s.displayName.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
        s.description.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
        s.keywords.some(k => k.toLowerCase().includes(this.searchQuery.toLowerCase()))
    );

    const groupedScripts = new Map<string, ScriptTypeInfo[]>();
    for (const s of filteredScripts) {
      if (!groupedScripts.has(s.category)) {
        groupedScripts.set(s.category, []);
      }
      groupedScripts.get(s.category)!.push(s);
    }

    const sortedCategories = Array.from(groupedScripts.keys()).sort();
    const selectedScript = scripts.find(s => s.id === this.selectedScriptId);

    return html`
      <div class="dialog-backdrop" @click=${this.onBackdropClick}>
        <div
          class="dialog-content behavior-picker-content"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <div class="picker-header">
            <div class="picker-header-row">
              <h2 class="dialog-title">Add Component</h2>
              <button
                class="btn-create-new"
                @click=${this.dispatchCreateNew}
                title="Create new script file"
              >
                ${this.iconService.getIcon('plus', 14)} Create New
              </button>
            </div>
            <div class="search-box">
              ${this.iconService.getIcon('search', 14)}
              <input
                type="text"
                placeholder="Search components..."
                .value=${this.searchQuery}
                @input=${(e: InputEvent) =>
                  (this.searchQuery = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Escape') this.dispatchCancel();
                }}
                autofocus
              />
            </div>
          </div>

          <div class="picker-body">
            <div class="behavior-list">
              ${sortedCategories.map(
                category => html`
                  <div class="category-section">
                    <h3 class="category-title">${category}</h3>
                    <div class="category-grid">
                      ${groupedScripts.get(category)!.map(
                        s => html`
                          <div
                            class="behavior-item ${this.selectedScriptId === s.id
                              ? 'selected'
                              : ''}"
                            @click=${() => (this.selectedScriptId = s.id)}
                            @dblclick=${() => this.dispatchSelect(s)}
                          >
                            <div class="behavior-icon">${this.iconService.getIcon('code', 18)}</div>
                            <div class="behavior-info">
                              <div class="behavior-name">${s.displayName}</div>
                            </div>
                          </div>
                        `
                      )}
                    </div>
                  </div>
                `
              )}
              ${filteredScripts.length === 0
                ? html`
                    <div class="no-results">No components found matching "${this.searchQuery}"</div>
                  `
                : ''}
            </div>

            <div class="selected-description-panel">
              ${selectedScript
                ? html`
                    <div class="description-title">${selectedScript.displayName}</div>
                    <div class="description-text">${selectedScript.description}</div>
                  `
                : html`<div class="description-empty">
                    Select a component to see its description.
                  </div>`}
            </div>
          </div>

          <div class="dialog-actions">
            <button class="btn-secondary" @click=${() => this.dispatchCancel()}>Cancel</button>
            <button
              class="btn-primary"
              ?disabled=${!this.selectedScriptId}
              @click=${() => {
                const s = scripts.find(x => x.id === this.selectedScriptId);
                if (s) this.dispatchSelect(s);
              }}
            >
              Add
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private onBackdropClick(): void {
    this.dispatchCancel();
  }

  private dispatchSelect(script: ScriptTypeInfo): void {
    this.dispatchEvent(
      new CustomEvent('component-selected', {
        detail: { pickerId: this.pickerId, component: script },
        bubbles: true,
        composed: true,
      })
    );
  }

  private dispatchCancel(): void {
    this.dispatchEvent(
      new CustomEvent('component-picker-cancelled', {
        detail: { pickerId: this.pickerId },
        bubbles: true,
        composed: true,
      })
    );
  }

  private dispatchCreateNew(): void {
    this.dispatchEvent(
      new CustomEvent('component-picker-create-new', {
        detail: { pickerId: this.pickerId },
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-behavior-picker': BehaviorPicker;
  }
}
