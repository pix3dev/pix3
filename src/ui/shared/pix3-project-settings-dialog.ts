import { ComponentBase, customElement, html, inject, state, subscribe } from '@/fw';
import { appState } from '@/state';
import { ProjectSettingsService } from '@/services/ProjectSettingsService';
import { OperationService } from '@/services/OperationService';
import { UpdateProjectSettingsOperation } from '@/features/project/UpdateProjectSettingsOperation';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { AddAutoloadCommand } from '@/features/project/AddAutoloadCommand';
import { RemoveAutoloadCommand } from '@/features/project/RemoveAutoloadCommand';
import { ToggleAutoloadEnabledCommand } from '@/features/project/ToggleAutoloadEnabledCommand';
import { ReorderAutoloadCommand } from '@/features/project/ReorderAutoloadCommand';
import './pix3-project-settings-dialog.ts.css';

type SettingsTab = 'general' | 'autoload';

@customElement('pix3-project-settings-dialog')
export class ProjectSettingsDialog extends ComponentBase {
  @inject(ProjectSettingsService)
  private readonly projectSettingsService!: ProjectSettingsService;

  @inject(OperationService)
  private readonly operationService!: OperationService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @state()
  private projectName: string = '';

  @state()
  private localAbsolutePath: string = '';

  @state()
  private defaultExportScenePath: string = '';

  @state()
  private viewportBaseWidth: string = '1920';

  @state()
  private viewportBaseHeight: string = '1080';

  private defaultExportScenePathDirty = false;
  private viewportBaseWidthDirty = false;
  private viewportBaseHeightDirty = false;

  @state()
  private activeTab: SettingsTab = 'general';

  @state()
  private autoloadScriptPath: string = '';

  @state()
  private autoloadSingleton: string = '';

  @state()
  private autoloadEnabled: boolean = true;

  @state()
  private autoloadError: string | null = null;

