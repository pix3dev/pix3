import { ComponentBase, customElement, html, property, state, inject } from '@/fw';
import {
  effectSupportsTarget,
  getAllShaderEffectTypes,
  type ShaderEffectTarget,
  type ShaderEffectTypeInfo,
} from '@pix3/runtime';
import { IconService } from '@/services/IconService';
// Reuse the behavior picker's styles (same modal/grid layout).
import './pix3-behavior-picker.ts.css';

@customElement('pix3-effect-picker')
export class EffectPicker extends ComponentBase {
  @inject(IconService)
  private readonly iconService!: IconService;

  @property({ type: String, reflect: true })
  public pickerId: string = '';

  @property({ attribute: false })
  public excludeTypes: string[] = [];

  /**
   * Material family of the host stack. When set, only effects declaring support
   * for it are listed. Undefined lists everything (legacy behavior).
   */
  @property({ attribute: false })
  public target?: ShaderEffectTarget;

  @state()
  private searchQuery: string = '';

  @state()
  private selectedEffectId: string | null = null;

  protected render() {
    const exclude = new Set(this.excludeTypes);
    const query = this.searchQuery.toLowerCase();
    const target = this.target;
    const effects = getAllShaderEffectTypes().filter(
      e => !exclude.has(e.id) && (target === undefined || effectSupportsTarget(e, target))
    );

    const filtered = effects.filter(
      e =>
        e.displayName.toLowerCase().includes(query) ||
        e.description.toLowerCase().includes(query) ||
        e.keywords.some(k => k.toLowerCase().includes(query))
    );

    const grouped = new Map<string, ShaderEffectTypeInfo[]>();
    for (const e of filtered) {
      if (!grouped.has(e.category)) {
        grouped.set(e.category, []);
      }
      grouped.get(e.category)!.push(e);
    }
    const sortedCategories = Array.from(grouped.keys()).sort();
    const selected = effects.find(e => e.id === this.selectedEffectId) ?? null;

    return html`
      <div class="dialog-backdrop" @click=${this.onBackdropClick}>
        <div
          class="dialog-content behavior-picker-content"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <div class="picker-header">
            <div class="picker-header-row">
              <h2 class="dialog-title">Add Effect</h2>
            </div>
            <div class="search-box">
              ${this.iconService.getIcon('search', 14)}
              <input
                type="text"
                placeholder="Search effects..."
                .value=${this.searchQuery}
                @input=${(e: InputEvent) =>
                  (this.searchQuery = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Escape') this.dispatchCancel();
                }}
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
                      ${grouped.get(category)!.map(
                        e => html`
                          <div
                            class="behavior-item ${this.selectedEffectId === e.id
                              ? 'selected'
                              : ''}"
                            @click=${() => (this.selectedEffectId = e.id)}
                            @dblclick=${() => this.dispatchSelect(e)}
                          >
                            <div class="behavior-icon">${this.iconService.getIcon('zap', 18)}</div>
                            <div class="behavior-info">
                              <div class="behavior-name">${e.displayName}</div>
                            </div>
                          </div>
                        `
                      )}
                    </div>
                  </div>
                `
              )}
              ${filtered.length === 0
                ? html`<div class="no-results">
                    No effects found matching "${this.searchQuery}"
                  </div>`
                : ''}
            </div>

            <div class="selected-description-panel">
              ${selected
                ? html`
                    <div class="description-title">${selected.displayName}</div>
                    <div class="description-text">${selected.description}</div>
                  `
                : html`<div class="description-empty">
                    Select an effect to see its description.
                  </div>`}
            </div>
          </div>

          <div class="dialog-actions">
            <button class="btn-secondary" @click=${() => this.dispatchCancel()}>Cancel</button>
            <button
              class="btn-primary"
              ?disabled=${!this.selectedEffectId}
              @click=${() => {
                const e = effects.find(x => x.id === this.selectedEffectId);
                if (e) this.dispatchSelect(e);
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

  private dispatchSelect(effect: ShaderEffectTypeInfo): void {
    this.dispatchEvent(
      new CustomEvent('effect-selected', {
        detail: { pickerId: this.pickerId, effectType: effect.id },
        bubbles: true,
        composed: true,
      })
    );
  }

  private dispatchCancel(): void {
    this.dispatchEvent(
      new CustomEvent('effect-picker-cancelled', {
        detail: { pickerId: this.pickerId },
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-effect-picker': EffectPicker;
  }
}
