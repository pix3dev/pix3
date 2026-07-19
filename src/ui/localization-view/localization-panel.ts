import { subscribe } from 'valtio/vanilla';
import { repeat } from 'lit/directives/repeat.js';

import { ComponentBase, customElement, html, state, inject } from '@/fw';
import { appState } from '@/state';
import { IconService, IconSize } from '@/services/IconService';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import {
  LocalizationEditorService,
  type LocaleTableSection,
} from '@/services/LocalizationEditorService';
import { UpdateLocaleEntryCommand } from '@/features/localization/UpdateLocaleEntryCommand';
import { RemoveLocalizationKeyCommand } from '@/features/localization/RemoveLocalizationKeyCommand';
import { AddLocaleCommand } from '@/features/localization/AddLocaleCommand';
import { RemoveLocaleCommand } from '@/features/localization/RemoveLocaleCommand';
import { SetPreviewLocaleCommand } from '@/features/localization/SetPreviewLocaleCommand';

import '../shared/pix3-panel';
import './localization-panel.ts.css';

/**
 * Localization authoring panel. Rows = keys, columns = the default (template)
 * locale plus one selected target locale, over two section tabs: **Strings**
 * (translations) and **Sprites** (localized `res://` texture paths keyed for
 * `Sprite2D.textureKey` / Button2D state keys). Every cell edit dispatches an
 * `UpdateLocaleEntryCommand` (undoable, write-through); locale add/remove and key
 * removal go through their own commands. Reads come straight off
 * {@link LocalizationEditorService}; it re-reads whenever `appState.localization.revision`
 * bumps (any table edit) so external edits / undo/redo stay reflected.
 */
@customElement('pix3-localization-panel')
export class LocalizationPanel extends ComponentBase {
  @inject(IconService)
  private readonly icons!: IconService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(LocalizationEditorService)
  private readonly service!: LocalizationEditorService;

  /** Bumped from appState.localization.revision to force a re-read/re-render. */
  @state()
  private revision = 0;

  @state()
  private filter = '';

  @state()
  private missingOnly = false;

  /** Which table section is being edited: UI strings or localized sprite paths. */
  @state()
  private section: LocaleTableSection = 'strings';

  /** The non-default locale shown in the second (editable) column. */
  @state()
  private targetLocale = '';

  @state()
  private addingLocale = false;

  @state()
  private addingKey = false;

