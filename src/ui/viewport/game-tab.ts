import { ComponentBase, customElement, html, inject, state, css, unsafeCSS } from '@/fw';
import { appState } from '@/state';
import type { GameAspectRatio, PlayModeError } from '@/state/AppState';
import { subscribe } from 'valtio/vanilla';
import styles from './game-tab.ts.css?raw';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { GamePlaySessionService } from '@/services/GamePlaySessionService';
import { PreviewHostService } from '@/services/PreviewHostService';
import { RuntimeErrorBridgeService } from '@/services/RuntimeErrorBridgeService';
import { LayoutManagerService } from '@/core/LayoutManager';
import './pix3-remote-preview-card';

interface AspectRatioPreset {
  readonly value: GameAspectRatio;
  readonly label: string;
  readonly buttonLabel: string;
}

const ASPECT_RATIO_PRESETS: readonly AspectRatioPreset[] = [
  { value: 'free', label: 'Free Aspect', buttonLabel: 'Free' },
  { value: '16:9-landscape', label: '16:9 Landscape', buttonLabel: '16:9' },
  { value: '16:9-portrait', label: '16:9 Portrait', buttonLabel: '9:16' },
  { value: '4:3', label: '4:3', buttonLabel: '4:3' },
];

@customElement('pix3-game-tab')
export class GameViewTab extends ComponentBase {
  static useShadowDom = true;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  @inject(GamePlaySessionService)
  private readonly gamePlaySessionService!: GamePlaySessionService;

  @inject(PreviewHostService)
  private readonly previewHostService!: PreviewHostService;

  @inject(LayoutManagerService)
  private readonly layoutManager!: LayoutManagerService;

  @inject(RuntimeErrorBridgeService)
  private readonly runtimeErrorBridge!: RuntimeErrorBridgeService;

  @state()
  private aspectRatio: GameAspectRatio = appState.ui.gameAspectRatio;

  @state()
  private isPlaying = appState.ui.isPlaying;

  @state()
  private isRunning = false;

  @state()
  private isGamePopoutOpen = appState.ui.isGamePopoutOpen;

  @state()
  private showColliders = appState.ui.showPhysicsColliders;

  @state()
  private isRemotePreviewActive = false;

  @state()
  private playModeError: PlayModeError | null = appState.ui.playModeError;

  private gameContainer?: HTMLElement;
  private viewportContainer?: HTMLElement;
  private resizeObserver?: ResizeObserver;
  private disposeSubscription?: () => void;
  private disposePreviewSubscription?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.startResizeObserver();
    this.disposePreviewSubscription = this.previewHostService.subscribe(state => {
      this.isRemotePreviewActive = state.status !== 'idle';
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.gameContainer) {
      this.gamePlaySessionService.unregisterTabHost(this.gameContainer);
    }
    this.resizeObserver?.disconnect();
    this.disposeSubscription?.();
    this.disposePreviewSubscription?.();
    this.disposePreviewSubscription = undefined;
  }

  protected firstUpdated(): void {
    this.viewportContainer = this.shadowRoot?.querySelector('.viewport-container') as HTMLElement;
    this.gameContainer = this.shadowRoot?.querySelector('.game-host') as HTMLElement;

    if (this.gameContainer) {
      this.gamePlaySessionService.registerTabHost(this.gameContainer, window, isRunning => {
        this.isRunning = isRunning;
        this.requestUpdate();
      });
    }

    if (this.viewportContainer) {
      this.resizeObserver?.observe(this.viewportContainer);
    }

    this.disposeSubscription = subscribe(appState.ui, () => {
      this.aspectRatio = appState.ui.gameAspectRatio;
      this.isPlaying = appState.ui.isPlaying;
      this.isGamePopoutOpen = appState.ui.isGamePopoutOpen;
      this.showColliders = appState.ui.showPhysicsColliders;
      this.playModeError = appState.ui.playModeError;
      requestAnimationFrame(() => this.handleResize());
      this.requestUpdate();
    });

    requestAnimationFrame(() => this.handleResize());
  }

  private startResizeObserver() {
    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
  }

  private handleResize() {
    this.applyViewportFit();
  }

