import { ComponentBase, customElement, html, inject, state, css, unsafeCSS } from '@/fw';
import QRCode from 'qrcode';
import { IconService, IconSize } from '@/services/editor/IconService';
import {
  OnlineSessionService,
  type OnlineSessionState,
} from '@/services/play/OnlineSessionService';
import { OperationService } from '@/services/core/OperationService';
import { SetPlayModeOperation } from '@/features/scripts/SetPlayModeOperation';
import styles from './pix3-online-session-card.ts.css?raw';

const IDLE_STATE: OnlineSessionState = {
  status: 'idle',
  networkStatus: 'offline',
  room: null,
  joinUrl: null,
  clientId: 0,
  isHost: false,
  peers: [],
  rtt: 0,
  entityCount: 0,
  prefabCount: 0,
  errorMessage: null,
};

/**
 * The multiplayer session card, floating over the running game in the Game tab (plan step 1.5).
 *
 * It overlays rather than replaces the viewport because an online session runs *while* the game
 * does — the host is a player. Collapsed it is a one-line status; expanded it carries the QR and
 * join link a second player needs, the roster, and the two numbers that tell you whether the
 * netcode is healthy: ping and how many replicated entities are currently visible.
 */
@customElement('pix3-online-session-card')
export class Pix3OnlineSessionCard extends ComponentBase {
  static useShadowDom = true;

  static styles = css`
    ${unsafeCSS(styles)}
  `;

  @inject(OnlineSessionService)
  private readonly onlineSession!: OnlineSessionService;

  @inject(OperationService)
  private readonly operationService!: OperationService;

  @inject(IconService)
  private readonly icons!: IconService;

  @state()
  private sessionState: OnlineSessionState = IDLE_STATE;

  @state()
  private collapsed = false;

  @state()
  private copied = false;

