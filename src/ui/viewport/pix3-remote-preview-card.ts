import { ComponentBase, customElement, html, inject, state, css, unsafeCSS } from '@/fw';
import QRCode from 'qrcode';
import { appState } from '@/state';
import { PreviewHostService, type PreviewHostState } from '@/services/play/PreviewHostService';
import {
  RemotePreviewTelemetryService,
  type RemotePlayerTelemetry,
} from '@/services/play/RemotePreviewTelemetryService';
import { EditorTabService } from '@/services/editor/EditorTabService';
import styles from './pix3-remote-preview-card.ts.css?raw';

const GAME_TAB_ID = 'game:game-view-instance';

/**
 * Remote preview session card rendered inside the Game tab (replaces the old
 * modal): QR + join link, relay status, and a live strip of connected devices
 * fed by RemotePreviewTelemetryService.
 */
@customElement('pix3-remote-preview-card')
export class Pix3RemotePreviewCard extends ComponentBase {
  static useShadowDom = true;

  static styles = css`
    ${unsafeCSS(styles)}
  `;

  @inject(PreviewHostService)
  private readonly previewHostService!: PreviewHostService;

  @inject(RemotePreviewTelemetryService)
  private readonly telemetryService!: RemotePreviewTelemetryService;

  @inject(EditorTabService)
  private readonly editorTabService!: EditorTabService;

  @state()
  private hostState: PreviewHostState = {
    status: 'idle',
    session: null,
    playerCount: 0,
    errorMessage: null,
  };

  @state()
  private players: readonly RemotePlayerTelemetry[] = [];

  @state()
  private copied = false;

  private disposeHostSubscription?: () => void;
  private disposeTelemetrySubscription?: () => void;
  private renderedQrUrl = '';
  private copiedTimer: number | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeHostSubscription = this.previewHostService.subscribe(state => {
      this.hostState = state;
    });
    this.disposeTelemetrySubscription = this.telemetryService.subscribe(players => {
      this.players = players;
    });
  }

  disconnectedCallback(): void {
    this.disposeHostSubscription?.();
    this.disposeHostSubscription = undefined;
    this.disposeTelemetrySubscription?.();
    this.disposeTelemetrySubscription = undefined;
    if (this.copiedTimer !== null) {
      window.clearTimeout(this.copiedTimer);
      this.copiedTimer = null;
    }
    super.disconnectedCallback();
  }

  protected updated(): void {
    const joinUrl = this.hostState.session?.joinUrl ?? '';
    if (joinUrl && joinUrl !== this.renderedQrUrl) {
      const canvas = this.shadowRoot?.querySelector<HTMLCanvasElement>('.remote-qr canvas');
      if (canvas) {
        this.renderedQrUrl = joinUrl;
        void QRCode.toCanvas(canvas, joinUrl, {
          width: 220,
          margin: 1,
          color: { dark: '#101418', light: '#f5f7fa' },
        }).catch(error => {
          console.error('[RemotePreviewCard] Failed to render QR code', error);
        });
      }
    }
  }

  protected render() {
    const { status, session, playerCount, errorMessage } = this.hostState;

    return html`
      <div class="remote-card">
        <div class="remote-card-header">
          <h2 class="remote-card-title">Remote Preview</h2>
          <span class="remote-status-badge remote-status-${status}"
            >${this.describeStatus(status)}</span
          >
        </div>
        <p class="remote-card-copy">
          Scan the QR code with a phone or open the link in another browser. Players stream the
          current scene live from this editor. Logs and metrics from devices appear in the Logs and
          Profiler panels.
        </p>

        ${session
          ? html`
              <div class="remote-card-body">
                <div class="remote-qr">
                  <canvas width="220" height="220"></canvas>
                </div>
                <div class="remote-details">
                  <label class="remote-field">
                    <span class="remote-field-label">Join link</span>
                    <input
                      class="remote-link"
                      type="text"
                      readonly
                      .value=${session.joinUrl}
                      @focus=${(event: Event) => (event.currentTarget as HTMLInputElement).select()}
                    />
                  </label>
                  <div class="remote-status-line">Players: <strong>${playerCount}</strong></div>
                  ${this.renderPlayers()}
                  ${errorMessage ? html`<p class="remote-error">${errorMessage}</p>` : null}
                  <div class="remote-actions">
                    <button class="remote-btn" @click=${this.onCopyClick}>
                      ${this.copied ? 'Copied!' : 'Copy Link'}
                    </button>
                    <button
                      class="remote-btn"
                      ?disabled=${playerCount === 0}
                      @click=${() => this.previewHostService.requestPlayersRestart()}
                    >
                      Restart Players
                    </button>
                    <button class="remote-btn remote-btn-danger" @click=${this.onStopClick}>
                      Stop Preview
                    </button>
                  </div>
                </div>
              </div>
            `
          : html`<p class="remote-error">${errorMessage ?? 'Starting session…'}</p>`}
      </div>
    `;
  }

  private renderPlayers() {
    if (this.players.length === 0) {
      return html`<p class="remote-players-empty">Waiting for a device to connect…</p>`;
    }

    return html`
      <ul class="remote-players" aria-label="Connected devices">
        ${this.players.map(player => {
          const sample = player.lastSample;
          const stats =
            player.connected && sample
              ? `${sample.fps.toFixed(0)} fps · ${sample.frameMs.toFixed(1)} ms`
              : player.connected
                ? this.describePlayModeStatus(player.playModeStatus)
                : 'offline';
          return html`
            <li class="remote-player ${player.connected ? '' : 'remote-player-offline'}">
              <span class="remote-player-dot" aria-hidden="true"></span>
              <span class="remote-player-label">${player.label}</span>
              <span class="remote-player-stats">${stats}</span>
            </li>
          `;
        })}
      </ul>
    `;
  }

  private describeStatus(status: PreviewHostState['status']): string {
    switch (status) {
      case 'online':
        return 'Online';
      case 'connecting':
        return 'Connecting…';
      case 'error':
        return 'Error';
      default:
        return 'Stopped';
    }
  }

  private describePlayModeStatus(status: RemotePlayerTelemetry['playModeStatus']): string {
    switch (status) {
      case 'loading':
        return 'loading…';
      case 'running':
        return 'running';
      case 'error':
        return 'error';
      default:
        return 'connected';
    }
  }

  private onCopyClick = (): void => {
    const joinUrl = this.hostState.session?.joinUrl;
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

  private onStopClick = (): void => {
    this.previewHostService.stop();
    // The Game tab exists to show this card; leave it open only when a local
    // game session still needs it.
    if (!appState.ui.isPlaying) {
      void this.editorTabService.closeTab(GAME_TAB_ID);
    }
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-remote-preview-card': Pix3RemotePreviewCard;
  }
}