  private applyViewportFit() {
    if (!this.gameContainer || !this.viewportContainer) {
      return;
    }

    const { width: availableWidth, height: availableHeight } = this.getViewportInnerSize(
      this.viewportContainer
    );

    if (availableWidth <= 0 || availableHeight <= 0) {
      return;
    }

    if (this.aspectRatio === 'free') {
      this.gameContainer.style.width = `${Math.floor(availableWidth)}px`;
      this.gameContainer.style.height = `${Math.floor(availableHeight)}px`;
      return;
    }

    const targetAspect = this.getAspectValue(this.aspectRatio);

    let fittedWidth = availableWidth;
    let fittedHeight = fittedWidth / targetAspect;

    if (fittedHeight > availableHeight) {
      fittedHeight = availableHeight;
      fittedWidth = fittedHeight * targetAspect;
    }

    this.gameContainer.style.width = `${Math.floor(fittedWidth)}px`;
    this.gameContainer.style.height = `${Math.floor(fittedHeight)}px`;
  }

  private getViewportInnerSize(viewport: HTMLElement): { width: number; height: number } {
    const rect = viewport.getBoundingClientRect();
    const styles = window.getComputedStyle(viewport);
    const horizontalPadding =
      Number.parseFloat(styles.paddingLeft || '0') + Number.parseFloat(styles.paddingRight || '0');
    const verticalPadding =
      Number.parseFloat(styles.paddingTop || '0') + Number.parseFloat(styles.paddingBottom || '0');

    return {
      width: Math.max(0, rect.width - horizontalPadding),
      height: Math.max(0, rect.height - verticalPadding),
    };
  }

  private getAspectValue(aspectRatio: Exclude<GameAspectRatio, 'free'>): number {
    switch (aspectRatio) {
      case '16:9-landscape':
        return 16 / 9;
      case '16:9-portrait':
        return 9 / 16;
      case '4:3':
        return 4 / 3;
    }
  }

  private setAspectRatio(aspectRatio: GameAspectRatio) {
    this.aspectRatio = aspectRatio;
    void this.gamePlaySessionService.setAspectRatio(aspectRatio);
    requestAnimationFrame(() => this.handleResize());
  }

  private handleStopClick() {
    void this.commandDispatcher.executeById('game.stop');
  }

  private handleRestartClick() {
    void this.commandDispatcher.executeById('game.restart');
  }

  private handlePopoutClick() {
    void this.commandDispatcher.executeById('game.open-popout-window');
  }

  private handleCollidersClick() {
    void this.commandDispatcher.executeById('view.toggle-colliders');
  }

  private handleOpenLogsClick() {
    this.layoutManager.focusPanel('logs');
  }

  private handleDismissError() {
    this.runtimeErrorBridge.clearPlayModeError();
  }

  private formatErrorLocation(error: PlayModeError): string {
    const parts: string[] = [];
    if (error.phase) {
      parts.push(error.phase);
    }
    if (error.nodeName) {
      parts.push(error.componentType ? `${error.nodeName} · ${error.componentType}` : error.nodeName);
    } else if (error.componentType) {
      parts.push(error.componentType);
    }
    return parts.join(' — ');
  }

  private getPlaceholderTitle(): string {
    if (this.isGamePopoutOpen && !this.isRunning) {
      return 'Game is rendering in a separate window';
    }

    if (this.isPlaying && !this.isRunning) {
      return 'Preparing runtime preview';
    }

    return 'Game preview is idle';
  }

  private getPlaceholderCopy(): string {
    if (this.isGamePopoutOpen && !this.isRunning) {
      return 'Press Play to run in the detached game window, or focus that window if it is already open.';
    }

    if (this.isPlaying && !this.isRunning) {
      return 'The runtime host is starting. The preview will appear here as soon as the scene is ready.';
    }

    return 'Press Play to run the active scene in this tab, or open a detached game window for an external preview.';
  }

  private renderErrorBanner(error: PlayModeError) {
    const location = this.formatErrorLocation(error);
    return html`
      <div class="game-error-banner" part="game-error-banner" role="alert">
        <svg class="game-error-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2 1 21h22L12 2zm0 5.5c.55 0 1 .45 1 1v5a1 1 0 0 1-2 0v-5c0-.55.45-1 1-1zm0 9.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z"
          />
        </svg>
        <div class="game-error-body">
          <div class="game-error-title">Runtime error — the game may have stopped updating</div>
          ${location ? html`<div class="game-error-location">${location}</div>` : null}
          <div class="game-error-message">${error.message}</div>
        </div>
        <div class="game-error-actions">
          <button
            type="button"
            class="game-error-button"
            @click=${this.handleOpenLogsClick}
            title="Open the Logs panel"
          >
            Open Logs
          </button>
          <button
            type="button"
            class="game-error-button"
            @click=${this.handleRestartClick}
            title="Restart the game"
          >
            Restart
          </button>
          <button
            type="button"
            class="game-error-dismiss"
            @click=${this.handleDismissError}
            aria-label="Dismiss error"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      </div>
    `;
  }

