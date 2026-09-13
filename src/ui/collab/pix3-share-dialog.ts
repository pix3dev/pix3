import { ComponentBase, customElement, html, inject, state } from '@/fw';
import { query } from 'lit/decorators.js';
import { nothing } from 'lit';
import { appState } from '@/state';
import { CollabSessionService } from '@/services/collab/CollabSessionService';
import { CloudProjectService } from '@/services/cloud/CloudProjectService';
import { DialogService } from '@/services/editor/DialogService';
import * as ApiClient from '@/services/cloud/ApiClient';
import type {
  ApiAssignableProjectMemberRole,
  ApiProjectAccess,
  ApiProjectMember,
  ApiProjectUserSuggestion,
} from '@/services/cloud/ApiClient';
import { subscribe } from 'valtio/vanilla';
import './pix3-share-dialog.ts.css';

type ShareScope = 'private' | 'selected' | 'link';

/**
 * Sharing state of the project the dialog acts on. For an open cloud project this mirrors
 * `appState.collaboration`; for a local folder linked to a cloud copy it is fetched from the
 * server, because the editor is not connected to that project's room.
 */
interface ShareAccess {
  shareEnabled: boolean;
  shareToken: string | null;
  role: ApiProjectAccess['role'] | null;
}

interface ShareTarget {
  projectId: string;
  /** `true` when the target is the cloud copy linked to the open local folder. */
  isLinkedCopy: boolean;
}

const EMPTY_ACCESS: ShareAccess = { shareEnabled: false, shareToken: null, role: null };

const sortMembers = (members: ApiProjectMember[]): ApiProjectMember[] =>
  [...members].sort((left, right) => {
    const leftRank = left.role === 'owner' ? 0 : left.role === 'editor' ? 1 : 2;
    const rightRank = right.role === 'owner' ? 0 : right.role === 'editor' ? 1 : 2;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.email.localeCompare(right.email);
  });

@customElement('pix3-share-dialog')
export class Pix3ShareDialog extends ComponentBase {
  @inject(CloudProjectService)
  private readonly cloudProjectService!: CloudProjectService;

  @inject(CollabSessionService)
  private readonly collabSessionService!: CollabSessionService;

  @inject(DialogService)
  private readonly dialogService!: DialogService;

  @state() private isOpen = false;
  @state() private link = '';
  @state() private copyLabel = 'Copy link';
  @state() private errorMessage = '';
  @state() private isLoadingMembers = false;
  @state() private isUpdatingScope = false;
  @state() private isSubmittingInvite = false;
  @state() private isSearchingUsers = false;
  @state() private removingUserId: string | null = null;
  @state() private updatingRoleUserId: string | null = null;
  @state() private inviteEmail = '';
  @state() private inviteRole: ApiAssignableProjectMemberRole = 'viewer';
  @state() private members: ApiProjectMember[] = [];
  @state() private suggestions: ApiProjectUserSuggestion[] = [];
  @state() private isSuggestionsOpen = false;
  @state() private shareScope: ShareScope = 'private';
  @state() private access: ShareAccess = EMPTY_ACCESS;
  @state() private isLoadingAccess = false;

  @query('#shareLinkInput') private inputEl!: HTMLInputElement | null;