  private disposeSub?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.syncTargetLocale();
    this.disposeSub = subscribe(appState.localization, () => {
      this.revision = appState.localization.revision;
      this.syncTargetLocale();
    });
  }

  disconnectedCallback(): void {
    this.disposeSub?.();
    this.disposeSub = undefined;
    super.disconnectedCallback();
  }

  /** Keep the target column valid as locales are added/removed. */
  private syncTargetLocale(): void {
    const others = this.otherLocales();
    if (this.targetLocale && others.includes(this.targetLocale)) return;
    this.targetLocale = others[0] ?? '';
  }

  private otherLocales(): string[] {
    const def = this.service.getDefaultLocale();
    return this.service.getLocales().filter(l => l !== def);
  }

  // ---- event handlers ------------------------------------------------------

  private onFilterInput(event: Event): void {
    this.filter = (event.target as HTMLInputElement).value.trim().toLowerCase();
  }

  private onTargetChange(event: Event): void {
    this.targetLocale = (event.target as HTMLSelectElement).value;
  }

  private onPreviewChange(event: Event): void {
    const locale = (event.target as HTMLSelectElement).value;
    void this.commandDispatcher.execute(new SetPreviewLocaleCommand({ locale }));
  }

  private onCellChange(locale: string, key: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    void this.commandDispatcher.execute(
      new UpdateLocaleEntryCommand({ locale, key, value, section: this.section })
    );
  }

  private onRemoveKey(key: string): void {
    void this.commandDispatcher.execute(
      new RemoveLocalizationKeyCommand({ key, section: this.section })
    );
  }

  private onRemoveLocale(locale: string): void {
    void this.commandDispatcher.execute(new RemoveLocaleCommand({ locale }));
  }

  private commitAddLocale(event: Event): void {
    const input = event.target as HTMLInputElement;
    const locale = input.value.trim().toLowerCase();
    this.addingLocale = false;
    if (locale) {
      void this.commandDispatcher.execute(new AddLocaleCommand({ locale }));
    }
  }

  /** Add a key = create an (empty) entry in the default locale; the row then appears. */
  private commitAddKey(event: Event): void {
    const input = event.target as HTMLInputElement;
    const key = input.value.trim();
    this.addingKey = false;
    if (key) {
      const def = this.service.getDefaultLocale();
      // Seed with the key itself as a starter value so the row materializes; the
      // author immediately overwrites it. (An empty value would delete the entry.)
      void this.commandDispatcher.execute(
        new UpdateLocaleEntryCommand({ locale: def, key, value: key, section: this.section })
      );
    }
  }

  private onEditKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      (event.target as HTMLInputElement).blur();
    } else if (event.key === 'Escape') {
      this.addingLocale = false;
      this.addingKey = false;
    }
  }

  // ---- rendering -----------------------------------------------------------

  private visibleKeys(): string[] {
    const def = this.service.getDefaultLocale();
    let keys = this.service.getAllKeys(this.section);
    if (this.missingOnly && this.targetLocale) {
      const missing = new Set(this.service.getMissing(this.targetLocale, this.section));
      keys = keys.filter(k => missing.has(k));
    }
    if (this.filter) {
      const f = this.filter;
      keys = keys.filter(
        k =>
          k.toLowerCase().includes(f) ||
          this.service.getEntry(def, k, this.section).toLowerCase().includes(f) ||
          (this.targetLocale
            ? this.service.getEntry(this.targetLocale, k, this.section).toLowerCase().includes(f)
            : false)
      );
    }
    return keys;
  }

  protected render() {
    // Touch revision so Lit re-renders on table edits (value read, not used).
    void this.revision;

    if (!this.service.isActive() && this.service.getLocales().length === 0) {
      return html`
        <pix3-panel panel-description="Author locale tables and translations.">
          <div class="loc-empty">
            <p>No locales in this project yet.</p>
            ${this.renderAddLocale('loc-empty-add')}
          </div>
        </pix3-panel>
      `;
    }

    return html`
      <pix3-panel
        panel-description="Author locale tables and translations."
        actions-label="Localization controls"
      >
        <div slot="toolbar" class="loc-toolbar">${this.renderToolbar()}</div>
        <div class="loc-body">${this.renderGrid()}</div>
      </pix3-panel>
    `;
  }

  private renderToolbar() {
    const def = this.service.getDefaultLocale();
    const others = this.otherLocales();
    const preview = this.service.getPreviewLocale();
    const locales = this.service.getLocales();

    return html`
      <div class="loc-toolbar-row">
        <div class="loc-section-tabs" role="tablist" aria-label="Table section">
          <button
            type="button"
            class="loc-btn loc-tab ${this.section === 'strings' ? 'is-active' : ''}"
            role="tab"
            aria-selected=${this.section === 'strings'}
            @click=${() => (this.section = 'strings')}
            title="Translated UI strings"
          >
            ${this.icons.getIcon('type', IconSize.SMALL)} Strings
          </button>
          <button
            type="button"
            class="loc-btn loc-tab ${this.section === 'sprites' ? 'is-active' : ''}"
            role="tab"
            aria-selected=${this.section === 'sprites'}
            @click=${() => (this.section = 'sprites')}
            title="Localized sprite texture paths (used by Sprite2D/Button2D texture keys)"
          >
            ${this.icons.getIcon('image', IconSize.SMALL)} Sprites
          </button>
        </div>
        <input
          class="loc-filter"
          type="text"
          placeholder="Filter key / value"
          .value=${this.filter}
          @input=${this.onFilterInput}
          aria-label="Filter translations"
        />
        <button
          type="button"
          class="loc-btn ${this.missingOnly ? 'is-active' : ''}"
          @click=${() => (this.missingOnly = !this.missingOnly)}
          title="Show only keys missing in the target locale"
          aria-pressed=${this.missingOnly}
        >
          ${this.icons.getIcon('alert-triangle', IconSize.SMALL)} Missing
        </button>
        <button
          type="button"
          class="loc-btn"
          @click=${() => (this.addingKey = true)}
          title="Add a new translation key"
        >
          ${this.icons.getIcon('plus', IconSize.SMALL)} Key
        </button>
      </div>

      <div class="loc-toolbar-row">
        <label class="loc-select-group">
          <span class="loc-select-label">Target</span>
          <select
            class="loc-select"
            .value=${this.targetLocale}
            @change=${this.onTargetChange}
            aria-label="Target locale column"
            ?disabled=${others.length === 0}
          >
            ${others.length === 0
              ? html`<option value="">— none —</option>`
              : repeat(
                  others,
                  l => l,
                  l =>
                    html`<option value=${l} ?selected=${l === this.targetLocale}>
                      ${this.service.getLocaleDisplayName(l)} (${l})
                    </option>`
                )}
          </select>
        </label>

        <label class="loc-select-group">
          <span class="loc-select-label" title="Locale previewed in the viewport">
            ${this.icons.getIcon('globe', IconSize.SMALL)}
          </span>
          <select
            class="loc-select"
            .value=${preview}
            @change=${this.onPreviewChange}
            aria-label="Preview locale"
          >
            ${repeat(
              locales,
              l => l,
              l =>
                html`<option value=${l} ?selected=${l === preview}>
                  ${this.service.getLocaleDisplayName(l)} (${l})
                </option>`
            )}
          </select>
        </label>

        ${this.addingLocale
          ? this.renderAddLocaleInput()
          : html`<button
              type="button"
              class="loc-btn"
              @click=${() => (this.addingLocale = true)}
              title="Add a locale"
            >
              ${this.icons.getIcon('plus', IconSize.SMALL)} Locale
            </button>`}
        ${this.targetLocale && this.targetLocale !== def
          ? html`<button
              type="button"
              class="loc-btn loc-btn-danger"
              @click=${() => this.onRemoveLocale(this.targetLocale)}
              title="Remove the target locale"
              aria-label="Remove target locale"
            >
              ${this.icons.getIcon('trash-2', IconSize.SMALL)}
            </button>`
          : null}
      </div>
    `;
  }

  private renderAddLocale(cls: string) {
    return this.addingLocale
      ? this.renderAddLocaleInput()
      : html`<button type="button" class="loc-btn ${cls}" @click=${() => (this.addingLocale = true)}>
          ${this.icons.getIcon('plus', IconSize.SMALL)} Add locale
        </button>`;
  }

  private renderAddLocaleInput() {
    return html`<input
      class="loc-add-input"
      type="text"
      placeholder="locale id (e.g. ru)"
      @change=${this.commitAddLocale}
      @keydown=${this.onEditKeydown}
      @blur=${(e: Event) => {
        // Commit on blur too, but only if it wasn't already committed by change.
        if (this.addingLocale) this.commitAddLocale(e);
      }}
      autofocus
      aria-label="New locale id"
    />`;
  }

  private renderGrid() {
    const def = this.service.getDefaultLocale();
    const target = this.targetLocale;
    const keys = this.visibleKeys();
    const missing = target
      ? new Set(this.service.getMissing(target, this.section))
      : new Set<string>();

    return html`
      <div class="loc-grid" role="table">
        <div class="loc-grid-head" role="row">
          <span class="loc-col-key" role="columnheader">Key</span>
          <span class="loc-col-val" role="columnheader">${def || 'default'}</span>
          ${target
            ? html`<span class="loc-col-val" role="columnheader">${target}</span>`
            : html`<span class="loc-col-val loc-col-hint" role="columnheader">add a locale →</span>`}
          <span class="loc-col-actions" role="columnheader"></span>
        </div>

        ${this.addingKey
          ? html`<div class="loc-row loc-row-new" role="row">
              <input
                class="loc-add-input loc-col-key"
                type="text"
                placeholder="new.key.name"
                @change=${this.commitAddKey}
                @keydown=${this.onEditKeydown}
                @blur=${(e: Event) => {
                  if (this.addingKey) this.commitAddKey(e);
                }}
                autofocus
                aria-label="New key name"
              />
              <span class="loc-col-val"></span>
              <span class="loc-col-val"></span>
              <span class="loc-col-actions"></span>
            </div>`
          : null}
        ${keys.length === 0 && !this.addingKey
          ? html`<p class="loc-placeholder">
              ${this.filter || this.missingOnly
                ? 'No matching keys.'
                : this.section === 'sprites'
                  ? 'No sprite keys yet. Add one and point each locale at a res:// texture.'
                  : 'No translation keys yet.'}
            </p>`
          : repeat(
              keys,
              k => k,
              k => this.renderRow(k, def, target, missing.has(k))
            )}
      </div>
    `;
  }

  private renderRow(key: string, def: string, target: string, isMissing: boolean) {
    const valuePlaceholder = this.section === 'sprites' ? 'res://path/to/texture.png' : '';
    return html`
      <div class="loc-row" role="row">
        <span class="loc-col-key" role="cell" title=${key}>${key}</span>
        <input
          class="loc-cell loc-col-val"
          role="cell"
          .value=${this.service.getEntry(def, key, this.section)}
          placeholder=${valuePlaceholder}
          @change=${(e: Event) => this.onCellChange(def, key, e)}
          @keydown=${this.onEditKeydown}
          aria-label=${`${key} in ${def}`}
        />
        ${target
          ? html`<input
              class="loc-cell loc-col-val ${isMissing ? 'is-missing' : ''}"
              role="cell"
              .value=${this.service.getEntry(target, key, this.section)}
              placeholder=${valuePlaceholder}
              @change=${(e: Event) => this.onCellChange(target, key, e)}
              @keydown=${this.onEditKeydown}
              aria-label=${`${key} in ${target}`}
            />`
          : html`<span class="loc-col-val"></span>`}
        <button
          type="button"
          class="loc-row-remove loc-col-actions"
          @click=${() => this.onRemoveKey(key)}
          title="Remove key from all locales"
          aria-label=${`Remove ${key}`}
        >
          ${this.icons.getIcon('trash-2', IconSize.SMALL)}
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-localization-panel': LocalizationPanel;
  }
}
