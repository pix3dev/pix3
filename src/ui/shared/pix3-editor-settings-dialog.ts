import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { appState } from '@/state';
import { EditorSettingsService } from '@/services/EditorSettingsService';
import { OperationService } from '@/services/OperationService';
import { UpdateEditorSettingsOperation } from '@/features/editor/UpdateEditorSettingsOperation';
import { AiImageSettingsService } from '@/services/AiImageSettingsService';
import { ImageGenProviderRegistry } from '@/services/image-gen/ImageGenProviderRegistry';
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
  private bgEngine: BgRemovalEngine = 'imgly';

  @state()
  private bgQuality: BgRemovalQuality = 'balanced';

  connectedCallback(): void {
    super.connectedCallback();
    this.warnOnUnsavedUnload = appState.ui.warnOnUnsavedUnload;
    this.pauseRenderingOnUnfocus = appState.ui.pauseRenderingOnUnfocus;
    this.navigation2D = { ...appState.ui.navigation2D };

    const prefs = this.aiImageSettings.getPreferences();
    this.aiProviderId = prefs.selectedProviderId || this.imageProviders.getDefault()?.id || '';
    this.aiModelId = this.aiImageSettings.getSelectedModelId(this.aiProviderId) ?? '';
    this.bgEngine = prefs.bgRemovalEngine;
    this.bgQuality = prefs.bgRemovalQuality;
    void this.refreshAiKeyStatus();
  }

  protected render() {
    return html`
      <div class="dialog-backdrop" @click=${this.onCancel}>
        <div class="dialog-content" @click=${(e: Event) => e.stopPropagation()}>
          <h2 class="dialog-title">Editor Settings</h2>

          <div class="settings-form">
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

            ${this.renderAiProvidersSection()}
          </div>

          <div class="dialog-actions">
            <button class="btn-cancel" @click=${this.onCancel}>Cancel</button>
            <button class="btn-save" @click=${this.onSave}>Save Changes</button>
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
