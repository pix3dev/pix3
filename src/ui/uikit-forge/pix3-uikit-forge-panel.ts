import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';
import { IconService, IconSize } from '@/services/editor/IconService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { CreatePrefabInstanceCommand } from '@/features/scene/CreatePrefabInstanceCommand';
import {
  ApplyUiKitSkinCommand,
  DEFAULT_UIKIT_COLOR_ROLE,
} from '@/features/uikit/ApplyUiKitSkinCommand';
import { SKINNABLE_NODE_TYPES } from '@/features/uikit/ApplyUiKitSkinOperation';
import { UiKitThemeService } from '@/services/uikit-editor/UiKitThemeService';
import { UiKitProjectWriter, type KitManifest } from '@/services/uikit-editor/UiKitProjectWriter';
import { UiKitPrefabBuilder } from '@/services/uikit-editor/UiKitPrefabBuilder';
import {
  CYR_FONTS,
  DEFAULT_THEME,
  FONTS,
  PALETTE,
  TABS,
  buildTab,
  faceSpecs,
  normalizeTheme,
  runBuild,
  type ForgeComponent,
  type ForgeLang,
  type ForgeTheme,
  type PaletteId,
  type TemplateId,
} from '@/services/uikit';
import { SceneManager } from '@pix3/runtime';
import './pix3-uikit-forge-panel.ts.css';

/**
 * One row of the controls column.
 *
 * The list below is generated from this rather than hand-written markup so that adding a knob to
 * `ForgeTheme` is one entry, and so the column provably covers every key — a control that exists
 * only in the standalone page is exactly how the two hosts drift apart (plan §7).
 */
type ControlDef =
  | { kind: 'range'; key: NumericThemeKey; label: string; min: number; max: number; step?: number }
  | { kind: 'check'; key: NumericThemeKey; label: string }
  | {
      kind: 'select';
      key: EnumThemeKey;
      label: string;
      options: readonly { value: string; label: string }[];
    }
  | { kind: 'color'; key: ColorThemeKey; label: string; nullable?: boolean };

type NumericThemeKey = {
  [K in keyof ForgeTheme]: ForgeTheme[K] extends number ? K : never;
}[keyof ForgeTheme];
type ColorThemeKey = 'darkTone' | 'labelEdge';
type EnumThemeKey = 'glossType' | 'txtColor' | 'font' | 'fontCyr' | 'shadowMode';

interface ControlGroup {
  title: string;
  controls: readonly ControlDef[];
}

