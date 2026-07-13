import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { appState } from '@/state';
import { EditorSettingsService, type EditorSettingsTab } from '@/services/EditorSettingsService';
import { OperationService } from '@/services/OperationService';
import { UpdateEditorSettingsOperation } from '@/features/editor/UpdateEditorSettingsOperation';
import { AiImageSettingsService } from '@/services/AiImageSettingsService';
import { ImageGenProviderRegistry } from '@/services/image-gen/ImageGenProviderRegistry';
import { AgentSettingsService } from '@/services/AgentSettingsService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import { LlmModelCatalogService } from '@/services/llm/LlmModelCatalogService';
import { formatPricingHint } from '@/services/llm/LlmTypes';
import type { BgRemovalEngine, BgRemovalQuality } from '@/services/bg-removal/types';
import type { Navigation2DSettings } from '@/state/AppState';
import './pix3-editor-settings-dialog.ts.css';

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

  @inject(LlmProviderRegistry)
  private readonly llmProviders!: LlmProviderRegistry;

  @inject(LlmModelCatalogService)
  private readonly llmModelCatalog!: LlmModelCatalogService;

  @state()
  private activeTab: EditorSettingsTab = 'general';

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
  private bgEngine: BgRemovalEngine = 'imgly';

  @state()
  private bgQuality: BgRemovalQuality = 'balanced';

  @state()
  private bgFillHoles = true;

  @state()
  private defaultSaveMaxSize = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.activeTab = this.editorSettingsService.getInitialTab();
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
    void this.refreshLlmKeyStatus();

    // Re-render (and re-derive custom-mode) when a live model catalog lands in the background.
    this.disposeCatalogSubscription = this.llmModelCatalog.subscribe(() => {
      this.llmModelCustomMode = this.isLlmModelCustom(this.llmProviderId, this.llmModelId);
      this.requestUpdate();
    });
  }

  disconnectedCallback(): void {
    this.disposeCatalogSubscription?.();
    this.disposeCatalogSubscription = undefined;
    super.disconnectedCallback();
  }

  private disposeCatalogSubscription?: () => void;

  /** A stored model not in the provider's (live or static) list is a hand-typed custom id. */
  private isLlmModelCustom(providerId: string, modelId: string): boolean {
    if (!modelId) return false;
    const models = this.llmModelCatalog.getModels(providerId);
    return !models.some(m => m.id === modelId);
  }

  protected render() {
    return html`
      <div class="dialog-backdrop" @click=${this.onCancel}>
        <div class="dialog-content" @click=${(e: Event) => e.stopPropagation()}>
          <h2 class="dialog-title">Editor Settings</h2>

          <div class="settings-tabs" role="tablist">
            <button
              class="settings-tab ${this.activeTab === 'general' ? 'is-active' : ''}"
              role="tab"
              aria-selected=${this.activeTab === 'general'}
              @click=${() => this.selectTab('general')}
            >
              General
            </button>
            <button
              class="settings-tab ${this.activeTab === 'ai' ? 'is-active' : ''}"
              role="tab"
              aria-selected=${this.activeTab === 'ai'}
              @click=${() => this.selectTab('ai')}
            >
              AI Generation
            </button>
          </div>

          <div class="settings-form">
            ${this.activeTab === 'general' ? this.renderGeneralTab() : this.renderAiTab()}
          </div>

          <div class="dialog-actions">
            <button class="btn-cancel" @click=${this.onCancel}>Cancel</button>
            <button class="btn-save" @click=${this.onSave}>Save Changes</button>
          </div>
        </div>
      </div>
    `;
  }

  private selectTab(tab: EditorSettingsTab): void {
    this.activeTab = tab;
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

  private renderAiTab() {
    const imageSection = this.renderAiProvidersSection();
    const llmSection = this.renderLlmProvidersSection();
    if (!imageSection && !llmSection) {
      return html`<div class="hint">No AI providers are registered.</div>`;
    }
    return html`${llmSection}${imageSection}`;
  }

  private renderLlmProvidersSection() {
    const providers = this.llmProviders.list();
    if (providers.length === 0) {
      return null;
    }
    const provider = this.llmProviders.get(this.llmProviderId) ?? providers[0];
    const models = provider ? this.llmModelCatalog.getModels(provider.id) : [];
    const canRefreshModels = provider ? this.llmModelCatalog.supportsRefresh(provider.id) : false;
    const helpUrl = provider?.apiKeyHelpUrl;

    return html`
      <div class="settings-section">
        <h3 class="section-title">Agent (LLM) Provider</h3>
        <div class="hint">Powers the in-editor Agent chat (Tools → Agent Chat).</div>

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
                  class="btn-key-save llm-models-refresh"
                  title="Fetch the provider's current model list"
                  aria-label="Refresh model list"
                  @click=${this.onRefreshLlmModels}
                  ?disabled=${this.llmModelsBusy}
                >
                  ${this.llmModelsBusy ? '…' : '↻'}
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
                Hosted OpenAI by default; point it at Ollama / LM Studio for local models (enable
                CORS there, e.g. <code>OLLAMA_ORIGINS</code>).
              </div>
            </div>`
          : null}

        <div class="settings-field">
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
                      <a href=${helpUrl} target="_blank" rel="noreferrer">the provider console</a>)`
                  : ''}.
                Stored encrypted in this browser only — never synced, and only sent to the selected
                provider.`}
          </div>
        </div>
      </div>
    `;
  }

  private renderAiProvidersSection() {
    const providers = this.imageProviders.list();
    if (providers.length === 0) {
      return null;
    }
    const provider = this.imageProviders.get(this.aiProviderId) ?? providers[0];
    const models = provider?.models ?? [];
    const activeModel = provider?.getModel(this.aiModelId);
    const helpUrl = provider?.apiKeyHelpUrl;

    return html`
      <div class="settings-section">
        <h3 class="section-title">AI Image Providers</h3>

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
            the Asset Generator.
          </div>
        </div>

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
            <input
              type="checkbox"
              .checked=${this.bgFillHoles}
              @change=${this.onBgFillHolesChange}
            />
            <span>Fill interior holes (solid cutout)</span>
          </label>
          <div class="hint">
            Runs on-device (no API key).
            ${this.bgEngine === 'imgly'
              ? 'imgly uses the ISNet model (AGPL-3.0 — commercial use needs an IMG.LY license). Runs on CPU or WebGPU.'
              : 'BiRefNet is MIT-licensed (commercial-safe) and higher quality, but its model runs at a fixed 1024² and REQUIRES a WebGPU browser (Chrome/Edge). Without WebGPU use imgly.'}
          </div>
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