  private disposeProjectSubscription?: () => void;
  private disposeCollaborationSubscription?: () => void;
  private disposeAuthSubscription?: () => void;
  private inviteBlurTimeout: number | null = null;
  private searchRequestId = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeProjectSubscription = subscribe(appState.project, () => {
      if (this.isOpen) {
        this.updateLink();
      }
      this.requestUpdate();
    });
    this.disposeCollaborationSubscription = subscribe(appState.collaboration, () => {
      if (this.isOpen && !this.shareTarget?.isLinkedCopy) {
        this.syncAccessFromCollaborationState();
        this.updateLink();
      }
      this.requestUpdate();
    });
    this.disposeAuthSubscription = subscribe(appState.auth, () => {
      this.requestUpdate();
    });
  }

  disconnectedCallback(): void {
    this.disposeProjectSubscription?.();
    this.disposeProjectSubscription = undefined;
    this.disposeCollaborationSubscription?.();
    this.disposeCollaborationSubscription = undefined;
    this.disposeAuthSubscription?.();
    this.disposeAuthSubscription = undefined;
    if (this.inviteBlurTimeout !== null) {
      window.clearTimeout(this.inviteBlurTimeout);
      this.inviteBlurTimeout = null;
    }
    super.disconnectedCallback();
  }

  public openDialog(): void {
    this.isOpen = true;
    this.copyLabel = 'Copy link';
    this.errorMessage = '';
    this.inviteEmail = '';
    this.inviteRole = 'viewer';
    this.members = [];
    this.suggestions = [];
    this.isSuggestionsOpen = false;
    this.access = EMPTY_ACCESS;
    this.shareScope = 'private';
    if (!this.shareTarget?.isLinkedCopy) {
      this.syncAccessFromCollaborationState();
      this.shareScope = this.access.shareEnabled ? 'link' : 'private';
    }
    this.updateLink();
    void this.initializeDialog();
  }

  public closeDialog(): void {
    this.isOpen = false;
    this.copyLabel = 'Copy link';
    this.errorMessage = '';
    this.suggestions = [];
    this.isSuggestionsOpen = false;
  }

  private async initializeDialog(): Promise<void> {
    if (this.shareTarget?.isLinkedCopy) {
      await this.loadLinkedCopyAccess();
    }
    await this.loadMembers();
    if (this.shareScope === 'link') {
      window.setTimeout(() => this.inputEl?.select(), 50);
    }
  }

  /**
   * The project this dialog shares: the open cloud project, or — for a local folder that has
   * been synced to the cloud — its linked cloud copy. Collaborators always work in the cloud
   * copy; the local owner exchanges changes with it through Sync Project.
   */
  private get shareTarget(): ShareTarget | null {
    if (appState.project.backend === 'cloud' && appState.project.id) {
      return { projectId: appState.project.id, isLinkedCopy: false };
    }

    const linkedCloudProjectId = appState.project.hybridSync.linkedCloudProjectId;
    if (linkedCloudProjectId) {
      return { projectId: linkedCloudProjectId, isLinkedCopy: true };
    }

    return null;
  }

  private get targetProjectId(): string | null {
    return this.shareTarget?.projectId ?? null;
  }

  private syncAccessFromCollaborationState(): void {
    this.access = {
      shareEnabled: appState.collaboration.shareEnabled,
      shareToken: appState.collaboration.shareToken,
      role: appState.collaboration.role,
    };
  }

  private async loadLinkedCopyAccess(): Promise<void> {
    const projectId = this.targetProjectId;
    if (!projectId || !appState.auth.isAuthenticated) {
      this.access = EMPTY_ACCESS;
      return;
    }

    this.isLoadingAccess = true;
    try {
      const access = await ApiClient.getProjectAccess(projectId);
      this.access = {
        shareEnabled: access.share_enabled,
        shareToken: access.share_token,
        role: access.role,
      };
      this.shareScope = access.share_enabled ? 'link' : 'private';
      this.updateLink();
    } catch (error) {
      this.errorMessage =
        error instanceof Error ? error.message : 'Failed to load sharing state of the cloud copy.';
    } finally {
      this.isLoadingAccess = false;
    }
  }

  private updateLink(): void {
    const projectId = this.targetProjectId;
    const sceneId = appState.scenes.activeSceneId;
    const shareToken = this.access.shareToken;

    if (!projectId || !sceneId || !this.access.shareEnabled || !shareToken) {
      this.link = '';
      return;
    }

    this.link = this.collabSessionService.buildInviteLink(projectId, sceneId, shareToken);
  }

  private buildLinkFromShareToken(shareToken?: string): string {
    const projectId = this.targetProjectId;
    const sceneId = appState.scenes.activeSceneId;
    if (!projectId || !sceneId) {
      return '';
    }

    return this.collabSessionService.buildInviteLink(projectId, sceneId, shareToken);
  }

  private get canManageShareSettings(): boolean {
    return this.access.role === 'owner';
  }

  private get canManageMembers(): boolean {
    return this.access.role === 'owner';
  }

  private get nonOwnerMembers(): ApiProjectMember[] {
    return this.members.filter(member => member.role !== 'owner');
  }

  private get isBusy(): boolean {
    return (
      this.isLoadingAccess ||
      this.isUpdatingScope ||
      this.isSubmittingInvite ||
      this.isLoadingMembers ||
      this.removingUserId !== null ||
      this.updatingRoleUserId !== null
    );
  }

  private get hasShareTarget(): boolean {
    return this.shareTarget !== null;
  }

  private syncScopeFromState(preserveSelectedScope = false): void {
    if (this.access.shareEnabled) {
      this.shareScope = 'link';
      return;
    }

    if (
      this.nonOwnerMembers.length > 0 ||
      (preserveSelectedScope && this.shareScope === 'selected')
    ) {
      this.shareScope = 'selected';
      return;
    }

    this.shareScope = 'private';
  }

  private async loadMembers(options?: { preserveSelectedScope?: boolean }): Promise<void> {
    if (!this.hasShareTarget || !this.targetProjectId || !appState.auth.isAuthenticated) {
      this.members = [];
      this.syncScopeFromState(options?.preserveSelectedScope ?? false);
      return;
    }

    this.isLoadingMembers = true;

    try {
      const { members } = await ApiClient.getProjectMembers(this.targetProjectId);
      this.members = sortMembers(members);
      this.syncScopeFromState(options?.preserveSelectedScope ?? false);
    } catch (error) {
      this.errorMessage =
        error instanceof Error ? error.message : 'Failed to load project access members.';
    } finally {
      this.isLoadingMembers = false;
    }
  }

  private async confirmSwitchToPrivate(): Promise<boolean> {
    const shouldRevokeLink = this.access.shareEnabled;
    const shouldRemoveMembers = this.nonOwnerMembers.length > 0;

    if (!shouldRevokeLink && !shouldRemoveMembers) {
      return true;
    }

    const effects: string[] = [];
    if (shouldRevokeLink) {
      effects.push('revoke the public link');
    }
    if (shouldRemoveMembers) {
      effects.push('remove all selected users');
    }

    return this.dialogService.showConfirmation({
      title: 'Restrict Access to Only Me',
      message: `This will ${effects.join(' and ')}.`,
      confirmLabel: 'Restrict access',
      cancelLabel: 'Cancel',
      isDangerous: true,
    });
  }

  private async onShareScopeChange(event: Event): Promise<void> {
    const target = event.target as HTMLSelectElement;
    const nextScope = target.value as ShareScope;
    const previousScope = this.shareScope;

    if (
      !this.hasShareTarget ||
      !this.targetProjectId ||
      nextScope === this.shareScope ||
      !this.canManageShareSettings ||
      this.isBusy
    ) {
      target.value = this.shareScope;
      return;
    }

    this.errorMessage = '';
    this.isUpdatingScope = true;

    try {
      if (nextScope === 'private') {
        const confirmed = await this.confirmSwitchToPrivate();
        if (!confirmed) {
          target.value = previousScope;
          return;
        }

        if (this.access.shareEnabled) {
          await this.cloudProjectService.revokeShareToken(this.targetProjectId);
          this.access = { ...this.access, shareEnabled: false, shareToken: null };
        }

        if (this.nonOwnerMembers.length > 0) {
          await ApiClient.removeAllNonOwnerProjectMembers(this.targetProjectId);
          this.members = this.members.filter(member => member.role === 'owner');
        }

        this.link = '';
        this.shareScope = 'private';
        return;
      }

      if (nextScope === 'selected') {
        if (this.access.shareEnabled) {
          await this.cloudProjectService.revokeShareToken(this.targetProjectId);
          this.access = { ...this.access, shareEnabled: false, shareToken: null };
        }

        this.link = '';
        this.shareScope = 'selected';
        return;
      }

      if (!appState.scenes.activeSceneId) {
        throw new Error('Open a scene before enabling link sharing.');
      }

      const shareToken = await this.cloudProjectService.generateShareToken(this.targetProjectId);
      this.access = { ...this.access, shareEnabled: true, shareToken };
      this.link = this.buildLinkFromShareToken(shareToken);
      this.copyLabel = 'Copy link';
      this.shareScope = 'link';
      window.setTimeout(() => this.inputEl?.select(), 50);
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Failed to update sharing.';
      target.value = previousScope;
    } finally {
      this.isUpdatingScope = false;
      this.requestUpdate();
    }
  }

  private async copyLink(): Promise<void> {
    if (!this.link) {
      return;
    }

    let copied = false;

    try {
      await navigator.clipboard.writeText(this.link);
      copied = true;
    } catch {
      if (this.inputEl) {
        this.inputEl.select();
        try {
          copied = document.execCommand('copy');
        } catch {
          copied = false;
        }
      }
    }

    this.copyLabel = copied ? 'Copied' : 'Copy failed';
    window.setTimeout(() => {
      this.copyLabel = 'Copy link';
    }, 1400);
  }

  private closeSuggestionPopup(): void {
    if (this.inviteBlurTimeout !== null) {
      window.clearTimeout(this.inviteBlurTimeout);
      this.inviteBlurTimeout = null;
    }
    this.isSuggestionsOpen = false;
  }

  private openSuggestionPopup(): void {
    if (
      this.suggestions.length > 0 ||
      this.isSearchingUsers ||
      this.inviteEmail.trim().length >= 2
    ) {
      this.isSuggestionsOpen = true;
    }
  }

  private onInviteFocus = (): void => {
    if (this.inviteBlurTimeout !== null) {
      window.clearTimeout(this.inviteBlurTimeout);
      this.inviteBlurTimeout = null;
    }
    this.openSuggestionPopup();
  };

  private onInviteBlur = (): void => {
    this.inviteBlurTimeout = window.setTimeout(() => {
      this.isSuggestionsOpen = false;
      this.inviteBlurTimeout = null;
    }, 140);
  };

  private async updateSuggestions(emailQuery: string): Promise<void> {
    const projectId = this.targetProjectId;
    if (!projectId || !this.canManageMembers || emailQuery.trim().length < 2) {
      this.suggestions = [];
      this.isSearchingUsers = false;
      this.isSuggestionsOpen = false;
      return;
    }

    this.isSearchingUsers = true;
    const requestId = ++this.searchRequestId;

    try {
      const { users } = await ApiClient.searchProjectUsersByEmail(projectId, emailQuery.trim());
      if (requestId !== this.searchRequestId) {
        return;
      }

      this.suggestions = users;
      this.isSuggestionsOpen = true;
    } catch {
      if (requestId !== this.searchRequestId) {
        return;
      }
      this.suggestions = [];
      this.isSuggestionsOpen = false;
    } finally {
      if (requestId === this.searchRequestId) {
        this.isSearchingUsers = false;
      }
    }
  }

  private onInviteEmailInput = (event: Event): void => {
    this.inviteEmail = (event.target as HTMLInputElement).value;
    void this.updateSuggestions(this.inviteEmail);
  };

  private onInviteKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.addMember();
      return;
    }

    if (event.key === 'Escape') {
      this.closeSuggestionPopup();
    }
  };

  private selectSuggestion = (suggestion: ApiProjectUserSuggestion): void => {
    if (this.inviteBlurTimeout !== null) {
      window.clearTimeout(this.inviteBlurTimeout);
      this.inviteBlurTimeout = null;
    }
    this.inviteEmail = suggestion.email;
    this.suggestions = [];
    this.isSuggestionsOpen = false;
  };

  private async addMember(): Promise<void> {
    const projectId = this.targetProjectId;
    const email = this.inviteEmail.trim();
    if (!projectId || !email || !this.canManageMembers || this.isBusy) {
      return;
    }

    const previousScope = this.shareScope;
    this.errorMessage = '';
    this.isSubmittingInvite = true;

    try {
      await ApiClient.addProjectMember(projectId, email, this.inviteRole);
      this.inviteEmail = '';
      this.suggestions = [];
      this.isSuggestionsOpen = false;
      this.shareScope = this.shareScope === 'private' ? 'selected' : this.shareScope;
      await this.loadMembers({ preserveSelectedScope: true });
    } catch (error) {
      this.shareScope = previousScope;
      this.errorMessage = error instanceof Error ? error.message : 'Failed to add project member.';
    } finally {
      this.isSubmittingInvite = false;
    }
  }

  private async updateMemberRole(member: ApiProjectMember, event: Event): Promise<void> {
    const projectId = this.targetProjectId;
    const nextRole = (event.target as HTMLSelectElement).value as ApiAssignableProjectMemberRole;
    if (
      !projectId ||
      member.role === 'owner' ||
      member.role === nextRole ||
      !this.canManageMembers
    ) {
      return;
    }

    this.errorMessage = '';
    this.updatingRoleUserId = member.user_id;

    try {
      await ApiClient.updateProjectMemberRole(projectId, member.user_id, nextRole);
      await this.loadMembers({ preserveSelectedScope: this.shareScope === 'selected' });
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Failed to update member role.';
    } finally {
      this.updatingRoleUserId = null;
    }
  }

  private async removeMember(member: ApiProjectMember): Promise<void> {
    const projectId = this.targetProjectId;
    if (!projectId || member.role === 'owner' || !this.canManageMembers) {
      return;
    }

    this.errorMessage = '';
    this.removingUserId = member.user_id;

    try {
      await ApiClient.removeProjectMember(projectId, member.user_id);
      await this.loadMembers({ preserveSelectedScope: this.shareScope === 'selected' });
    } catch (error) {
      this.errorMessage =
        error instanceof Error ? error.message : 'Failed to remove project member.';
    } finally {
      this.removingUserId = null;
    }
  }

  private getRoleLabel(role: ApiProjectMember['role']): string {
    switch (role) {
      case 'owner':
        return 'Owner';
      case 'editor':
        return 'Editor';
      default:
        return 'Viewer';
    }
  }

  private renderShareHint() {
    if (this.shareScope === 'link') {
      return html`
        <div class="pix3-share-hint">
          Anyone with the link can open the project in view-only mode. Explicit members keep their
          assigned roles.
        </div>
      `;
    }

    if (this.shareScope === 'selected') {
      return html`
        <div class="pix3-share-hint">
          Only invited Pix3 users can access this project. Add people by email below.
        </div>
      `;
    }

    return html`
      <div class="pix3-share-hint">
        Only the project owner can access this workspace until you invite specific users or enable a
        public link.
      </div>
    `;
  }

  private renderInviteSuggestions() {
    const shouldRenderEmptyState =
      this.inviteEmail.trim().length >= 2 &&
      !this.isSearchingUsers &&
      this.suggestions.length === 0;

    if (
      !this.isSuggestionsOpen ||
      (!this.isSearchingUsers && !shouldRenderEmptyState && this.suggestions.length === 0)
    ) {
      return nothing;
    }

    return html`
      <div class="pix3-share-suggestions" role="listbox">
        ${this.isSearchingUsers
          ? html`<div class="pix3-share-suggestions__status">Searching users…</div>`
          : nothing}
        ${!this.isSearchingUsers && this.suggestions.length > 0
          ? this.suggestions.map(
              suggestion => html`
                <button
                  class="pix3-share-suggestion"
                  type="button"
                  @pointerdown=${(event: PointerEvent) => {
                    event.preventDefault();
                    this.selectSuggestion(suggestion);
                  }}
                >
                  <span class="pix3-share-suggestion__email">${suggestion.email}</span>
                  <span class="pix3-share-suggestion__name">${suggestion.username}</span>
                </button>
              `
            )
          : nothing}
        ${shouldRenderEmptyState
          ? html`<div class="pix3-share-suggestions__status">No registered users found.</div>`
          : nothing}
      </div>
    `;
  }

  private renderMembersSection() {
    if (!this.hasShareTarget) {
      return nothing;
    }

    const isAuthenticatedMember = appState.auth.isAuthenticated;
    const currentUserId = appState.auth.user?.id ?? null;

    return html`
      <div class="pix3-share-section">
        <div class="pix3-share-section__header">
          <div class="pix3-share-section__title">Selected Users</div>
        </div>
        ${!isAuthenticatedMember
          ? html`
              <div class="pix3-share-empty">
                Sign in as a project member to manage explicit user access.
              </div>
            `
          : nothing}
        ${isAuthenticatedMember && this.canManageMembers
          ? html`
              <div class="pix3-share-row">
                <label class="pix3-share-field-label" for="inviteEmailInput">Add user</label>
                <div class="pix3-share-invite">
                  <div class="pix3-share-invite__field">
                    <input
                      id="inviteEmailInput"
                      class="pix3-share-input"
                      .value=${this.inviteEmail}
                      @input=${this.onInviteEmailInput}
                      @focus=${this.onInviteFocus}
                      @blur=${this.onInviteBlur}
                      @keydown=${this.onInviteKeyDown}
                      placeholder="Search registered user by email"
                      autocomplete="off"
                    />
                    ${this.renderInviteSuggestions()}
                  </div>
                  <select
                    class="pix3-share-select pix3-share-select--compact"
                    .value=${this.inviteRole}
                    ?disabled=${this.isBusy}
                    @change=${(event: Event) => {
                      this.inviteRole = (event.target as HTMLSelectElement)
                        .value as ApiAssignableProjectMemberRole;
                    }}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                  <button
                    class="pix3-share-button pix3-share-button--primary"
                    @click=${() => void this.addMember()}
                    ?disabled=${this.isBusy || this.inviteEmail.trim().length === 0}
                  >
                    ${this.isSubmittingInvite ? 'Adding...' : 'Add'}
                  </button>
                </div>
              </div>
            `
          : nothing}
        ${isAuthenticatedMember && this.isLoadingMembers
          ? html`<div class="pix3-share-empty">Loading members…</div>`
          : nothing}
        ${isAuthenticatedMember && !this.isLoadingMembers && this.members.length === 0
          ? html`
              <div class="pix3-share-empty">
                No project members loaded yet. Reopen the dialog if this persists.
              </div>
            `
          : nothing}
        ${isAuthenticatedMember && !this.isLoadingMembers && this.members.length > 0
          ? html`
              <ul class="pix3-share-members">
                ${this.members.map(
                  member => html`
                    <li class="pix3-share-member">
                      <div class="pix3-share-member__info">
                        <div class="pix3-share-member__identity">
                          <span class="pix3-share-member__email">${member.email}</span>
                          ${member.user_id === currentUserId
                            ? html`<span class="pix3-share-member__tag">You</span>`
                            : nothing}
                        </div>
                        <div class="pix3-share-member__name">${member.username}</div>
                      </div>
                      <div class="pix3-share-member__actions">
                        ${member.role === 'owner' || !this.canManageMembers
                          ? html`
                              <span class="pix3-share-role-pill">
                                ${this.getRoleLabel(member.role)}
                              </span>
                            `
                          : html`
                              <select
                                class="pix3-share-select pix3-share-select--compact"
                                .value=${member.role}
                                ?disabled=${this.isBusy &&
                                this.updatingRoleUserId !== member.user_id}
                                @change=${(event: Event) =>
                                  void this.updateMemberRole(member, event)}
                              >
                                <option value="viewer">Viewer</option>
                                <option value="editor">Editor</option>
                              </select>
                            `}
                        ${member.role !== 'owner' && this.canManageMembers
                          ? html`
                              <button
                                class="pix3-share-button pix3-share-button--danger"
                                @click=${() => void this.removeMember(member)}
                                ?disabled=${this.isBusy && this.removingUserId !== member.user_id}
                              >
                                ${this.removingUserId === member.user_id ? 'Removing...' : 'Remove'}
                              </button>
                            `
                          : nothing}
                      </div>
                    </li>
                  `
                )}
              </ul>
            `
          : nothing}
      </div>
    `;
  }

  private onOverlayClick(): void {
    this.closeDialog();
  }

  protected render() {
    if (!this.isOpen) {
      return nothing;
    }

    return html`
      <div class="pix3-share-overlay" @click=${this.onOverlayClick}>
        <div class="pix3-share-dialog" @click=${(event: Event) => event.stopPropagation()}>
          <div class="pix3-share-header">
            <div class="pix3-share-title">Share Project</div>
            <div class="pix3-share-subtitle">
              ${this.shareTarget?.isLinkedCopy
                ? 'Manage who can open the cloud copy of this folder and whether a view-only share link is active.'
                : 'Manage who can open this cloud project and whether a view-only share link is active.'}
            </div>
          </div>
          <div class="pix3-share-body">
            ${this.errorMessage
              ? html`<div class="pix3-share-error">${this.errorMessage}</div>`
              : nothing}
            ${this.shareTarget?.isLinkedCopy
              ? html`
                  <div class="pix3-share-hint pix3-share-hint--linked">
                    You are sharing the cloud copy linked to this folder. Collaborators work in the
                    cloud project; run Project / Sync Project to exchange changes with it.
                  </div>
                `
              : nothing}
            ${this.hasShareTarget
              ? html`
                  <div class="pix3-share-section">
                    <div class="pix3-share-section__header">
                      <div class="pix3-share-section__title">Share Access</div>
                    </div>
                    <div class="pix3-share-row">
                      <label class="pix3-share-field-label" for="sharedForSelect">Shared for</label>
                      <select
                        id="sharedForSelect"
                        class="pix3-share-select"
                        .value=${this.shareScope}
                        ?disabled=${this.isUpdatingScope || !this.canManageShareSettings}
                        @change=${(event: Event) => void this.onShareScopeChange(event)}
                      >
                        <option value="private">Only me</option>
                        <option value="selected">Selected users</option>
                        <option value="link">Any user with the link</option>
                      </select>
                    </div>
                    ${this.renderShareHint()}
                    ${this.shareScope === 'link'
                      ? html`
                          <input
                            id="shareLinkInput"
                            class="pix3-share-input"
                            .value=${this.link}
                            readonly
                          />
                        `
                      : nothing}
                  </div>
                  ${this.renderMembersSection()}
                `
              : html`
                  <div class="pix3-share-empty">
                    Sharing needs a cloud project. Open one, or create a cloud copy of this folder
                    with Project / Sync Project — the copy can then be shared from here.
                  </div>
                `}
          </div>
          <div class="pix3-share-actions">
            ${this.hasShareTarget
              ? html`
                  <button
                    class="pix3-share-button"
                    @click=${this.copyLink}
                    ?disabled=${this.shareScope !== 'link' || !this.link}
                  >
                    ${this.copyLabel}
                  </button>
                `
              : nothing}
            <button class="pix3-share-button" @click=${this.closeDialog}>Close</button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-share-dialog': Pix3ShareDialog;
  }
}
