import { ComponentBase, customElement, html, inject, state, subscribe } from '@/fw';
import './pix3-welcome.ts.css';
import { ProjectService } from '@/services/project/ProjectService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { UIKIT_FORGE_HASH } from '@/core/tool-routes';
import { CloudProjectService } from '@/services/cloud/CloudProjectService';
import { DialogService } from '@/services/editor/DialogService';
import type { ApiProject } from '@/services/cloud/ApiClient';
import { appState } from '@/state';
import type { RecentProjectEntry } from '@/services/project/ProjectService';
import { ProjectLifecycleService } from '@/services/project/ProjectLifecycleService';
import {
  ProjectTemplateService,
  type ProjectTemplate,
} from '@/services/project/ProjectTemplateService';
import { WorkspaceModeService } from '@/services/editor/WorkspaceModeService';
import { EditorSettingsService } from '@/services/editor/EditorSettingsService';
import { BridgeConnectionService } from '@/services/llm/BridgeConnectionService';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';
import {
  PrototypeBootstrapService,
  type PrototypeBootstrapStatus,
} from '@/services/flow/PrototypeBootstrapService';
import {
  ATTACHMENT_ROLES,
  attachmentPreviewUrl,
  attachmentRoleHint,
  attachmentRoleLabel,
  dragCarriesFiles,
  formatAttachmentSize,
  readFilesAsAttachments,
  withAttachmentRole,
  type ComposerAttachment,
} from '@/ui/shared/composer-attachments';
import { CURRENT_EDITOR_VERSION } from '@/version';

/**
 * The welcome screen leads with the prompt: Flow is the default way in (design §1.1/§3.1), so
 * "describe your game" is the primary content and opening an existing project sits in a narrower
 * column beside it. Stacking the two put the project lists past the bottom of the viewport on a
 * laptop screen, where the card neither shrank nor scrolled; two columns keep the whole screen
 * reachable without hiding anything.
 */
@customElement('pix3-welcome')
export class Pix3Welcome extends ComponentBase {
  private static readonly DEFAULT_TAB_AUTHENTICATED = 'cloud';

  private static readonly DEFAULT_TAB_UNAUTHENTICATED = 'local';

  @inject(ProjectService)
  private readonly projectService!: ProjectService;

  @inject(IconService)
  private readonly iconService!: IconService;

  @inject(CloudProjectService)
  private readonly cloudProjectService!: CloudProjectService;

  @inject(ProjectLifecycleService)
  private readonly projectLifecycleService!: ProjectLifecycleService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @inject(ProjectTemplateService)
  private readonly templateService!: ProjectTemplateService;

  @inject(WorkspaceModeService)
  private readonly workspaceModeService!: WorkspaceModeService;

  @inject(PrototypeBootstrapService)
  private readonly bootstrapService!: PrototypeBootstrapService;

  @inject(EditorSettingsService)
  private readonly editorSettingsService!: EditorSettingsService;

  @inject(BridgeConnectionService)
  private readonly bridge!: BridgeConnectionService;

  @inject(AgentSettingsService)
  private readonly agentSettings!: AgentSettingsService;

  @inject(LlmProviderRegistry)
  private readonly llmRegistry!: LlmProviderRegistry;

  @state()
  private prompt = '';

  @state()
  private bridgeAvailable = false;

  @state()
  private bridgeProviderCount = 0;

  @state()
  private bridgeProbing = false;

  /** True once ANY registered provider has a key (Gemini's own key, or the bridge pairing token). */
  @state()
  private aiKeyConfigured = false;

  /** Label of the provider the prompt will actually use, when it has a key. */
  @state()
  private aiProviderLabel = '';

  @state()
  private attachments: ComposerAttachment[] = [];

  @state()
  private attachWarning = '';

  @state()
  private pinnedRecipeId: string | null = null;

  @state()
  private bootstrapStatus: PrototypeBootstrapStatus = {
    phase: 'idle',
    message: '',
    brief: null,
    error: null,
  };

  @state()
  private dragActive = false;

  @state()
  private recents: RecentProjectEntry[] = [];

  @state()
  private cloudProjects: ApiProject[] = [];

  @state()
  private cloudProjectsLoading = false;

  @state()
  private isAuthenticated = appState.auth.isAuthenticated;

  @state()
  private deletingCloudProjectId: string | null = null;

  @state()
  private cloudProjectsError: string | null = null;

  @state()
  private activeTab: 'cloud' | 'local' = appState.auth.isAuthenticated
    ? Pix3Welcome.DEFAULT_TAB_AUTHENTICATED
    : Pix3Welcome.DEFAULT_TAB_UNAUTHENTICATED;

  @state()
  private projectError: string | null = appState.project.errorMessage;