const CONTROL_GROUPS: readonly ControlGroup[] = [
  {
    title: 'Palette shift',
    controls: [
      { kind: 'range', key: 'hue', label: 'Hue', min: -180, max: 180 },
      { kind: 'range', key: 'sat', label: 'Saturation', min: -40, max: 40 },
      { kind: 'range', key: 'light', label: 'Lightness', min: -30, max: 30 },
    ],
  },
  {
    title: 'Geometry',
    controls: [
      { kind: 'range', key: 'radius', label: 'Corner radius', min: 0, max: 40, step: 0.5 },
      { kind: 'range', key: 'bevel', label: 'Bevel lip', min: 0, max: 20, step: 0.5 },
      { kind: 'range', key: 'outline', label: 'Outline', min: 0, max: 6, step: 0.5 },
      { kind: 'range', key: 'skew', label: 'Skew', min: 0, max: 15, step: 0.5 },
      { kind: 'range', key: 'puffy', label: 'Pillow', min: 0, max: 20, step: 0.5 },
      { kind: 'range', key: 'pad', label: 'Preview padding', min: 0, max: 64 },
    ],
  },
  {
    title: 'Surface',
    controls: [
      { kind: 'check', key: 'glossOn', label: 'Gloss' },
      {
        kind: 'select',
        key: 'glossType',
        label: 'Gloss shape',
        options: [
          { value: 'strip', label: 'Strip' },
          { value: 'dome', label: 'Dome' },
          { value: 'corner', label: 'Corner' },
        ],
      },
      { kind: 'range', key: 'glossH', label: 'Gloss height %', min: 0, max: 100 },
      { kind: 'range', key: 'glossA', label: 'Gloss alpha %', min: 0, max: 60 },
      { kind: 'check', key: 'gradOn', label: 'Gradient' },
      { kind: 'range', key: 'gradK', label: 'Gradient strength', min: 0, max: 30 },
    ],
  },
  {
    title: 'Shadow',
    controls: [
      {
        kind: 'select',
        key: 'shadowMode',
        label: 'Mode',
        options: [
          { value: '0', label: 'Off' },
          { value: '1', label: 'Hard slab' },
          { value: '2', label: 'Blurred' },
        ],
      },
      { kind: 'range', key: 'shadowDx', label: 'Offset X', min: -10, max: 10, step: 0.5 },
      { kind: 'range', key: 'shadowDy', label: 'Offset Y', min: -10, max: 20, step: 0.5 },
      { kind: 'range', key: 'shadowBlur', label: 'Blur', min: 0, max: 20, step: 0.5 },
      { kind: 'range', key: 'shadowA', label: 'Alpha %', min: 0, max: 100 },
    ],
  },
  {
    title: 'Type',
    controls: [
      {
        kind: 'select',
        key: 'font',
        label: 'Family',
        options: FONTS.map(f => ({ value: f.f, label: f.f })),
      },
      {
        kind: 'select',
        key: 'fontCyr',
        label: 'Cyrillic family',
        options: CYR_FONTS.map(f => ({ value: f.f, label: f.f })),
      },
      { kind: 'range', key: 'txtOut', label: 'Outline', min: 0, max: 8, step: 0.5 },
      { kind: 'range', key: 'txtDrop', label: 'Drop', min: 0, max: 8, step: 0.5 },
      { kind: 'range', key: 'track', label: 'Tracking', min: -2, max: 8, step: 0.5 },
      {
        kind: 'select',
        key: 'txtColor',
        label: 'Ink',
        options: [
          { value: 'white', label: 'White' },
          { value: 'dark', label: 'Dark' },
          { value: 'auto', label: 'Auto' },
        ],
      },
    ],
  },
  {
    title: 'Tones',
    controls: [
      { kind: 'color', key: 'darkTone', label: 'Dark tone' },
      { kind: 'color', key: 'labelEdge', label: 'Caption edge', nullable: true },
    ],
  },
];

type ActionState = 'idle' | 'busy' | 'ok' | 'error';

/** Families already asked of Google Fonts, so a repaint does not re-append a <link>. */
const injectedFontFamilies = new Set<string>();

/**
 * The editor host of UI Kit Forge (plan §6 Ф6).
 *
 * A VIEW, not a model: the theme lives in {@link UiKitThemeService} (a project document), the
 * generator lives in the host-agnostic `src/services/uikit/` core, baking lives in
 * {@link UiKitProjectWriter}, prefabs in {@link UiKitPrefabBuilder}. Everything this file owns is
 * the arrangement of controls, the preview and the four buttons.
 *
 * The standalone page on `#uikit` is NOT legacy: it is the delivery to the user who does not open
 * the editor at all (plan §1). Both are hosts over the same core.
 */
@customElement('pix3-uikit-forge-panel')
export class UiKitForgePanel extends ComponentBase {
  @inject(IconService)
  private readonly icons!: IconService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(UiKitThemeService)
  private readonly themeService!: UiKitThemeService;

  @inject(UiKitProjectWriter)
  private readonly writer!: UiKitProjectWriter;

  @inject(UiKitPrefabBuilder)
  private readonly prefabBuilder!: UiKitPrefabBuilder;

  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  // Seeded from the defaults rather than the service: field initialisers run before the DI
  // accessors are usable, and `connectedCallback` adopts the service's theme immediately.
  @state() private theme: ForgeTheme = normalizeTheme(DEFAULT_THEME);
  @state() private presetName = '';
  // `lang` is taken by HTMLElement — the caption language needs its own name.
  @state() private captionLang: ForgeLang = 'en';
  @state() private activeTab = 'buttons';
  @state() private colorRole: PaletteId = DEFAULT_UIKIT_COLOR_ROLE;

