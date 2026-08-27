import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { appState } from '@/state';
import {
  EditorSettingsService,
  type EditorSettingsTab,
} from '@/services/editor/EditorSettingsService';
import { OperationService } from '@/services/core/OperationService';
import { UpdateEditorSettingsOperation } from '@/features/editor/UpdateEditorSettingsOperation';
import { AiImageSettingsService } from '@/services/image-gen/AiImageSettingsService';
import { ImageGenProviderRegistry } from '@/services/image-gen/ImageGenProviderRegistry';
import { modelPickerLabel } from '@/services/image-gen/ImageGenTypes';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import {
  SOUL_PRESETS,
  CUSTOM_SOUL_ID,
  CUSTOM_SOUL_AVATAR,
  type AgentSoul,
} from '@/services/agent/AgentSouls';
import { AgentAdvisorService } from '@/services/agent/AgentAdvisorService';
import { AgentVisionService } from '@/services/agent/AgentVisionService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import { BridgeConnectionService } from '@/services/llm/BridgeConnectionService';
import { BRIDGE_TOKEN_SECRET_ID, DEFAULT_BRIDGE_URL } from '@/services/llm/BridgeProviders';
import { formatPricingHint, type LlmModel, type LlmProvider } from '@/services/llm/LlmTypes';
import { IconService, IconSize } from '@/services/editor/IconService';
import {
  StropheAccountService,
  STROPHE_KEY_HELP_URL,
  describeSpendHeadroom,
} from '@/services/strophe/StropheAccountService';
import type { StropheAccount, StropheFamilySummary } from '@/services/strophe/StropheTypes';
import { Model3DGenSettingsService } from '@/services/model-gen/Model3DGenSettingsService';
import { STROPHE_DEFAULT_3D_FAMILY } from '@/services/model-gen/neural/StropheModel3DProvider';
import type { Neural3DProviderId } from '@/services/model-gen/neural/Neural3DProvider';
import type { BgRemovalEngine, BgRemovalQuality } from '@/services/bg-removal/types';
import type { Navigation2DSettings } from '@/state/AppState';
import { CURRENT_EDITOR_VERSION } from '@/version';
import './pix3-editor-settings-dialog.ts.css';

interface SettingsSubtab {
  id: string;
  label: string;
}

/**
 * Public product links surfaced in Settings → About. The editor is often reached through a bare
 * URL someone was handed, so this is the one place in the app that says where Pix3 actually lives.
 */
const PIX3_LINKS: readonly { href: string; icon: string; label: string; hint: string }[] = [
  {
    href: 'https://pix3.dev',
    icon: 'globe',
    label: 'pix3.dev',
    hint: 'Project landing page — what Pix3 is, what it does, and where it is going.',
  },
  {
    href: 'https://editor.pix3.dev',
    icon: 'edit-3',
    label: 'editor.pix3.dev',
    hint: 'The hosted editor. Share this link to open Pix3 in any browser.',
  },
  {
    href: 'https://github.com/pix3dev/pix3',
    icon: 'github',
    label: 'github.com/pix3dev/pix3',
    hint: 'Source, issue tracker and releases.',
  },
];

/**
 * Recognisable API-key shapes, so a provider key pasted into the bridge's pairing-token field is
 * caught at the point of entry instead of surfacing later as an unexplained 401. Prefixes only —
 * matching on length would reject a future bridge token format.
 */
const PROVIDER_KEY_PREFIXES: ReadonlyArray<{ prefix: string; vendor: string }> = [
  { prefix: 'AIza', vendor: 'Google Gemini' },
  { prefix: 'sk-ant-', vendor: 'Anthropic' },
  { prefix: 'csk-', vendor: 'Cerebras' },
  { prefix: 'sk-', vendor: 'OpenAI-style' },
];

/** The vendor whose key format this string matches, or null when it could be a pairing token. */
const recogniseProviderKey = (value: string): string | null =>
  PROVIDER_KEY_PREFIXES.find(entry => value.startsWith(entry.prefix))?.vendor ?? null;

interface SettingsSectionDef {
  id: EditorSettingsTab;
  label: string;
  /** Feather / custom IconService id shown in the sidebar. */
  icon: string;
  /** Optional one-line description shown under the pane title. */
  description?: string;
  /** Sub-tabs rendered at the top of the pane; omit for single-view sections. */
  subtabs?: readonly SettingsSubtab[];
}

/**
 * Godot-style layout: the sidebar lists the main sections; a section with a lot
 * of content splits into sub-tabs rendered at the top of the content pane.
 */
const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { id: 'general', label: 'General', icon: 'sliders' },
  {
    id: 'agent',
    label: 'Agent (LLM)',
    icon: 'message-square',
    description: 'Powers the in-editor Agent chat (Tools → Agent Chat).',
    subtabs: [
      { id: 'model', label: 'Model & Key' },
      { id: 'assistants', label: 'Assistants' },
      { id: 'souls', label: 'Souls' },
    ],
  },
  {
    id: 'images',
    label: 'AI Images',
    icon: 'image',
    description: 'Image generation and background removal used by the Sprite Editor.',
    subtabs: [
      { id: 'generation', label: 'Generation' },
      { id: 'background', label: 'Background Removal' },
    ],
  },
  {
    id: 'strophe',
    label: 'Strophe',
    icon: 'zap',
    description: 'One metered account for image and image→3D generation, paid in Strophe credits.',
  },
  {
    id: 'about',
    label: 'About',
    icon: 'info',
    description: 'Version and where to find Pix3 outside this tab.',
  },
];

@customElement('pix3-editor-settings-dialog')
export class EditorSettingsDialog extends ComponentBase {
  @inject(EditorSettingsService)
  private readonly editorSettingsService!: EditorSettingsService;

  @inject(OperationService)
  private readonly operationService!: OperationService;

  @inject(AiImageSettingsService)
  private readonly aiImageSettings!: AiImageSettingsService;

  @inject(ImageGenProviderRegistry)
  private readonly imageProviders!: ImageGenProviderRegistry;

  @inject(AgentSettingsService)
  private readonly agentSettings!: AgentSettingsService;

  @inject(AgentAdvisorService)
  private readonly agentAdvisor!: AgentAdvisorService;

  @inject(AgentVisionService)
  private readonly agentVision!: AgentVisionService;

  @inject(LlmProviderRegistry)
  private readonly llmProviders!: LlmProviderRegistry;

  @inject(LlmModelCatalogService)
  private readonly llmModelCatalog!: LlmModelCatalogService;

  @inject(BridgeConnectionService)
  private readonly bridge!: BridgeConnectionService;

  @inject(IconService)
  private readonly icons!: IconService;

  @inject(StropheAccountService)
  private readonly strophe!: StropheAccountService;

  @inject(Model3DGenSettingsService)
  private readonly modelLabSettings!: Model3DGenSettingsService;

  @state()
  private activeSection: EditorSettingsTab = 'general';

  /**
   * Keys of the explanations currently expanded. Every note in this dialog lives behind an (i)
   * toggle: the prose is worth keeping (most of it explains a decision the control itself cannot
   * convey) but stacked permanently under every field it buried the controls.
   */
  @state()
  private openNotes: readonly string[] = [];

  /** Keys of the API-key rows currently expanded — a key is entered once and then stays put. */
  @state()
  private openKeys: readonly string[] = [];

  /** Active sub-tab id within the current section (empty when the section has none). */
  @state()
  private activeSubtab = '';

  @state()
  private warnOnUnsavedUnload = true;

  @state()
  private pauseRenderingOnUnfocus = true;

  @state()
  private navigation2D: Navigation2DSettings = {
    panSensitivity: 0.75,
    zoomSensitivity: 0.001,
  };

  @state()
  private aiProviderId = '';

  @state()
  private aiModelId = '';

  @state()
  private aiKeyConfigured = false;

  @state()
  private aiKeyInput = '';

  @state()
  private aiKeyBusy = false;

  @state()
  private aiKeyMessage: string | null = null;

  @state()
  private llmProviderId = '';

  @state()
  private llmModelId = '';

  /** True when the LLM model is a hand-typed custom id (local models on OpenAI-compatible). */
  @state()
  private llmModelCustomMode = false;

  @state()
  private llmBaseUrl = '';

  @state()
  private llmKeyConfigured = false;

  @state()
  private llmKeyInput = '';

  @state()
  private llmKeyBusy = false;

  @state()
  private llmKeyMessage: string | null = null;

  @state()
  private llmModelsBusy = false;

  @state()
  private llmModelsMessage: string | null = null;

  @state()
  private llmDebugMode = false;

  // Souls: the agent's name + personality preset (or a user-authored custom soul).
  @state()
  private soulId = '';

  @state()
  private customSoulName = '';

  @state()
  private customSoulPrompt = '';

  // -- Pix3AgentBridge connection (serves the metered providers) --------------
  @state()
  private bridgeAvailable = false;

  @state()
  private bridgeUrlInput = '';

  @state()
  private bridgeTokenInput = '';

  @state()
  private bridgeTokenConfigured = false;

  @state()
  private bridgeBusy = false;

  @state()
  private bridgeMessage: string | null = null;

  /** Renders {@link bridgeMessage} as a correction rather than a neutral note. */
  @state()
  private bridgeMessageIsWarning = false;

  /** The command text most recently copied to the clipboard (drives the transient "Copied" glyph). */
  @state()
  private copiedCommand: string | null = null;

  // Advisor: a deliberately stronger model the agent consults via `ask_advisor`. Empty provider = off.
  @state()
  private advisorProviderId = '';

  @state()
  private advisorModelId = '';

  @state()
  private advisorKeyConfigured = false;

