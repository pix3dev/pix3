import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { appState, type ProjectBackend } from '@/state';
import {
  ProjectAuthRequiredError,
  ProjectLifecycleService,
  type CreateProjectParams,
} from '@/services/ProjectLifecycleService';
import { BrowserProjectStorageService } from '@/services/BrowserProjectStorageService';
import { ProjectTemplateService, type ProjectTemplate } from '@/services/ProjectTemplateService';
import type { TargetPlatform } from '@/core/ProjectManifest';
import './pix3-create-project-dialog.ts.css';

type ViewportPresetId = '1920x1080' | '1280x720' | '1080x1920' | '1080x1080' | 'custom';

const VIEWPORT_PRESETS: Array<{
  id: ViewportPresetId;
  label: string;
  width: number;
  height: number;
}> = [
  { id: '1920x1080', label: 'Full HD (1920 x 1080)', width: 1920, height: 1080 },
  { id: '1280x720', label: 'HD (1280 x 720)', width: 1280, height: 720 },
  { id: '1080x1920', label: 'Mobile Portrait (1080 x 1920)', width: 1080, height: 1920 },
  { id: '1080x1080', label: 'Square (1080 x 1080)', width: 1080, height: 1080 },
  { id: 'custom', label: 'Custom', width: 1920, height: 1080 },
];

const TARGET_PLATFORM_OPTIONS: Array<{
  id: TargetPlatform;
  label: string;
  hint: string;
}> = [
  {
    id: 'mobile',
    label: 'Mobile',
    hint: 'Lean rendering: no antialiasing or shadows, pixel ratio capped at 2.',
  },
  {
    id: 'desktop',
    label: 'Desktop',
    hint: 'Rich rendering: antialiasing and shadows on, higher pixel ratio.',
  },
  {
    id: 'universal',
    label: 'Universal',
    hint: 'Balanced defaults that run well on both desktop and mobile.',
  },
];

@customElement('pix3-create-project-dialog')
export class Pix3CreateProjectDialog extends ComponentBase {
  @inject(ProjectLifecycleService)
  private readonly projectLifecycleService!: ProjectLifecycleService;

  @inject(ProjectTemplateService)
  private readonly projectTemplateService!: ProjectTemplateService;

  @inject(BrowserProjectStorageService)
  private readonly browserStore!: BrowserProjectStorageService;

  @property({ type: String, reflect: true })
  public dialogId = '';

  @property({ type: String, reflect: true, attribute: 'initial-backend' })
  public initialBackend: ProjectBackend = 'local';

