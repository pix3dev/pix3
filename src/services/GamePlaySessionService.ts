import { injectable, inject } from '@/fw/di';
import { subscribe } from 'valtio/vanilla';
import {
  AssetLoader,
  AudioService,
  RuntimeRenderer,
  SceneManager,
  SceneRunner,
} from '@pix3/runtime';
import { appState } from '@/state';
import type { GameAspectRatio } from '@/state/AppState';
import { OperationService } from '@/services/OperationService';
import { ProfilerSessionService } from '@/services/ProfilerSessionService';
import { UpdateEditorSettingsOperation } from '@/features/editor/UpdateEditorSettingsOperation';
import { SetGamePopoutWindowOpenOperation } from '@/features/scripts/SetGamePopoutWindowOpenOperation';
import { SetPlayModeOperation } from '@/features/scripts/SetPlayModeOperation';
import { isDocumentActive } from './page-activity';

type GameHostKind = 'tab' | 'popout';

interface RegisteredGameHost {
  kind: GameHostKind;
  mount: HTMLElement;
  windowRef: Window;
  setRunningState?: (isRunning: boolean) => void;
}

interface PopoutShellElements {
  host: HTMLElement;
  viewport: HTMLElement;
  placeholder: HTMLElement;
  statusValue: HTMLElement;
  aspectSelect: HTMLSelectElement;
  restartButton: HTMLButtonElement;
}

@injectable()
export class GamePlaySessionService {
  @inject(SceneManager)
  private readonly sceneManager!: SceneManager;

  @inject(AudioService)
  private readonly audioService!: AudioService;

  @inject(AssetLoader)
  private readonly assetLoader!: AssetLoader;

  @inject(OperationService)
  private readonly operationService!: OperationService;

  @inject(ProfilerSessionService)
  private readonly profilerSessionService!: ProfilerSessionService;

  private initialized = false;
  private disposeUiSubscription?: () => void;
  private activeHostKind: GameHostKind | null = null;
  private tabHost?: RegisteredGameHost;
  private popoutHost?: RegisteredGameHost;
  private popoutWindow: Window | null = null;
  private popoutShell: PopoutShellElements | null = null;
  private popoutWindowUnloadHandler?: () => void;
  private popoutWindowResizeHandler?: () => void;
  private runner?: SceneRunner;
  private renderer?: RuntimeRenderer;
  private focusCleanup?: () => void;
  private syncPromise: Promise<void> = Promise.resolve();
  private readonly onPopoutAspectChange = (event: Event): void => {
    const target = event.target as HTMLSelectElement;
    const aspectRatio = target.value;
    if (!this.isGameAspectRatio(aspectRatio)) {
      return;
    }

    void this.setAspectRatio(aspectRatio);
  };

  private readonly onPopoutRestartClick = (): void => {
    void this.restart();
  };

  initialize(): void {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.disposeUiSubscription = subscribe(appState.ui, () => {
      this.queueSync();
      this.updatePopoutPresentation();
    });
  }

  dispose(): void {
    this.disposeUiSubscription?.();
    this.disposeUiSubscription = undefined;
    this.detachRuntime();
    this.closePopoutWindow();
  }

  getAspectRatio(): GameAspectRatio {
    return appState.ui.gameAspectRatio;
  }

  async setAspectRatio(aspectRatio: GameAspectRatio): Promise<void> {
    this.initialize();
    await this.operationService.invoke(
      new UpdateEditorSettingsOperation({ gameAspectRatio: aspectRatio })
    );
  }

  registerTabHost(
    mount: HTMLElement,
    windowRef: Window,
    setRunningState?: (isRunning: boolean) => void
  ): void {
    this.initialize();
    this.tabHost = {
      kind: 'tab',
      mount,
      windowRef,
      setRunningState,
    };
    this.queueSync();
  }

  unregisterTabHost(mount: HTMLElement): void {
    if (!this.tabHost || this.tabHost.mount !== mount) {
      return;
    }

    const wasActive = this.activeHostKind === 'tab';
    this.tabHost = undefined;
    if (wasActive) {
      this.detachRuntime();
    }
    this.queueSync();
  }

  isPopoutOpen(): boolean {
    return Boolean(this.popoutWindow && !this.popoutWindow.closed);
  }

  async openOrFocusPopoutWindow(): Promise<void> {
    this.initialize();

    if (this.isPopoutOpen() && this.popoutWindow) {
      this.popoutWindow.focus();
      this.updatePopoutPresentation();
      return;
    }

    const popup = window.open('', 'pix3-game-window', 'popup=yes,width=1280,height=900');
    if (!popup) {
      throw new Error('Failed to open game window. The browser may have blocked the popup.');
    }

    this.popoutWindow = popup;
    this.preparePopoutWindow(popup);
    await this.operationService.invoke(new SetGamePopoutWindowOpenOperation({ isOpen: true }));
    this.queueSync();
  }

