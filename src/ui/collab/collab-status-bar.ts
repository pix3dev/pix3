import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ComponentBase } from '@/fw/component-base';
import { ServiceContainer } from '@/fw/di';
import {
  CollaborationService,
  type CollabConnectionStatus,
} from '@/services/collab/CollaborationService';
import { appState, type CollabRemoteUser } from '@/state';
import { subscribe } from 'valtio/vanilla';
import './collab-status-bar.ts.css';

interface RemoteUserDisplay {
  clientId: number;
  name: string;
  color: string;
}

export function isSystemParticipantName(name: string, projectName?: string | null): boolean {
  const normalizedName = name.trim();
  if (!normalizedName) {
    return true;
  }

  if (normalizedName === 'Pix3 Host') {
    return true;
  }

  const normalizedProjectName = projectName?.trim();
  if (normalizedProjectName && normalizedName === `${normalizedProjectName} Host`) {
    return true;
  }

  return false;
}

@customElement('collab-status-bar')
export class CollabStatusBar extends ComponentBase {
  @state() private connectionStatus: CollabConnectionStatus = 'disconnected';
  @state() private remoteUsers: RemoteUserDisplay[] = [];
  @state() private showDropdown = false;

  private unsubscribe: (() => void) | null = null;
  private removeStatusListener: (() => void) | null = null;
  private awarenessHandler: (() => void) | null = null;
  private awarenessSource: { off: (event: 'change', handler: () => void) => void } | null = null;

  connectedCallback(): void {
    super.connectedCallback();

    // Subscribe to collaboration state
    this.unsubscribe = subscribe(appState.collaboration, () => {
      this.connectionStatus = appState.collaboration.connectionStatus;
    });

    // Listen for awareness changes
    this.setupStatusListener();
    this.attachAwarenessListener();

    // Close dropdown on outside click
    this.handleOutsideClick = this.handleOutsideClick.bind(this);
    document.addEventListener('click', this.handleOutsideClick);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.removeStatusListener?.();
    document.removeEventListener('click', this.handleOutsideClick);
    this.cleanupAwareness();
  }

  private setupStatusListener(): void {
    try {
      const container = ServiceContainer.getInstance();
      const collabService = container.getService<CollaborationService>(
        container.getOrCreateToken(CollaborationService)
      );

      this.removeStatusListener = collabService.addStatusListener(() => {
        this.connectionStatus = collabService.connectionStatus;
        if (
          collabService.connectionStatus === 'connected' ||
          collabService.connectionStatus === 'synced'
        ) {
          this.attachAwarenessListener();
          this.updateRemoteUsers();
        } else if (collabService.connectionStatus === 'disconnected') {
          this.cleanupAwareness();
          this.remoteUsers = [];
          appState.collaboration.remoteUsers = [];
        }
      });
    } catch {
      // CollaborationService not available yet
    }
  }

  private attachAwarenessListener(): void {
    try {
      const container = ServiceContainer.getInstance();
      const collabService = container.getService<CollaborationService>(
        container.getOrCreateToken(CollaborationService)
      );
      const awareness = collabService.getAwareness();
      if (!awareness || this.awarenessSource === awareness) {
        return;
      }

      this.cleanupAwareness();
      this.awarenessHandler = () => {
        this.updateRemoteUsers();
      };
      awareness.on('change', this.awarenessHandler);
      this.awarenessSource = awareness as typeof this.awarenessSource;
    } catch {
      // CollaborationService not available yet
    }
  }

  private cleanupAwareness(): void {
    if (this.awarenessHandler && this.awarenessSource) {
      try {
        this.awarenessSource.off('change', this.awarenessHandler);
      } catch {
        // Service not available
      }
      this.awarenessHandler = null;
      this.awarenessSource = null;
    }
  }

  private updateRemoteUsers(): void {
    try {
      const container = ServiceContainer.getInstance();
      const collabService = container.getService<CollaborationService>(
        container.getOrCreateToken(CollaborationService)
      );
      const awareness = collabService.getAwareness();
      if (!awareness) return;

      const localClientId = awareness.clientID;
      const users: RemoteUserDisplay[] = [];
      const remoteUsers: CollabRemoteUser[] = [];
      awareness.getStates().forEach((state: Record<string, unknown>, clientId: number) => {
        if (clientId === localClientId) {
          return;
        }
        const user = state.user as
          | { name?: string; color?: string; selection?: string[] }
          | undefined;
        if (user?.name && !isSystemParticipantName(user.name, appState.project.projectName)) {
          users.push({
            clientId,
            name: user.name,
            color: user.color || 'var(--fg-3)',
          });
          remoteUsers.push({
            clientId,
            name: user.name,
            color: user.color || 'var(--fg-3)',
            selection: Array.isArray(user.selection) ? [...user.selection] : [],
          });
        }
      });
      this.remoteUsers = users;
      appState.collaboration.remoteUsers = remoteUsers;
    } catch {
      // Service not available
    }
  }

  private handleOutsideClick(e: Event): void {
    if (!this.contains(e.target as Node)) {
      this.showDropdown = false;
    }
  }

  private toggleDropdown(): void {
    if (this.connectionStatus === 'disconnected') {
      return;
    }

    this.showDropdown = !this.showDropdown;
    if (this.showDropdown) {
      this.updateRemoteUsers();
    }
  }

  private get statusText(): string {
    const isCloudProject = appState.project.backend === 'cloud';
    const isReadOnly = appState.collaboration.isReadOnly;

    switch (this.connectionStatus) {
      case 'synced':
        if (this.remoteUsers.length > 0) {
          return `${this.remoteUsers.length} online`;
        }
        return isReadOnly ? 'Read only' : isCloudProject ? 'Cloud shared' : 'Shared';
      case 'connected':
        return isReadOnly ? 'Read only' : isCloudProject ? 'Cloud shared' : 'Connected';
      case 'connecting':
        return isCloudProject ? 'Connecting...' : 'Sharing...';
      case 'disconnected':
        return isCloudProject ? (isReadOnly ? 'Read only' : 'Cloud shared') : 'Local only';
      default:
        return isCloudProject ? 'Cloud shared' : 'Local only';
    }
  }

  private get indicatorClass(): string {
    return `collab-indicator collab-indicator--${this.connectionStatus}`;
  }

  render() {
    return html`
      <div @click=${this.toggleDropdown}>
        <span class=${this.indicatorClass}></span>
        <span class="collab-status-text">${this.statusText}</span>
      </div>
      ${this.showDropdown ? this.renderDropdown() : nothing}
    `;
  }

  private renderDropdown() {
    return html`
      <div class="collab-users-dropdown">
        ${this.remoteUsers.length === 0
          ? html`<div class="collab-user-item">No users connected</div>`
          : this.remoteUsers.map(
              user => html`
                <div class="collab-user-item">
                  <span class="collab-user-dot" style="background-color: ${user.color}"></span>
                  <span class="collab-user-name">${user.name}</span>
                </div>
              `
            )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'collab-status-bar': CollabStatusBar;
  }
}
