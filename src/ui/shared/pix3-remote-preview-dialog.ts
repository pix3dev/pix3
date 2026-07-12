import { ComponentBase, customElement, html, property, state } from '@/fw';
import { inject } from '@/fw/di';
import QRCode from 'qrcode';
import { PreviewHostService, type PreviewHostState } from '@/services/PreviewHostService';
import { RemotePreviewDialogService } from '@/services/RemotePreviewDialogService';
import './pix3-remote-preview-dialog.ts.css';

@customElement('pix3-remote-preview-dialog')
export class Pix3RemotePreviewDialog extends ComponentBase {
  @property({ type: String, reflect: true })
  public dialogId: string = '';

  @inject(PreviewHostService)
  private readonly previewHostService!: PreviewHostService;

  @inject(RemotePreviewDialogService)
  private readonly remotePreviewDialogService!: RemotePreviewDialogService;

  @state()
  private hostState: PreviewHostState = {
    status: 'idle',
    session: null,
    playerCount: 0,
    errorMessage: null,
  };

  @state()
  private copied = false;

  private disposeSubscription?: () => void;
  private renderedQrUrl = '';
  private copiedTimer: number | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeSubscription = this.previewHostService.subscribe(state => {
      this.hostState = state;
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
    const joinUrl = this.hostState.session?.joinUrl ?? '';
    if (joinUrl && joinUrl !== this.renderedQrUrl) {
      const canvas = this.querySelector<HTMLCanvasElement>('.remote-preview-qr canvas');
      if (canvas) {
        this.renderedQrUrl = joinUrl;
        void QRCode.toCanvas(canvas, joinUrl, {
          width: 220,
          margin: 1,
          color: { dark: '#101418', light: '#f5f7fa' },
        }).catch(error => {
          console.error('[RemotePreviewDialog] Failed to render QR code', error);
        });
      }
    }
  }

  protected render() {
    const { status, session, playerCount, errorMessage } = this.hostState;

    return html`
      <div class="dialog-backdrop" @click=${this.close}>
        <div
          class="dialog-content remote-preview-dialog-content"
          role="dialog"
          aria-modal="true"
          aria-label="Remote preview"
          @click=${(event: Event) => event.stopPropagation()}
          @keydown=${this.onDialogKeyDown}
        >
          <h2 class="dialog-title">Remote Preview</h2>
          <p class="dialog-message">
            Scan the QR code with a phone or open the link in another browser. Players stream the
            current scene live from this editor — keep this tab open.
          </p>

          ${session
            ? html`
                <div class="remote-preview-body">
                  <div class="remote-preview-qr">
                    <canvas width="220" height="220"></canvas>
                  </div>
                  <div class="remote-preview-details">
                    <label class="dialog-field">
                      <span class="dialog-field__label">Join link</span>
                      <input
                        class="remote-preview-link"
                        type="text"
                        readonly
                        .value=${session.joinUrl}
                        @focus=${(event: Event) =>
                          (event.currentTarget as HTMLInputElement).select()}
                      />
                    </label>
                    <div class="remote-preview-status">
                      <span class="remote-preview-status__item">
                        Status:
                        <strong>${this.describeStatus(status)}</strong>
                      </span>
                      <span class="remote-preview-status__item">
                        Players: <strong>${playerCount}</strong>
                      </span>
                    </div>
                    ${errorMessage
                      ? html`<p class="remote-preview-error">${errorMessage}</p>`
                      : null}
                  </div>
                </div>
              `
            : html`<p class="remote-preview-error">${errorMessage ?? 'Starting session…'}</p>`}

          <div class="dialog-actions remote-preview-actions">
            <button class="btn-secondary" @click=${this.onStopClick}>Stop Preview</button>
            <button
              class="btn-secondary"
              ?disabled=${playerCount === 0}
              @click=${() => this.previewHostService.requestPlayersRestart()}
            >
              Restart Players
            </button>
            <button class="btn-secondary" ?disabled=${!session} @click=${this.onCopyClick}>
              ${this.copied ? 'Copied!' : 'Copy Link'}
            </button>
            <button class="btn-primary" @click=${this.close}>Close</button>
          </div>
        </div>
      </div>
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

  private onDialogKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  };

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
    this.close();
  };

  private close = (): void => {
    this.remotePreviewDialogService.close(this.dialogId);
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-remote-preview-dialog': Pix3RemotePreviewDialog;
  }
}