  @state()
  private advisorKeyInput = '';

  @state()
  private advisorKeyBusy = false;

  /** Human-readable line describing what the advisor currently resolves to (null = off/unusable). */
  @state()
  private advisorStatus: string | null = null;

  // Vision helper: a vision-capable model used by `analyze_image` for text-only main models.
  // Empty provider = auto (first provider with a key + a vision model).
  @state()
  private visionProviderId = '';

  @state()
  private visionModelId = '';

  @state()
  private visionKeyConfigured = false;

  @state()
  private visionKeyInput = '';

  @state()
  private visionKeyBusy = false;

  /** Human-readable line describing what the vision helper currently resolves to (null = none). */
  @state()
  private visionStatus: string | null = null;

  @state()
  private bgEngine: BgRemovalEngine = 'u2net';

  @state()
  private bgQuality: BgRemovalQuality = 'balanced';

  @state()
  private bgFillHoles = true;

  @state()
  private defaultSaveMaxSize = 0;

  // -- Strophe (metered image + image→3D generation) --------------------------
  @state()
  private stropheKeyConfigured = false;

  @state()
  private stropheKeyInput = '';

  @state()
  private stropheBusy = false;

  @state()
  private stropheMessage: string | null = null;

  /** Account snapshot for the connected key (plan, scopes, spend headroom); null = not connected. */
  @state()
  private stropheAccount: StropheAccount | null = null;

  /** Cached image→3D families, for the 3D model picker. */
  @state()
  private strophe3dFamilies: readonly StropheFamilySummary[] = [];

  @state()
  private neural3dProviderId: Neural3DProviderId = 'strophe';

  @state()
  private neural3dFamilyId = STROPHE_DEFAULT_3D_FAMILY;

  connectedCallback(): void {
    super.connectedCallback();
    this.activeSection = this.editorSettingsService.getInitialTab();
    this.activeSubtab = this.defaultSubtab(this.activeSection);
    this.warnOnUnsavedUnload = appState.ui.warnOnUnsavedUnload;
    this.pauseRenderingOnUnfocus = appState.ui.pauseRenderingOnUnfocus;
    this.navigation2D = { ...appState.ui.navigation2D };

    const prefs = this.aiImageSettings.getPreferences();
    this.aiProviderId = prefs.selectedProviderId || this.imageProviders.getDefault()?.id || '';
    this.aiModelId = this.aiImageSettings.getSelectedModelId(this.aiProviderId) ?? '';
    this.bgEngine = prefs.bgRemovalEngine;
    this.bgQuality = prefs.bgRemovalQuality;
    this.bgFillHoles = prefs.bgFillHoles;
    this.defaultSaveMaxSize = prefs.defaultSaveMaxSize;
    void this.refreshAiKeyStatus();

    const agentPrefs = this.agentSettings.getPreferences();
    // The provider that will actually serve a turn (an unpinned pick resolves to the bridge when
    // one is paired), so opening Settings shows what is in use rather than what was last stored.
    this.llmProviderId = this.agentSettings.getSelectedProvider()?.id ?? '';
    this.llmModelId = this.agentSettings.getSelectedModelId(this.llmProviderId) ?? '';
    this.llmBaseUrl = agentPrefs.customBaseUrl;
    this.llmModelCustomMode = this.isLlmModelCustom(this.llmProviderId, this.llmModelId);
    this.llmDebugMode = agentPrefs.debugMode;
    this.soulId = agentPrefs.soulId;
    this.customSoulName = agentPrefs.customSoulName;
    this.customSoulPrompt = agentPrefs.customSoulPrompt;
    void this.refreshLlmKeyStatus();

    this.advisorProviderId = agentPrefs.advisorProviderId;
    this.advisorModelId = agentPrefs.advisorModelId;
    this.visionProviderId = agentPrefs.visionProviderId;
    this.visionModelId = agentPrefs.visionModelId;
    void this.refreshAdvisorKeyStatus();
    void this.refreshVisionKeyStatus();
    void this.refreshAssistantStatus();

    this.bridgeUrlInput = agentPrefs.bridgeUrl;
    this.bridgeAvailable = this.bridge.isAvailable();
    void this.refreshBridgeStatus();

    const modelLabPrefs = this.modelLabSettings.getPreferences();
    this.neural3dProviderId = modelLabPrefs.neural3dProviderId ?? 'strophe';
    this.neural3dFamilyId = modelLabPrefs.neural3dFamilyId ?? STROPHE_DEFAULT_3D_FAMILY;
    void this.refreshStropheStatus();

    // Re-render (and re-derive custom-mode) when a live model catalog lands in the background.
    this.disposeCatalogSubscription = this.llmModelCatalog.subscribe(() => {
      this.llmModelCustomMode = this.isLlmModelCustom(this.llmProviderId, this.llmModelId);
      this.requestUpdate();
    });
    // Re-render when the bridge connects/disconnects (dynamic providers appear/disappear). A probe
    // also fills in the assistant roles from the lane that nominates models for them, so the local
    // copies of those prefs are re-read — otherwise this pane would keep showing "Off"/"Auto" for
    // settings that have just been decided under it.
    this.disposeBridgeSubscription = this.bridge.subscribe(() => {
      this.bridgeAvailable = this.bridge.isAvailable();
      const prefs = this.agentSettings.getPreferences();
      this.advisorProviderId = prefs.advisorProviderId;
      this.advisorModelId = prefs.advisorModelId;
      this.visionProviderId = prefs.visionProviderId;
      this.visionModelId = prefs.visionModelId;
      void this.refreshBridgeStatus();
      void this.refreshAdvisorKeyStatus();
      void this.refreshVisionKeyStatus();
      void this.refreshAssistantStatus();
      this.requestUpdate();
    });
  }

  disconnectedCallback(): void {
    this.disposeCatalogSubscription?.();
    this.disposeCatalogSubscription = undefined;
    this.disposeBridgeSubscription?.();
    this.disposeBridgeSubscription = undefined;
    super.disconnectedCallback();
  }

  private disposeCatalogSubscription?: () => void;
  private disposeBridgeSubscription?: () => void;

  private async refreshBridgeStatus(): Promise<void> {
    this.bridgeTokenConfigured = await this.bridge.hasToken();
    this.requestUpdate();
  }

  /** A stored model not in the provider's (live or static) list is a hand-typed custom id. */
  private isLlmModelCustom(providerId: string, modelId: string): boolean {
    if (!modelId) return false;
    const models = this.llmModelCatalog.getModels(providerId);
    return !models.some(m => m.id === modelId);
  }

  protected render() {
    const section =
      SETTINGS_SECTIONS.find(s => s.id === this.activeSection) ?? SETTINGS_SECTIONS[0];
    return html`
      <div class="dialog-backdrop" @click=${this.onCancel}>
        <div class="dialog-content" @click=${(e: Event) => e.stopPropagation()}>
          <h2 class="dialog-title">Editor Settings</h2>

          <div class="settings-body">
            <nav class="settings-sidebar" role="tablist" aria-orientation="vertical">
              ${SETTINGS_SECTIONS.map(
                item => html`
                  <button
                    class="settings-nav-item ${item.id === this.activeSection ? 'is-active' : ''}"
                    role="tab"
                    aria-selected=${item.id === this.activeSection}
                    @click=${() => this.selectSection(item.id)}
                  >
                    <span class="nav-icon">${this.icons.getIcon(item.icon, IconSize.SMALL)}</span>
                    <span class="nav-label">${item.label}</span>
                  </button>
                `
              )}
            </nav>

            <div class="settings-pane">
              <div class="pane-header">
                <h3 class="pane-title">${section.label}</h3>
                ${section.description
                  ? html`<p class="pane-description">${section.description}</p>`
                  : null}
              </div>
              ${section.subtabs ? this.renderSubtabs(section.subtabs) : null}
              <div class="settings-form">${this.renderSectionContent(section)}</div>
            </div>
          </div>

          <div class="dialog-actions">
            <button class="btn-cancel" @click=${this.onCancel}>Cancel</button>
            <button class="btn-save" @click=${this.onSave}>Save Changes</button>
          </div>
        </div>
      </div>
    `;
  }

  /** An (i) button that reveals the note registered under `key` by {@link renderNote}. */
  private renderInfo(key: string, label = 'Explain this setting') {
    const open = this.openNotes.includes(key);
    return html`<button
      type="button"
      class="info-toggle ${open ? 'is-open' : ''}"
      aria-expanded=${open}
      aria-label=${label}
      title=${label}
      @click=${() => this.toggleNote(key)}
    >
      ${this.icons.getIcon('info', IconSize.SMALL)}
    </button>`;
  }

  /** The note for `key`, rendered only while its {@link renderInfo} toggle is on. */
  private renderNote(key: string, body: unknown) {
    return this.openNotes.includes(key) ? html`<div class="field-note">${body}</div>` : null;
  }

  private toggleNote(key: string): void {
    this.openNotes = this.openNotes.includes(key)
      ? this.openNotes.filter(item => item !== key)
      : [...this.openNotes, key];
  }

  /**
   * The key button that reveals the entry row for `key`. Its own colour carries the status that used
   * to need a permanently-visible "Configured" chip, so a keyed provider still reads at a glance.
   */
  private renderKeyToggle(key: string, configured: boolean, label: string) {
    const open = this.openKeys.includes(key);
    const title = `${label} — ${configured ? 'configured' : 'not set'}`;
    return html`<button
      type="button"
      class="key-toggle ${configured ? 'is-set' : ''} ${open ? 'is-open' : ''}"
      aria-expanded=${open}
      aria-label=${title}
      title=${title}
      @click=${() => this.toggleKey(key)}
    >
      ${this.icons.getIcon('key', IconSize.SMALL)}
    </button>`;
  }