  private disposeProjectSubscription?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.projectName = appState.project.projectName ?? '';
    this.localAbsolutePath = appState.project.localAbsolutePath ?? '';
    this.syncFormFieldsFromManifest();
    this.disposeProjectSubscription = subscribe(appState.project, () => {
      this.syncFormFieldsFromManifest();
      this.requestUpdate();
    });
  }

  disconnectedCallback(): void {
    this.disposeProjectSubscription?.();
    this.disposeProjectSubscription = undefined;
    super.disconnectedCallback();
  }

  protected render() {
    const autoloads = appState.project.manifest?.autoloads ?? [];

    return html`
      <div class="dialog-backdrop" @click=${this.onCancel}>
        <div class="dialog-content" @click=${(e: Event) => e.stopPropagation()}>
          <h2 class="dialog-title">Project Settings</h2>

          <div class="settings-tabs">
            <button
              class="settings-tab ${this.activeTab === 'general' ? 'settings-tab--active' : ''}"
              @click=${() => (this.activeTab = 'general')}
            >
              General
            </button>
            <button
              class="settings-tab ${this.activeTab === 'autoload' ? 'settings-tab--active' : ''}"
              @click=${() => (this.activeTab = 'autoload')}
            >
              Autoload
            </button>
          </div>

          ${this.activeTab === 'general'
            ? html`
                <div class="settings-form">
                  <div class="settings-field">
                    <label for="projectName">Project Name</label>
                    <input
                      id="projectName"
                      type="text"
                      .value=${this.projectName}
                      @input=${(e: InputEvent) =>
                        (this.projectName = (e.target as HTMLInputElement).value)}
                      placeholder="My Awesome Project"
                    />
                  </div>

                  <div class="settings-field">
                    <label for="defaultExportScenePath">Default Export Scene Path</label>
                    <input
                      id="defaultExportScenePath"
                      type="text"
                      .value=${this.defaultExportScenePath}
                      @input=${(e: InputEvent) => {
                        this.defaultExportScenePath = (e.target as HTMLInputElement).value;
                        this.defaultExportScenePathDirty = true;
                      }}
                      placeholder="src/assets/scenes/main.pix3scene"
                    />
                    <div class="hint">
                      Project-relative scene path used as the default startup scene for playable
                      export. You can override it in the export dialog.
                    </div>
                  </div>

                  <div class="settings-field">
                    <label for="localAbsolutePath">Local Project Path (Absolute)</label>
                    <input
                      id="localAbsolutePath"
                      type="text"
                      .value=${this.localAbsolutePath}
                      @input=${(e: InputEvent) =>
                        (this.localAbsolutePath = (e.target as HTMLInputElement).value)}
                      placeholder="/Users/name/projects/my-game"
                    />
                    <div class="hint">
                      Configure the absolute path to your project root to enable VS Code
                      integration. Example: <code>/Users/name/Projects/my-pix3-game</code>
                    </div>
                  </div>

                  <div class="settings-grid-2col">
                    <div class="settings-field">
                      <label for="viewportBaseWidth">Base Viewport Width</label>
                      <input
                        id="viewportBaseWidth"
                        type="number"
                        min="64"
                        step="1"
                        .value=${this.viewportBaseWidth}
                        @input=${(e: InputEvent) => {
                          this.viewportBaseWidth = (e.target as HTMLInputElement).value;
                          this.viewportBaseWidthDirty = true;
                        }}
                      />
                    </div>

                    <div class="settings-field">
                      <label for="viewportBaseHeight">Base Viewport Height</label>
                      <input
                        id="viewportBaseHeight"
                        type="number"
                        min="64"
                        step="1"
                        .value=${this.viewportBaseHeight}
                        @input=${(e: InputEvent) => {
                          this.viewportBaseHeight = (e.target as HTMLInputElement).value;
                          this.viewportBaseHeightDirty = true;
                        }}
                      />
                    </div>
                  </div>

                  <div class="settings-field">
                    <div class="hint">
                      Base viewport size is used as the editor reference frame for 2D composition
                      and camera scaling.
                    </div>
                  </div>
                </div>
              `
            : html`
                <div class="autoload-form">
                  <div class="settings-field">
                    <label for="autoloadScriptPath">Script Path</label>
                    <input
                      id="autoloadScriptPath"
                      type="text"
                      .value=${this.autoloadScriptPath}
                      @input=${(e: InputEvent) =>
                        (this.autoloadScriptPath = (e.target as HTMLInputElement).value)}
                      placeholder="scripts/GameManager.ts"
                    />
                  </div>
                  <div class="settings-field">
                    <label for="autoloadSingleton">Singleton Name</label>
                    <input
                      id="autoloadSingleton"
                      type="text"
                      .value=${this.autoloadSingleton}
                      @input=${(e: InputEvent) =>
                        (this.autoloadSingleton = (e.target as HTMLInputElement).value)}
                      placeholder="GameManager"
                    />
                  </div>
                  <label class="autoload-enabled-label">
                    <input
                      type="checkbox"
                      .checked=${this.autoloadEnabled}
                      @change=${(e: Event) =>
                        (this.autoloadEnabled = (e.target as HTMLInputElement).checked)}
                    />
                    Enabled
                  </label>
                  <button class="btn-save" @click=${() => this.onAddAutoload()}>
                    Add Autoload
                  </button>
                  ${this.autoloadError
                    ? html`<div class="autoload-error">${this.autoloadError}</div>`
                    : ''}

                  <div class="autoload-table">
                    <div class="autoload-row autoload-row--header">
                      <span>#</span>
                      <span>Enabled</span>
                      <span>Singleton</span>
                      <span>Script</span>
                      <span>Actions</span>
                    </div>
                    ${autoloads.map(
                      (entry, index) => html`
                        <div class="autoload-row">
                          <span>${index + 1}</span>
                          <input
                            type="checkbox"
                            .checked=${entry.enabled}
                            @change=${(e: Event) =>
                              this.onToggleAutoload(
                                entry.singleton,
                                (e.target as HTMLInputElement).checked
                              )}
                          />
                          <span>${entry.singleton}</span>
                          <span class="autoload-path">${entry.scriptPath}</span>
                          <span class="autoload-actions">
                            <button
                              class="btn-small"
                              ?disabled=${index === 0}
                              @click=${() => this.onReorderAutoload(index, index - 1)}
                            >
                              ↑
                            </button>
                            <button
                              class="btn-small"
                              ?disabled=${index === autoloads.length - 1}
                              @click=${() => this.onReorderAutoload(index, index + 1)}
                            >
                              ↓
                            </button>
                            <button
                              class="btn-small btn-small--danger"
                              @click=${() => this.onRemoveAutoload(entry.singleton)}
                            >
                              Remove
                            </button>
                          </span>
                        </div>
                      `
                    )}
                  </div>
                </div>
              `}

          <div class="dialog-actions">
            <button class="btn-cancel" @click=${this.onCancel}>Cancel</button>
            ${this.activeTab === 'general'
              ? html`<button class="btn-save" @click=${this.onSave}>Save Changes</button>`
              : ''}
          </div>
        </div>
      </div>
    `;
  }

  private onCancel(): void {
    this.projectSettingsService.close();
  }

  private async onSave(): Promise<void> {
    const parsedViewportBaseWidth = Number(this.viewportBaseWidth);
    const parsedViewportBaseHeight = Number(this.viewportBaseHeight);

    const operation = new UpdateProjectSettingsOperation({
      projectName: this.projectName.trim() || undefined,
      localAbsolutePath: this.localAbsolutePath.trim() || null,
      defaultExportScenePath: this.defaultExportScenePath.trim() || null,
      viewportBaseWidth: Number.isFinite(parsedViewportBaseWidth)
        ? Math.max(64, Math.round(parsedViewportBaseWidth))
        : 1920,
      viewportBaseHeight: Number.isFinite(parsedViewportBaseHeight)
        ? Math.max(64, Math.round(parsedViewportBaseHeight))
        : 1080,
    });

    await this.operationService.invokeAndPush(operation);
    this.defaultExportScenePathDirty = false;
    this.viewportBaseWidthDirty = false;
    this.viewportBaseHeightDirty = false;
    this.projectSettingsService.close();
  }

  private syncFormFieldsFromManifest(): void {
    const manifest = appState.project.manifest;
    if (!manifest) {
      return;
    }

    if (!this.defaultExportScenePathDirty) {
      this.defaultExportScenePath = manifest.defaultExportScenePath ?? '';
    }

    if (!this.viewportBaseWidthDirty) {
      this.viewportBaseWidth = String(manifest.viewportBaseSize.width);
    }

    if (!this.viewportBaseHeightDirty) {
      this.viewportBaseHeight = String(manifest.viewportBaseSize.height);
    }
  }

  private async onAddAutoload(): Promise<void> {
    const command = new AddAutoloadCommand({
      scriptPath: this.autoloadScriptPath.trim(),
      singleton: this.autoloadSingleton.trim(),
      enabled: this.autoloadEnabled,
    });
    const didMutate = await this.commandDispatcher.execute(command);
    if (!didMutate) {
      this.autoloadError =
        'Failed to add autoload. Ensure script exists and singleton is unique/valid.';
      return;
    }
    this.autoloadScriptPath = '';
    this.autoloadSingleton = '';
    this.autoloadEnabled = true;
    this.autoloadError = null;
  }

  private async onRemoveAutoload(singleton: string): Promise<void> {
    await this.commandDispatcher.execute(
      new RemoveAutoloadCommand({
        singleton,
      })
    );
  }

  private async onToggleAutoload(singleton: string, enabled: boolean): Promise<void> {
    await this.commandDispatcher.execute(
      new ToggleAutoloadEnabledCommand({
        singleton,
        enabled,
      })
    );
  }

  private async onReorderAutoload(fromIndex: number, toIndex: number): Promise<void> {
    await this.commandDispatcher.execute(
      new ReorderAutoloadCommand({
        fromIndex,
        toIndex,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-project-settings-dialog': ProjectSettingsDialog;
  }
}