  private disposeSubscription?: () => void;
  private renderedQrUrl = '';
  private copiedTimer: number | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeSubscription = this.onlineSession.subscribe(state => {
      this.sessionState = state;
    });
  }

  disconnectedCallback(): void {
    this.disposeSubscription?.();
    this.disposeSubscription = undefined;
    if (this.copiedTimer !== null) {
      window.clearTimeout(this.copiedTimer);
      this.copiedTimer = null;
    }
    super.disconnectedCallback();
  }

  protected updated(): void {
    const joinUrl = this.sessionState.joinUrl ?? '';
    const canvas = this.shadowRoot?.querySelector<HTMLCanvasElement>('.online-qr canvas');
    if (!canvas) {
      // Collapsed: the next expand re-renders it.
      this.renderedQrUrl = '';
      return;
    }

    if (joinUrl && joinUrl !== this.renderedQrUrl) {
      this.renderedQrUrl = joinUrl;
      void QRCode.toCanvas(canvas, joinUrl, {
        width: 160,
        margin: 1,
        color: { dark: '#101418', light: '#f5f7fa' },
      }).catch(error => {
        console.error('[OnlineSessionCard] Failed to render QR code', error);
      });
    }
  }

  protected render() {
    const { status, room, peers, rtt, entityCount, errorMessage } = this.sessionState;
    if (status === 'idle') {
      return null;
    }

    return html`
      <section class="online-card ${this.collapsed ? 'is-collapsed' : ''}">
        <header class="online-card-header">
          <span class="online-status-dot online-status-${this.statusModifier()}"></span>
          <h2 class="online-card-title">${room ? `Room ${room.roomId}` : 'Online session'}</h2>
          <span class="online-card-meta"
            >${peers.length}${room?.maxPlayers ? `/${room.maxPlayers}` : ''}</span
          >
          <button
            class="online-icon-button"
            @click=${() => (this.collapsed = !this.collapsed)}
            title=${this.collapsed ? 'Expand session card' : 'Collapse session card'}
            aria-label=${this.collapsed ? 'Expand session card' : 'Collapse session card'}
            aria-expanded=${String(!this.collapsed)}
          >
            ${this.icons.getIcon(this.collapsed ? 'chevron-down' : 'chevron-up', IconSize.SMALL)}
          </button>
        </header>

        ${this.collapsed
          ? null
          : html`
              <div class="online-card-body">
                <div class="online-stats">
                  <span class="online-stat" title="Round-trip time to the room">
                    <span class="online-stat-label">ping</span>
                    <strong>${rtt} ms</strong>
                  </span>
                  <span class="online-stat" title="Replicated entities currently visible">
                    <span class="online-stat-label">entities</span>
                    <strong>${entityCount}</strong>
                  </span>
                  <span class="online-stat" title="Room tick rate">
                    <span class="online-stat-label">tick</span>
                    <strong>${room?.tickHz ?? 0} Hz</strong>
                  </span>
                </div>

                ${status === 'starting'
                  ? html`<p class="online-note">Creating the room…</p>`
                  : null}
                ${errorMessage ? html`<p class="online-error">${errorMessage}</p>` : null}
                ${this.sessionState.joinUrl ? this.renderInvite() : null} ${this.renderPeers()}

                <div class="online-actions">
                  <button
                    class="online-btn"
                    ?disabled=${!this.sessionState.joinUrl}
                    @click=${this.onCopyClick}
                  >
                    ${this.copied ? 'Copied!' : 'Copy join link'}
                  </button>
                  <button class="online-btn online-btn-danger" @click=${this.onLeaveClick}>
                    Leave room
                  </button>
                </div>
              </div>
            `}
      </section>
    `;
  }

  private renderInvite() {
    return html`
      <div class="online-invite">
        <div class="online-qr"><canvas width="160" height="160"></canvas></div>
        <label class="online-field">
          <span class="online-field-label">Join link</span>
          <input
            class="online-link"
            type="text"
            readonly
            .value=${this.sessionState.joinUrl ?? ''}
            @focus=${(event: Event) => (event.currentTarget as HTMLInputElement).select()}
          />
        </label>
      </div>
    `;
  }

  private renderPeers() {
    const { peers, isHost } = this.sessionState;
    if (peers.length === 0) {
      return html`<p class="online-note">Waiting for players to join…</p>`;
    }

    return html`
      <ul class="online-peers" aria-label="Players in the room">
        ${peers.map(
          peer => html`
            <li class="online-peer ${peer.isLocal ? 'is-local' : ''}">
              <span class="online-peer-name">${peer.displayName || `Client ${peer.clientId}`}</span>
              ${peer.isLocal
                ? html`<span class="online-peer-tag">you${isHost ? ' · host' : ''}</span>`
                : null}
            </li>
          `
        )}
      </ul>
    `;
  }

  private statusModifier(): string {
    const { status, networkStatus } = this.sessionState;
    if (status === 'error') {
      return 'error';
    }
    if (status === 'online') {
      return networkStatus === 'online' ? 'online' : 'reconnecting';
    }
    return 'starting';
  }

  private onCopyClick = (): void => {
    const joinUrl = this.sessionState.joinUrl;
    if (!joinUrl) {
      return;
    }

    void navigator.clipboard.writeText(joinUrl).then(() => {
      this.copied = true;
      if (this.copiedTimer !== null) {
        window.clearTimeout(this.copiedTimer);
      }
      this.copiedTimer = window.setTimeout(() => {
        this.copied = false;
        this.copiedTimer = null;
      }, 1500);
    });
  };

  /**
   * Leaving ends the multiplayer session *and* play mode: a room whose host has left is not a game.
   * Clearing play state is what tears the runtime down (GamePlaySessionService watches it), so the
   * order here is leave-then-stop and never the reverse.
   */
  private onLeaveClick = (): void => {
    void this.onlineSession.stop();
    void this.operationService.invoke(
      new SetPlayModeOperation({ isPlaying: false, status: 'stopped' })
    );
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-online-session-card': Pix3OnlineSessionCard;
  }
}
