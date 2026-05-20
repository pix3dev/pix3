import { ComponentBase, customElement, html, inject, state, css, unsafeCSS } from '@/fw';
import { appState } from '@/state';
import type { GameAspectRatio } from '@/state/AppState';
import { subscribe } from 'valtio/vanilla';
import styles from './game-tab.ts.css?raw';
import { CommandDispatcher } from '@/services/CommandDispatcher';
import { GamePlaySessionService } from '@/services/GamePlaySessionService';

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

  @state()
  private aspectRatio: GameAspectRatio = appState.ui.gameAspectRatio;

  @state()
  private isPlaying = appState.ui.isPlaying;

  @state()
  private isRunning = false;

  @state()
  private isGamePopoutOpen = appState.ui.isGamePopoutOpen;

  private gameContainer?: HTMLElement;
  private viewportContainer?: HTMLElement;
  private resizeObserver?: ResizeObserver;
  private disposeSubscription?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    this.startResizeObserver();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.gameContainer) {
      this.gamePlaySessionService.unregisterTabHost(this.gameContainer);
    }
    this.resizeObserver?.disconnect();
    this.disposeSubscription?.();
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

  private isAspectRatio(value: string): value is GameAspectRatio {
    return ASPECT_RATIO_PRESETS.some(preset => preset.value === value);
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

  private handleAspectChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    if (!this.isAspectRatio(target.value)) {
      return;
    }

    this.setAspectRatio(target.value);
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

  protected render() {
    return html`
      <div class="game-view">
        <div class="top-toolbar">
          <button class="toolbar-button active" @click=${this.handleStopClick} title="Stop Game">
            <span style="margin-right: 4px;">■</span> Stop
          </button>

          ${this.isPlaying
            ? html`
                <button
                  class="toolbar-button"
                  @click=${this.handleRestartClick}
                  title="Restart Game"
                >
                  <span style="margin-right: 4px;">↻</span> Restart
                </button>
              `
            : null}

          <button class="toolbar-button" @click=${this.handlePopoutClick} title="Open Game Window">
            <span style="margin-right: 4px;">▣</span>
            ${this.isGamePopoutOpen ? 'Focus Window' : 'Open Window'}
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

          <select
            class="aspect-selector"
            @change=${this.handleAspectChange}
            .value=${this.aspectRatio}
          >
            ${ASPECT_RATIO_PRESETS.map(
              preset => html`<option value=${preset.value}>${preset.label}</option>`
            )}
          </select>
        </div>

        <div class="viewport-container">
          <div class="game-host aspect-${this.aspectRatio.replace(':', '-')}" part="game-host">
            <!-- Canvas will be attached here -->
          </div>
          ${this.isRunning
            ? null
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
