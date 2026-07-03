import { ComponentBase, customElement, html, property } from '@/fw';
import './pix3-playable-export-progress-dialog.ts.css';

@customElement('pix3-playable-export-progress-dialog')
export class Pix3PlayableExportProgressDialog extends ComponentBase {
  @property({ type: String, reflect: true })
  public dialogId: string = '';

  @property({ type: String })
  public title: string = 'Building Playable HTML';

  @property({ type: String })
  public message: string = 'Bundling scripts and embedding project assets into a single HTML file.';

  protected render() {
    const titleId = this.dialogId ? `${this.dialogId}-title` : 'playable-export-progress-title';

    return html`
      <div class="dialog-backdrop">
        <div
          class="dialog-content playable-export-progress-dialog"
          role="dialog"
          aria-modal="true"
          aria-busy="true"
          aria-labelledby=${titleId}
        >
          <div class="playable-export-progress__spinner" aria-hidden="true"></div>
          <h2 id=${titleId} class="dialog-title">${this.title}</h2>
          <p class="dialog-message">${this.message}</p>
          <div class="playable-export-progress__hint">
            This dialog closes automatically when the build finishes.
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-playable-export-progress-dialog': Pix3PlayableExportProgressDialog;
  }
}
