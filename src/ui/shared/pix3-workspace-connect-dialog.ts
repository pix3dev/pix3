import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { appState } from '@/state';
import { ProjectService } from '@/services/project/ProjectService';
import { ProjectLifecycleService } from '@/services/project/ProjectLifecycleService';
import { IconService, IconSize } from '@/services/editor/IconService';
import { WorkspaceConnectDialogService } from '@/services/project/workspace/WorkspaceConnectDialogService';
import { WorkspaceCredentialStore } from '@/services/project/workspace/WorkspaceCredentialStore';
import {
  DEFAULT_WORKSPACE_ENDPOINT,
  isWorkspaceError,
} from '@/services/project/workspace/workspace-protocol';
import './pix3-workspace-connect-dialog.ts.css';

/**
 * "Connect to Workspace": address + token of a `pix3 serve` workspace. On success the project
 * opens through `ProjectService.openWorkspaceProject` — no File System Access picker anywhere.
 */
@customElement('pix3-workspace-connect-dialog')
export class Pix3WorkspaceConnectDialog extends ComponentBase {
  @inject(ProjectService)
  private readonly projectService!: ProjectService;

  @inject(ProjectLifecycleService)
  private readonly projectLifecycleService!: ProjectLifecycleService;

  @inject(WorkspaceConnectDialogService)
  private readonly dialogService!: WorkspaceConnectDialogService;

  @inject(IconService)
  private readonly icons!: IconService;

  @inject(WorkspaceCredentialStore)
  private readonly credentials!: WorkspaceCredentialStore;

  @property({ type: String, attribute: false })
  public endpoint: string | null = null;

  @property({ type: String, attribute: false })
  public initialError: string | null = null;

  @property({ type: String, attribute: false })
  public workspaceName: string | null = null;

  @property({ type: String, attribute: false })
  public workspaceId: string | null = null;

  @state() private address = DEFAULT_WORKSPACE_ENDPOINT;
  @state() private token = '';
  @state() private error = '';
  @state() private submitting = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.address = this.endpoint ?? DEFAULT_WORKSPACE_ENDPOINT;
    this.error = this.initialError ?? '';
    if (this.workspaceId) {
      // Reconnecting a known workspace: a still-valid stored token makes it one click. A rejected
      // one was already deleted by the open path, so this stays empty then.
      void this.credentials.get(this.workspaceId).then(token => {
        if (token && !this.token) {
          this.token = token;
        }
      });
    }
  }

  protected firstUpdated(): void {
    const focusTarget = this.querySelector<HTMLInputElement>(
      this.endpoint ? '#workspaceToken' : '#workspaceAddress'
    );
    focusTarget?.focus();
  }

  protected render() {
    return html`
      <div class="workspace-connect-backdrop" @click=${this.onCancel}>
        <form
          class="workspace-connect-content"
          role="dialog"
          aria-modal="true"
          aria-labelledby="workspaceConnectTitle"
          @click=${(event: Event) => event.stopPropagation()}
          @submit=${this.onSubmit}
          @keydown=${this.onKeyDown}
        >
          <h2 class="workspace-connect-title" id="workspaceConnectTitle">
            <span class="workspace-connect-title__icon" aria-hidden="true"
              >${this.icons.getIcon('server', IconSize.MEDIUM)}</span
            >
            ${this.workspaceName ? `Reconnect to ${this.workspaceName}` : 'Connect to Workspace'}
          </h2>
          <p class="workspace-connect-copy">
            Run <code>pix3 serve</code> in the project folder on the remote machine, forward its
            port to this computer, then enter the local address and the token it printed.
          </p>

          <div class="workspace-connect-field">
            <label for="workspaceAddress">Address</label>
            <input
              id="workspaceAddress"
              type="text"
              inputmode="url"
              autocomplete="off"
              spellcheck="false"
              .value=${this.address}
              placeholder=${DEFAULT_WORKSPACE_ENDPOINT}
              ?disabled=${this.submitting}
              @input=${(event: InputEvent) =>
                (this.address = (event.target as HTMLInputElement).value)}
            />
          </div>

          <div class="workspace-connect-field">
            <label for="workspaceToken">Token</label>
            <input
              id="workspaceToken"
              type="password"
              autocomplete="off"
              spellcheck="false"
              .value=${this.token}
              placeholder="p3ws_…"
              ?disabled=${this.submitting}
              @input=${(event: InputEvent) =>
                (this.token = (event.target as HTMLInputElement).value)}
            />
            <span class="workspace-connect-hint"
              >Stored in this browser for this workspace;
              <code>pix3 serve --new-token</code> revokes it.</span
            >
          </div>

          ${this.error
            ? html`<div class="workspace-connect-error" role="alert">
                <span class="workspace-connect-error__icon" aria-hidden="true"
                  >${this.icons.getIcon('alert-triangle', IconSize.SMALL)}</span
                >
                <span>${this.error}</span>
              </div>`
            : null}

          <div class="workspace-connect-actions">
            <button
              type="button"
              class="workspace-connect-btn"
              ?disabled=${this.submitting}
              @click=${this.onCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="workspace-connect-btn workspace-connect-btn--primary"
              ?disabled=${this.submitting || !this.address.trim() || !this.token.trim()}
            >
              ${this.submitting ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>
      </div>
    `;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !this.submitting) {
      event.stopPropagation();
      this.onCancel();
    }
  };

  private onCancel = (): void => {
    if (this.submitting) {
      return;
    }
    this.dialogService.close();
  };

  private onSubmit = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (this.submitting) {
      return;
    }
    // Reconnecting the open workspace keeps its documents; only a real switch asks about them.
    const isReconnect =
      appState.project.backend === 'workspace' &&
      this.workspaceId !== null &&
      appState.project.id === this.workspaceId;
    if (!isReconnect && !(await this.projectLifecycleService.confirmProjectSwitchIfNeeded())) {
      return;
    }
    this.submitting = true;
    this.error = '';
    try {
      await this.projectService.openWorkspaceProject({
        endpoint: this.address,
        token: this.token,
      });
      // The welcome screen (if showing) switches to the editor route on `status === 'ready'`.
      this.dialogService.close();
    } catch (error) {
      this.error = isWorkspaceError(error)
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Could not connect to the workspace.';
    } finally {
      this.submitting = false;
    }
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-workspace-connect-dialog': Pix3WorkspaceConnectDialog;
  }
}