  async restart(): Promise<void> {
    this.initialize();
    await this.restartRuntime();
  }

  private queueSync(): void {
    this.syncPromise = this.syncPromise
      .then(() => this.syncRuntimeToUiState())
      .catch(error => {
        console.error('[GamePlaySessionService] Failed to sync runtime state', error);
      });
  }

  private async syncRuntimeToUiState(): Promise<void> {
    if (!appState.ui.isPlaying) {
      this.detachRuntime();
      this.updateHostRunningState(false);
      return;
    }

    const preferredHost = this.getPreferredHost();
    if (!preferredHost) {
      return;
    }

    if (this.activeHostKind !== preferredHost.kind || !this.runner || !this.renderer) {
      await this.startRuntime(preferredHost);
      return;
    }

    this.handleFocusPause();
  }

  private getPreferredHost(): RegisteredGameHost | null {
    if (this.popoutHost) {
      return this.popoutHost;
    }

    if (this.tabHost) {
      return this.tabHost;
    }

    return null;
  }

  private async restartRuntime(): Promise<void> {
    const host = this.getPreferredHost();
    if (!host) {
      return;
    }

    await this.startRuntime(host);
  }

  private async startRuntime(host: RegisteredGameHost): Promise<void> {
    this.detachRuntime();
    this.activeHostKind = host.kind;
    this.updateHostRunningState(false);
    this.profilerSessionService.beginSession(host.kind);

    const renderer = new RuntimeRenderer({
      antialias: true,
      shadows: true,
    });
    renderer.attach(host.mount);

    const runner = new SceneRunner(
      this.sceneManager,
      renderer,
      this.audioService,
      this.assetLoader,
      {
        width: appState.project.manifest?.viewportBaseSize?.width ?? 1920,
        height: appState.project.manifest?.viewportBaseSize?.height ?? 1080,
      }
    );

    this.renderer = renderer;
    this.runner = runner;
    this.profilerSessionService.bindRuntime(runner, renderer, host.kind);

    this.attachFocusListeners(host.windowRef);

    const activeSceneId = appState.scenes.activeSceneId;
    if (!activeSceneId) {
      console.warn('[GamePlaySessionService] No active scene to play.');
      this.profilerSessionService.endSession();
      this.updateHostRunningState(false);
      return;
    }

    try {
      await runner.startScene(activeSceneId);
      this.updateHostRunningState(true);
      this.handleFocusPause();
    } catch (error) {
      this.profilerSessionService.endSession();
      console.error('[GamePlaySessionService] Failed to start scene', error);
      this.updateHostRunningState(false);
      throw error;
    }
  }

  private detachRuntime(): void {
    this.focusCleanup?.();
    this.focusCleanup = undefined;
    this.profilerSessionService.endSession();

    if (this.runner) {
      this.runner.stop();
      this.runner = undefined;
    }

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = undefined;
    }