  /** The key entry row for `key`, rendered only while its {@link renderKeyToggle} is on. */
  private renderKeyPanel(key: string, body: unknown) {
    return this.openKeys.includes(key) ? html`<div class="key-panel">${body}</div>` : null;
  }

  private toggleKey(key: string): void {
    this.openKeys = this.openKeys.includes(key)
      ? this.openKeys.filter(item => item !== key)
      : [...this.openKeys, key];
  }

  /**
   * Who holds this provider's credential, which decides what its key button opens:
   * - `subscription` — the bridge's Agent-SDK lane: the pairing token IS the only credential, and it
   *   is set up in the bridge panel, so a second field here would only be a way to overwrite it by
   *   accident;
   * - `bridge` — a metered provider proxied by the bridge, whose real key never enters the browser;
   * - `local` — a key this browser stores itself.
   */
  private keyOwner(
    providerId: string,
    apiKeySecretId: string
  ): 'subscription' | 'bridge' | 'local' {
    if (this.bridge.getEntries().some(e => e.id === providerId && e.kind === 'agent-sdk')) {
      return 'subscription';
    }
    return apiKeySecretId === BRIDGE_TOKEN_SECRET_ID ? 'bridge' : 'local';
  }

  private renderSubtabs(subtabs: readonly SettingsSubtab[]) {
    return html`
      <div class="settings-subtabs" role="tablist">
        ${subtabs.map(
          tab => html`
            <button
              class="settings-subtab ${tab.id === this.activeSubtab ? 'is-active' : ''}"
              role="tab"
              aria-selected=${tab.id === this.activeSubtab}
              @click=${() => this.selectSubtab(tab.id)}
            >
              ${tab.label}
            </button>
          `
        )}
      </div>
    `;
  }

  private renderSectionContent(section: SettingsSectionDef) {
    switch (section.id) {
      case 'general':
        return this.renderGeneralTab();
      case 'agent':
        if (this.activeSubtab === 'assistants') {
          return this.renderAgentAssistantsTab();
        }
        if (this.activeSubtab === 'souls') {
          return this.renderAgentSoulsTab();
        }
        return this.renderAgentModelTab();
      case 'strophe':
        return this.renderStropheTab();
      case 'images':
        return this.activeSubtab === 'background'
          ? this.renderImagesBackgroundTab()
          : this.renderImagesGenerationTab();
      case 'about':
        return this.renderAboutTab();
    }
  }

  private renderAboutTab() {
    return html`
      <div class="settings-field">
        <div class="field-head">
          <span class="field-title">Version</span>
          <span class="resolved-tag">
            Pix3 Editor
            ${CURRENT_EDITOR_VERSION.displayVersion}${CURRENT_EDITOR_VERSION.publishedAt
              ? ` · published ${new Date(CURRENT_EDITOR_VERSION.publishedAt).toLocaleDateString()}`
              : ''}
          </span>
        </div>
      </div>

      <div class="settings-field">
        <div class="about-links">
          ${PIX3_LINKS.map(
            link => html`
              <a class="about-link" href=${link.href} target="_blank" rel="noreferrer">
                <span class="about-link-icon">
                  ${this.icons.getIcon(link.icon, IconSize.MEDIUM)}
                </span>
                <span class="about-link-text">
                  <span class="about-link-label">${link.label}</span>
                  <span class="about-link-hint">${link.hint}</span>
                </span>
                <span class="about-link-external">
                  ${this.icons.getIcon('external-link', IconSize.SMALL)}
                </span>
              </a>
            `
          )}
        </div>
      </div>
    `;
  }

  /** First sub-tab id of a section, or '' when the section has none. */
  private defaultSubtab(sectionId: EditorSettingsTab): string {
    const section = SETTINGS_SECTIONS.find(s => s.id === sectionId);
    return section?.subtabs?.[0]?.id ?? '';
  }

  private selectSection(sectionId: EditorSettingsTab): void {
    this.activeSection = sectionId;
    this.activeSubtab = this.defaultSubtab(sectionId);
  }

  private selectSubtab(subtabId: string): void {
    this.activeSubtab = subtabId;
  }

  private renderGeneralTab() {
    return html`
      <div class="settings-field">
        <div class="field-head">
          <label class="toggle-row">
            <input
              type="checkbox"
              .checked=${this.warnOnUnsavedUnload}
              @change=${this.onWarnToggle}
            />
            <span>Warn me about unsaved changes when leaving the page</span>
          </label>
          ${this.renderInfo('warn-unsaved')}
        </div>
        ${this.renderNote(
          'warn-unsaved',
          'Disable this to skip the browser confirmation dialog on refresh or navigation.'
        )}
      </div>

      <div class="settings-field">
        <div class="field-head">
          <label class="toggle-row">
            <input
              type="checkbox"
              .checked=${this.pauseRenderingOnUnfocus}
              @change=${this.onPauseToggle}
            />
            <span>Pause rendering when window is unfocused</span>
          </label>
          ${this.renderInfo('pause-rendering')}
        </div>
        ${this.renderNote(
          'pause-rendering',
          'Reduces CPU/GPU usage and saves battery when you are working in another window.'
        )}
      </div>

      <div class="settings-section">
        <h3 class="section-title"><span>2D Navigation</span></h3>

        <div class="settings-field">
          <div class="field-head">
            <span class="field-title">
              Pan sensitivity: ${this.navigation2D.panSensitivity.toFixed(2)}
            </span>
            ${this.renderInfo('pan-sensitivity')}
          </div>
          ${this.renderNote(
            'pan-sensitivity',
            'Controls how fast the camera pans with mouse wheel or trackpad gestures.'
          )}
          <input
            type="range"
            aria-label="Pan sensitivity"
            min="0.1"
            max="1.0"
            step="0.05"
            .value=${String(this.navigation2D.panSensitivity)}
            @input=${this.onPanSensitivityChange}
          />
        </div>

        <div class="settings-field">
          <div class="field-head">
            <span class="field-title">
              Zoom sensitivity: ${this.navigation2D.zoomSensitivity.toFixed(4)}
            </span>
            ${this.renderInfo('zoom-sensitivity')}
          </div>
          ${this.renderNote(
            'zoom-sensitivity',
            'Controls how fast the camera zooms with Ctrl+wheel or pinch gestures.'
          )}
          <input
            type="range"
            aria-label="Zoom sensitivity"
            min="0.001"
            max="0.01"
            step="0.0005"
            .value=${String(this.navigation2D.zoomSensitivity)}
            @input=${this.onZoomSensitivityChange}
          />
        </div>
      </div>
    `;
  }

  private renderAgentModelTab() {
    const providers = this.llmProviders.list().filter(provider => !provider.hidden);
    if (providers.length === 0) {
      return html`<div class="field-note">No LLM providers are registered.</div>`;
    }
    const provider = this.llmProviders.get(this.llmProviderId) ?? providers[0];
    const models = provider ? this.llmModelCatalog.getModels(provider.id) : [];
    const canRefreshModels = provider ? this.llmModelCatalog.supportsRefresh(provider.id) : false;
    const helpUrl = provider?.apiKeyHelpUrl;
    const owner = provider ? this.keyOwner(provider.id, provider.apiKeySecretId) : 'local';

    return html`
      ${this.renderBridgePanel()}
      <div class="settings-field">
        <div class="field-head">
          <span class="field-title">Provider &amp; model</span>
          ${this.renderInfo('llm-model')}
        </div>
        ${this.renderNote(
          'llm-model',
          html`Answers every turn in the Agent chat. Bridge-served providers appear here only while
          Pix3AgentBridge is running; Gemini and OpenRouter are called straight from this browser
          with a key you paste.`
        )}
        <div class="inline-row">
          <select class="inline-select" aria-label="Provider" @change=${this.onLlmProviderChange}>
            ${providers.map(
              item =>
                html`<option value=${item.id} ?selected=${item.id === this.llmProviderId}>
                  ${item.label}
                </option>`
            )}
          </select>
          <select class="inline-select" aria-label="Model" @change=${this.onLlmModelSelectChange}>
            ${models.map(model => {
              const hint = formatPricingHint(model.pricing);
              return html`<option
                value=${model.id}
                ?selected=${!this.llmModelCustomMode && model.id === this.llmModelId}
              >
                ${model.label}${hint ? ` · ${hint}` : ''}
              </option>`;
            })}
            ${provider?.requiresBaseUrl
              ? html`<option value="__custom__" ?selected=${this.llmModelCustomMode}>
                  Custom…
                </option>`
              : null}
          </select>
          ${canRefreshModels
            ? html`<button
                class="icon-btn ${this.llmModelsBusy ? 'is-busy' : ''}"
                title="Fetch the provider's current model list"
                aria-label="Refresh model list"
                @click=${this.onRefreshLlmModels}
                ?disabled=${this.llmModelsBusy}
              >
                ${this.icons.getIcon('refresh-cw', IconSize.SMALL)}
              </button>`
            : null}
          ${this.renderKeyToggle(
            'llm',
            owner === 'local' ? this.llmKeyConfigured : this.bridgeTokenConfigured,
            `${provider?.label ?? 'Provider'} API key`
          )}
        </div>
        ${this.llmModelCustomMode
          ? html`<input
              type="text"
              class="llm-custom-model"
              .value=${this.llmModelId}
              @change=${this.onLlmModelChange}
              placeholder="custom model id (e.g. a local model name)"
            />`
          : null}
        ${this.llmModelsMessage
          ? html`<div class="field-note">${this.llmModelsMessage}</div>`
          : null}
        ${this.renderKeyPanel('llm', this.renderLlmKeyBody(provider, owner, helpUrl))}
      </div>

      ${provider?.requiresBaseUrl
        ? html`<div class="settings-field">
            <div class="field-head">
              <span class="field-title">Base URL</span>
              ${this.renderInfo('llm-base-url')}
            </div>
            ${this.renderNote(
              'llm-base-url',
              html`Hosted OpenAI by default; point it at Ollama / LM Studio for local models (enable
                CORS there, e.g. <code>OLLAMA_ORIGINS</code>).`
            )}
            <input
              type="text"
              .value=${this.llmBaseUrl}
              @change=${this.onLlmBaseUrlChange}
              placeholder=${provider.defaultBaseUrl ?? 'https://…'}
            />
          </div>`
        : null}

      <div class="settings-field">
        <div class="field-head">
          <label class="toggle-row">
            <input
              type="checkbox"
              .checked=${this.llmDebugMode}
              @change=${this.onLlmDebugModeChange}
            />
            <span>Debug mode</span>
          </label>
          ${this.renderInfo('llm-debug')}
        </div>
        ${this.renderNote(
          'llm-debug',
          html`Reveals the raw wire-format conversation log, the resolved system prompt, and
          per-response timing / tokens-per-second in the Agent panel, and logs every request and
          response to the browser devtools console.`
        )}
      </div>
    `;
  }

