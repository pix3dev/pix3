/**
 * pix3-easing-picker — a visual picker for the animation timeline's discrete
 * named easings. Instead of a 23-entry text `<select>` (`sineInOut`…), it shows
 * the CURRENT easing as a mini curve + label, and opens a popover gallery of
 * curve sparklines grouped by family (Godot / easings.net idiom): pick by
 * SHAPE, not by memorizing names.
 *
 * The gallery renderer (`renderEasingGrid`) is exported so it can also be
 * embedded inline in the timeline's key context menu without nesting portals.
 *
 * Light DOM by convention; the popover is moved into a `DropdownPortal` while
 * open, so its styles are declared globally under `.pix3-dropdown-portal`
 * (mirroring the timeline panel's `.atl-menu` pattern).
 */

import { ComponentBase, customElement, html, property, state } from '@/fw';
import type { TemplateResult } from 'lit';
import { EASING_NAMES, type KeyframeEasing } from '@pix3/runtime';
import {
  EASING_BASIC,
  EASING_DIRECTION_COLUMNS,
  EASING_FAMILY_ROWS,
  EASING_FLAT_ORDER,
  easingLabel,
  easingSparklinePath,
  easingTooltip,
  linearGuidePath,
} from '@/ui/animation-timeline/easing-curve';
import { DropdownPortal } from '@/ui/shared/dropdown-portal';
import './pix3-easing-picker.ts.css';

/** A single curve card (button) used by both the popover and the inline grid. */
function renderEasingCard(
  easing: KeyframeEasing,
  selected: boolean,
  onSelect: (easing: KeyframeEasing) => void,
  caption?: string
): TemplateResult {
  const w = 52;
  const h = 30;
  return html`
    <button
      type="button"
      role="option"
      aria-selected=${selected ? 'true' : 'false'}
      class="pix3-easing-card ${selected ? 'pix3-easing-card--selected' : ''}"
      data-easing=${easing}
      title=${easingTooltip(easing)}
      aria-label=${easingTooltip(easing)}
      @click=${() => onSelect(easing)}
    >
      <svg
        class="pix3-easing-card__curve"
        viewBox="0 0 ${w} ${h}"
        width=${w}
        height=${h}
        aria-hidden="true"
      >
        <polyline class="pix3-easing-guide" points=${linearGuidePath(w, h, 5)} />
        <polyline
          class="pix3-easing-stroke"
          points=${easingSparklinePath(easing, w, h, { pad: 5 })}
        />
      </svg>
      ${caption ? html`<span class="pix3-easing-card__caption">${caption}</span>` : null}
    </button>
  `;
}

/**
 * Render the full easing gallery grid: a Basic row (Linear / Step) above In /
 * Out / In-Out column headers, then one row per family.
 */
export function renderEasingGrid(options: {
  value: KeyframeEasing | null;
  onSelect: (easing: KeyframeEasing) => void;
}): TemplateResult {
  const { value, onSelect } = options;
  return html`
    <div class="pix3-easing-grid" role="listbox" aria-label="Easing curve">
      <div class="pix3-easing-row-label">Basic</div>
      ${EASING_BASIC.map(easing =>
        renderEasingCard(easing, easing === value, onSelect, easingLabel(easing))
      )}
      <div class="pix3-easing-card--spacer" aria-hidden="true"></div>

      <div class="pix3-easing-corner"></div>
      ${EASING_DIRECTION_COLUMNS.map(
        col => html`<div class="pix3-easing-col-head">${col.label}</div>`
      )}
      ${EASING_FAMILY_ROWS.map(
        row => html`
          <div class="pix3-easing-row-label">${row.label}</div>
          ${renderEasingCard(row.in, row.in === value, onSelect)}
          ${renderEasingCard(row.out, row.out === value, onSelect)}
          ${renderEasingCard(row.inOut, row.inOut === value, onSelect)}
        `
      )}
    </div>
  `;
}

@customElement('pix3-easing-picker')
export class Pix3EasingPicker extends ComponentBase {
  @property({ attribute: false })
  value: KeyframeEasing | null = null;

  @property({ type: Boolean, reflect: true })
  disabled = false;

  @property({ type: String })
  placeholder = 'Easing';

  @property({ type: String })
  tooltip: string | null = null;

  @state() private open = false;

  private readonly portal = new DropdownPortal({ minWidth: 'max-content' });