  protected render() {
    const popoutTitle = this.isGamePopoutOpen ? 'Focus Game Window' : 'Open Game Window';

    return html`
      <div class="game-view">
        <div class="top-toolbar">
          <button
            class="toolbar-button toolbar-icon-button active"
            @click=${this.handleStopClick}
            title="Stop Game"
            aria-label="Stop Game"
          >
            <svg
              class="toolbar-svg-icon"
              viewBox="0 0 2000 2000"
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
            >
              <g fill="currentColor">
                <path
                  d="M6355 19280 l-3880 -5 -124 -28 c-424 -95 -769 -283 -1052 -574 -285 -294 -457 -618 -546 -1029 l-28 -129 0 -7515 0 -7515 28 -129 c91 -423 281 -772 574 -1057 367 -356 809 -551 1318 -579 212 -12 14498 -12 14710 0 509 28 951 223 1318 579 293 285 483 634 574 1057 l28 129 0 7515 0 7515 -28 129 c-89 411 -261 735 -546 1029 -356 366 -826 578 -1346 607 -164 9 -4001 9 -11000 0z m11060 -1443 c203 -61 381 -246 427 -443 20 -88 20 -14700 0 -14788 -46 -200 -228 -387 -432 -443 -62 -17 -381 -18 -7405 -18 -6105 0 -7350 2 -7399 13 -200 46 -387 228 -443 432 -17 62 -18 381 -18 7410 0 7029 1 7348 18 7410 51 184 211 355 389 416 25 8 74 19 109 23 35 5 3356 8 7379 7 7012 -1 7317 -2 7375 -19z"
                  transform="matrix(.1 0 0 -.1 0 2000)"
                  fill="currentColor"
                  stroke="none"
                ></path>
              </g>
            </svg>
          </button>

          ${this.isPlaying
            ? html`
                <button
                  class="toolbar-button toolbar-icon-button"
                  @click=${this.handleRestartClick}
                  title="Restart Game"
                  aria-label="Restart Game"
                >
                  <svg
                    class="toolbar-svg-icon"
                    viewBox="0 0 2000 2000"
                    preserveAspectRatio="xMidYMid meet"
                    aria-hidden="true"
                  >
                    <g fill="currentColor">
                      <g transform="matrix(.1 0 0 -.1 0 2000)" fill="currentColor" stroke="none">
                        <path
                          d="M1995 19993 c-514 -35 -990 -252 -1362 -620 -327 -325 -531 -728 -610 -1204 -16 -97 -18 -479 -21 -5934 -2 -4259 0 -5868 8 -5970 41 -507 245 -962 595 -1324 276 -286 627 -490 1010 -587 272 -68 74 -64 3152 -64 1531 0 2783 -3 2783 -8 0 -4 -363 -369 -806 -812 -443 -443 -833 -839 -867 -880 -119 -148 -162 -281 -155 -478 4 -95 10 -133 33 -202 71 -207 244 -375 460 -447 71 -24 94 -27 215 -26 116 0 146 4 213 26 175 57 86 -27 1714 1601 1003 1002 1502 1509 1525 1546 155 248 155 532 0 780 -23 37 -524 545 -1525 1546 -1649 1649 -1546 1553 -1730 1605 -122 35 -300 33 -412 -4 -213 -70 -380 -230 -456 -437 -28 -73 -33 -102 -37 -207 -7 -183 29 -313 125 -447 20 -28 415 -430 877 -894 l841 -842 -2770 3 c-2623 2 -2773 4 -2830 20 -92 28 -217 93 -277 145 -107 92 -196 227 -235 358 -17 56 -18 351 -21 5874 -3 6499 -10 5895 69 6057 97 198 283 344 494 388 66 13 783 15 6577 15 7052 0 6560 3 6698 -52 165 -66 326 -226 390 -387 59 -150 54 104 60 -3156 l5 -2980 30 -85 c72 -208 245 -376 460 -447 112 -37 290 -39 412 -4 214 61 390 226 475 449 l33 87 3 2980 c3 3102 4 3078 -39 3299 -177 928 -970 1636 -1922 1715 -90 8 -2078 10 -6630 9 -3576 -1 -6524 -3 -6552 -5z"
                        ></path>
                        <path
                          d="M12595 9986 c-442 -74 -816 -350 -1018 -752 -47 -93 -103 -263 -125 -377 -16 -86 -17 -318 -17 -3857 0 -3539 1 -3771 17 -3857 89 -468 391 -850 818 -1034 203 -87 400 -120 618 -101 244 20 409 77 649 221 101 61 4229 2609 5578 3443 312 194 365 230 460 323 383 375 521 954 349 1465 -39 115 -106 250 -180 363 -59 89 -235 266 -329 332 -38 26 -383 240 -765 475 -1445 888 -2587 1589 -3855 2368 -720 443 -1357 829 -1415 858 -117 59 -226 97 -345 119 -112 22 -341 27 -440 11z m1550 -2263 c671 -412 1663 -1022 2205 -1355 542 -333 1257 -773 1590 -977 333 -205 608 -375 612 -379 4 -4 -41 -37 -100 -73 -204 -127 -5527 -3412 -5559 -3432 l-33 -19 0 3512 0 3512 33 -19 c17 -11 581 -357 1252 -770z"
                        ></path>
                      </g>
                    </g>
                  </svg>
                </button>
              `
            : null}

          <button
            class="toolbar-button toolbar-icon-button"
            @click=${this.handlePopoutClick}
            title=${popoutTitle}
            aria-label=${popoutTitle}
          >
            <svg
              class="toolbar-svg-icon"
              viewBox="0 0 2000 2000"
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
            >
              <g fill="currentColor">
                <g transform="matrix(.1 0 0 -.1 0 2000)" fill="currentColor" stroke="none">
                  <path
                    d="M5520 19989 c-157 -13 -308 -45 -474 -100 -780 -260 -1329 -915 -1453 -1735 -17 -113 -18 -271 -18 -2939 l0 -2820 23 -78 c71 -246 244 -425 482 -499 64 -19 95 -23 210 -22 118 0 145 4 215 27 221 74 380 235 466 477 l24 65 3 963 3 962 6784 0 6785 0 0 -3969 c0 -4307 3 -4034 -52 -4164 -73 -171 -208 -309 -373 -383 -140 -62 -37 -57 -1550 -64 -1302 -5 -1383 -6 -1435 -24 -204 -68 -363 -204 -446 -383 -46 -97 -66 -190 -66 -303 0 -320 194 -579 512 -686 52 -18 123 -19 1435 -22 1433 -3 1479 -2 1680 38 637 130 1177 532 1474 1101 145 277 217 526 241 828 14 184 14 11585 0 11767 -22 277 -95 538 -224 794 -111 221 -216 368 -394 548 -167 170 -329 286 -552 398 -259 130 -520 203 -800 224 -168 12 -12346 11 -12500 -1z m12493 -1435 c211 -46 406 -206 496 -406 63 -139 61 -96 61 -1322 l0 -1116 -6785 0 -6785 0 0 1110 c0 1243 -2 1196 71 1346 94 192 285 345 484 387 62 14 801 15 6228 16 5594 1 6165 0 6230 -15z"
                  ></path>
                  <path
                    d="M1958 9989 c-498 -41 -963 -258 -1326 -618 -258 -255 -448 -579 -552 -938 -32 -113 -59 -276 -71 -428 -7 -94 -9 -1109 -7 -3105 4 -3249 0 -3014 60 -3260 111 -458 387 -889 750 -1172 258 -202 577 -356 855 -413 253 -53 -106 -48 4658 -52 3178 -3 4440 -1 4545 7 672 52 1244 387 1631 955 152 222 275 534 323 815 35 207 37 378 34 3340 -4 2647 -5 2925 -20 3020 -33 210 -64 327 -130 495 -304 769 -1006 1289 -1827 1354 -161 13 -8769 13 -8923 0z m8907 -1434 c255 -53 463 -250 541 -510 16 -55 18 -127 21 -837 l4 -778 -5000 0 -5001 0 0 756 c0 845 -1 831 70 979 92 191 269 335 475 386 66 16 333 18 4443 18 3885 1 4381 -1 4447 -14z m562 -5047 c-3 -1407 -4 -1496 -21 -1553 -64 -212 -212 -382 -411 -469 -135 -60 200 -56 -4570 -56 -3990 0 -4372 1 -4438 16 -210 47 -393 194 -487 389 -74 152 -70 64 -70 1700 l0 1465 5000 0 5001 0 -4 -1492z"
                  ></path>
                </g>
              </g>
            </svg>
          </button>

          <div class="toolbar-separator"></div>

          <button
            class="toolbar-button toolbar-icon-button ${this.showColliders ? 'active' : ''}"
            @click=${this.handleCollidersClick}
            title="Toggle physics collider wireframes"
            aria-label="Toggle physics collider wireframes"
            aria-pressed=${String(this.showColliders)}
          >
            <svg
              class="toolbar-svg-icon"
              viewBox="0 0 2000 2000"
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
            >
              <g fill="currentColor">
                <path
                  d="M1311 19279 c-76 -13 -183 -52 -249 -91 -73 -42 -208 -177 -250 -250 -41 -70 -78 -172 -91 -258 -15 -93 -15 -12248 0 -12357 14 -103 58 -215 118 -299 32 -45 949 -968 2608 -2624 1945 -1944 2572 -2563 2615 -2589 73 -42 177 -78 264 -91 99 -14 12266 -14 12354 1 159 25 277 86 395 204 118 118 179 236 204 395 15 88 15 12255 1 12354 -13 87 -49 191 -91 264 -48 82 -5169 5203 -5251 5251 -73 42 -177 78 -264 91 -89 12 -12286 12 -12363 -1z m11547 -3206 l2 -1783 -3067 0 -3068 0 -1785 1785 -1785 1785 4850 -2 4850 -3 3 -1782z m-7148 -5866 l0 -3067 -1782 2 -1783 3 -3 4850 -2 4850 1785 -1785 1785 -1785 0 -3068z m9860 5358 l1275 -1275 -1278 0 -1277 0 0 1275 c0 701 1 1275 3 1275 1 0 576 -574 1277 -1275z m-2715 -5565 l0 -2855 -2855 0 -2855 0 -3 2845 c-1 1565 0 2851 3 2858 3 10 580 12 2857 10 l2853 -3 0 -2855z m5003 -1995 l2 -4850 -1785 1785 -1785 1785 0 3068 0 3067 1783 -2 1782 -3 3 -4850z m-12148 -3570 c0 -701 -1 -1275 -3 -1275 -1 0 -576 574 -1277 1275 l-1275 1275 1278 0 1277 0 0 -1275z m9350 -510 l1785 -1785 -4850 2 -4850 3 -3 1783 -2 1782 3067 0 3068 0 1785 -1785z"
                  transform="matrix(.1 0 0 -.1 0 2000)"
                  fill="currentColor"
                  stroke="none"
                ></path>
              </g>
            </svg>
          </button>

          <div class="toolbar-separator"></div>

          <div class="aspect-preset-toolbar" role="toolbar" aria-label="Aspect ratio presets">
            ${ASPECT_RATIO_PRESETS.map(
              preset => html`
                <button
                  type="button"
                  class="toolbar-button aspect-preset-button ${this.aspectRatio === preset.value
                    ? 'active'
                    : ''}"
                  title=${preset.label}
                  aria-pressed=${String(this.aspectRatio === preset.value)}
                  @click=${() => this.setAspectRatio(preset.value)}
                >
                  ${preset.buttonLabel}
                </button>
              `
            )}
          </div>
        </div>

        <div class="viewport-container">
          <div class="game-host aspect-${this.aspectRatio.replace(':', '-')}" part="game-host">
            <!-- Canvas will be attached here -->
          </div>
          ${this.playModeError ? this.renderErrorBanner(this.playModeError) : null}
          ${this.isRunning
            ? null
            : this.isRemotePreviewActive
              ? html`
                  <div class="game-placeholder game-placeholder-remote" part="game-placeholder">
                    <pix3-remote-preview-card></pix3-remote-preview-card>
                  </div>
                `
              : html`
                  <div class="game-placeholder" part="game-placeholder">
                    <div class="game-placeholder-card">
                      <p class="game-placeholder-title">${this.getPlaceholderTitle()}</p>
                      <p class="game-placeholder-copy">${this.getPlaceholderCopy()}</p>
                    </div>
                  </div>
                `}
        </div>
      </div>
    `;
  }

  static styles = css`
    ${unsafeCSS(styles)}
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-game-tab': GameViewTab;
  }
}