  /** What the main provider's key button opens — see {@link keyOwner} for the three cases. */
  private renderLlmKeyBody(
    provider: LlmProvider | undefined,
    owner: 'subscription' | 'bridge' | 'local',
    helpUrl: string | undefined
  ) {
    if (!provider) {
      return null;
    }
    if (owner === 'subscription') {
      return html`<div class="field-note">
        Served by your Claude subscription through Pix3AgentBridge — there is no provider key. The
        only credential is the bridge pairing token above.
      </div>`;
    }
    if (owner === 'bridge') {
      return html`
        <div class="field-note">
          The API key for <strong>${provider.label}</strong> lives in Pix3AgentBridge on your
          machine — manage it there, not here:
        </div>
        ${this.renderCommandBlock(`pix3-agent-bridge provider set-key ${provider.id} <key>`)}
      `;
    }
    return html`
      <div class="key-row">
        <input
          type="password"
          autocomplete="off"
          placeholder=${this.llmKeyConfigured ? '•••••••• stored' : 'Paste API key'}
          .value=${this.llmKeyInput}
          @input=${this.onLlmKeyInput}
        />
        <button
          class="btn-key-save"
          @click=${this.onSaveLlmKey}
          ?disabled=${!this.llmKeyInput.trim() || this.llmKeyBusy}
        >
          Save
        </button>
        ${this.llmKeyConfigured
          ? html`<button
              class="btn-key-clear"
              @click=${this.onClearLlmKey}
              ?disabled=${this.llmKeyBusy}
            >
              Clear
            </button>`
          : null}
      </div>
      <div class="field-note">
        ${this.llmKeyMessage
          ? html`<span>${this.llmKeyMessage}</span>`
          : html`Paste your provider API
            key${helpUrl
              ? html` (get one from
                  <a href=${helpUrl} target="_blank" rel="noreferrer">the provider console</a>)`
              : ''}.
            Stored encrypted in this browser only — never synced, and only sent to the selected
            provider.`}
      </div>
    `;
  }

  /**
   * Pix3AgentBridge connection panel: pairing token + optional URL override + live status and the
   * list of providers the bridge currently serves. When the bridge is unreachable this is the setup
   * call to action (the metered providers are simply absent from the pickers until it connects).
   */
  /** A monospaced, one-line command with a copy-to-clipboard button on the right. */
  private renderCommandBlock(command: string) {
    const copied = this.copiedCommand === command;
    return html`
      <div class="command-block">
        <code>${command}</code>
        <button
          class="command-copy ${copied ? 'is-copied' : ''}"
          aria-label=${copied ? 'Copied' : 'Copy command'}
          title=${copied ? 'Copied' : 'Copy'}
          @click=${() => void this.copyCommand(command)}
        >
          ${this.icons.getIcon(copied ? 'check' : 'copy', IconSize.SMALL)}
        </button>
      </div>
    `;
  }