  @state() private step: 'template' | 'settings' = 'template';
  @state() private templateId = '';
  @state() private name = 'New Project';
  @state() private backend: ProjectBackend = 'local';
  @state() private targetPlatform: TargetPlatform = 'universal';
  @state() private preset: ViewportPresetId = '1920x1080';
  @state() private viewportBaseWidth = '1920';
  @state() private viewportBaseHeight = '1080';
  @state() private error = '';
  @state() private submitting = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.backend = this.initialBackend;
    const defaultTemplate = this.projectTemplateService.getDefaultTemplate();
    this.applyTemplateDefaults(defaultTemplate);
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('initialBackend')) {
      this.backend = this.initialBackend;
    }
  }

  protected render() {
    return html`
      <div class="create-project-backdrop" @click=${this.onCancel}>
        <div
          class="create-project-content ${this.step === 'template'
            ? 'create-project-content--wide'
            : ''}"
          @click=${(event: Event) => event.stopPropagation()}
        >
          <h2 class="create-project-title">
            ${this.step === 'template' ? 'New Project — Choose a Template' : 'New Project'}
          </h2>
          ${this.step === 'template' ? this.renderTemplateStep() : this.renderSettingsStep()}
        </div>
      </div>
    `;
  }

  private renderTemplateStep() {
    const templates = this.projectTemplateService.getTemplates();

    return html`
      <div class="template-grid" role="listbox" aria-label="Project templates">
        ${templates.map(
          template => html`
            <button
              type="button"
              role="option"
              aria-selected=${this.templateId === template.id ? 'true' : 'false'}
              class="template-card ${this.templateId === template.id
                ? 'template-card--selected'
                : ''}"
              @click=${() => this.onTemplateSelected(template)}
              @dblclick=${() => {
                this.onTemplateSelected(template);
                this.step = 'settings';
              }}
            >
              <span class="template-card__cover">
                ${template.coverUrl
                  ? html`<img src=${template.coverUrl} alt="" loading="lazy" />`
                  : html`<span class="template-card__cover-fallback">${template.title}</span>`}
              </span>
              <span class="template-card__body">
                <span class="template-card__title">
                  ${template.title}
                  <span class="template-card__badge">${template.projectType.toUpperCase()}</span>
                </span>
                <span class="template-card__description">${template.description}</span>
              </span>
            </button>
          `
        )}
      </div>

      <div class="create-project-actions">
        <button type="button" class="btn-cancel" @click=${this.onCancel}>Cancel</button>
        <button
          type="button"
          class="btn-confirm"
          ?disabled=${!this.templateId}
          @click=${() => (this.step = 'settings')}
        >
          Next
        </button>
      </div>
    `;
  }

  private renderSettingsStep() {
    const isCloudUnauthenticated = this.backend === 'cloud' && !appState.auth.isAuthenticated;
    const selectedTemplate = this.projectTemplateService.getTemplate(this.templateId);

    return html`
      <div class="settings-form">
        ${selectedTemplate
          ? html`
              <div class="selected-template">
                <span class="selected-template__label">Template</span>
                <span class="selected-template__value">
                  ${selectedTemplate.title}
                  <button
                    type="button"
                    class="selected-template__change"
                    @click=${() => (this.step = 'template')}
                  >
                    Change
                  </button>
                </span>
              </div>
            `
          : null}

        <div class="settings-field">
          <label for="projectName">Project Name</label>
          <input
            id="projectName"
            type="text"
            .value=${this.name}
            @input=${(event: InputEvent) => (this.name = (event.target as HTMLInputElement).value)}
            placeholder="New Project"
          />
        </div>

        <div class="settings-field">
          <label>Storage</label>
          <div class="backend-toggle">
            ${this.browserStore.isSupported()
              ? html`
                  <button
                    type="button"
                    class="backend-option ${this.backend === 'browser'
                      ? 'backend-option--active'
                      : ''}"
                    @click=${() => (this.backend = 'browser')}
                  >
                    In Browser
                  </button>
                `
              : null}
            <button
              type="button"
              class="backend-option ${this.backend === 'local' ? 'backend-option--active' : ''}"
              @click=${() => (this.backend = 'local')}
            >
              Folder
            </button>
            <button
              type="button"
              class="backend-option ${this.backend === 'cloud' ? 'backend-option--active' : ''}"
              @click=${() => (this.backend = 'cloud')}
            >
              Cloud
            </button>
          </div>
          <div class="backend-copy">
            ${this.backend === 'browser'
              ? html`
                  <p>
                    Instant start — the project is stored inside this browser. No folder or account
                    needed. You can move it to a folder or the cloud later.
                  </p>
                `
              : this.backend === 'local'
                ? html`
                    <p>
                      Folder will keep all data on your computer in the local folder. Best for
                      private, small or test projects.
                    </p>
                  `
                : html`
                    <p>
                      Cloud will keep data on the server and allow you to share and collaborate.
                    </p>
                  `}
          </div>
          ${this.backend === 'cloud'
            ? html`
                <div class="cloud-auth-status">
                  <div class="cloud-auth-status__label">
                    ${appState.auth.isAuthenticated
                      ? `Logged in as ${appState.auth.user?.username ?? 'User'}`
                      : 'Not logged in'}
                  </div>
                  ${!appState.auth.isAuthenticated
                    ? html`
                        <button
                          type="button"
                          class="cloud-auth-status__button"
                          @click=${this.onLoginRequest}
                        >
                          Login
                        </button>
                      `
                    : null}
                </div>
                ${!appState.auth.isAuthenticated
                  ? html`<div class="cloud-auth-status__hint">Login to create cloud project</div>`
                  : null}
              `
            : null}
        </div>

        <div class="settings-field">
          <label>Target Platform</label>
          <div class="backend-toggle">
            ${TARGET_PLATFORM_OPTIONS.map(
              option => html`
                <button
                  type="button"
                  class="backend-option ${this.targetPlatform === option.id
                    ? 'backend-option--active'
                    : ''}"
                  @click=${() => (this.targetPlatform = option.id)}
                >
                  ${option.label}
                </button>
              `
            )}
          </div>
          <div class="backend-copy">
            <p>
              ${TARGET_PLATFORM_OPTIONS.find(option => option.id === this.targetPlatform)?.hint ??
              ''}
            </p>
          </div>
        </div>

        <div class="settings-field">
          <label for="viewportPreset">Base Size</label>
          <select id="viewportPreset" .value=${this.preset} @change=${this.onPresetChange}>
            ${VIEWPORT_PRESETS.map(
              preset => html`<option value=${preset.id}>${preset.label}</option>`
            )}
          </select>
        </div>

        <div class="settings-grid-2col">
          <div class="settings-field">
            <label for="viewportWidth">Width</label>
            <input
              id="viewportWidth"
              type="number"
              min="64"
              step="1"
              .value=${this.viewportBaseWidth}
              @input=${(event: InputEvent) => {
                this.viewportBaseWidth = (event.target as HTMLInputElement).value;
                this.preset = 'custom';
              }}
            />
          </div>
          <div class="settings-field">
            <label for="viewportHeight">Height</label>
            <input
              id="viewportHeight"
              type="number"
              min="64"
              step="1"
              .value=${this.viewportBaseHeight}
              @input=${(event: InputEvent) => {
                this.viewportBaseHeight = (event.target as HTMLInputElement).value;
                this.preset = 'custom';
              }}
            />
          </div>
        </div>

        ${this.error ? html`<div class="create-project-error">${this.error}</div>` : null}
      </div>

      <div class="create-project-actions">
        <button type="button" class="btn-cancel" @click=${() => (this.step = 'template')}>
          Back
        </button>
        <button type="button" class="btn-cancel" @click=${this.onCancel}>Cancel</button>
        <button
          type="button"
          class="btn-confirm"
          @click=${this.onSubmit}
          ?disabled=${this.submitting || isCloudUnauthenticated}
        >
          ${this.submitting ? 'Creating...' : 'Create'}
        </button>
      </div>
    `;
  }

  private onTemplateSelected(template: ProjectTemplate): void {
    this.templateId = template.id;
    this.applyTemplateDefaults(template);
  }

  private applyTemplateDefaults(template: ProjectTemplate | null): void {
    if (!template) {
      return;
    }
    this.templateId = template.id;
    this.targetPlatform = template.targetPlatform;
    this.viewportBaseWidth = String(template.viewport.width);
    this.viewportBaseHeight = String(template.viewport.height);
    this.preset =
      VIEWPORT_PRESETS.find(
        preset =>
          preset.id !== 'custom' &&
          preset.width === template.viewport.width &&
          preset.height === template.viewport.height
      )?.id ?? 'custom';
  }

  private onPresetChange = (event: Event): void => {
    const presetId = (event.target as HTMLSelectElement).value as ViewportPresetId;
    this.preset = presetId;
    const preset = VIEWPORT_PRESETS.find(entry => entry.id === presetId);
    if (!preset || preset.id === 'custom') {
      return;
    }

    this.viewportBaseWidth = String(preset.width);
    this.viewportBaseHeight = String(preset.height);
  };

  private onCancel = (): void => {
    this.projectLifecycleService.closeCreateDialog();
  };

  private onLoginRequest = (): void => {
    this.dispatchEvent(
      new CustomEvent('pix3-auth:request', {
        detail: { projectId: null, source: 'create-cloud-project' },
        bubbles: true,
        composed: true,
      })
    );
  };

  private onSubmit = async (): Promise<void> => {
    this.error = '';
    this.submitting = true;

    const width = Math.max(64, Number(this.viewportBaseWidth) || 1920);
    const height = Math.max(64, Number(this.viewportBaseHeight) || 1080);
    const template = this.projectTemplateService.getTemplate(this.templateId);
    const params: CreateProjectParams = {
      name: this.name.trim() || 'New Project',
      backend: this.backend,
      viewportBaseWidth: width,
      viewportBaseHeight: height,
      templateId: this.templateId || undefined,
      projectType: template?.projectType,
      targetPlatform: this.targetPlatform,
    };

    try {
      await this.projectLifecycleService.createProject(params);
    } catch (error) {
      if (error instanceof ProjectAuthRequiredError) {
        this.dispatchEvent(
          new CustomEvent('pix3-auth:request', {
            detail: { projectId: null, source: 'create-cloud-project' },
            bubbles: true,
            composed: true,
          })
        );
      } else {
        this.error = error instanceof Error ? error.message : 'Failed to create project';
      }
    } finally {
      this.submitting = false;
    }
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-create-project-dialog': Pix3CreateProjectDialog;
  }
}