    this.activeHostKind = null;
  }

  private attachFocusListeners(windowRef: Window): void {
    const onFocus = (): void => {
      this.handleFocusPause();
    };
    const onBlur = (): void => {
      this.handleFocusPause();
    };
    const onVisibilityChange = (): void => {
      this.handleFocusPause();
    };
    const onPageShow = (): void => {
      this.handleFocusPause();
    };
    const onPageHide = (): void => {
      this.handleFocusPause();
    };

    windowRef.addEventListener('focus', onFocus);
    windowRef.addEventListener('blur', onBlur);
    windowRef.addEventListener('pageshow', onPageShow);
    windowRef.addEventListener('pagehide', onPageHide);
    windowRef.document.addEventListener('visibilitychange', onVisibilityChange);

    this.focusCleanup = () => {
      windowRef.removeEventListener('focus', onFocus);
      windowRef.removeEventListener('blur', onBlur);
      windowRef.removeEventListener('pageshow', onPageShow);
      windowRef.removeEventListener('pagehide', onPageHide);
      windowRef.document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }

  private handleFocusPause(): void {
    if (!this.runner) {
      return;
    }

    const host = this.activeHostKind === 'popout' ? this.popoutHost : this.tabHost;
    if (!host) {
      return;
    }

    const documentRef = host.windowRef.document;
    const isVisible = isDocumentActive(documentRef);
    const shouldPause = appState.ui.pauseRenderingOnUnfocus && !isVisible;
    if (shouldPause) {
      this.runner.pause();
    } else {
      this.runner.resume();
    }
  }

  private updateHostRunningState(isRunning: boolean): void {
    this.tabHost?.setRunningState?.(isRunning && this.activeHostKind === 'tab');
    this.popoutHost?.setRunningState?.(isRunning && this.activeHostKind === 'popout');
    this.updatePopoutPresentation();
  }

  private preparePopoutWindow(windowRef: Window): void {
    const documentRef = windowRef.document;
    documentRef.open();
    documentRef.write(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pix3 Game</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: "Segoe UI", sans-serif;
      }
      * {
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: radial-gradient(circle at top, #2d3238 0%, #121518 55%, #0a0c0e 100%);
        color: #f5f7fa;
      }
      .shell {
        display: flex;
        flex-direction: column;
        height: 100vh;
        min-height: 0;
      }
      .toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(6, 8, 10, 0.78);
        backdrop-filter: blur(10px);
      }
      .toolbar-group {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .toolbar button,
      .toolbar select {
        min-height: 34px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(16, 20, 24, 0.96);
        color: #f5f7fa;
        padding: 0 12px;
        font: inherit;
      }
      .toolbar select {
        color-scheme: dark;
      }
      .toolbar select option {
        background: #11161b;
        color: #f5f7fa;
      }
      .toolbar button {
        cursor: pointer;
      }
      .toolbar button:hover,
      .toolbar select:hover {
        background: rgba(255, 255, 255, 0.11);
      }
      .meta {
        display: flex;
        gap: 16px;
        font-size: 12px;
        color: rgba(245, 247, 250, 0.72);
        flex-wrap: wrap;
      }
      .viewport {
        position: relative;
        flex: 1;
        min-height: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        overflow: hidden;
      }
      .game-host {
        position: relative;
        flex: 0 0 auto;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
      }
      .placeholder {
        position: absolute;
        inset: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
      .placeholder-card {
        width: min(420px, 100%);
        padding: 28px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 18px;
        background: rgba(10, 13, 15, 0.82);
        text-align: center;
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.32);
      }
      .placeholder-title {
        margin: 0 0 8px;
        font-size: 20px;
        font-weight: 600;
      }
      .placeholder-copy {
        margin: 0;
        line-height: 1.5;
        color: rgba(245, 247, 250, 0.72);
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="toolbar">
        <div class="toolbar-group">
          <strong>Game Window</strong>
          <button id="pix3-game-window-restart" type="button">Restart</button>
          <select id="pix3-game-window-aspect" aria-label="Game aspect ratio">
            <option value="free">Free Aspect</option>
            <option value="16:9-landscape">16:9 Landscape</option>
            <option value="16:9-portrait">16:9 Portrait</option>
            <option value="4:3">4:3</option>
          </select>
        </div>
        <div class="meta">
          <span>Status: <strong id="pix3-game-window-status">Stopped</strong></span>
        </div>
      </div>
      <div class="viewport" id="pix3-game-window-viewport">
        <div class="game-host" id="pix3-game-window-host"></div>
        <div class="placeholder" id="pix3-game-window-placeholder">
          <div class="placeholder-card">
            <p class="placeholder-title">Game preview is idle</p>
            <p class="placeholder-copy">Press Play in the editor to run the scene here. This window stays open between runs.</p>
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`);
    documentRef.close();

    const host = documentRef.getElementById('pix3-game-window-host');
    const viewport = documentRef.getElementById('pix3-game-window-viewport');
    const placeholder = documentRef.getElementById('pix3-game-window-placeholder');
    const statusValue = documentRef.getElementById('pix3-game-window-status');
    const aspectSelect = documentRef.getElementById('pix3-game-window-aspect');
    const restartButton = documentRef.getElementById('pix3-game-window-restart');

    if (!host || !viewport || !placeholder || !statusValue || !aspectSelect || !restartButton) {
      throw new Error('Failed to initialize the game popout window shell.');
    }

    this.popoutShell = {
      host: host as HTMLElement,
      viewport: viewport as HTMLElement,
      placeholder: placeholder as HTMLElement,
      statusValue: statusValue as HTMLElement,
      aspectSelect: aspectSelect as HTMLSelectElement,
      restartButton: restartButton as HTMLButtonElement,
    };

    this.popoutShell.aspectSelect.addEventListener('change', this.onPopoutAspectChange);
    this.popoutShell.restartButton.addEventListener('click', this.onPopoutRestartClick);

    this.popoutHost = {
      kind: 'popout',
      mount: this.popoutShell.host,
      windowRef,
      setRunningState: isRunning => {
        this.updatePopoutPresentation(isRunning);
      },
    };

    this.popoutWindowUnloadHandler = () => {
      void this.handlePopoutWindowClosed();
    };
    this.popoutWindowResizeHandler = () => {
      this.updatePopoutPresentation();
    };

    windowRef.addEventListener('beforeunload', this.popoutWindowUnloadHandler);
    windowRef.addEventListener('unload', this.popoutWindowUnloadHandler);
    windowRef.addEventListener('resize', this.popoutWindowResizeHandler);
    this.updatePopoutPresentation();
  }

  private updatePopoutPresentation(forcedRunningState?: boolean): void {
    if (!this.popoutShell) {
      return;
    }

    const aspectRatio = appState.ui.gameAspectRatio;
    const isRunning =
      forcedRunningState ?? (appState.ui.isPlaying && this.activeHostKind === 'popout');
    this.popoutShell.aspectSelect.value = aspectRatio;
    this.popoutShell.statusValue.textContent = isRunning ? 'Playing' : 'Stopped';
    this.popoutShell.restartButton.disabled = !appState.ui.isPlaying;
    this.popoutShell.placeholder.style.display = isRunning ? 'none' : 'flex';
    this.applyAspectRatioToElement(this.popoutShell.host, this.popoutShell.viewport, aspectRatio);
  }

  private applyAspectRatioToElement(
    host: HTMLElement,
    viewport: HTMLElement,
    aspectRatio: GameAspectRatio
  ): void {
    const { width: availableWidth, height: availableHeight } = this.getViewportInnerSize(
      viewport,
      host.ownerDocument.defaultView ?? window
    );

    if (availableWidth <= 0 || availableHeight <= 0) {
      return;
    }

    if (aspectRatio === 'free') {
      host.style.width = `${Math.floor(availableWidth)}px`;
      host.style.height = `${Math.floor(availableHeight)}px`;
      return;
    }

    const targetAspect = this.getAspectRatioValue(aspectRatio);

    let fittedWidth = availableWidth;
    let fittedHeight = fittedWidth / targetAspect;

    if (fittedHeight > availableHeight) {
      fittedHeight = availableHeight;
      fittedWidth = fittedHeight * targetAspect;
    }

    host.style.width = `${Math.floor(fittedWidth)}px`;
    host.style.height = `${Math.floor(fittedHeight)}px`;
  }

  private getViewportInnerSize(
    viewport: HTMLElement,
    windowRef: Window
  ): { width: number; height: number } {
    const rect = viewport.getBoundingClientRect();
    const styles = windowRef.getComputedStyle(viewport);
    const horizontalPadding =
      Number.parseFloat(styles.paddingLeft || '0') + Number.parseFloat(styles.paddingRight || '0');
    const verticalPadding =
      Number.parseFloat(styles.paddingTop || '0') + Number.parseFloat(styles.paddingBottom || '0');

    return {
      width: Math.max(0, rect.width - horizontalPadding),
      height: Math.max(0, rect.height - verticalPadding),
    };
  }

  private getAspectRatioValue(aspectRatio: Exclude<GameAspectRatio, 'free'>): number {
    switch (aspectRatio) {
      case '16:9-landscape':
        return 16 / 9;
      case '16:9-portrait':
        return 9 / 16;
      case '4:3':
        return 4 / 3;
    }
  }

  private isGameAspectRatio(value: string): value is GameAspectRatio {
    return (
      value === 'free' || value === '16:9-landscape' || value === '16:9-portrait' || value === '4:3'
    );
  }

  private async handlePopoutWindowClosed(): Promise<void> {
    this.focusCleanup?.();
    if (this.activeHostKind === 'popout') {
      this.detachRuntime();
      if (appState.ui.isPlaying) {
        await this.operationService.invoke(
          new SetPlayModeOperation({
            isPlaying: false,
            status: 'stopped',
          })
        );
      }
    }

    this.popoutHost = undefined;
    this.popoutShell = null;
    this.closePopoutWindow(false);
    await this.operationService.invoke(new SetGamePopoutWindowOpenOperation({ isOpen: false }));
  }

  private closePopoutWindow(shouldCloseWindow = true): void {
    if (this.popoutShell) {
      this.popoutShell.aspectSelect.removeEventListener('change', this.onPopoutAspectChange);
      this.popoutShell.restartButton.removeEventListener('click', this.onPopoutRestartClick);
    }

    if (this.popoutWindow && this.popoutWindowUnloadHandler) {
      this.popoutWindow.removeEventListener('beforeunload', this.popoutWindowUnloadHandler);
      this.popoutWindow.removeEventListener('unload', this.popoutWindowUnloadHandler);
    }
    if (this.popoutWindow && this.popoutWindowResizeHandler) {
      this.popoutWindow.removeEventListener('resize', this.popoutWindowResizeHandler);
    }

    if (shouldCloseWindow && this.popoutWindow && !this.popoutWindow.closed) {
      this.popoutWindow.close();
    }

    this.popoutWindowUnloadHandler = undefined;
    this.popoutWindowResizeHandler = undefined;
    this.popoutWindow = null;
    this.popoutShell = null;
  }
}
