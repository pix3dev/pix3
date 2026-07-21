import { ComponentBase, customElement, html, inject, state, subscribe } from '@/fw';
import './pix3-welcome.ts.css';
import { ProjectService } from '@/services/ProjectService';
import { IconService } from '@/services/IconService';
import { CloudProjectService } from '@/services/CloudProjectService';
import { DialogService } from '@/services/DialogService';
import type { ApiProject } from '@/services/ApiClient';
import { appState } from '@/state';
import type { RecentProjectEntry } from '@/services/ProjectService';
import { ProjectLifecycleService } from '@/services/ProjectLifecycleService';
import { CURRENT_EDITOR_VERSION } from '@/version';

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
    Promise.resolve().then(() => {
      this.loadRecents();
      this.loadCloudProjects();
    });
  }

  private disposeCloudSubscription?: () => void;
  private disposeProjectSubscription?: () => void;
  private disposeAuthSubscription?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
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
    return entry.backend === 'browser' ? 'Browser' : 'Local';
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

  protected render() {
    const localProjectItems = this.getLocalProjectItems();

    return html`
      <div class="welcome-root" role="region" aria-label="Welcome">
        <div class="welcome-card">
          <div class="welcome-header">
            <img src="/splash-logo.png" alt="Pix3" class="welcome-logo" />
            <div class="welcome-version">${CURRENT_EDITOR_VERSION.displayVersion}</div>
          </div>

          <div class="welcome-actions-grid">
            <div class="action-column">
              <button @click=${this.onOpen} class="action-btn">
                <span class="action-icon">${this.iconService.getIcon('folder-outline', 18)}</span>
                <span class="action-label">Open Project</span>
              </button>
            </div>
            <div class="action-column">
              <button @click=${this.onStartNew} class="action-btn">
                <span class="action-icon"
                  >${this.iconService.getIcon('plus-circle-outline', 20)}</span
                >
                <span class="action-label">Start New Project</span>
              </button>
            </div>
          </div>

          ${this.projectError
            ? html`<div class="recent-error welcome-error" role="alert">${this.projectError}</div>`
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
                            <div class="cloud-auth-status__hint">Login to load cloud projects.</div>
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
                                          >${this.iconService.getIcon('cloud-outline', 18)}</span
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
                                ? html`<div class="recent-error">${this.cloudProjectsError}</div>`
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