  private copyCommand = async (command: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      return;
    }
    this.copiedCommand = command;
    window.setTimeout(() => {
      if (this.copiedCommand === command) {
        this.copiedCommand = null;
      }
    }, 1400);
  };

  private renderBridgePanel() {
    const entries = this.bridge.getEntries();
    const connected = this.bridgeAvailable;
    return html`
      <div class="settings-section">
        <h3 class="section-title">
          <span>Pix3AgentBridge</span>
          <span class="key-status ${connected ? 'is-set' : 'is-unset'}">
            ${connected ? 'Connected' : 'Not running'}
          </span>
          ${this.renderInfo('bridge', 'About Pix3AgentBridge')}
        </h3>
        ${this.renderNote(
          'bridge',
          html`Serves the metered providers (OpenAI, Anthropic, OpenCode Zen, custom) from your
          machine so keys never enter the browser. Gemini works without it. Start it and open the
          pairing link it prints — that stores the token for you; the field behind the key button is
          only for pasting it by hand. Then add providers:
          ${this.renderCommandBlock('npx @pix3/agent-bridge')}
          ${this.renderCommandBlock('npx @pix3/agent-bridge provider add openai --key sk-…')}`
        )}

        <div class="settings-field">
          <div class="field-head">
            <span class="field-title">Bridge URL</span>
            ${this.renderInfo('bridge-url')}
            <span class="field-head-spacer"></span>
            <button
              class="icon-btn"
              title="Recheck the connection"
              aria-label="Recheck the bridge connection"
              @click=${this.onProbeBridge}
              ?disabled=${this.bridgeBusy}
            >
              ${this.icons.getIcon('refresh-cw', IconSize.SMALL)}
            </button>
            ${this.renderKeyToggle('bridge-token', this.bridgeTokenConfigured, 'Pairing token')}
          </div>
          ${this.renderNote(
            'bridge-url',
            'Only change this if you run the bridge on a non-default port.'
          )}
          <input
            type="text"
            .value=${this.bridgeUrlInput}
            @change=${this.onBridgeUrlChange}
            placeholder=${DEFAULT_BRIDGE_URL}
          />
          ${this.renderKeyPanel(
            'bridge-token',
            html`
              <div class="key-row">
                <input
                  type="password"
                  autocomplete="off"
                  placeholder=${this.bridgeTokenConfigured
                    ? '•••••••• stored'
                    : 'Paste pairing token'}
                  .value=${this.bridgeTokenInput}
                  @input=${this.onBridgeTokenInput}
                />
                <button
                  class="btn-key-save"
                  @click=${this.onSaveBridgeToken}
                  ?disabled=${!this.bridgeTokenInput.trim() || this.bridgeBusy}
                >
                  Save
                </button>
                ${this.bridgeTokenConfigured
                  ? html`<button
                      class="btn-key-clear"
                      @click=${this.onClearBridgeToken}
                      ?disabled=${this.bridgeBusy}
                    >
                      Clear
                    </button>`
                  : null}
              </div>
              <div class="field-note">
                The token the bridge prints on start — or just open the pairing link next to it,
                which stores it for you.
              </div>
            `
          )}
          ${this.bridgeMessage
            ? html`<div class="field-note ${this.bridgeMessageIsWarning ? 'field-note--warn' : ''}">
                ${this.bridgeMessage}
              </div>`
            : null}
          ${connected && entries.length > 0
            ? html`<div class="field-note">Serving: ${entries.map(e => e.label).join(', ')}.</div>`
            : null}
        </div>
      </div>
    `;
  }

  private onBridgeTokenInput = (event: Event): void => {
    this.bridgeTokenInput = (event.target as HTMLInputElement).value;
    if (this.bridgeMessageIsWarning) {
      // The correction applied to the value that has just been replaced.
      this.bridgeMessage = null;
      this.bridgeMessageIsWarning = false;
    }
  };

  private onSaveBridgeToken = async (): Promise<void> => {
    const token = this.bridgeTokenInput.trim();
    if (!token) return;
    // The two fields on this pane both take an opaque secret, and pasting a provider key here is the
    // easy mistake to make — it stores fine and then every request comes back 401 with nothing on
    // screen explaining why. A recognisable provider prefix can never be a bridge token.
    const providerKeyVendor = recogniseProviderKey(token);
    if (providerKeyVendor) {
      this.bridgeMessageIsWarning = true;
      this.bridgeMessage = `That looks like a ${providerKeyVendor} API key, not the bridge pairing token. Provider keys go in the API Key field below (or onto the bridge itself with "pix3-agent-bridge provider add"). The pairing token is the one the bridge prints on start — or just open the pairing link it prints next to it.`;
      return;
    }
    this.bridgeMessageIsWarning = false;
    this.bridgeBusy = true;
    this.bridgeMessage = null;
    try {
      await this.bridge.setToken(token);
      this.bridgeTokenInput = '';
      this.bridgeTokenConfigured = true;
      this.bridgeAvailable = this.bridge.isAvailable();
      this.bridgeMessage = this.bridgeAvailable
        ? 'Connected to Pix3AgentBridge.'
        : 'Token saved, but the bridge did not respond. Is it running?';
    } catch (error) {
      this.bridgeMessage = error instanceof Error ? error.message : 'Failed to save the token.';
    } finally {
      this.bridgeBusy = false;
    }
  };

  private onClearBridgeToken = async (): Promise<void> => {
    this.bridgeBusy = true;
    this.bridgeMessageIsWarning = false;
    try {
      await this.bridge.setToken('');
      this.bridgeTokenConfigured = false;
      this.bridgeAvailable = false;
      this.bridgeMessage = 'Pairing token cleared.';
    } finally {
      this.bridgeBusy = false;
    }
  };

  private onBridgeUrlChange = async (event: Event): Promise<void> => {
    this.bridgeUrlInput = (event.target as HTMLInputElement).value;
    this.bridgeBusy = true;
    try {
      await this.bridge.setBridgeUrl(this.bridgeUrlInput);
      this.bridgeAvailable = this.bridge.isAvailable();
    } finally {
      this.bridgeBusy = false;
    }
  };

  private onProbeBridge = async (): Promise<void> => {
    this.bridgeBusy = true;
    this.bridgeMessage = null;
    this.bridgeMessageIsWarning = false;
    try {
      await this.bridge.probe();
      this.bridgeAvailable = this.bridge.isAvailable();
      this.bridgeMessage = this.bridgeAvailable
        ? `Connected — serving ${this.bridge.getEntries().length} provider(s).`
        : 'Bridge not reachable. Run `npx @pix3/agent-bridge` and check the token/URL.';
    } finally {
      this.bridgeBusy = false;
    }
  };

  private renderAgentAssistantsTab() {
    if (this.llmProviders.list().length === 0) {
      return html`<div class="field-note">No LLM providers are registered.</div>`;
    }
    return html`${this.renderAdvisorField()} ${this.renderVisionField()}`;
  }

  /**
   * Shared renderer for a *secondary* LLM picker (advisor / vision helper): a provider select whose
   * first entry disables/auto-resolves the feature, a model select (only meaningful once a provider
   * is chosen), a compact per-provider API-key row, and a resolved-status line. Both features reuse
   * the same encrypted per-provider key as the main Agent provider, so picking a provider that is
   * already keyed needs no extra input.
   */
  private renderSecondaryLlm(config: {
    /** Stable key for this block's note / key-panel toggles. */
    key: string;
    title: string;
    hint: unknown;
    providerId: string;
    modelId: string;
    /** Label of the first provider option (value=''): 'Off' for advisor, 'Auto' for vision. */
    providerNoneLabel: string;
    /** Label of the first model option (value=''): the default/auto model. */
    modelDefaultLabel: string;
    /** When true, the model list is limited to vision-capable models. */
    visionOnly: boolean;
    keyConfigured: boolean;
    keyInput: string;
    keyBusy: boolean;
    status: string | null;
    onProviderChange: (id: string) => void;
    onModelChange: (id: string) => void;
    onKeyInput: (value: string) => void;
    onSaveKey: () => void;
    onClearKey: () => void;
  }) {
    const provider = config.providerId ? this.llmProviders.get(config.providerId) : undefined;
    const allModels = provider ? this.llmModelCatalog.getModels(provider.id) : [];
    const models: readonly LlmModel[] = (() => {
      if (!config.visionOnly) return allModels;
      const visionModels = allModels.filter(m => m.capabilities.supportsImages);
      return visionModels.length > 0 ? visionModels : allModels;
    })();
    const owner = provider ? this.keyOwner(provider.id, provider.apiKeySecretId) : 'local';

    return html`
      <div class="settings-subsection">
        <div class="field-head">
          <h4 class="subsection-title">${config.title}</h4>
          ${this.renderInfo(config.key)}
          ${config.status
            ? html`<span class="resolved-tag" title="What this role resolves to right now">
                ${config.status}
              </span>`
            : null}
        </div>
        ${this.renderNote(config.key, config.hint)}

        <div class="inline-row">
          <select
            class="inline-select"
            aria-label="Provider"
            @change=${(e: Event) => config.onProviderChange((e.target as HTMLSelectElement).value)}
          >
            <option value="" ?selected=${config.providerId === ''}>
              ${config.providerNoneLabel}
            </option>
            ${this.llmProviders
              .list()
              .map(
                item =>
                  html`<option value=${item.id} ?selected=${item.id === config.providerId}>
                    ${item.label}
                  </option>`
              )}
          </select>
          <select
            class="inline-select"
            aria-label="Model"
            ?disabled=${!provider}
            @change=${(e: Event) => config.onModelChange((e.target as HTMLSelectElement).value)}
          >
            <option value="" ?selected=${config.modelId === ''}>${config.modelDefaultLabel}</option>
            ${models.map(model => {
              const hint = formatPricingHint(model.pricing);
              return html`<option value=${model.id} ?selected=${model.id === config.modelId}>
                ${model.label}${hint ? ` · ${hint}` : ''}
              </option>`;
            })}
          </select>
          ${provider
            ? this.renderKeyToggle(
                `${config.key}-key`,
                config.keyConfigured,
                `${provider.label} API key`
              )
            : null}
        </div>

        ${provider
          ? this.renderKeyPanel(
              `${config.key}-key`,
              owner === 'local'
                ? html`
                    <div class="key-row">
                      <input
                        type="password"
                        autocomplete="off"
                        placeholder=${config.keyConfigured ? '•••••••• stored' : 'Paste API key'}
                        .value=${config.keyInput}
                        @input=${(e: Event) =>
                          config.onKeyInput((e.target as HTMLInputElement).value)}
                      />
                      <button
                        class="btn-key-save"
                        @click=${config.onSaveKey}
                        ?disabled=${!config.keyInput.trim() || config.keyBusy}
                      >
                        Save
                      </button>
                      ${config.keyConfigured
                        ? html`<button
                            class="btn-key-clear"
                            @click=${config.onClearKey}
                            ?disabled=${config.keyBusy}
                          >
                            Clear
                          </button>`
                        : null}
                    </div>
                    <div class="field-note">
                      Shares the encrypted key with this provider everywhere in the app.
                    </div>
                  `
                : html`<div class="field-note">
                    ${provider.label} is served by Pix3AgentBridge, so it has no key of its own here
                    — the pairing token in <strong>Model &amp; Key</strong> is the only credential.
                  </div>`
            )
          : null}
      </div>
    `;
  }

  private renderAdvisorField() {
    return this.renderSecondaryLlm({
      key: 'advisor',
      title: 'Advisor model',
      hint: html`A deliberately stronger model the agent can consult via the
        <code>ask_advisor</code> tool when it is stuck or facing a design decision. Off unless a
        provider serves it at no marginal cost — the Claude Code (MAX) bridge lane nominates its
        strongest model here as soon as the bridge connects. Picking anything yourself (including
        Off) is remembered and never overwritten.`,
      providerId: this.advisorProviderId,
      modelId: this.advisorModelId,
      providerNoneLabel: 'Off',
      modelDefaultLabel: "Provider's selected model",
      visionOnly: false,
      keyConfigured: this.advisorKeyConfigured,
      keyInput: this.advisorKeyInput,
      keyBusy: this.advisorKeyBusy,
      status: this.advisorStatus,
      onProviderChange: id => this.onAdvisorProviderChange(id),
      onModelChange: id => this.onAdvisorModelChange(id),
      onKeyInput: value => {
        this.advisorKeyInput = value;
      },
      onSaveKey: () => void this.onSaveAdvisorKey(),
      onClearKey: () => void this.onClearAdvisorKey(),
    });
  }

  private renderVisionField() {
    return this.renderSecondaryLlm({
      key: 'vision',
      title: 'Vision helper',
      hint: html`Lets a text-only main model "see" images (<code>analyze_image</code>) by delegating
      to a vision-capable model. Auto = the first provider with a key and a vision model — which
      lands on your main model when it already supports images.`,
      providerId: this.visionProviderId,
      modelId: this.visionModelId,
      providerNoneLabel: 'Auto',
      modelDefaultLabel: 'Auto (first vision-capable model)',
      visionOnly: true,
      keyConfigured: this.visionKeyConfigured,
      keyInput: this.visionKeyInput,
      keyBusy: this.visionKeyBusy,
      status: this.visionStatus,
      onProviderChange: id => this.onVisionProviderChange(id),
      onModelChange: id => this.onVisionModelChange(id),
      onKeyInput: value => {
        this.visionKeyInput = value;
      },
      onSaveKey: () => void this.onSaveVisionKey(),
      onClearKey: () => void this.onClearVisionKey(),
    });
  }

  // ── Advisor handlers ──────────────────────────────────────────────────────

  private onAdvisorProviderChange(providerId: string): void {
    this.advisorProviderId = providerId;
    // Changing the provider invalidates a model id from the previous provider.
    this.advisorModelId = '';
    this.advisorKeyInput = '';
    this.agentSettings.updatePreferences({
      advisorProviderId: providerId,
      advisorModelId: '',
    });
    void this.refreshAdvisorKeyStatus();
    void this.refreshAssistantStatus();
  }

  private onAdvisorModelChange(modelId: string): void {
    this.advisorModelId = modelId;
    this.agentSettings.updatePreferences({ advisorModelId: modelId });
    void this.refreshAssistantStatus();
  }

  private async onSaveAdvisorKey(): Promise<void> {
    const key = this.advisorKeyInput.trim();
    if (!key || !this.advisorProviderId) {
      return;
    }
    this.advisorKeyBusy = true;
    try {
      await this.agentSettings.setApiKey(this.advisorProviderId, key);
      this.advisorKeyConfigured = true;
      this.advisorKeyInput = '';
    } finally {
      this.advisorKeyBusy = false;
    }
    void this.refreshAssistantStatus();
  }

  private async onClearAdvisorKey(): Promise<void> {
    if (!this.advisorProviderId) {
      return;
    }
    this.advisorKeyBusy = true;
    try {
      await this.agentSettings.clearApiKey(this.advisorProviderId);
      this.advisorKeyConfigured = false;
      this.advisorKeyInput = '';
    } finally {
      this.advisorKeyBusy = false;
    }
    void this.refreshAssistantStatus();
  }

  private async refreshAdvisorKeyStatus(): Promise<void> {
    const providerId = this.advisorProviderId;
    if (!providerId) {
      this.advisorKeyConfigured = false;
      return;
    }
    try {
      const configured = await this.agentSettings.hasApiKey(providerId);
      if (providerId === this.advisorProviderId) {
        this.advisorKeyConfigured = configured;
      }
    } catch {
      this.advisorKeyConfigured = false;
    }
  }

  // ── Vision handlers ───────────────────────────────────────────────────────

  private onVisionProviderChange(providerId: string): void {
    this.visionProviderId = providerId;
    this.visionModelId = '';
    this.visionKeyInput = '';
    this.agentSettings.updatePreferences({
      visionProviderId: providerId,
      visionModelId: '',
    });
    void this.refreshVisionKeyStatus();
    void this.refreshAssistantStatus();
  }

  private onVisionModelChange(modelId: string): void {
    this.visionModelId = modelId;
    this.agentSettings.updatePreferences({ visionModelId: modelId });
    void this.refreshAssistantStatus();
  }

  private async onSaveVisionKey(): Promise<void> {
    const key = this.visionKeyInput.trim();
    if (!key || !this.visionProviderId) {
      return;
    }
    this.visionKeyBusy = true;
    try {
      await this.agentSettings.setApiKey(this.visionProviderId, key);
      this.visionKeyConfigured = true;
      this.visionKeyInput = '';
    } finally {
      this.visionKeyBusy = false;
    }
    void this.refreshAssistantStatus();
  }

  private async onClearVisionKey(): Promise<void> {
    if (!this.visionProviderId) {
      return;
    }
    this.visionKeyBusy = true;
    try {
      await this.agentSettings.clearApiKey(this.visionProviderId);
      this.visionKeyConfigured = false;
      this.visionKeyInput = '';
    } finally {
      this.visionKeyBusy = false;
    }
    void this.refreshAssistantStatus();
  }

  private async refreshVisionKeyStatus(): Promise<void> {
    const providerId = this.visionProviderId;
    if (!providerId) {
      this.visionKeyConfigured = false;
      return;
    }
    try {
      const configured = await this.agentSettings.hasApiKey(providerId);
      if (providerId === this.visionProviderId) {
        this.visionKeyConfigured = configured;
      }
    } catch {
      this.visionKeyConfigured = false;
    }
  }

  /** Recompute the "Currently resolved" lines for both the advisor and the vision helper. */
  private async refreshAssistantStatus(): Promise<void> {
    try {
      const advisor = await this.agentAdvisor.describeAdvisor();
      this.advisorStatus = advisor
        ? `${advisor.providerLabel} · ${advisor.modelLabel ?? advisor.modelId}`
        : null;
    } catch {
      this.advisorStatus = null;
    }
    try {
      const vision = await this.agentVision.describeHelper();
      this.visionStatus = vision
        ? `${vision.providerLabel} · ${vision.modelLabel ?? vision.modelId}${vision.auto ? ' (auto)' : ''}`
        : null;
    } catch {
      this.visionStatus = null;
    }
  }

  private onLlmDebugModeChange(e: Event): void {
    this.llmDebugMode = (e.target as HTMLInputElement).checked;
    this.agentSettings.updatePreferences({ debugMode: this.llmDebugMode });
  }

  // ── Souls (agent name + personality) ──────────────────────────────────────

  private renderAgentSoulsTab() {
    const customSelected = this.soulId === CUSTOM_SOUL_ID;
    return html`
      <div class="field-head">
        <span class="field-title">Personality</span>
        ${this.renderInfo('souls')}
      </div>
      ${this.renderNote(
        'souls',
        'Give the agent a name and a character. The soul only changes how it talks — not what it does.'
      )}

      <div class="soul-grid">
        ${SOUL_PRESETS.map(soul => this.renderSoulCard(soul, soul.id === this.soulId))}
        ${this.renderSoulCard(
          {
            id: CUSTOM_SOUL_ID,
            name: 'Custom',
            tagline: 'Write your own name and personality.',
            sample: '',
            prompt: '',
            avatar: CUSTOM_SOUL_AVATAR,
          },
          customSelected
        )}
      </div>

      ${customSelected
        ? html`<div class="soul-custom">
            <div class="settings-field">
              <label class="select-row">
                <span>Name</span>
                <input
                  type="text"
                  class="soul-custom-name"
                  .value=${this.customSoulName}
                  @input=${this.onCustomSoulNameInput}
                  placeholder="e.g. Brobot"
                />
              </label>
            </div>
            <div class="settings-field">
              <label class="select-row">
                <span>Personality prompt</span>
                <textarea
                  class="soul-custom-prompt"
                  rows="6"
                  .value=${this.customSoulPrompt}
                  @input=${this.onCustomSoulPromptInput}
                  placeholder="Describe who the agent is and how it talks. Short beats long."
                ></textarea>
              </label>
            </div>
          </div>`
        : null}
    `;
  }

  private renderSoulCard(soul: AgentSoul, selected: boolean) {
    return html`
      <button
        type="button"
        class="soul-card ${selected ? 'is-selected' : ''}"
        aria-pressed=${selected}
        @click=${() => this.onSelectSoul(soul.id)}
      >
        <span class="soul-head">
          <img class="soul-avatar" src=${soul.avatar} alt="" aria-hidden="true" />
          <span class="soul-name">${soul.name}</span>
        </span>
        <span class="soul-tagline">${soul.tagline}</span>
        ${soul.sample ? html`<span class="soul-sample">“${soul.sample}”</span>` : null}
      </button>
    `;
  }

  private onSelectSoul(soulId: string): void {
    this.soulId = soulId;
    this.agentSettings.updatePreferences({ soulId });
  }

  private onCustomSoulNameInput(e: Event): void {
    this.customSoulName = (e.target as HTMLInputElement).value;
    this.agentSettings.updatePreferences({ customSoulName: this.customSoulName });
  }

  private onCustomSoulPromptInput(e: Event): void {
    this.customSoulPrompt = (e.target as HTMLTextAreaElement).value;
    this.agentSettings.updatePreferences({ customSoulPrompt: this.customSoulPrompt });
  }

  private renderImagesGenerationTab() {
    const providers = this.imageProviders.list();
    if (providers.length === 0) {
      return html`<div class="field-note">No image providers are registered.</div>`;
    }
    const provider = this.imageProviders.get(this.aiProviderId) ?? providers[0];
    const models = provider?.models ?? [];
    const activeModel = provider?.getModel(this.aiModelId);
    const helpUrl = provider?.apiKeyHelpUrl;
    const ownsKey = provider?.requiresApiKey !== false;

    return html`
      <div class="settings-field">
        <div class="field-head">
          <span class="field-title">Provider &amp; model</span>
          ${this.renderInfo('image-model')}
        </div>
        ${this.renderNote(
          'image-model',
          activeModel?.description ??
            'Draws every generation in the Sprite Editor and the AI image tools.'
        )}
        <div class="inline-row">
          <select class="inline-select" aria-label="Provider" @change=${this.onAiProviderChange}>
            ${providers.map(
              item =>
                html`<option value=${item.id} ?selected=${item.id === this.aiProviderId}>
                  ${item.label}
                </option>`
            )}
          </select>
          <select class="inline-select" aria-label="Model" @change=${this.onAiModelChange}>
            ${models.map(
              model =>
                html`<option value=${model.id} ?selected=${model.id === this.aiModelId}>
                  ${modelPickerLabel(model)}
                </option>`
            )}
          </select>
          ${this.renderKeyToggle(
            'image',
            ownsKey ? this.aiKeyConfigured : false,
            `${provider?.label ?? 'Provider'} API key`
          )}
        </div>
        ${this.renderKeyPanel(
          'image',
          ownsKey
            ? this.renderImageKeyBody(helpUrl)
            : html`<div class="field-note">
                This provider has no key of its own — it draws with the model the Agent chat is set
                to. Configure that in the Agent (LLM) tab.
              </div>`
        )}
      </div>

      <div class="settings-field">
        <div class="field-head">
          <span class="field-title">Default save size (downscale)</span>
          ${this.renderInfo('image-save-size')}
        </div>
        ${this.renderNote(
          'image-save-size',
          'Downscales the longest edge when saving a generated image into the project (never upscales). Game elements rarely need the full 1K/2K generation. Overridable per-save in the Sprite Editor.'
        )}
        <select aria-label="Default save size" @change=${this.onDefaultSaveSizeChange}>
          <option value="0" ?selected=${this.defaultSaveMaxSize === 0}>Original size</option>
          <option value="1024" ?selected=${this.defaultSaveMaxSize === 1024}>≤ 1024 px</option>
          <option value="512" ?selected=${this.defaultSaveMaxSize === 512}>≤ 512 px</option>
          <option value="256" ?selected=${this.defaultSaveMaxSize === 256}>≤ 256 px</option>
          <option value="128" ?selected=${this.defaultSaveMaxSize === 128}>≤ 128 px</option>
          <option value="64" ?selected=${this.defaultSaveMaxSize === 64}>≤ 64 px</option>
        </select>
      </div>
    `;
  }

  /** API-key entry for an image provider that owns one (behind its key button). */
  private renderImageKeyBody(helpUrl: string | undefined) {
    return html`
      <div class="key-row">
        <input
          type="password"
          autocomplete="off"
          placeholder=${this.aiKeyConfigured ? '•••••••• stored' : 'Paste API key'}
          .value=${this.aiKeyInput}
          @input=${this.onAiKeyInput}
        />
        <button
          class="btn-key-save"
          @click=${this.onSaveAiKey}
          ?disabled=${!this.aiKeyInput.trim() || this.aiKeyBusy}
        >
          Save
        </button>
        ${this.aiKeyConfigured
          ? html`<button
              class="btn-key-clear"
              @click=${this.onClearAiKey}
              ?disabled=${this.aiKeyBusy}
            >
              Clear
            </button>`
          : null}
      </div>
      <div class="field-note">
        ${this.aiKeyMessage
          ? html`<span>${this.aiKeyMessage}</span>`
          : html`Paste your provider API
            key${helpUrl
              ? html` (get one from
                  <a href=${helpUrl} target="_blank" rel="noreferrer">the provider console</a>)`
              : ''}.
            Stored encrypted in this browser only — never synced, and only sent to the selected
            provider.`}
      </div>
    `;
  }

  /**
   * Strophe: one metered account that serves both the image lane (as a provider in AI Images) and the
   * Model Lab neural image→3D lane. Key entry is here rather than duplicated per lane because it is
   * one credential for one account.
   */
  private renderStropheTab() {
    const account = this.stropheAccount;
    const scopes = account?.token?.scopes ?? [];
    const families = this.strophe3dFamilies.filter(family => family.available);
    const usingStrophe3d = this.neural3dProviderId === 'strophe';

    return html`
      <div class="settings-field">
        <div class="field-head">
          <span class="field-title">Account</span>
          ${this.renderInfo('strophe-key')}
          ${account
            ? html`<span class="resolved-tag">
                ${describeSpendHeadroom(account)}${account.plan ? ` · plan ${account.plan}` : ''}
              </span>`
            : html`<span class="key-status is-unset">Not set</span>`}
          <span class="field-head-spacer"></span>
          ${this.renderKeyToggle('strophe', this.stropheKeyConfigured, 'Strophe API key')}
        </div>
        ${this.renderNote(
          'strophe-key',
          html`Create a key in
            <a href=${STROPHE_KEY_HELP_URL} target="_blank" rel="noreferrer"
              >Strophe → Settings → Integrations</a
            >. It is checked against your account before being stored, then kept encrypted in this
            browser only. A Strophe key is a password to the account's credits, so give it only the
            scopes the editor needs (<code>catalog:read</code>, <code>generations:read</code>,
            <code>generations:write</code>, <code>files:write</code>, <code>account:read</code>) and
            set a daily credit limit on it — both are per-key settings in the Strophe console, and
            they cap what a leaked key, or an agent running unattended, can spend.`
        )}
        ${this.renderKeyPanel(
          'strophe',
          html`
            <div class="key-row">
              <input
                type="password"
                autocomplete="off"
                placeholder=${this.stropheKeyConfigured
                  ? '•••••••• stored'
                  : 'Paste your Strophe key'}
                .value=${this.stropheKeyInput}
                @input=${this.onStropheKeyInput}
              />
              <button
                class="btn-key-save"
                @click=${this.onSaveStropheKey}
                ?disabled=${!this.stropheKeyInput.trim() || this.stropheBusy}
              >
                ${this.stropheBusy ? 'Checking…' : 'Save'}
              </button>
              ${this.stropheKeyConfigured
                ? html`<button
                    class="btn-key-clear"
                    @click=${this.onClearStropheKey}
                    ?disabled=${this.stropheBusy}
                  >
                    Clear
                  </button>`
                : null}
            </div>
            ${this.stropheMessage
              ? html`<div class="field-note">${this.stropheMessage}</div>`
              : null}
            ${account
              ? html`<div class="field-note">
                  ${account.team?.name ? html`Team ${account.team.name}. ` : ''}${scopes.length > 0
                    ? html`Key scopes: ${scopes.join(', ')}.`
                    : ''}
                  ${account.availableCredits === null
                    ? html` This account bills against a shared team pool, so Strophe reports no
                      credit balance — the figure above is this key's own daily allowance.`
                    : ''}
                </div>`
              : null}
          `
        )}
      </div>

      <div class="settings-field">
        <div class="field-head">
          <span class="field-title">Image generation</span>
          ${this.renderInfo('strophe-images')}
        </div>
        ${this.renderNote(
          'strophe-images',
          html`Strophe appears as a provider in <strong>AI Images → Generation</strong>; pick a
            model there. Each image is charged separately, so a count of 4 costs four generations.
            Strophe exposes no transparency flag, so transparent cutouts still run through the local
            (free) background removal.`
        )}
      </div>

      <div class="settings-field">
        <div class="field-head">
          <span class="field-title">Neural image→3D backend</span>
          ${this.renderInfo('strophe-3d')}
        </div>
        ${this.renderNote(
          'strophe-3d',
          "Used by Model Lab's neural lane. Strophe needs no proxy and works in a production build; Tripo3D direct requires the dev-only proxy routes. PBR textures are requested when the model supports them, and Strophe reports no numeric progress, so Model Lab's progress bar is interpolated from the model's own time estimate."
        )}
        <div class="inline-row">
          <select
            class="inline-select"
            aria-label="Neural image→3D backend"
            @change=${this.onNeural3dProviderChange}
          >
            <option value="strophe" ?selected=${usingStrophe3d}>Strophe (credits)</option>
            <option value="tripo" ?selected=${!usingStrophe3d}>Tripo3D direct (own key)</option>
          </select>
          ${usingStrophe3d
            ? html`<select
                class="inline-select"
                aria-label="3D model"
                @change=${this.onNeural3dFamilyChange}
                ?disabled=${families.length === 0}
              >
                ${families.length === 0
                  ? html`<option value=${this.neural3dFamilyId}>
                      ${this.stropheKeyConfigured ? 'Loading…' : 'Connect a key first'}
                    </option>`
                  : families.map(
                      family =>
                        html`<option
                          value=${family.id}
                          ?selected=${family.id === this.neural3dFamilyId}
                        >
                          ${family.name}${family.price
                            ? ` — ${family.price.credits} credits`
                            : ''}${family.generationTime ? ` · ~${family.generationTime}s` : ''}
                        </option>`
                    )}
              </select>`
            : null}
        </div>
      </div>
    `;
  }

  private renderImagesBackgroundTab() {
    return html`
      <div class="settings-field">
        <div class="field-head">
          <span class="field-title">Background removal</span>
          ${this.renderInfo('bg-removal')}
        </div>
        ${this.renderNote(
          'bg-removal',
          html`Runs on-device (no API key). U²-Net is Apache-2.0 for both code and weights and runs
          on the CPU, so it works without WebGPU — it mattes at 320², so edges are softer. BiRefNet
          is MIT-licensed and higher quality, but runs at a fixed 1024² and REQUIRES a WebGPU
          browser; note that WebGPU is blocklisted on Qualcomm Adreno (Snapdragon X /
          Windows-on-ARM), so use U²-Net there.`
        )}
        <div class="inline-row">
          <select class="inline-select" aria-label="Engine" @change=${this.onBgEngineChange}>
            <option value="u2net" ?selected=${this.bgEngine === 'u2net'}>
              U²-Net (Apache-2.0, runs on CPU)
            </option>
            <option value="birefnet" ?selected=${this.bgEngine === 'birefnet'}>
              BiRefNet (MIT, needs WebGPU)
            </option>
          </select>
          <select class="inline-select" aria-label="Quality" @change=${this.onBgQualityChange}>
            ${this.bgEngine === 'u2net'
              ? html`
                  <option value="balanced" ?selected=${this.bgQuality === 'balanced'}>
                    Balanced · u2netp (4.7 MB)
                  </option>
                  <option value="max" ?selected=${this.bgQuality === 'max'}>
                    Max · u2net (176 MB)
                  </option>
                `
              : html`
                  <option value="balanced" ?selected=${this.bgQuality === 'balanced'}>
                    Balanced (lite)
                  </option>
                  <option value="max" ?selected=${this.bgQuality === 'max'}>
                    Max (full, large download)
                  </option>
                `}
          </select>
        </div>
        <label class="toggle-row">
          <input type="checkbox" .checked=${this.bgFillHoles} @change=${this.onBgFillHolesChange} />
          <span>Fill interior holes (solid cutout)</span>
        </label>
      </div>
    `;
  }

  private onBgEngineChange(e: Event): void {
    this.bgEngine = (e.target as HTMLSelectElement).value as BgRemovalEngine;
    this.aiImageSettings.updatePreferences({ bgRemovalEngine: this.bgEngine });
  }

  private onBgQualityChange(e: Event): void {
    this.bgQuality = (e.target as HTMLSelectElement).value as BgRemovalQuality;
    this.aiImageSettings.updatePreferences({ bgRemovalQuality: this.bgQuality });
  }

  private onBgFillHolesChange(e: Event): void {
    this.bgFillHoles = (e.target as HTMLInputElement).checked;
    this.aiImageSettings.updatePreferences({ bgFillHoles: this.bgFillHoles });
  }

  private onDefaultSaveSizeChange(e: Event): void {
    this.defaultSaveMaxSize = Number((e.target as HTMLSelectElement).value) || 0;
    this.aiImageSettings.updatePreferences({ defaultSaveMaxSize: this.defaultSaveMaxSize });
  }

  // -- Strophe handlers -------------------------------------------------------

  /**
   * Refresh "is a key stored", the account snapshot and the 3D family list. Failures are swallowed:
   * this runs on dialog open, so a network blip must not surface as an error the user did not ask for.
   */
  private async refreshStropheStatus(): Promise<void> {
    try {
      this.stropheKeyConfigured = await this.strophe.hasKey();
    } catch {
      this.stropheKeyConfigured = false;
    }
    if (!this.stropheKeyConfigured) {
      this.stropheAccount = null;
      this.strophe3dFamilies = [];
      return;
    }
    this.stropheAccount = await this.strophe.getAccountStatus();
    try {
      this.strophe3dFamilies = await this.strophe.listFamilies('3d');
    } catch {
      this.strophe3dFamilies = [];
    }
  }

  private onStropheKeyInput(e: Event): void {
    this.stropheKeyInput = (e.target as HTMLInputElement).value;
    this.stropheMessage = null;
  }

  /**
   * Verify the pasted key against `/account` BEFORE storing it, so a typo or a key without the right
   * scopes is reported here rather than at the first generation. Nothing is stored if the check fails.
   */
  private async onSaveStropheKey(): Promise<void> {
    const key = this.stropheKeyInput.trim();
    if (!key) {
      return;
    }
    this.stropheBusy = true;
    this.stropheMessage = null;
    try {
      const account = await this.strophe.verifyKey(key);
      await this.strophe.setKey(key);
      this.stropheAccount = account;
      this.stropheKeyConfigured = true;
      this.stropheKeyInput = '';
      this.stropheMessage = `Connected — ${describeSpendHeadroom(account)}.`;
      try {
        this.strophe3dFamilies = await this.strophe.listFamilies('3d', { refresh: true });
      } catch {
        this.strophe3dFamilies = [];
      }
    } catch (error) {
      this.stropheMessage = `Key rejected: ${error instanceof Error ? error.message : 'unknown error'}`;
    } finally {
      this.stropheBusy = false;
    }
  }

  private async onClearStropheKey(): Promise<void> {
    this.stropheBusy = true;
    try {
      await this.strophe.clearKey();
      this.stropheKeyConfigured = false;
      this.stropheAccount = null;
      this.strophe3dFamilies = [];
      this.stropheKeyInput = '';
      this.stropheMessage = 'API key removed.';
    } catch (error) {
      this.stropheMessage = `Failed to remove key: ${error instanceof Error ? error.message : 'unknown error'}`;
    } finally {
      this.stropheBusy = false;
    }
  }

  private onNeural3dProviderChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value;
    this.neural3dProviderId = value === 'tripo' ? 'tripo' : 'strophe';
    this.modelLabSettings.updatePreferences({ neural3dProviderId: this.neural3dProviderId });
    if (this.neural3dProviderId === 'strophe' && this.strophe3dFamilies.length === 0) {
      void this.refreshStropheStatus();
    }
  }

  private onNeural3dFamilyChange(e: Event): void {
    this.neural3dFamilyId = (e.target as HTMLSelectElement).value;
    this.modelLabSettings.updatePreferences({ neural3dFamilyId: this.neural3dFamilyId });
  }

  private async refreshAiKeyStatus(): Promise<void> {
    if (!this.aiProviderId) {
      this.aiKeyConfigured = false;
      return;
    }
    try {
      this.aiKeyConfigured = await this.aiImageSettings.hasApiKey(this.aiProviderId);
    } catch {
      this.aiKeyConfigured = false;
    }
  }

  private onAiProviderChange(e: Event): void {
    const providerId = (e.target as HTMLSelectElement).value;
    this.aiProviderId = providerId;
    this.aiImageSettings.updatePreferences({ selectedProviderId: providerId });
    this.aiModelId = this.aiImageSettings.getSelectedModelId(providerId) ?? '';
    this.aiKeyInput = '';
    this.aiKeyMessage = null;
    void this.refreshAiKeyStatus();
  }

  private onAiModelChange(e: Event): void {
    const modelId = (e.target as HTMLSelectElement).value;
    this.aiModelId = modelId;
    this.aiImageSettings.updatePreferences({ modelByProvider: { [this.aiProviderId]: modelId } });
  }

  private onAiKeyInput(e: Event): void {
    this.aiKeyInput = (e.target as HTMLInputElement).value;
    this.aiKeyMessage = null;
  }

  private async onSaveAiKey(): Promise<void> {
    const key = this.aiKeyInput.trim();
    if (!key || !this.aiProviderId) {
      return;
    }
    this.aiKeyBusy = true;
    try {
      await this.aiImageSettings.setApiKey(this.aiProviderId, key);
      this.aiKeyConfigured = true;
      this.aiKeyInput = '';
      this.aiKeyMessage = 'API key saved.';
    } catch (error) {
      this.aiKeyMessage = `Failed to save key: ${error instanceof Error ? error.message : 'unknown error'}`;
    } finally {
      this.aiKeyBusy = false;
    }
  }

  private async onClearAiKey(): Promise<void> {
    if (!this.aiProviderId) {
      return;
    }
    this.aiKeyBusy = true;
    try {
      await this.aiImageSettings.clearApiKey(this.aiProviderId);
      this.aiKeyConfigured = false;
      this.aiKeyInput = '';
      this.aiKeyMessage = 'API key removed.';
    } catch (error) {
      this.aiKeyMessage = `Failed to remove key: ${error instanceof Error ? error.message : 'unknown error'}`;
    } finally {
      this.aiKeyBusy = false;
    }
  }

  private async refreshLlmKeyStatus(): Promise<void> {
    if (!this.llmProviderId) {
      this.llmKeyConfigured = false;
      return;
    }
    try {
      this.llmKeyConfigured = await this.agentSettings.hasApiKey(this.llmProviderId);
    } catch {
      this.llmKeyConfigured = false;
    }
  }

  private onLlmProviderChange(e: Event): void {
    const providerId = (e.target as HTMLSelectElement).value;
    this.llmProviderId = providerId;
    this.agentSettings.updatePreferences({ selectedProviderId: providerId });
    this.llmModelId = this.agentSettings.getSelectedModelId(providerId) ?? '';
    this.llmModelCustomMode = this.isLlmModelCustom(providerId, this.llmModelId);
    this.llmKeyInput = '';
    this.llmKeyMessage = null;
    this.llmModelsMessage = null;
    void this.refreshLlmKeyStatus();
  }

  private async onRefreshLlmModels(): Promise<void> {
    if (!this.llmProviderId || this.llmModelsBusy) {
      return;
    }
    this.llmModelsBusy = true;
    this.llmModelsMessage = null;
    try {
      const models = await this.llmModelCatalog.refresh(this.llmProviderId);
      this.llmModelsMessage = `Model list updated (${models.length} models).`;
      this.llmModelCustomMode = this.isLlmModelCustom(this.llmProviderId, this.llmModelId);
    } catch (error) {
      this.llmModelsMessage = `Failed to fetch models: ${error instanceof Error ? error.message : 'unknown error'}`;
    } finally {
      this.llmModelsBusy = false;
    }
  }

  private onLlmModelSelectChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value;
    if (value === '__custom__') {
      this.llmModelCustomMode = true;
      return;
    }
    this.llmModelCustomMode = false;
    this.agentSettings.updatePreferences({ modelByProvider: { [this.llmProviderId]: value } });
    this.llmModelId = value;
  }

  private onLlmModelChange(e: Event): void {
    const modelId = (e.target as HTMLInputElement).value.trim();
    this.llmModelId = modelId;
    if (modelId) {
      this.agentSettings.updatePreferences({ modelByProvider: { [this.llmProviderId]: modelId } });
    }
  }

  private onLlmBaseUrlChange(e: Event): void {
    this.llmBaseUrl = (e.target as HTMLInputElement).value.trim();
    this.agentSettings.updatePreferences({ customBaseUrl: this.llmBaseUrl });
  }

  private onLlmKeyInput(e: Event): void {
    this.llmKeyInput = (e.target as HTMLInputElement).value;
    this.llmKeyMessage = null;
  }

  private async onSaveLlmKey(): Promise<void> {
    const key = this.llmKeyInput.trim();
    if (!key || !this.llmProviderId) {
      return;
    }
    this.llmKeyBusy = true;
    try {
      await this.agentSettings.setApiKey(this.llmProviderId, key);
      this.llmKeyConfigured = true;
      this.llmKeyInput = '';
      this.llmKeyMessage = 'API key saved.';
    } catch (error) {
      this.llmKeyMessage = `Failed to save key: ${error instanceof Error ? error.message : 'unknown error'}`;
    } finally {
      this.llmKeyBusy = false;
    }
  }

  private async onClearLlmKey(): Promise<void> {
    if (!this.llmProviderId) {
      return;
    }
    this.llmKeyBusy = true;
    try {
      await this.agentSettings.clearApiKey(this.llmProviderId);
      this.llmKeyConfigured = false;
      this.llmKeyInput = '';
      this.llmKeyMessage = 'API key removed.';
    } catch (error) {
      this.llmKeyMessage = `Failed to remove key: ${error instanceof Error ? error.message : 'unknown error'}`;
    } finally {
      this.llmKeyBusy = false;
    }
  }

  private onWarnToggle(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.warnOnUnsavedUnload = target.checked;
  }

  private onPauseToggle(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.pauseRenderingOnUnfocus = target.checked;
  }

  private onPanSensitivityChange(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.navigation2D.panSensitivity = parseFloat(target.value);
  }

  private onZoomSensitivityChange(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.navigation2D.zoomSensitivity = parseFloat(target.value);
  }

  private onCancel(): void {
    this.editorSettingsService.close();
  }

  private async onSave(): Promise<void> {
    const operation = new UpdateEditorSettingsOperation({
      warnOnUnsavedUnload: this.warnOnUnsavedUnload,
      pauseRenderingOnUnfocus: this.pauseRenderingOnUnfocus,
      navigation2D: this.navigation2D,
    });

    await this.operationService.invoke(operation);
    this.editorSettingsService.close();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-editor-settings-dialog': EditorSettingsDialog;
  }
}
