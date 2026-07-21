import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { appState } from '@/state';
import { EditorSettingsService, type EditorSettingsTab } from '@/services/EditorSettingsService';
import { OperationService } from '@/services/OperationService';
import { UpdateEditorSettingsOperation } from '@/features/editor/UpdateEditorSettingsOperation';
import { AiImageSettingsService } from '@/services/AiImageSettingsService';
import { ImageGenProviderRegistry } from '@/services/image-gen/ImageGenProviderRegistry';
import { AgentSettingsService } from '@/services/AgentSettingsService';
import { AgentAdvisorService } from '@/services/agent/AgentAdvisorService';
import { AgentVisionService } from '@/services/agent/AgentVisionService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import { BridgeConnectionService } from '@/services/llm/BridgeConnectionService';
import { BRIDGE_TOKEN_SECRET_ID, DEFAULT_BRIDGE_URL } from '@/services/llm/BridgeProviders';
import { formatPricingHint, type LlmModel } from '@/services/llm/LlmTypes';
import { IconService, IconSize } from '@/services/IconService';
import type { BgRemovalEngine, BgRemovalQuality } from '@/services/bg-removal/types';
import type { Navigation2DSettings } from '@/state/AppState';
import './pix3-editor-settings-dialog.ts.css';

interface SettingsSubtab {
  id: string;
  label: string;
}

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

  @state()
  private activeSection: EditorSettingsTab = 'general';

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
  private bgEngine: BgRemovalEngine = 'imgly';

  @state()
  private bgQuality: BgRemovalQuality = 'balanced';

  @state()
  private bgFillHoles = true;

  @state()
  private defaultSaveMaxSize = 0;

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
    this.llmProviderId = agentPrefs.selectedProviderId || this.llmProviders.getDefault()?.id || '';
    this.llmModelId = this.agentSettings.getSelectedModelId(this.llmProviderId) ?? '';
    this.llmBaseUrl = agentPrefs.customBaseUrl;
    this.llmModelCustomMode = this.isLlmModelCustom(this.llmProviderId, this.llmModelId);
    this.llmDebugMode = agentPrefs.debugMode;
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

    // Re-render (and re-derive custom-mode) when a live model catalog lands in the background.
    this.disposeCatalogSubscription = this.llmModelCatalog.subscribe(() => {
      this.llmModelCustomMode = this.isLlmModelCustom(this.llmProviderId, this.llmModelId);
      this.requestUpdate();
    });
    // Re-render when the bridge connects/disconnects (dynamic providers appear/disappear).
    this.disposeBridgeSubscription = this.bridge.subscribe(() => {
      this.bridgeAvailable = this.bridge.isAvailable();
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
        return this.activeSubtab === 'assistants'
          ? this.renderAgentAssistantsTab()
          : this.renderAgentModelTab();
      case 'images':
        return this.activeSubtab === 'background'
          ? this.renderImagesBackgroundTab()
          : this.renderImagesGenerationTab();
    }
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
        <label class="toggle-row">
          <input
            type="checkbox"
            .checked=${this.warnOnUnsavedUnload}
            @change=${this.onWarnToggle}
          />
          <span>Warn me about unsaved changes when leaving the page</span>
        </label>
        <div class="hint">
          Disable this to skip the browser confirmation dialog on refresh or navigation.
        </div>
      </div>

      <div class="settings-field">
        <label class="toggle-row">
          <input
            type="checkbox"
            .checked=${this.pauseRenderingOnUnfocus}
            @change=${this.onPauseToggle}
          />
          <span>Pause rendering when window is unfocused</span>
        </label>
        <div class="hint">
          Reduces CPU/GPU usage and saves battery when you are working in another window.
        </div>
      </div>

      <div class="settings-section">
        <h3 class="section-title">2D Navigation</h3>

        <div class="settings-field">
          <label class="slider-row">
            <span>Pan Sensitivity: ${this.navigation2D.panSensitivity.toFixed(2)}</span>
            <input
              type="range"
              min="0.1"
              max="1.0"
              step="0.05"
              .value=${String(this.navigation2D.panSensitivity)}
              @input=${this.onPanSensitivityChange}
            />
          </label>
          <div class="hint">
            Controls how fast the camera pans with mouse wheel or trackpad gestures.
          </div>
        </div>

        <div class="settings-field">
          <label class="slider-row">
            <span>Zoom Sensitivity: ${this.navigation2D.zoomSensitivity.toFixed(4)}</span>
            <input
              type="range"
              min="0.001"
              max="0.01"
              step="0.0005"
              .value=${String(this.navigation2D.zoomSensitivity)}
              @input=${this.onZoomSensitivityChange}
            />
          </label>
          <div class="hint">
            Controls how fast the camera zooms with Ctrl+wheel or pinch gestures.
          </div>
        </div>
      </div>
    `;
  }

  private renderAgentModelTab() {
    const providers = this.llmProviders.list().filter(provider => !provider.hidden);
    if (providers.length === 0) {
      return html`<div class="hint">No LLM providers are registered.</div>`;
    }
    const provider = this.llmProviders.get(this.llmProviderId) ?? providers[0];
    const models = provider ? this.llmModelCatalog.getModels(provider.id) : [];
    const canRefreshModels = provider ? this.llmModelCatalog.supportsRefresh(provider.id) : false;
    const helpUrl = provider?.apiKeyHelpUrl;

    return html`
      ${this.renderBridgePanel()}
      <div class="settings-field">
        <label class="select-row">
          <span>Provider</span>
          <select @change=${this.onLlmProviderChange}>
            ${providers.map(
              item =>
                html`<option value=${item.id} ?selected=${item.id === this.llmProviderId}>
                  ${item.label}
                </option>`
            )}
          </select>
        </label>
      </div>

      <div class="settings-field">
        <label class="select-row">
          <span>Model</span>
          <select @change=${this.onLlmModelSelectChange}>
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
                class="btn-key-save llm-models-refresh ${this.llmModelsBusy ? 'is-busy' : ''}"
                title="Fetch the provider's current model list"
                aria-label="Refresh model list"
                @click=${this.onRefreshLlmModels}
                ?disabled=${this.llmModelsBusy}
              >
                ${this.icons.getIcon('refresh-cw', IconSize.SMALL)}
              </button>`
            : null}
        </label>
        ${this.llmModelsMessage ? html`<div class="hint">${this.llmModelsMessage}</div>` : null}
        ${this.llmModelCustomMode
          ? html`<input
              type="text"
              class="llm-custom-model"
              .value=${this.llmModelId}
              @change=${this.onLlmModelChange}
              placeholder="custom model id (e.g. a local model name)"
            />`
          : null}
      </div>

      ${provider?.requiresBaseUrl
        ? html`<div class="settings-field">
            <label class="select-row">
              <span>Base URL</span>
              <input
                type="text"
                .value=${this.llmBaseUrl}
                @change=${this.onLlmBaseUrlChange}
                placeholder=${provider.defaultBaseUrl ?? 'https://…'}
              />
            </label>
            <div class="hint">
              Hosted OpenAI by default; point it at Ollama / LM Studio for local models (enable CORS
              there, e.g. <code>OLLAMA_ORIGINS</code>).
            </div>
          </div>`
        : null}
      ${provider?.apiKeySecretId === BRIDGE_TOKEN_SECRET_ID
        ? html`<div class="hint">
            The API key for <strong>${provider.label}</strong> lives in Pix3AgentBridge on your
            machine — manage it there (<code
              >pix3-agent-bridge provider set-key ${provider.id} &lt;key&gt;</code
            >), not here.
          </div>`
        : html`<div class="settings-field">
            <span class="key-label">
              API Key
              <span class="key-status ${this.llmKeyConfigured ? 'is-set' : 'is-unset'}">
                ${this.llmKeyConfigured ? 'Configured' : 'Not set'}
              </span>
            </span>
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
            <div class="hint">
              ${this.llmKeyMessage
                ? html`<span>${this.llmKeyMessage}</span>`
                : html`Paste your provider API
                  key${helpUrl
                    ? html` (get one from
                        <a href=${helpUrl} target="_blank" rel="noreferrer">the provider console</a
                        >)`
                    : ''}.
                  Stored encrypted in this browser only — never synced, and only sent to the
                  selected provider.`}
            </div>
          </div>`}

      <div class="settings-field">
        <label class="toggle-row">
          <input
            type="checkbox"
            .checked=${this.llmDebugMode}
            @change=${this.onLlmDebugModeChange}
          />
          <span>Debug mode</span>
        </label>
        <div class="hint">
          Reveals the raw wire-format conversation log, the resolved system prompt, and per-response
          timing / tokens-per-second in the Agent panel, and logs every request and response to the
          browser devtools console.
        </div>
      </div>
    `;
  }

  /**
   * Pix3AgentBridge connection panel: pairing token + optional URL override + live status and the
   * list of providers the bridge currently serves. When the bridge is unreachable this is the setup
   * call to action (the metered providers are simply absent from the pickers until it connects).
   */
  private renderBridgePanel() {
    const entries = this.bridge.getEntries();
    const connected = this.bridgeAvailable;
    return html`
      <div class="settings-section">
        <h3 class="section-title">
          Pix3AgentBridge
          <span class="key-status ${connected ? 'is-set' : 'is-unset'}">
            ${connected ? 'Connected' : 'Not running'}
          </span>
        </h3>
        <div class="hint">
          Serves the metered providers (OpenAI, Anthropic, OpenCode Zen, custom) from your machine
          so keys never enter the browser. Gemini works without it. Start it with
          <code>npx pix3-agent-bridge</code>, then paste the pairing token it prints below and add
          providers with <code>pix3-agent-bridge provider add openai --key sk-…</code>.
        </div>

        <div class="settings-field">
          <span class="key-label">
            Pairing token
            <span class="key-status ${this.bridgeTokenConfigured ? 'is-set' : 'is-unset'}">
              ${this.bridgeTokenConfigured ? 'Configured' : 'Not set'}
            </span>
          </span>
          <div class="key-row">
            <input
              type="password"
              autocomplete="off"
              placeholder=${this.bridgeTokenConfigured ? '•••••••• stored' : 'Paste pairing token'}
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
            <button class="btn-key-save" @click=${this.onProbeBridge} ?disabled=${this.bridgeBusy}>
              Recheck
            </button>
          </div>
          ${this.bridgeMessage ? html`<div class="hint">${this.bridgeMessage}</div>` : null}
        </div>

        <div class="settings-field">
          <label class="select-row">
            <span>Bridge URL</span>
            <input
              type="text"
              .value=${this.bridgeUrlInput}
              @change=${this.onBridgeUrlChange}
              placeholder=${DEFAULT_BRIDGE_URL}
            />
          </label>
          <div class="hint">Only change this if you run the bridge on a non-default port.</div>
        </div>

        ${connected && entries.length > 0
          ? html`<div class="hint">Serving: ${entries.map(e => e.label).join(', ')}.</div>`
          : null}
      </div>
    `;
  }

  private onBridgeTokenInput = (event: Event): void => {
    this.bridgeTokenInput = (event.target as HTMLInputElement).value;
  };

  private onSaveBridgeToken = async (): Promise<void> => {
    const token = this.bridgeTokenInput.trim();
    if (!token) return;
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
    try {
      await this.bridge.probe();
      this.bridgeAvailable = this.bridge.isAvailable();
      this.bridgeMessage = this.bridgeAvailable
        ? `Connected — serving ${this.bridge.getEntries().length} provider(s).`
        : 'Bridge not reachable. Run `npx pix3-agent-bridge` and check the token/URL.';
    } finally {
      this.bridgeBusy = false;
    }
  };

  private renderAgentAssistantsTab() {
    if (this.llmProviders.list().length === 0) {
      return html`<div class="hint">No LLM providers are registered.</div>`;
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
    title: string;
    hint: string;
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

    return html`
      <div class="settings-subsection">
        <h4 class="subsection-title">${config.title}</h4>
        <div class="hint">${config.hint}</div>

        <div class="settings-field">
          <label class="select-row">
            <span>Provider</span>
            <select
              @change=${(e: Event) =>
                config.onProviderChange((e.target as HTMLSelectElement).value)}
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
          </label>
        </div>

        ${provider
          ? html`
              <div class="settings-field">
                <label class="select-row">
                  <span>Model</span>
                  <select
                    @change=${(e: Event) =>
                      config.onModelChange((e.target as HTMLSelectElement).value)}
                  >
                    <option value="" ?selected=${config.modelId === ''}>
                      ${config.modelDefaultLabel}
                    </option>
                    ${models.map(model => {
                      const hint = formatPricingHint(model.pricing);
                      return html`<option
                        value=${model.id}
                        ?selected=${model.id === config.modelId}
                      >
                        ${model.label}${hint ? ` · ${hint}` : ''}
                      </option>`;
                    })}
                  </select>
                </label>
              </div>

              <div class="settings-field">
                <span class="key-label">
                  ${provider.label} API Key
                  <span class="key-status ${config.keyConfigured ? 'is-set' : 'is-unset'}">
                    ${config.keyConfigured ? 'Configured' : 'Not set'}
                  </span>
                </span>
                <div class="key-row">
                  <input
                    type="password"
                    autocomplete="off"
                    placeholder=${config.keyConfigured ? '•••••••• stored' : 'Paste API key'}
                    .value=${config.keyInput}
                    @input=${(e: Event) => config.onKeyInput((e.target as HTMLInputElement).value)}
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
                <div class="hint">
                  Shares the encrypted key with this provider everywhere in the app.
                </div>
              </div>
            `
          : null}
        ${config.status ? html`<div class="hint">Currently resolved: ${config.status}</div>` : null}
      </div>
    `;
  }

  private renderAdvisorField() {
    return this.renderSecondaryLlm({
      title: 'Advisor model (optional)',
      hint: 'A deliberately stronger model the agent can consult via the ask_advisor tool when it is stuck or facing a design decision. Off by default — never auto-picked.',
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
      title: 'Vision helper (optional)',
      hint: 'Lets a text-only main model "see" images (analyze_image) by delegating to a vision-capable model. Auto = the first provider with a key and a vision model — which lands on your main model when it already supports images.',
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

  private renderImagesGenerationTab() {
    const providers = this.imageProviders.list();
    if (providers.length === 0) {
      return html`<div class="hint">No image providers are registered.</div>`;
    }
    const provider = this.imageProviders.get(this.aiProviderId) ?? providers[0];
    const models = provider?.models ?? [];
    const activeModel = provider?.getModel(this.aiModelId);
    const helpUrl = provider?.apiKeyHelpUrl;

    return html`
      <div class="settings-field">
        <label class="select-row">
          <span>Provider</span>
          <select @change=${this.onAiProviderChange}>
            ${providers.map(
              item =>
                html`<option value=${item.id} ?selected=${item.id === this.aiProviderId}>
                  ${item.label}
                </option>`
            )}
          </select>
        </label>
      </div>

      <div class="settings-field">
        <label class="select-row">
          <span>Model</span>
          <select @change=${this.onAiModelChange}>
            ${models.map(
              model =>
                html`<option value=${model.id} ?selected=${model.id === this.aiModelId}>
                  ${model.label}
                </option>`
            )}
          </select>
        </label>
        ${activeModel?.description
          ? html`<div class="hint">${activeModel.description}</div>`
          : null}
      </div>

      <div class="settings-field">
        <span class="key-label">
          API Key
          <span class="key-status ${this.aiKeyConfigured ? 'is-set' : 'is-unset'}">
            ${this.aiKeyConfigured ? 'Configured' : 'Not set'}
          </span>
        </span>
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
        <div class="hint">
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
      </div>

      <div class="settings-field">
        <label class="select-row">
          <span>Default save size (downscale)</span>
          <select @change=${this.onDefaultSaveSizeChange}>
            <option value="0" ?selected=${this.defaultSaveMaxSize === 0}>Original size</option>
            <option value="1024" ?selected=${this.defaultSaveMaxSize === 1024}>≤ 1024 px</option>
            <option value="512" ?selected=${this.defaultSaveMaxSize === 512}>≤ 512 px</option>
            <option value="256" ?selected=${this.defaultSaveMaxSize === 256}>≤ 256 px</option>
            <option value="128" ?selected=${this.defaultSaveMaxSize === 128}>≤ 128 px</option>
            <option value="64" ?selected=${this.defaultSaveMaxSize === 64}>≤ 64 px</option>
          </select>
        </label>
        <div class="hint">
          Downscales the longest edge when saving a generated image into the project (never
          upscales). Game elements rarely need the full 1K/2K generation. Overridable per-save in
          the Sprite Editor.
        </div>
      </div>
    `;
  }

  private renderImagesBackgroundTab() {
    return html`
      <div class="settings-field">
        <label class="select-row">
          <span>Background removal engine</span>
          <select @change=${this.onBgEngineChange}>
            <option value="imgly" ?selected=${this.bgEngine === 'imgly'}>
              imgly · ISNet (reliable)
            </option>
            <option value="birefnet" ?selected=${this.bgEngine === 'birefnet'}>
              BiRefNet (MIT, heavier)
            </option>
          </select>
        </label>
        ${this.bgEngine === 'birefnet'
          ? html`<label class="select-row">
              <span>BiRefNet quality</span>
              <select @change=${this.onBgQualityChange}>
                <option value="balanced" ?selected=${this.bgQuality === 'balanced'}>
                  Balanced (lite)
                </option>
                <option value="max" ?selected=${this.bgQuality === 'max'}>
                  Max (full, large download)
                </option>
              </select>
            </label>`
          : null}
        <label class="toggle-row">
          <input type="checkbox" .checked=${this.bgFillHoles} @change=${this.onBgFillHolesChange} />
          <span>Fill interior holes (solid cutout)</span>
        </label>
        <div class="hint">
          Runs on-device (no API key).
          ${this.bgEngine === 'imgly'
            ? 'imgly uses the ISNet model (AGPL-3.0 — commercial use needs an IMG.LY license). Runs on CPU or WebGPU.'
            : 'BiRefNet is MIT-licensed (commercial-safe) and higher quality, but its model runs at a fixed 1024² and REQUIRES a WebGPU browser (Chrome/Edge). Without WebGPU use imgly.'}
        </div>
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
