import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { nothing } from 'lit';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';
import { LocalSyncService } from '@/services/project/LocalSyncService';
import { ProjectSyncService } from '@/services/project/ProjectSyncService';
import './pix3-project-sync-dialog.ts.css';

@customElement('pix3-project-sync-dialog')
export class ProjectSyncDialog extends ComponentBase {
  @inject(ProjectSyncService)
  private readonly projectSyncService!: ProjectSyncService;

  @inject(LocalSyncService)
  private readonly localSyncService!: LocalSyncService;

  @state()
  private errorMessage = '';

  @state()
  private isSyncing = false;

  private disposeProjectSubscription?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.errorMessage = '';
    this.disposeProjectSubscription = subscribe(appState.project, () => {
      this.requestUpdate();
    });
    void this.localSyncService.refreshCurrentProjectStatus().finally(() => this.requestUpdate());
  }

  disconnectedCallback(): void {
    this.disposeProjectSubscription?.();
    this.disposeProjectSubscription = undefined;
    super.disconnectedCallback();
  }

  private closeDialog = (): void => {
    this.errorMessage = '';
    this.projectSyncService.close();
  };

  private onOverlayClick = (): void => {
    this.closeDialog();
  };

  private requestAuthentication(): void {
    this.dispatchEvent(
      new CustomEvent('pix3-auth:request', {
        detail: {
          projectId: null,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  private get syncStatusLabel(): string {
    switch (appState.project.hybridSync.status) {
      case 'checking':
        return 'Checking sync status';
      case 'up-to-date':
        return 'Up to date';
      case 'local-changes':
        return 'Local folder changed';
      case 'cloud-changes':
        return 'Cloud project changed';
      case 'conflict':
        return 'Sync conflict';
      case 'syncing':
        return 'Syncing';
      case 'auth-required':
        return 'Sign in required';
      case 'error':
        return 'Sync needs attention';
      default:
        return 'Not linked';
    }
  }

  private get syncHint(): string {
    const { hybridSync } = appState.project;
    if (hybridSync.errorMessage) {
      return hybridSync.errorMessage;
    }

    switch (hybridSync.status) {
      case 'up-to-date':
        return hybridSync.lastSyncAt
          ? `Last sync: ${new Date(hybridSync.lastSyncAt).toLocaleString()}`
          : 'Local folder and cloud project match.';
      case 'local-changes':
        return `${hybridSync.localChangeCount} local file change(s) are ready to upload.`;
      case 'cloud-changes':
        return `${hybridSync.cloudChangeCount} cloud file change(s) are ready to download.`;
      case 'conflict':
        return `${hybridSync.conflictCount} file(s) changed on both sides since the last sync.`;
      case 'auth-required':
        return 'Open your account to compare and sync with the cloud project.';
      case 'checking':
        return 'Scanning the local folder and cloud manifest.';
      case 'syncing':
        return 'Applying file updates between the linked folder and cloud project.';
      case 'error':
        return 'Reconnect the link or rerun sync to recover.';
      default:
        return appState.project.backend === 'local'
          ? 'Create a cloud copy of this local project and keep both sides in sync.'
          : 'Download this cloud project into a linked local folder for Git and external tools.';
    }
  }

  private get syncProgressLabel(): string | null {
    const { processedFileCount, totalFileCount, status } = appState.project.hybridSync;
    if (status !== 'syncing' || totalFileCount <= 0) {
      return null;
    }

    return `Processed ${processedFileCount}/${totalFileCount} files`;
  }

  private get syncPrimaryActionLabel(): string {
    if (appState.project.backend === 'local') {
      return appState.project.hybridSync.linkedCloudProjectId ? 'Sync Changes' : 'Sync to Cloud';
    }

    if (appState.project.hybridSync.linkedLocalSessionId) {
      return appState.project.hybridSync.status === 'error' ? 'Reconnect Folder' : 'Sync Changes';
    }

    return 'Sync to Local Folder';
  }

  private async handleSyncAction(): Promise<void> {
    if (appState.project.backend === 'local' && !appState.auth.isAuthenticated) {
      this.requestAuthentication();
      return;
    }

    this.errorMessage = '';
    this.isSyncing = true;

    try {
      if (appState.project.backend === 'local') {
        if (appState.project.hybridSync.linkedCloudProjectId) {
          await this.localSyncService.syncCurrentProject();
        } else {
          await this.localSyncService.syncCurrentLocalProjectToCloud();
        }
      } else if (
        appState.project.hybridSync.linkedLocalSessionId &&
        appState.project.hybridSync.status !== 'error'
      ) {
        await this.localSyncService.syncCurrentProject();
      } else {
        await this.localSyncService.syncCurrentCloudProjectToLocalFolder();
      }
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Failed to synchronize project.';
    } finally {
      this.isSyncing = false;
    }
  }

  private renderSyncIssues() {
    const issues = appState.project.hybridSync.issues;
    if (issues.length === 0) {
      return nothing;
    }

    return html`
      <div class="project-sync-issues">
        <div class="project-sync-issues__title">Problems</div>
        <ul class="project-sync-issues__list">
          ${issues.map(
            issue => html`
              <li class="project-sync-issues__item">
                <div class="project-sync-issues__path">${issue.path}</div>
                <div class="project-sync-issues__reason">${issue.reason}</div>
              </li>
            `
          )}
        </ul>
      </div>
    `;
  }

  protected render() {
    const hasLink = Boolean(
      appState.project.backend === 'local'
        ? appState.project.hybridSync.linkedCloudProjectId
        : appState.project.hybridSync.linkedLocalSessionId
    );
    const linkedTarget =
      appState.project.backend === 'local'
        ? appState.project.hybridSync.linkedCloudProjectId
        : (appState.project.hybridSync.linkedLocalPath ??
          appState.project.hybridSync.linkedLocalSessionId);

    return html`
      <div class="project-sync-backdrop" @click=${this.onOverlayClick}>
        <div class="project-sync-dialog" @click=${(event: Event) => event.stopPropagation()}>
          <div class="project-sync-header">
            <div class="project-sync-title">Sync Project</div>
            <div class="project-sync-subtitle">
              ${appState.project.backend === 'local'
                ? 'Create a cloud copy of this local project or resynchronize the existing cloud link.'
                : 'Link this cloud project to a local folder and keep both copies synchronized.'}
            </div>
          </div>
          <div class="project-sync-body">
            ${this.errorMessage
              ? html`<div class="project-sync-error">${this.errorMessage}</div>`
              : nothing}
            <div class="project-sync-section">
              <div class="project-sync-section__header">
                <div class="project-sync-section__title">Sync Status</div>
                <div class="project-sync-section__badge">${this.syncStatusLabel}</div>
              </div>
              ${hasLink && linkedTarget
                ? html`<div class="project-sync-linkage">Linked to ${linkedTarget}</div>`
                : nothing}
              <div class="project-sync-hint">${this.syncHint}</div>
              <div class="project-sync-actions project-sync-actions--inline">
                <button
                  class="project-sync-button project-sync-button--primary"
                  @click=${() => void this.handleSyncAction()}
                  ?disabled=${this.isSyncing || appState.project.status !== 'ready'}
                >
                  ${this.isSyncing ? 'Working...' : this.syncPrimaryActionLabel}
                </button>
                ${this.syncProgressLabel
                  ? html`<div class="project-sync-progress">${this.syncProgressLabel}</div>`
                  : nothing}
              </div>
              ${this.renderSyncIssues()}
            </div>
          </div>
          <div class="project-sync-actions">
            <button class="project-sync-button" @click=${this.closeDialog}>Close</button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-project-sync-dialog': ProjectSyncDialog;
  }
}
