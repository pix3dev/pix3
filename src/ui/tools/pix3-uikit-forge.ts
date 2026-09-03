import { ComponentBase, customElement, html, inject } from '@/fw';
import { IconService, IconSize } from '@/services/editor/IconService';
import { appState } from '@/state';
import { UIKIT_FORGE_URL } from '@/core/tool-routes';

import './pix3-uikit-forge.ts.css';

/**
 * Full-window host for the UI Kit Forge generator.
 *
 * The tool itself is a self-contained vanilla page under `public/tools/` embedded here as a
 * same-origin iframe — see the comment at the top of that file for why it is not bundled. This
 * component owns only the route chrome: a slim bar to get back out and to pop the tool into its
 * own tab.
 */
@customElement('pix3-uikit-forge')
export class Pix3UiKitForge extends ComponentBase {
  @inject(IconService)
  private readonly iconService!: IconService;

  /**
   * Leaving goes back to whatever the session actually has: an open project returns to its shell
   * (Flow or Studio), a cold-loaded tool session returns to the welcome screen.
   */
  private onClose = (): void => {
    if (appState.project.status === 'ready') {
      window.location.hash = appState.ui.workspaceMode === 'flow' ? '#flow' : '#editor';
      return;
    }
    window.location.hash = '#welcome';
  };

  protected render() {
    return html`
      <div class="uikit-forge" role="region" aria-label="UI Kit Forge">
        <div class="uikit-forge__bar">
          <button
            class="uikit-forge__back"
            type="button"
            title="Close UI Kit Forge"
            @click=${this.onClose}
          >
            ${this.iconService.getIcon('arrow-left', IconSize.SMALL)}
            <span>Back</span>
          </button>
          <span class="uikit-forge__title">UI Kit Forge</span>
          <a
            class="uikit-forge__link"
            href=${UIKIT_FORGE_URL}
            target="_blank"
            rel="noopener"
            title="Open the tool in its own tab"
          >
            ${this.iconService.getIcon('external-link', IconSize.SMALL)}
            <span>Open in new tab</span>
          </a>
        </div>
        <iframe
          class="uikit-forge__frame"
          src=${UIKIT_FORGE_URL}
          title="UI Kit Forge"
          allow="clipboard-read; clipboard-write"
        ></iframe>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-uikit-forge': Pix3UiKitForge;
  }
}