  private readonly onWindowPointerDown = (event: PointerEvent): void => {
    if (!this.open) {
      return;
    }
    const target = event.target as Node;
    if (this.portal.contains(target) || this.contains(target)) {
      return;
    }
    this.open = false;
  };

  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (this.open && event.key === 'Escape') {
      event.stopPropagation();
      this.open = false;
      this.focusTrigger();
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('pointerdown', this.onWindowPointerDown, { capture: true });
    window.addEventListener('keydown', this.onWindowKeyDown);
  }

  disconnectedCallback(): void {
    document.removeEventListener('pointerdown', this.onWindowPointerDown, { capture: true });
    window.removeEventListener('keydown', this.onWindowKeyDown);
    this.portal.close();
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    if (!changed.has('open')) {
      return;
    }
    if (this.portal.isOpen()) {
      this.portal.close();
    }
    if (!this.open) {
      return;
    }
    const popover = this.querySelector('.pix3-easing-popover') as HTMLElement | null;
    const trigger = this.querySelector('.pix3-easing-trigger') as HTMLElement | null;
    if (popover && trigger) {
      this.portal.open(trigger, popover);
      // Focus the selected card (or the first) for keyboard operation.
      requestAnimationFrame(() => this.focusCard(this.value));
    }
  }

  private toggle(): void {
    if (this.disabled) {
      return;
    }
    this.open = !this.open;
  }

  private select(easing: KeyframeEasing): void {
    this.open = false;
    this.dispatchEvent(
      new CustomEvent('easing-change', { detail: { easing }, bubbles: true, composed: true })
    );
    this.focusTrigger();
  }

  private focusTrigger(): void {
    (this.querySelector('.pix3-easing-trigger') as HTMLElement | null)?.focus();
  }

  private focusCard(easing: KeyframeEasing | null): void {
    const popover = this.portal.isOpen()
      ? (document.querySelector('.pix3-dropdown-portal .pix3-easing-popover') as HTMLElement | null)
      : (this.querySelector('.pix3-easing-popover') as HTMLElement | null);
    if (!popover) {
      return;
    }
    const selector = easing ? `.pix3-easing-card[data-easing="${easing}"]` : '.pix3-easing-card';
    const card =
      (popover.querySelector(selector) as HTMLElement | null) ??
      (popover.querySelector('.pix3-easing-card') as HTMLElement | null);
    card?.focus();
  }

  /** Arrow-key navigation across the flat easing order (Left/Right ±1, Up/Down ±3). */
  private onGridKeyDown(event: KeyboardEvent): void {
    const step =
      event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowDown'
            ? 3
            : event.key === 'ArrowUp'
              ? -3
              : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const focused = (event.target as HTMLElement).closest(
      '.pix3-easing-card'
    ) as HTMLElement | null;
    const current = focused?.dataset.easing as KeyframeEasing | undefined;
    const index = current ? EASING_FLAT_ORDER.indexOf(current) : 0;
    const next = Math.min(Math.max(0, index + step), EASING_FLAT_ORDER.length - 1);
    this.focusCard(EASING_FLAT_ORDER[next]);
  }

  protected render() {
    const value = this.value;
    const label = value ? easingLabel(value) : this.placeholder;
    const w = 30;
    const h = 16;
    return html`
      <button
        type="button"
        class="pix3-easing-trigger ${value ? '' : 'pix3-easing-trigger--placeholder'}"
        aria-haspopup="listbox"
        aria-expanded=${this.open ? 'true' : 'false'}
        ?disabled=${this.disabled}
        title=${this.tooltip ?? 'Easing'}
        @click=${() => this.toggle()}
      >
        ${value
          ? html`<svg
              class="pix3-easing-trigger__curve"
              viewBox="0 0 ${w} ${h}"
              width=${w}
              height=${h}
              aria-hidden="true"
            >
              <polyline
                class="pix3-easing-stroke"
                points=${easingSparklinePath(value, w, h, { pad: 3, samples: 24 })}
              />
            </svg>`
          : null}
        <span class="pix3-easing-trigger__label">${label}</span>
      </button>
      <div
        class="pix3-easing-popover"
        role="dialog"
        aria-label="Choose easing"
        @keydown=${(e: KeyboardEvent) => this.onGridKeyDown(e)}
        @pointerdown=${(e: Event) => e.stopPropagation()}
      >
        ${EASING_NAMES.length > 0
          ? renderEasingGrid({ value, onSelect: e => this.select(e) })
          : null}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-easing-picker': Pix3EasingPicker;
  }
}
