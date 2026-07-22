import { ComponentBase, customElement, html, inject, property, state, css, unsafeCSS } from '@/fw';
import { ifDefined } from 'lit/directives/if-defined.js';
import { FocusRingService } from '@/services/editor/FocusRingService';
import styles from './pix3-panel.ts.css?raw';

let panelCounter = 0;

@customElement('pix3-panel')
export class Pix3Panel extends ComponentBase {
  static useShadowDom = true;

  static styles = css`
    ${unsafeCSS(styles)}
  `;

  @property({ attribute: 'panel-title' })
  title = '';

  @property({ attribute: 'panel-description' })
  description = '';

  @property({ attribute: 'panel-role' })
  panelRole: 'region' | 'form' | 'presentation' = 'region';

  @property({ attribute: 'actions-label' })
  actionsLabel = 'Panel actions';

  @property({ attribute: 'accent', reflect: true })
  accent: 'default' | 'primary' | 'warning' = 'default';

  @state()
  private hasBodyContent = false;

  @inject(FocusRingService)
  private readonly focusRing!: FocusRingService;

  private cleanupActions?: () => void;
  private readonly instanceId = panelCounter++;

  private onSlotChange(): void {
    const rootEl = this.renderRoot as ShadowRoot | HTMLElement;
    const slot = rootEl.querySelector('slot:not([name])') as HTMLSlotElement | null;
    if (!slot) {
      this.hasBodyContent = false;
      return;
    }
    const nodes = slot.assignedNodes({ flatten: true }).filter((node: Node) => {
      // Filter out whitespace-only text nodes
      return node.nodeType !== Node.TEXT_NODE || (node.textContent?.trim() ?? '').length > 0;
    });
    const newHasBodyContent = nodes.length > 0;

    // Only update state if the value actually changed to avoid unnecessary renders
    if (newHasBodyContent !== this.hasBodyContent) {
      this.hasBodyContent = newHasBodyContent;
    }
  }

  disconnectedCallback(): void {
    this.cleanupActions?.();
    this.cleanupActions = undefined;
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.ensureActionsFocusController();
  }

  private ensureActionsFocusController(): void {
    if (this.cleanupActions) {
      return;
    }

    const root = (this.renderRoot as HTMLElement) ?? this;
    const actionsHost = root.querySelector<HTMLElement>('[data-panel-actions]');
    if (!actionsHost) {
      return;
    }

    this.cleanupActions = this.focusRing.attachRovingFocus(actionsHost, {
      selector: 'pix3-toolbar-button:not([disabled])',
      orientation: 'horizontal',
      focusFirstOnInit: false,
    });
  }

  protected render() {
    const headerId = `pix3-panel-${this.instanceId}-header`;
    const descriptionId = this.description
      ? `pix3-panel-${this.instanceId}-description`
      : undefined;

    const ariaDescribedBy = descriptionId ? descriptionId : undefined;
    const rootEl = this.renderRoot as ShadowRoot | HTMLElement;
    const hasHeader = this.title || Boolean(rootEl?.querySelector?.('[slot="actions"]'));

    return html`
      <section
        class="panel"
        role=${this.panelRole}
        aria-labelledby=${ifDefined(hasHeader ? headerId : undefined)}
        aria-describedby=${ifDefined(ariaDescribedBy)}
      >
        <slot name="toolbar" class="panel__toolbar-slot"></slot>
        ${hasHeader
          ? html`<header id=${headerId} class="panel__header" tabindex="0">
              <div class="panel__heading">
                <span class="panel__title">${this.title}</span>
                <slot name="subtitle" class="panel__subtitle"></slot>
              </div>
              <div
                class="panel__actions"
                data-panel-actions
                role="toolbar"
                aria-label=${this.actionsLabel}
              >
                <slot name="actions"></slot>
              </div>
            </header>`
          : null}
        ${this.description && !this.hasBodyContent
          ? html`<p id=${ifDefined(descriptionId)} class="panel__description">
              ${this.description}
            </p>`
          : null}
        <div class="panel__body">
          <slot @slotchange=${this.onSlotChange.bind(this)}></slot>
        </div>
        <footer class="panel__footer">
          <slot name="footer"></slot>
        </footer>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-panel': Pix3Panel;
  }
}
