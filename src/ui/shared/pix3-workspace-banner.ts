import { subscribe } from 'valtio/vanilla';
import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { appState, type WorkspaceConnectionState } from '@/state';
import { IconService, IconSize } from '@/services/editor/IconService';
import { WorkspaceSessionService } from '@/services/project/workspace/WorkspaceSessionService';
import { WorkspaceConnectDialogService } from '@/services/project/workspace/WorkspaceConnectDialogService';
import { ProjectOwnershipService } from '@/services/project/coauthoring/ProjectOwnershipService';
import './pix3-workspace-banner.ts.css';

type BannerKind = 'read-only' | 'disconnected' | 'not-owner' | null;

/**
 * The one state that must not hide in the status bar: this window cannot save.
 * Workspace: shown while another window holds the edit lease (with an explicit "Take over") and
 * after the connection died for good (with "Reconnect…"); a transient reconnect stays in the
 * status bar. Local folder: shown while another window of the same browser profile holds the
 * project's Web Lock (plan §4.3 "Несколько окон") — "Take over" runs the `BroadcastChannel`
 * hand-over of `ProjectOwnershipService`. A refused edit (`coauthoring.editBlockedAt`) makes the
 * banner say so for a moment.
 */
@customElement('pix3-workspace-banner')
export class Pix3WorkspaceBanner extends ComponentBase {
  @inject(IconService)
  private readonly icons!: IconService;

  @inject(WorkspaceSessionService)
  private readonly session!: WorkspaceSessionService;

  @inject(WorkspaceConnectDialogService)
  private readonly connectDialog!: WorkspaceConnectDialogService;

  @inject(ProjectOwnershipService)
  private readonly ownership!: ProjectOwnershipService;

  @state() private takeOverPending = false;
  @state() private blockedFlash = false;
  private lastBlockedAt: number | null = null;
  private blockedTimer: ReturnType<typeof setTimeout> | null = null;

  @state() private kind: BannerKind = null;
  @state() private inGrace = false;
  @state() private errorMessage: string | null = null;

  private disposeProjectSubscription?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.sync();
    this.disposeProjectSubscription = subscribe(appState.project, () => this.sync());
  }

  disconnectedCallback(): void {
    this.disposeProjectSubscription?.();
    this.disposeProjectSubscription = undefined;
    if (this.blockedTimer !== null) clearTimeout(this.blockedTimer);
    this.blockedTimer = null;
    super.disconnectedCallback();
  }

  private sync(): void {
    const project = appState.project;
    const workspace: WorkspaceConnectionState = project.workspace;
    this.syncBlocked();
    if (
      project.status === 'ready' &&
      (project.backend === 'local' || project.backend === 'browser')
    ) {
      this.kind = project.coauthoring.isOwner ? null : 'not-owner';
      this.takeOverPending = project.coauthoring.takeOverPending;
      return;
    }
    if (project.backend !== 'workspace' || project.status !== 'ready') {
      this.kind = null;
      return;
    }
    if (workspace.status === 'disconnected') {
      this.kind = 'disconnected';
    } else if (workspace.lease === 'busy' || workspace.lease === 'lost') {
      this.kind = 'read-only';
    } else {
      this.kind = null;
    }
    this.inGrace = workspace.leaseInGrace;
    this.errorMessage = workspace.errorMessage;
  }

  protected render() {
    if (!this.kind) {
      return null;
    }

    if (this.kind === 'disconnected') {
      return html`
        <div class="workspace-banner workspace-banner--error" role="alert">
          <span class="workspace-banner__icon" aria-hidden="true"
            >${this.icons.getIcon('alert-triangle', IconSize.SMALL)}</span
          >
          <span class="workspace-banner__text">
            Workspace disconnected — changes cannot be saved.
            ${this.errorMessage
              ? html`<span class="workspace-banner__detail">${this.errorMessage}</span>`
              : null}
          </span>
          <button type="button" class="workspace-banner__action" @click=${this.onReconnect}>
            Reconnect…
          </button>
        </div>
      `;
    }

    if (this.kind === 'not-owner') {
      return html`
        <div
          class="workspace-banner ${this.blockedFlash ? 'workspace-banner--flash' : ''}"
          role="status"
          data-kind="not-owner"
        >
          <span class="workspace-banner__icon" aria-hidden="true"
            >${this.icons.getIcon('lock', IconSize.SMALL)}</span
          >
          <span class="workspace-banner__text"
            >Project is being edited in another window. This window is view-only.
            ${this.blockedFlash
              ? html`<span class="workspace-banner__detail"
                  >Editing is disabled here — take over to edit.</span
                >`
              : null}</span
          >
          <button
            type="button"
            class="workspace-banner__action"
            ?disabled=${this.takeOverPending}
            @click=${this.onTakeOverLocal}
          >
            ${this.takeOverPending ? 'Taking over…' : 'Take over'}
          </button>
        </div>
      `;
    }

    const lostCopy =
      appState.project.workspace.lease === 'lost'
        ? 'Another Pix3 window took over this workspace.'
        : this.inGrace
          ? 'Another Pix3 window was editing this workspace and may come back.'
          : 'Another Pix3 window is editing this workspace.';

    return html`
      <div class="workspace-banner" role="status">
        <span class="workspace-banner__icon" aria-hidden="true"
          >${this.icons.getIcon('lock', IconSize.SMALL)}</span
        >
        <span class="workspace-banner__text"
          >${lostCopy} This window is read-only: nothing here will be saved.</span
        >
        <button type="button" class="workspace-banner__action" @click=${this.onTakeOver}>
          Take over
        </button>
      </div>
    `;
  }

  private onTakeOverLocal = (): void => {
    void this.ownership.requestTakeOver();
  };

  private syncBlocked(): void {
    const at = appState.project.coauthoring.editBlockedAt;
    if (at === null || at === this.lastBlockedAt) return;
    this.lastBlockedAt = at;
    this.blockedFlash = true;
    if (this.blockedTimer !== null) clearTimeout(this.blockedTimer);
    this.blockedTimer = setTimeout(() => {
      this.blockedTimer = null;
      this.blockedFlash = false;
    }, 2500);
  }

  private onTakeOver = (): void => {
    this.session.takeOverLease();
  };

  private onReconnect = (): void => {
    this.connectDialog.open({
      endpoint: appState.project.workspace.endpoint,
      errorMessage: appState.project.workspace.errorMessage,
      workspaceName: appState.project.projectName,
      workspaceId: appState.project.id,
    });
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-workspace-banner': Pix3WorkspaceBanner;
  }
}