  protected firstUpdated(): void {
    void Promise.resolve().then(() => {
      this.loadRecents();
      this.loadCloudProjects();
    });
  }

  private disposeCloudSubscription?: () => void;
  private disposeProjectSubscription?: () => void;
  private disposeAuthSubscription?: () => void;
  private disposeBootstrapSubscription?: () => void;
  private disposeBridgeSubscription?: () => void;
  private disposeAgentSettingsSubscription?: () => void;
  private attachmentSeq = 0;
  private dragDepth = 0;
  /** Guards the async key check against an out-of-order answer from an earlier refresh. */
  private aiStatusSeq = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeBootstrapSubscription = this.bootstrapService.subscribe(status => {
      this.bootstrapStatus = status;
    });
    // The bridge and the API keys decide whether the prompt above can build anything at all, so the
    // welcome screen reports them instead of letting the user find out from a failed build.
    this.readBridgeState();
    this.disposeBridgeSubscription = this.bridge.subscribe(() => {
      this.readBridgeState();
      // Bridge providers register only after a successful probe, so the key check has to re-run:
      // asking before discovery answers reports "no key" for a perfectly paired bridge.
      void this.refreshAiStatus();
    });
    this.disposeAgentSettingsSubscription = this.agentSettings.subscribe(() => {
      void this.refreshAiStatus();
    });
    // The bridge is usually started AFTER the editor tab, so the boot probe result is stale by the
    // time anyone reads this screen.
    void this.probeBridge();
    // The whole page is the drop zone (design §3.1) — a reference dropped anywhere on the welcome
    // screen is meant for the prompt, and making the user aim at the textarea is friction for
    // nothing.
    window.addEventListener('dragenter', this.onWindowDragEnter);
    window.addEventListener('dragover', this.onWindowDragOver);
    window.addEventListener('dragleave', this.onWindowDragLeave);
    window.addEventListener('drop', this.onWindowDrop);
    this.disposeCloudSubscription = this.cloudProjectService.subscribe(state => {
      this.cloudProjects = state.projects;
      this.cloudProjectsLoading = state.isLoading;
    });
    this.disposeAuthSubscription = subscribe(appState.auth, () => {
      const wasAuthenticated = this.isAuthenticated;
      this.isAuthenticated = appState.auth.isAuthenticated;
      if (wasAuthenticated !== this.isAuthenticated) {
        this.activeTab = this.isAuthenticated
          ? Pix3Welcome.DEFAULT_TAB_AUTHENTICATED
          : Pix3Welcome.DEFAULT_TAB_UNAUTHENTICATED;
      }
      this.loadCloudProjects();
      this.requestUpdate();
    });
    // subscribe to project state: reload recents and auto-remove the welcome overlay when project is ready
    this.disposeProjectSubscription = subscribe(appState.project, () => {
      try {
        this.loadRecents();
        this.projectError = appState.project.errorMessage;
        if (appState.project.status === 'ready') {
          // Notify host/shell that project is ready so it can remove the welcome component
          try {
            this.dispatchEvent(
              new CustomEvent('pix3-welcome:project-ready', { bubbles: true, composed: true })
            );
          } catch {
            // ignore dispatch errors
          }
        }
      } catch {
        // ignore errors during UI cleanup
      }
    });
    // Note: component no longer moves itself in the DOM; the shell/host should
    // listen for the 'pix3-welcome:project-ready' event and remove the element.
  }

  disconnectedCallback(): void {
    window.removeEventListener('dragenter', this.onWindowDragEnter);
    window.removeEventListener('dragover', this.onWindowDragOver);
    window.removeEventListener('dragleave', this.onWindowDragLeave);
    window.removeEventListener('drop', this.onWindowDrop);
    this.disposeBootstrapSubscription?.();
    this.disposeBootstrapSubscription = undefined;
    this.disposeBridgeSubscription?.();
    this.disposeBridgeSubscription = undefined;
    this.disposeAgentSettingsSubscription?.();
    this.disposeAgentSettingsSubscription = undefined;
    this.disposeCloudSubscription?.();
    this.disposeCloudSubscription = undefined;
    this.disposeAuthSubscription?.();
    this.disposeAuthSubscription = undefined;
    this.disposeProjectSubscription?.();
    this.disposeProjectSubscription = undefined;
    super.disconnectedCallback();
    // No DOM restore needed; shell will handle cleanup.
  }

  private loadRecents(): void {
    this.recents = this.projectService?.getRecentProjects?.() ?? [];
  }

  private loadCloudProjects(): void {
    this.cloudProjectsError = null;
    void this.cloudProjectService.loadProjects();
  }

  // ── AI setup status ─────────────────────────────────────────────────────────

  private readBridgeState(): void {
    this.bridgeAvailable = this.bridge.isAvailable();
    this.bridgeProviderCount = this.bridge.getEntries().length;
  }

  private async probeBridge(): Promise<void> {
    this.bridgeProbing = true;
    try {
      await this.bridge.probe();
    } catch {
      // An unreachable bridge is the normal case, not an error to report — the chip says "offline".
    } finally {
      this.bridgeProbing = false;
      this.readBridgeState();
      await this.refreshAiStatus();
    }
  }

  /**
   * "Can this screen's prompt reach a model?" — true when any registered provider has a key. Gemini
   * carries the user's own key; every bridge-backed provider shares the pairing token, so a paired
   * bridge answers yes for all of them at once.
   */
  private async refreshAiStatus(): Promise<void> {
    const seq = ++this.aiStatusSeq;
    const providers = this.llmRegistry.list().filter(provider => !provider.hidden);
    const configured = await Promise.all(
      providers.map(provider => this.agentSettings.hasApiKey(provider.id).catch(() => false))
    );
    if (seq !== this.aiStatusSeq) {
      return; // A later refresh already answered; its result wins.
    }
    const ready = providers.filter((_, index) => configured[index]);
    // The provider that would actually answer, not the stored preference — an unpinned pick
    // resolves to the bridge when one is paired, and this strip is where the user checks that.
    const selectedId = this.agentSettings.getSelectedProvider()?.id;
    const active = ready.find(provider => provider.id === selectedId) ?? ready[0];
    this.aiKeyConfigured = ready.length > 0;
    this.aiProviderLabel = active?.label ?? '';
  }

  private onOpenAiSettings = (): void => {
    // Reflect whatever the user changed in the dialog the moment it closes.
    void this.editorSettingsService.showSettings('agent').then(() => this.probeBridge());
  };

  /**
   * UI Kit Forge needs no project, so the welcome screen is its natural entry point — a plain hash
   * navigation, the same URL a bookmark or a shared link would carry.
   */
  private onOpenUiKitForge = (): void => {
    window.location.hash = UIKIT_FORGE_HASH;
  };

  private onOpenEditorSettings = (): void => {
    void this.editorSettingsService.showSettings('general').then(() => this.probeBridge());
  };

  private onRecheckBridge = (): void => {
    void this.probeBridge();
  };

  // ── Prompt hero ─────────────────────────────────────────────────────────────

  private get isBootstrapping(): boolean {
    return this.bootstrapStatus.phase === 'planning' || this.bootstrapStatus.phase === 'expanding';
  }

  private get canSubmitPrompt(): boolean {
    return !this.isBootstrapping && (Boolean(this.prompt.trim()) || this.attachments.length > 0);
  }

  /** Recipe cards: the Flow catalog once it is installed, else the bundled 2D templates. */
  private getRecipeCards(): ProjectTemplate[] {
    // Visible templates only: the fallback branch below offers every 2D template as a card, and
    // `idea-blank` is scaffolding a code path picks, never a starter to choose.
    const templates = this.templateService.getVisibleTemplates();
    // A recipe is either its own template (`recipe-*`) or a shipped template promoted into the
    // catalog by declaring the recipe it serves — the 3D recipe is the second kind, and filtering
    // on the id prefix alone is what kept it out of this list.
    const recipes = templates.filter(
      template => template.id.startsWith('recipe-') || Boolean(template.recipeId)
    );
    return recipes.length > 0
      ? recipes
      : templates.filter(template => template.projectType === '2d');
  }

  private onPromptInput = (event: Event): void => {
    this.prompt = (event.target as HTMLTextAreaElement).value;
    if (this.bootstrapStatus.phase === 'error') {
      this.bootstrapService.reset();
    }
  };

  private onPromptKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void this.onSubmitPrompt();
    }
  };

  /** A recipe card pins the genre; whatever is already typed still describes the game. */
  private onRecipeCard = (recipeId: string): void => {
    this.pinnedRecipeId = this.pinnedRecipeId === recipeId ? null : recipeId;
  };

  /**
   * Prompt → project. The workspace mode flips to Flow **before** the project exists so the shell
   * that appears the moment it becomes ready is the Flow one — the alternative is a visible flash of
   * the full editor, which is the exact impression this mode is trying not to give (design §3.6).
   *
   * `claimNextProject` rather than `set`: flipping the current shell is only half of it — the
   * project that is about to be generated has to inherit Flow too, or the shell resolves it to its
   * default the instant it becomes ready and the whole generation plays out in Studio.
   */
  private onSubmitPrompt = async (): Promise<void> => {
    if (!this.canSubmitPrompt) {
      return;
    }
    this.projectError = null;
    const previousMode = this.workspaceModeService.get();
    this.workspaceModeService.claimNextProject('flow');
    const request = {
      prompt: this.prompt,
      attachments: this.attachments,
      ...(this.pinnedRecipeId ? { recipeId: this.pinnedRecipeId } : {}),
    };
    try {
      // The prompt opens the IDEA stage: a project, a seeded design document and the agent's first
      // turn, with no planner and no LLM call on the way in. The recipe is chosen later, at
      // "Start prototype", when the brief is worked out — which is the whole point of the stage
      // (plan §3.1). The old straight-to-prototype path was retired with the transition.
      await this.bootstrapService.startIdea(request);
    } catch (error) {
      // Nothing was created, so leaving the shell in Flow would strand the user in an empty stage —
      // and the unclaimed Flow must not be inherited by whatever project the user opens next.
      this.workspaceModeService.clearPendingMode();
      this.workspaceModeService.set(previousMode, { persist: false });
      this.projectError = error instanceof Error ? error.message : 'Failed to build the prototype.';
    }
  };

  // ── Attachments (paste / drop / picker) ─────────────────────────────────────

  private onPromptPaste = (event: ClipboardEvent): void => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) return; // Plain text paste falls through to the textarea.
    event.preventDefault();
    void this.addFiles(files);
  };

  private onFileInput = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      void this.addFiles(input.files);
    }
    input.value = '';
  };

  private onPickFiles = (): void => {
    this.querySelector<HTMLInputElement>('.hero-file-input')?.click();
  };

  private onWindowDragEnter = (event: DragEvent): void => {
    if (!dragCarriesFiles(event)) return;
    this.dragDepth += 1;
    this.dragActive = true;
  };

  private onWindowDragOver = (event: DragEvent): void => {
    if (!dragCarriesFiles(event)) return;
    // Without this the browser navigates to the dropped file and the session is gone.
    event.preventDefault();
  };

  private onWindowDragLeave = (event: DragEvent): void => {
    if (!dragCarriesFiles(event)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.dragActive = false;
    }
  };

  private onWindowDrop = (event: DragEvent): void => {
    this.dragDepth = 0;
    this.dragActive = false;
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      event.preventDefault();
      void this.addFiles(files);
    }
  };

  private async addFiles(files: FileList | File[]): Promise<void> {
    const { attachments, warnings } = await readFilesAsAttachments(files, {
      makeId: () => `hero-${this.attachmentSeq++}`,
    });
    if (attachments.length > 0) {
      this.attachments = [...this.attachments, ...attachments];
    }
    this.attachWarning = warnings.join(' ');
  }

  private onCycleAttachmentRole = (id: string): void => {
    const current = this.attachments.find(attachment => attachment.id === id);
    if (!current || current.kind !== 'image') return;
    const next =
      ATTACHMENT_ROLES[(ATTACHMENT_ROLES.indexOf(current.role) + 1) % ATTACHMENT_ROLES.length];
    this.attachments = withAttachmentRole(this.attachments, id, next);
  };

  private onRemoveAttachment = (id: string): void => {
    this.attachments = this.attachments.filter(attachment => attachment.id !== id);
  };

  private onOpen = async (): Promise<void> => {
    this.projectError = null;
    try {
      await this.projectService.openProjectViaPicker();
    } catch (error) {
      this.captureProjectOpenError(error);
    }
  };

  private onStartNew = async (): Promise<void> => {
    try {
      await this.projectLifecycleService.showCreateDialog();
    } catch (error) {
      if (error instanceof Error) {
        alert(error.message);
      } else {
        alert('Failed to create new project');
      }
    }
  };

  private onRecent = async (e: Event): Promise<void> => {
    const btn = e.currentTarget as HTMLElement | null;
    if (!btn) return;
    const idxAttr = btn.getAttribute('data-recent-index');
    const idx = idxAttr ? Number(idxAttr) : NaN;
    if (!Number.isFinite(idx)) {
      await this.onOpen();
      return;
    }
    const entry = this.recents[idx];
    if (!entry) {
      await this.onOpen();
      return;
    }

    if (entry.backend === 'cloud' && !this.isAuthenticated) {
      this.requestAuth({
        projectId: entry.id ?? null,
        source: 'recent-cloud',
      });
      return;
    }

    this.projectError = null;
    try {
      await this.projectService.openRecentProject(entry);
    } catch (error) {
      this.captureProjectOpenError(error);
    }
  };

  private captureProjectOpenError(error: unknown): void {
    this.projectError =
      appState.project.errorMessage ??
      (error instanceof Error ? error.message : 'Failed to open project');
  }

  private formatTime(ts: number): string {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return '';
    }
  }

  private onRemoveRecent = async (e: Event): Promise<void> => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement | null;
    if (!btn) return;
    const idxAttr = btn.getAttribute('data-recent-index');
    const idx = idxAttr ? Number(idxAttr) : NaN;
    if (!Number.isFinite(idx)) return;
    const entry = this.recents[idx];
    if (!entry) return;
    try {
      this.projectService.removeRecentProject({ id: entry.id, name: entry.name });
    } catch {
      // ignore removal errors
    }
    this.loadRecents();
  };

  private onCloudProject = async (e: Event): Promise<void> => {
    const btn = e.currentTarget as HTMLElement | null;
    if (!btn) return;
    const projectId = btn.getAttribute('data-cloud-id');
    if (!projectId) return;

    if (!this.isAuthenticated) {
      this.requestAuth({
        projectId,
        source: 'cloud-list',
      });
      return;
    }

    await this.cloudProjectService.openProject(projectId);
  };

  private onDeleteCloudProject = async (e: Event): Promise<void> => {
    e.stopPropagation();
    const button = e.currentTarget as HTMLElement | null;
    if (!button) return;

    const projectId = button.getAttribute('data-cloud-delete-id');
    if (!projectId || this.deletingCloudProjectId === projectId) {
      return;
    }

    const project = this.cloudProjects.find(entry => entry.id === projectId);
    if (!project || !this.isCloudProjectOwner(project)) {
      return;
    }

    const confirmed = await this.dialogService.showConfirmation({
      title: 'Delete Cloud Project',
      message: `Delete ${project.name} from the cloud workspace? This removes the project and all stored files for everyone who has access.`,
      disclaimer: 'Deleted cloud projects cannot be restored.',
      confirmLabel: 'Delete Project',
      cancelLabel: 'Keep Project',
      isDangerous: true,
      requiredInputLabel: `Enter the project name to confirm: ${project.name}`,
      requiredInputValue: project.name,
      requiredInputPlaceholder: project.name,
    });

    if (!confirmed) {
      return;
    }

    this.deletingCloudProjectId = projectId;
    this.cloudProjectsError = null;

    try {
      await this.cloudProjectService.deleteProject(projectId);
    } catch (error) {
      this.cloudProjectsError =
        error instanceof Error ? error.message : 'Failed to delete cloud project.';
    } finally {
      if (this.deletingCloudProjectId === projectId) {
        this.deletingCloudProjectId = null;
      }
    }
  };

  private onLoginRequest = (): void => {
    this.requestAuth({
      projectId: null,
      source: 'cloud-list',
    });
  };

  private setActiveTab(tab: 'cloud' | 'local'): void {
    this.activeTab = tab;
  }

  private requestAuth(detail: { projectId: string | null; source: 'recent-cloud' | 'cloud-list' }) {
    this.dispatchEvent(
      new CustomEvent('pix3-auth:request', {
        detail,
        bubbles: true,
        composed: true,
      })
    );
  }

  private getProjectBadgeLabel(entry: RecentProjectEntry): string {
    if (entry.linkedCloudProjectId || entry.linkedLocalSessionId) {
      return 'Hybrid';
    }

    if (entry.backend === 'cloud') {
      return 'Cloud';
    }
    // Both rows under the Local Projects tab are local; the badge says WHERE, so a
    // file-system project reads "Folder" rather than repeating the tab's own word.
    return entry.backend === 'browser' ? 'Browser' : 'Folder';
  }

  private getProjectBadgeClass(entry: RecentProjectEntry): string {
    return entry.linkedCloudProjectId || entry.linkedLocalSessionId
      ? 'recent-backend recent-backend--hybrid'
      : 'recent-backend';
  }

  private getProjectIcon(entry: RecentProjectEntry) {
    const iconName =
      entry.backend === 'cloud'
        ? 'cloud-outline'
        : entry.backend === 'browser'
          ? 'globe'
          : 'folder-outline';
    return this.iconService.getIcon(iconName, 18);
  }

  private isCloudProjectOwner(project: ApiProject): boolean {
    return project.owner_id === appState.auth.user?.id;
  }

  private getLocalProjectItems(): Array<{ entry: RecentProjectEntry; recentIndex: number }> {
    return this.recents
      .map((entry, recentIndex) => ({ entry, recentIndex }))
      .filter(item => item.entry.backend === 'local' || item.entry.backend === 'browser');
  }

  private renderPromptHero() {
    const status = this.bootstrapStatus;
    return html`
      <section class="welcome-hero" aria-label="Describe your game">
        <h2 class="hero-title">Describe your game</h2>
        <p class="hero-subtitle">
          One sentence is enough. Pix3 builds a playable skeleton and an agent takes it from there.
        </p>

        <div class="hero-composer ${this.dragActive ? 'hero-composer--drag' : ''}">
          <textarea
            class="hero-input"
            rows="3"
            .value=${this.prompt}
            placeholder="e.g. tap the falling coins, miss a bomb and you lose"
            aria-label="Describe your game"
            ?disabled=${this.isBootstrapping}
            @input=${this.onPromptInput}
            @keydown=${this.onPromptKeyDown}
            @paste=${this.onPromptPaste}
          ></textarea>

          ${this.renderAttachments()}

          <div class="hero-composer__bar">
            <button
              class="hero-attach"
              type="button"
              title="Attach a reference image or a design document"
              ?disabled=${this.isBootstrapping}
              @click=${this.onPickFiles}
            >
              ${this.iconService.getIcon('paperclip', IconSize.SMALL)}
              <span>Attach</span>
            </button>
            <input
              class="hero-file-input"
              type="file"
              multiple
              accept="image/*,text/*,.md,.txt,.json,.csv,.yaml,.yml"
              aria-label="Attach reference files"
              hidden
              @change=${this.onFileInput}
            />
            <span class="hero-hint">Paste, drop or attach references · Ctrl+Enter to build</span>
            <button
              class="hero-make"
              type="button"
              ?disabled=${!this.canSubmitPrompt}
              @click=${this.onSubmitPrompt}
            >
              ${this.isBootstrapping
                ? html`<span class="hero-spinner" aria-hidden="true"></span>`
                : this.iconService.getIcon('zap', IconSize.SMALL)}
              <span>${this.isBootstrapping ? 'Building…' : 'Make'}</span>
            </button>
          </div>
        </div>

        ${this.attachWarning
          ? html`<div class="hero-warning" role="status">${this.attachWarning}</div>`
          : null}
        ${status.phase !== 'idle'
          ? html`<div
              class="hero-status ${status.phase === 'error' ? 'hero-status--error' : ''}"
              role="status"
            >
              ${this.isBootstrapping
                ? html`<span class="hero-spinner" aria-hidden="true"></span>`
                : null}
              <span>${status.error ?? status.message}</span>
            </div>`
          : null}
        ${this.renderRecipeCards()}
      </section>
    `;
  }

  private renderRecipeCards() {
    const recipes = this.getRecipeCards();
    if (recipes.length === 0) {
      return null;
    }
    return html`
      <div class="hero-recipes" role="list" aria-label="Start from a recipe">
        ${recipes.map(recipe => {
          // Pin the RECIPE id, not the template id: it is what the planner is told to use, and it
          // is validated against the recipe catalog.
          const recipeId = recipe.recipeId ?? recipe.id;
          const pinned = this.pinnedRecipeId === recipeId;
          return html`
            <button
              class="hero-recipe ${pinned ? 'hero-recipe--pinned' : ''}"
              type="button"
              role="listitem"
              aria-pressed=${pinned}
              title=${recipe.description || recipe.title}
              ?disabled=${this.isBootstrapping}
              @click=${() => this.onRecipeCard(recipeId)}
            >
              ${recipe.coverUrl
                ? html`<img class="hero-recipe__cover" src=${recipe.coverUrl} alt="" />`
                : html`<span class="hero-recipe__cover hero-recipe__cover--blank" aria-hidden="true"
                    >${this.iconService.getIcon('grid', IconSize.LARGE)}</span
                  >`}
              <span class="hero-recipe__title">${recipe.title}</span>
              ${pinned
                ? html`<span class="hero-recipe__pin">
                    ${this.iconService.getIcon('check', IconSize.SMALL)}
                  </span>`
                : null}
            </button>
          `;
        })}
      </div>
    `;
  }

  private renderAttachments() {
    if (this.attachments.length === 0) {
      return null;
    }
    return html`
      <div class="hero-attachments">
        ${this.attachments.map(attachment =>
          attachment.kind === 'image'
            ? html`
                <span class="hero-attachment hero-attachment--image" title=${attachment.name}>
                  <img
                    class="hero-attachment__thumb"
                    src=${attachmentPreviewUrl(attachment)}
                    alt=${attachment.name}
                  />
                  <button
                    class="hero-attachment__role"
                    type="button"
                    title=${attachmentRoleHint(attachment.role)}
                    aria-label="Reference role: ${attachmentRoleLabel(
                      attachment.role
                    )}. Click to change."
                    @click=${() => this.onCycleAttachmentRole(attachment.id)}
                  >
                    ${attachmentRoleLabel(attachment.role)}
                  </button>
                  <button
                    class="hero-attachment__remove"
                    type="button"
                    aria-label="Remove ${attachment.name}"
                    @click=${() => this.onRemoveAttachment(attachment.id)}
                  >
                    ${this.iconService.getIcon('x-close', 12)}
                  </button>
                </span>
              `
            : html`
                <span class="hero-attachment hero-attachment--doc" title=${attachment.name}>
                  <span class="hero-attachment__icon" aria-hidden="true"
                    >${this.iconService.getIcon('file-text', IconSize.SMALL)}</span
                  >
                  <span class="hero-attachment__name">${attachment.name}</span>
                  <span class="hero-attachment__size"
                    >${formatAttachmentSize(attachment.size)}</span
                  >
                  <button
                    class="hero-attachment__remove"
                    type="button"
                    aria-label="Remove ${attachment.name}"
                    @click=${() => this.onRemoveAttachment(attachment.id)}
                  >
                    ${this.iconService.getIcon('x-close', 12)}
                  </button>
                </span>
              `
        )}
      </div>
    `;
  }

  /**
   * The setup strip: the AI key and the bridge, both of which the prompt depends on and neither of
   * which used to be visible until a build failed. Every control lands in the same Editor Settings
   * dialog the running editor uses — this is a shortcut into it, not a second place to store keys.
   */
  private renderSetupStatus() {
    const bridgeLabel = this.bridgeAvailable
      ? `Bridge · ${this.bridgeProviderCount} provider${this.bridgeProviderCount === 1 ? '' : 's'}`
      : 'Bridge offline';
    return html`
      <div class="welcome-setup" aria-label="AI setup status">
        <button
          class="welcome-chip ${this.aiKeyConfigured ? 'welcome-chip--ok' : 'welcome-chip--warn'}"
          type="button"
          title=${this.aiKeyConfigured
            ? `Model provider: ${this.aiProviderLabel}. Click to change keys and models.`
            : 'No API key configured yet — the prompt above needs one. Click to add a key.'}
          @click=${this.onOpenAiSettings}
        >
          <span class="welcome-chip__dot" aria-hidden="true"></span>
          <span
            >${this.aiKeyConfigured
              ? `AI: ${this.aiProviderLabel}`
              : 'No AI key — set one up'}</span
          >
        </button>

        <button
          class="welcome-chip ${this.bridgeAvailable ? 'welcome-chip--ok' : 'welcome-chip--idle'}"
          type="button"
          title=${this.bridgeAvailable
            ? `Pix3AgentBridge reachable at ${this.bridge.getBridgeUrl()}`
            : `No bridge at ${this.bridge.getBridgeUrl()} — run "npx @pix3/agent-bridge" to add OpenAI, Anthropic and Zen. Click to set it up.`}
          @click=${this.onOpenAiSettings}
        >
          <span class="welcome-chip__dot" aria-hidden="true"></span>
          <span>${bridgeLabel}</span>
        </button>

        <button
          class="welcome-tool ${this.bridgeProbing ? 'welcome-tool--busy' : ''}"
          type="button"
          title="Re-check the bridge connection"
          aria-label="Re-check the bridge connection"
          ?disabled=${this.bridgeProbing}
          @click=${this.onRecheckBridge}
        >
          ${this.iconService.getIcon('refresh-cw', IconSize.SMALL)}
        </button>

        <button
          class="welcome-tool"
          type="button"
          title="UI Kit Forge — generate game UI sprites (no project needed)"
          aria-label="Open UI Kit Forge"
          @click=${this.onOpenUiKitForge}
        >
          ${this.iconService.getIcon('grid', IconSize.SMALL)}
        </button>

        <button
          class="welcome-tool"
          type="button"
          title="Editor settings"
          aria-label="Editor settings"
          @click=${this.onOpenEditorSettings}
        >
          ${this.iconService.getIcon('settings', IconSize.SMALL)}
        </button>
      </div>
    `;
  }

  protected render() {
    const localProjectItems = this.getLocalProjectItems();

    return html`
      <div class="welcome-root" role="region" aria-label="Welcome">
        ${this.dragActive
          ? html`<div class="welcome-dropzone" aria-hidden="true">
              <span>Drop references anywhere</span>
            </div>`
          : null}
        <div class="welcome-card">
          <div class="welcome-header">
            <img src="/splash-logo.png" alt="Pix3" class="welcome-logo" />
            <div class="welcome-version">${CURRENT_EDITOR_VERSION.displayVersion}</div>
            ${this.renderSetupStatus()}
          </div>

          <div class="welcome-columns">
            <div class="welcome-column welcome-column--primary">${this.renderPromptHero()}</div>

            <aside class="welcome-column welcome-column--secondary" aria-label="Existing projects">
              <h3 class="welcome-secondary__title">Or work on an existing project</h3>

              <div class="welcome-actions-grid">
                <button @click=${this.onOpen} class="action-btn">
                  <span class="action-icon">${this.iconService.getIcon('folder-outline', 18)}</span>
                  <span class="action-label">Open Project</span>
                </button>
                <button @click=${this.onStartNew} class="action-btn">
                  <span class="action-icon"
                    >${this.iconService.getIcon('plus-circle-outline', 18)}</span
                  >
                  <span class="action-label">Start New Project</span>
                </button>
              </div>

              ${this.projectError
                ? html`<div class="recent-error welcome-error" role="alert">
                    ${this.projectError}
                  </div>`
                : null}

              <div class="recent-list project-tabs">
                <div class="project-tabs__nav" role="tablist" aria-label="Project sources">
                  <button
                    class="project-tab ${this.activeTab === 'cloud' ? 'project-tab--active' : ''}"
                    type="button"
                    role="tab"
                    aria-selected=${this.activeTab === 'cloud'}
                    @click=${() => this.setActiveTab('cloud')}
                  >
                    Cloud Projects
                  </button>
                  <button
                    class="project-tab ${this.activeTab === 'local' ? 'project-tab--active' : ''}"
                    type="button"
                    role="tab"
                    aria-selected=${this.activeTab === 'local'}
                    @click=${() => this.setActiveTab('local')}
                  >
                    Local Projects
                  </button>
                </div>

                <div class="project-tabs__panel" role="tabpanel">
                  <div class="project-tabs__scroll">
                    ${this.activeTab === 'cloud'
                      ? html`
                          ${!this.isAuthenticated
                            ? html`
                                <div class="cloud-auth-status">
                                  <button
                                    type="button"
                                    class="cloud-auth-status__button"
                                    @click=${this.onLoginRequest}
                                  >
                                    Login
                                  </button>
                                  <div class="cloud-auth-status__hint">
                                    Login to load cloud projects.
                                  </div>
                                </div>
                              `
                            : this.cloudProjectsLoading && this.cloudProjects.length === 0
                              ? html`<div class="recent-empty">Loading cloud projects...</div>`
                              : this.cloudProjects.length
                                ? html`<ul>
                                      ${this.cloudProjects.map(p => {
                                        const isDeleting = this.deletingCloudProjectId === p.id;
                                        return html`<li>
                                          <div class="recent-row">
                                            <button
                                              class="recent-item"
                                              data-cloud-id="${p.id}"
                                              ?disabled=${isDeleting}
                                              @click=${this.onCloudProject}
                                            >
                                              <span class="folder-icon" aria-hidden="true"
                                                >${this.iconService.getIcon(
                                                  'cloud-outline',
                                                  18
                                                )}</span
                                              >
                                              <span class="recent-name">${p.name}</span>
                                              <span class="recent-backend">Cloud</span>
                                              <span class="recent-time"
                                                >${this.formatTime(
                                                  new Date(p.updated_at).getTime()
                                                )}</span
                                              >
                                            </button>
                                            ${this.isCloudProjectOwner(p)
                                              ? html`
                                                  <button
                                                    class="cloud-project-delete"
                                                    type="button"
                                                    data-cloud-delete-id="${p.id}"
                                                    ?disabled=${isDeleting}
                                                    @click=${this.onDeleteCloudProject}
                                                    aria-label="Delete cloud project ${p.name}"
                                                  >
                                                    ${isDeleting ? 'Deleting...' : 'Delete'}
                                                  </button>
                                                `
                                              : null}
                                          </div>
                                        </li>`;
                                      })}
                                    </ul>
                                    ${this.cloudProjectsError
                                      ? html`<div class="recent-error">
                                          ${this.cloudProjectsError}
                                        </div>`
                                      : null}`
                                : html`<div class="recent-empty">No cloud projects yet.</div>`}
                        `
                      : html`
                          ${localProjectItems.length
                            ? html`<ul>
                                ${localProjectItems.map(
                                  ({ entry, recentIndex }) =>
                                    html`<li>
                                      <div class="recent-row">
                                        <button
                                          class="recent-item"
                                          data-recent-index="${recentIndex}"
                                          @click=${this.onRecent}
                                        >
                                          <span class="folder-icon" aria-hidden="true"
                                            >${this.getProjectIcon(entry)}</span
                                          >
                                          <span class="recent-name">${entry.name}</span>
                                          <span class=${this.getProjectBadgeClass(entry)}
                                            >${this.getProjectBadgeLabel(entry)}</span
                                          >
                                          <span class="recent-time"
                                            >${this.formatTime(entry.lastOpenedAt)}</span
                                          >
                                        </button>
                                        <button
                                          class="recent-remove"
                                          title="Remove from recent"
                                          data-recent-index="${recentIndex}"
                                          @click=${this.onRemoveRecent}
                                          aria-label="Remove recent"
                                        >
                                          ${this.iconService.getIcon('x-close', 12)}
                                        </button>
                                      </div>
                                    </li>`
                                )}
                              </ul>`
                            : html`<div class="recent-empty">No local projects yet.</div>`}
                        `}
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>
    `;
  }

  // Styles moved to external CSS file (pix3-welcome.ts.css) and imported
  // at module top so bundlers can include the stylesheet. Kept `css` import
  // in case other components rely on it.
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-welcome': Pix3Welcome;
  }
}