  @state() private bakeState: ActionState = 'idle';
  @state() private bakeMessage = '';
  @state() private bakeProgress: { done: number; total: number } | null = null;
  @state() private applyMessage = '';
  @state() private prefabMessage = '';
  @state() private lastPrefabPath: string | null = null;
  @state() private manifest: KitManifest | null = null;
  @state() private skinnableSelection = 0;

  private disposeTheme?: () => void;
  private disposeSelection?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.theme = this.themeService.getTheme();
    this.presetName = this.themeService.getPresetName();
    this.captionLang = this.themeService.getLang();

    this.disposeTheme = this.themeService.subscribe(() => {
      this.theme = this.themeService.getTheme();
      this.presetName = this.themeService.getPresetName();
      this.captionLang = this.themeService.getLang();
      this.ensurePreviewFonts();
    });
    this.disposeSelection = subscribe(appState.selection, () => this.recountSelection());
    this.recountSelection();
    this.ensurePreviewFonts();

    void this.themeService.load().then(() => {
      this.theme = this.themeService.getTheme();
      this.ensurePreviewFonts();
    });
    void this.refreshManifest();
  }

  disconnectedCallback(): void {
    this.disposeTheme?.();
    this.disposeSelection?.();
    this.disposeTheme = undefined;
    this.disposeSelection = undefined;
    super.disconnectedCallback();
  }

  // -- preview ---------------------------------------------------------------

  /**
   * Ask Google Fonts for the families the theme draws with.
   *
   * Only the PREVIEW needs this. The baked PNGs go through `rasterizeSvg`, whose blob-URL →
   * `<img>` route is the browser's restricted SVG-as-image mode and refuses to fetch a webfont —
   * which is fine, because the engine lane strips captions entirely and the engine draws them.
   * Inline SVG in the document, which is what the preview is, DOES use the page's fonts.
   *
   * Failures are silent by design: an offline editor should show Arial-shaped previews, not an
   * error banner about a font.
   */
  private ensurePreviewFonts(): void {
    if (typeof document === 'undefined') return;
    let specs: { family: string; weight: number }[];
    try {
      specs = runBuild({ theme: this.theme }, () => faceSpecs());
    } catch {
      return;
    }

    for (const spec of specs) {
      const key = `${spec.family}:${spec.weight}`;
      if (injectedFontFamilies.has(key)) continue;
      injectedFontFamilies.add(key);
      try {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.dataset.pix3UikitFont = key;
        // css2 serves per-subset @font-face blocks with unicode-range, so latin AND cyrillic
        // arrive from one request and the browser fetches only what a caption actually uses.
        link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
          spec.family
        ).replace(/%20/g, '+')}:wght@${spec.weight}&display=swap`;
        document.head.appendChild(link);
      } catch {
        // No network, no <head>, a blocked CDN — the preview simply falls back.
      }
    }
  }

  private get previewComponents(): ForgeComponent[] {
    try {
      return buildTab(this.activeTab, { theme: this.theme, lang: this.captionLang });
    } catch (error) {
      console.error('[UiKitForgePanel] preview build failed', error);
      return [];
    }
  }

  // -- state helpers ---------------------------------------------------------

  private recountSelection(): void {
    const graph = this.sceneManager?.getActiveSceneGraph?.();
    if (!graph) {
      this.skinnableSelection = 0;
      return;
    }
    let count = 0;
    for (const id of appState.selection.nodeIds) {
      const node = graph.nodeMap.get(id);
      if (node && SKINNABLE_NODE_TYPES.includes(node.type)) count += 1;
    }
    this.skinnableSelection = count;
  }

  private async refreshManifest(): Promise<void> {
    this.manifest = await this.writer.readManifest();
  }

  private patchTheme(patch: Partial<ForgeTheme>): void {
    this.themeService.setTheme(patch);
  }

  // -- actions ---------------------------------------------------------------

  private async onSaveKit(): Promise<void> {
    if (this.bakeState === 'busy') return;
    this.bakeState = 'busy';
    this.bakeMessage = '';
    this.bakeProgress = { done: 0, total: 0 };
    try {
      const result = await this.writer.writeKit(this.theme, {
        onProgress: (done, total) => {
          this.bakeProgress = { done, total };
        },
      });
      this.manifest = result.manifest;
      this.bakeState = 'ok';
      this.bakeMessage = `Kit ${result.kitId}: ${Object.keys(result.manifest.parts).length} sprites at ${result.scale}x`;
    } catch (error) {
      this.bakeState = 'error';
      this.bakeMessage = error instanceof Error ? error.message : String(error);
    } finally {
      this.bakeProgress = null;
    }
  }

  private async onApplyToSelection(): Promise<void> {
    this.applyMessage = '';
    const applied = await this.commandDispatcher.execute(
      new ApplyUiKitSkinCommand({
        colorRole: this.colorRole,
        ...(this.manifest ? { manifest: this.manifest } : {}),
      })
    );
    this.applyMessage = applied
      ? `Skinned ${this.skinnableSelection} node${this.skinnableSelection === 1 ? '' : 's'} as ${this.colorRole}`
      : 'Nothing to skin — select a Button2D, Slider2D, Bar2D, Checkbox2D or panel sprite, and bake a kit first.';
  }

  private async onCreatePrefab(templateId: TemplateId): Promise<void> {
    this.prefabMessage = '';
    try {
      const result = await this.prefabBuilder.buildAndWrite(templateId, this.theme, {
        lang: this.captionLang,
        colorRole: 'sky',
        ...(this.manifest ? { manifest: this.manifest } : {}),
      });
      this.lastPrefabPath = result.resourcePath;
      this.prefabMessage = result.warnings.length
        ? `${result.path} — ${result.warnings[0]}`
        : `Wrote ${result.path}`;
    } catch (error) {
      this.lastPrefabPath = null;
      this.prefabMessage = error instanceof Error ? error.message : String(error);
    }
  }

  private async onInstancePrefab(): Promise<void> {
    if (!this.lastPrefabPath) return;
    const created = await this.commandDispatcher.execute(
      new CreatePrefabInstanceCommand({ prefabPath: this.lastPrefabPath })
    );
    this.prefabMessage = created
      ? `Instanced ${this.lastPrefabPath}`
      : 'Could not instance — open a scene first.';
  }

  // -- render ----------------------------------------------------------------

  render() {
    return html`
      <div class="uikit-forge">
        <aside class="uikit-controls">
          <header class="uikit-header">
            <span class="uikit-header-icon">${this.icons.getIcon('layers', IconSize.LARGE)}</span>
            <div>
              <h2>UI Kit</h2>
              <p class="uikit-subtitle">Procedural UI skins</p>
            </div>
          </header>

          <div class="uikit-section">
            <label class="uikit-field">
              <span>Preset</span>
              <select
                .value=${this.presetName}
                @change=${(e: Event) =>
                  this.themeService.applyPreset((e.target as HTMLSelectElement).value)}
              >
                ${this.themeService
                  .listPresets()
                  .map(
                    name =>
                      html`<option value=${name} ?selected=${name === this.presetName}>
                        ${name}
                      </option>`
                  )}
              </select>
            </label>
            <label class="uikit-field">
              <span>Captions</span>
              <select
                .value=${this.captionLang}
                @change=${(e: Event) =>
                  this.themeService.setLang((e.target as HTMLSelectElement).value as ForgeLang)}
              >
                <option value="en">English</option>
                <option value="ru">Русский</option>
              </select>
            </label>
            <div class="uikit-row">
              <button class="uikit-btn" type="button" @click=${() => this.themeService.randomize()}>
                ${this.icons.getIcon('shuffle', IconSize.SMALL)}<span>Randomize</span>
              </button>
              <button class="uikit-btn" type="button" @click=${() => this.themeService.reset()}>
                ${this.icons.getIcon('rotate-ccw', IconSize.SMALL)}<span>Reset</span>
              </button>
            </div>
          </div>

          ${CONTROL_GROUPS.map(group => this.renderGroup(group))} ${this.renderPaletteOverrides()}
        </aside>

        <section class="uikit-preview">
          <nav class="uikit-tabs">
            ${TABS.map(
              tab => html`
                <button
                  type="button"
                  class="uikit-tab ${tab.id === this.activeTab ? 'is-active' : ''}"
                  @click=${() => {
                    this.activeTab = tab.id;
                  }}
                >
                  ${tab.name}
                </button>
              `
            )}
          </nav>
          <div class="uikit-gallery">
            ${this.previewComponents.map(
              component => html`
                <figure class="uikit-cell">
                  <div class="uikit-art">${unsafeHTML(component.svg)}</div>
                  <figcaption>${component.name}</figcaption>
                </figure>
              `
            )}
          </div>
        </section>

        <footer class="uikit-actions">${this.renderActions()}</footer>
      </div>
    `;
  }

  private renderGroup(group: ControlGroup) {
    return html`
      <div class="uikit-section">
        <h3>${group.title}</h3>
        ${group.controls.map(control => this.renderControl(control))}
      </div>
    `;
  }

  private renderControl(control: ControlDef) {
    switch (control.kind) {
      case 'range': {
        const value = this.theme[control.key];
        return html`
          <label class="uikit-field uikit-field-range">
            <span>${control.label}<em>${value}</em></span>
            <input
              type="range"
              min=${control.min}
              max=${control.max}
              step=${control.step ?? 1}
              .value=${String(value)}
              @input=${(e: Event) =>
                this.patchTheme({
                  [control.key]: Number((e.target as HTMLInputElement).value),
                } as Partial<ForgeTheme>)}
            />
          </label>
        `;
      }
      case 'check':
        return html`
          <label class="uikit-field uikit-field-check">
            <input
              type="checkbox"
              .checked=${this.theme[control.key] > 0}
              @change=${(e: Event) =>
                this.patchTheme({
                  [control.key]: (e.target as HTMLInputElement).checked ? 1 : 0,
                } as Partial<ForgeTheme>)}
            />
            <span>${control.label}</span>
          </label>
        `;
      case 'select':
        return html`
          <label class="uikit-field">
            <span>${control.label}</span>
            <select
              @change=${(e: Event) => {
                const raw = (e.target as HTMLSelectElement).value;
                this.patchTheme({
                  [control.key]: control.key === 'shadowMode' ? Number(raw) : raw,
                } as Partial<ForgeTheme>);
              }}
            >
              ${control.options.map(
                option => html`
                  <option
                    value=${option.value}
                    ?selected=${String(this.theme[control.key]) === option.value}
                  >
                    ${option.label}
                  </option>
                `
              )}
            </select>
          </label>
        `;
      case 'color': {
        const raw = this.theme[control.key];
        return html`
          <label class="uikit-field uikit-field-color">
            <span>${control.label}</span>
            <span class="uikit-color-controls">
              <input
                type="color"
                .value=${raw ?? this.theme.darkTone}
                @input=${(e: Event) =>
                  this.patchTheme({
                    [control.key]: (e.target as HTMLInputElement).value,
                  } as Partial<ForgeTheme>)}
              />
              ${control.nullable
                ? html`<button
                    class="uikit-btn uikit-btn-ghost"
                    type="button"
                    title="Fall back to the dark tone"
                    @click=${() =>
                      this.patchTheme({ [control.key]: null } as unknown as Partial<ForgeTheme>)}
                  >
                    ${raw ? 'Clear' : 'Auto'}
                  </button>`
                : null}
            </span>
          </label>
        `;
      }
    }
  }

  /**
   * Per-role absolute colour overrides — the plan's "absolute colours, not deltas" (§4). A
   * project palette pins the roles here; the hue/sat/light sliders stay a convenience on top.
   */
  private renderPaletteOverrides() {
    const overrides = this.theme.palette ?? {};
    return html`
      <div class="uikit-section">
        <h3>Palette overrides</h3>
        <div class="uikit-palette">
          ${PALETTE.map(
            entry => html`
              <label class="uikit-swatch" title=${`${entry.label} — ${entry.role}`}>
                <input
                  type="color"
                  .value=${overrides[entry.id] ?? entry.hex}
                  @input=${(e: Event) =>
                    this.patchTheme({
                      palette: {
                        ...overrides,
                        [entry.id]: (e.target as HTMLInputElement).value,
                      },
                    })}
                />
                <span>${entry.label}</span>
              </label>
            `
          )}
        </div>
        <button
          class="uikit-btn uikit-btn-ghost"
          type="button"
          ?disabled=${!this.theme.palette}
          @click=${() => this.patchTheme({ palette: null })}
        >
          Clear overrides
        </button>
      </div>
    `;
  }

  private renderActions() {
    const hasProject = appState.project.status === 'ready';
    const progress = this.bakeProgress;
    return html`
      <div class="uikit-action-row">
        <button
          class="uikit-btn uikit-btn-primary"
          type="button"
          ?disabled=${!hasProject || this.bakeState === 'busy'}
          @click=${() => void this.onSaveKit()}
        >
          ${this.icons.getIcon('save', IconSize.SMALL)}
          <span
            >${this.bakeState === 'busy'
              ? progress && progress.total
                ? `Baking ${progress.done}/${progress.total}`
                : 'Baking…'
              : 'Save kit to project'}</span
          >
        </button>

        <label class="uikit-field uikit-field-inline">
          <span>Role</span>
          <select
            @change=${(e: Event) => {
              this.colorRole = (e.target as HTMLSelectElement).value as PaletteId;
            }}
          >
            ${PALETTE.map(
              entry => html`
                <option value=${entry.id} ?selected=${entry.id === this.colorRole}>
                  ${entry.label}
                </option>
              `
            )}
          </select>
        </label>

        <button
          class="uikit-btn"
          type="button"
          ?disabled=${!hasProject || this.skinnableSelection === 0}
          @click=${() => void this.onApplyToSelection()}
        >
          ${this.icons.getIcon('droplet', IconSize.SMALL)}
          <span
            >Apply to
            selection${this.skinnableSelection ? ` (${this.skinnableSelection})` : ''}</span
          >
        </button>

        <button
          class="uikit-btn"
          type="button"
          ?disabled=${!hasProject}
          @click=${() => void this.onCreatePrefab('dialog')}
        >
          ${this.icons.getIcon('copy', IconSize.SMALL)}<span>Dialog prefab</span>
        </button>
        <button
          class="uikit-btn"
          type="button"
          ?disabled=${!hasProject}
          @click=${() => void this.onCreatePrefab('settings')}
        >
          ${this.icons.getIcon('copy', IconSize.SMALL)}<span>Settings prefab</span>
        </button>
        <button
          class="uikit-btn"
          type="button"
          ?disabled=${!this.lastPrefabPath}
          @click=${() => void this.onInstancePrefab()}
        >
          ${this.icons.getIcon('plus-square', IconSize.SMALL)}<span>Instance into scene</span>
        </button>
      </div>

      <div class="uikit-status">
        ${this.manifest
          ? html`<span class="uikit-chip"
              >kit ${this.manifest.kitId} · ${this.manifest.scale}x</span
            >`
          : html`<span class="uikit-chip uikit-chip-dim">no kit baked yet</span>`}
        ${this.bakeMessage
          ? html`<span
              class=${this.bakeState === 'error' ? 'uikit-msg is-error' : 'uikit-msg is-ok'}
              >${this.bakeMessage}</span
            >`
          : null}
        ${this.applyMessage ? html`<span class="uikit-msg">${this.applyMessage}</span>` : null}
        ${this.prefabMessage ? html`<span class="uikit-msg">${this.prefabMessage}</span>` : null}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-uikit-forge-panel': UiKitForgePanel;
  }
}
