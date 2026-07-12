import 'reflect-metadata';

import { installRuntimeImportMap } from '@/core/runtime-import-map';
import { ensureRapierLoaded } from '@/core/lazy-rapier';
import {
  AssetLoader,
  AudioService,
  getGameDebug,
  registerBuiltInScripts,
  RuntimeRenderer,
  SceneLoader,
  SceneManager,
  SceneRunner,
  SceneSaver,
  Script,
  ScriptRegistry,
  type ScriptComponent,
  type PropertySchemaProvider,
  type SceneRunnerFrameSample,
} from '@pix3/runtime';
import {
  buildPreviewWsUrl,
  type PreviewMetricsSample,
  type PreviewSessionConfig,
} from '@/core/remote-preview/protocol';
import { PreviewPlayerClient, type PreviewConnectionState } from './PreviewPlayerClient';
import { RemoteResourceManager } from './RemoteResourceManager';

installRuntimeImportMap();

interface PlayerUi {
  readonly app: HTMLElement;
  readonly overlay: HTMLElement;
  readonly statusTitle: HTMLElement;
  readonly statusDetail: HTMLElement;
}

interface RuntimeStack {
  readonly runner: SceneRunner;
  readonly renderer: RuntimeRenderer;
  disposeFrameSubscription(): void;
}

const RESTART_DEBOUNCE_MS = 300;
const METRICS_INTERVAL_MS = 1000;

class PreviewPlayerApp {
  private readonly ui: PlayerUi;
  private readonly client: PreviewPlayerClient;
  private readonly audioService = new AudioService();

  private sessionConfig: PreviewSessionConfig | null = null;
  private scriptBundle: { code: string; hash: string } | null = null;
  private scriptModule: { exports: Record<string, unknown>; hash: string } | null = null;
  private stack: RuntimeStack | null = null;
  private startTimer: number | null = null;
  private startGeneration = 0;
  private starting = false;
  private pendingScreenshotRequestId: string | null | undefined = undefined;

  // Metrics aggregation over ~1s windows.
  private frameCount = 0;
  private frameMsSum = 0;
  private logicMsSum = 0;
  private renderMsSum = 0;
  private lastSample: SceneRunnerFrameSample | null = null;
  private lastMetricsFlush = performance.now();

  constructor(ui: PlayerUi, sessionId: string, token: string, relayOrigin: string | null) {
    this.ui = ui;
    this.client = new PreviewPlayerClient(
      sessionId,
      // An explicit relay origin in the join link (set when the preview server
      // advertises PREVIEW_PUBLIC_URL, e.g. https://cloud.pix3.dev) beats the
      // page origin, so the player works no matter where this page is hosted.
      buildPreviewWsUrl(relayOrigin || location.origin, sessionId, token),
      {
        onSessionConfig: config => {
          const entrySceneChanged = this.sessionConfig?.entryScenePath !== config.entryScenePath;
          const bundleHashChanged =
            this.sessionConfig?.scriptBundleHash !== config.scriptBundleHash;
          this.sessionConfig = config;
          if (entrySceneChanged || bundleHashChanged || !this.stack) {
            this.scheduleStart();
          }
        },
        onScriptBundle: (code, hash) => {
          this.scriptBundle = { code, hash };
          this.scheduleStart();
        },
        onSceneUpdated: () => {
          this.scheduleStart();
        },
        onRestartRequested: () => {
          this.scheduleStart();
        },
        onScreenshotRequested: requestId => {
          this.pendingScreenshotRequestId = requestId;
        },
        onConnectionStateChanged: state => {
          this.onConnectionStateChanged(state);
        },
        onCommand: (commandId, action, params) => {
          this.handleCommand(commandId, action, params);
        },
      }
    );

    this.interceptConsole();
    window.addEventListener('error', event => {
      this.client.reportLog(
        'error',
        `Uncaught: ${event.message} (${event.filename}:${event.lineno})`
      );
    });
    window.addEventListener('unhandledrejection', event => {
      this.client.reportLog('error', `Unhandled rejection: ${stringifyLogArgument(event.reason)}`);
    });
  }

  start(): void {
    this.showOverlay('Connecting…', 'Reaching the preview session.');
    this.client.connect();
  }

  private onConnectionStateChanged(state: PreviewConnectionState): void {
    switch (state) {
      case 'connecting':
        this.showOverlay('Connecting…', 'Reaching the preview session.');
        break;
      case 'host-offline':
        this.showOverlay(
          'Waiting for the editor…',
          'Open the project in Pix3 and start Remote Preview.'
        );
        break;
      case 'connected':
        if (!this.stack) {
          this.showOverlay('Loading…', 'Waiting for the scene from the editor.');
          this.scheduleStart();
        }
        break;
      case 'disconnected':
        this.showOverlay('Reconnecting…', 'Lost connection to the preview relay.');
        break;
      case 'unauthorized':
        this.showOverlay(
          'Session unavailable',
          'The preview link is invalid or expired. Ask for a fresh link.'
        );
        break;
    }
  }

  private scheduleStart(): void {
    if (this.startTimer !== null) {
      window.clearTimeout(this.startTimer);
    }

    this.startTimer = window.setTimeout(() => {
      this.startTimer = null;
      void this.tryStart();
    }, RESTART_DEBOUNCE_MS);
  }

  private async tryStart(): Promise<void> {
    const config = this.sessionConfig;
    if (!config || !this.client.isHostOnline()) {
      return;
    }

    // A configured script bundle must arrive (relay replays the cached one)
    // before the scene can run with its user components.
    if (config.scriptBundleHash && this.scriptBundle?.hash !== config.scriptBundleHash) {
      this.showOverlay('Loading…', 'Fetching project scripts.');
      return;
    }

    if (this.starting) {
      this.scheduleStart();
      return;
    }

    this.starting = true;
    const generation = ++this.startGeneration;
    this.client.reportStatus('loading');
    this.showOverlay('Loading…', `Starting ${config.entryScenePath}`);

    try {
      await this.startScene(config, generation);
      if (generation === this.startGeneration) {
        this.hideOverlay();
        this.client.reportStatus('running');
      }
    } catch (error) {
      console.error('[Pix3 Player] Failed to start scene', error);
      if (generation === this.startGeneration) {
        const message = error instanceof Error ? error.message : String(error);
        this.showOverlay('Failed to start scene', message);
        this.client.reportStatus('error', message);
      }
    } finally {
      this.starting = false;
    }
  }

  private async startScene(config: PreviewSessionConfig, generation: number): Promise<void> {
    this.teardownStack();

    const scriptRegistry = new ScriptRegistry();
    registerBuiltInScripts(scriptRegistry);
    await this.registerUserScripts(scriptRegistry);

    // A fresh resource stack per start keeps invalidated assets out of the
    // AssetLoader/audio caches; transfer cost stays low because the client
    // revalidates by content hash.
    const resourceManager = new RemoteResourceManager(this.client);
    const assetLoader = new AssetLoader(resourceManager, this.audioService);
    const sceneLoader = new SceneLoader(assetLoader, scriptRegistry, resourceManager);
    const sceneManager = new SceneManager(sceneLoader, new SceneSaver());

    const scenePath = config.entryScenePath;
    const sceneText = await resourceManager.readText(`res://${scenePath}`);
    if (generation !== this.startGeneration) {
      return;
    }

    const graph = await sceneManager.parseScene(sceneText, { filePath: scenePath });
    if (generation !== this.startGeneration) {
      return;
    }
    sceneManager.setActiveSceneGraph(scenePath, graph);

    const renderer = new RuntimeRenderer({
      antialias: config.quality.antialias,
      shadows: config.quality.shadows,
      pixelRatio: Math.min(window.devicePixelRatio || 1, config.quality.maxPixelRatio),
    });
    renderer.attach(this.ui.app);

    const runner = new SceneRunner(sceneManager, renderer, this.audioService, assetLoader, {
      width: config.viewportBaseSize.width,
      height: config.viewportBaseSize.height,
    });

    const disposeFrameSubscription = runner.subscribeFrameStats(sample => {
      this.onFrameSample(sample, renderer);
    });

    this.stack = { runner, renderer, disposeFrameSubscription };
    this.resetMetricsWindow();

    await runner.startScene(scenePath);
    if (generation !== this.startGeneration) {
      return;
    }
  }

  private async registerUserScripts(registry: ScriptRegistry): Promise<void> {
    const bundle = this.scriptBundle;
    if (!bundle || bundle.code.trim().length === 0) {
      this.scriptModule = null;
      return;
    }

    if (!this.scriptModule || this.scriptModule.hash !== bundle.hash) {
      if (bundle.code.includes('@dimforge/')) {
        await ensureRapierLoaded();
      }

      const blob = new Blob([bundle.code], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      try {
        const exports = (await import(/* @vite-ignore */ blobUrl)) as Record<string, unknown>;
        this.scriptModule = { exports, hash: bundle.hash };
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }

    for (const [namespaceName, namespaceExports] of Object.entries(this.scriptModule.exports)) {
      if (typeof namespaceExports !== 'object' || namespaceExports === null) {
        continue;
      }

      for (const [className, classValue] of Object.entries(namespaceExports)) {
        this.tryRegisterScriptClass(registry, className, classValue, namespaceName);
      }
    }
  }

  private tryRegisterScriptClass(
    registry: ScriptRegistry,
    className: string,
    classValue: unknown,
    sourceFile: string
  ): void {
    if (typeof classValue !== 'function') {
      return;
    }

    const ctor = classValue as { prototype?: object; getPropertySchema?: unknown };
    if (typeof ctor.getPropertySchema !== 'function') {
      return;
    }

    let prototype = ctor.prototype;
    let extendsScript = false;
    while (prototype) {
      if (prototype === Script.prototype) {
        extendsScript = true;
        break;
      }
      prototype = Object.getPrototypeOf(prototype);
    }

    if (!extendsScript) {
      return;
    }

    registry.registerComponent({
      id: `user:${className}`,
      displayName: className,
      description: `Project component from ${sourceFile}`,
      category: 'Project',
      componentClass: ctor as unknown as (new (id: string, type: string) => ScriptComponent) &
        PropertySchemaProvider,
      keywords: ['project', 'component', className.toLowerCase()],
    });
  }

  /**
   * Agent HTTP API commands routed to this player. Diagnostics go through the
   * game's optional `__PIX3_GAME_DEBUG__` provider (see game-debug.ts);
   * property edits reuse the SceneRunner live-property sink.
   */
  private handleCommand(commandId: string, action: string, params: unknown): void {
    try {
      switch (action) {
        case 'set-property': {
          const record = (params ?? {}) as {
            nodeId?: unknown;
            propertyPath?: unknown;
            value?: unknown;
          };
          if (typeof record.nodeId !== 'string' || typeof record.propertyPath !== 'string') {
            this.client.sendCommandAck(
              commandId,
              false,
              undefined,
              'nodeId and propertyPath are required'
            );
            return;
          }
          const applied =
            this.stack?.runner.applyLivePropertyUpdate(
              record.nodeId,
              record.propertyPath,
              record.value
            ) ?? false;
          this.client.sendCommandAck(
            commandId,
            applied,
            { applied },
            applied ? undefined : 'node or property not found (is the scene running?)'
          );
          return;
        }
        case 'snapshot': {
          const provider = getGameDebug();
          const result = {
            scene: this.sessionConfig?.entryScenePath ?? null,
            running: this.stack !== null,
            game: provider?.snapshot ? provider.snapshot() : null,
            provider: provider ? { name: provider.name, version: provider.version ?? 1 } : null,
          };
          this.client.sendCommandAck(commandId, true, result);
          return;
        }
        case 'inspect': {
          const provider = getGameDebug();
          if (!provider?.inspect) {
            this.client.sendCommandAck(
              commandId,
              false,
              undefined,
              'game exposes no debug inspect() provider'
            );
            return;
          }
          const record = (params ?? {}) as { query?: unknown; args?: unknown };
          const result = provider.inspect(String(record.query ?? ''), record.args);
          this.client.sendCommandAck(commandId, true, result ?? null);
          return;
        }
        case 'game-action': {
          const provider = getGameDebug();
          if (!provider?.action) {
            this.client.sendCommandAck(
              commandId,
              false,
              undefined,
              'game exposes no debug action() provider'
            );
            return;
          }
          const record = (params ?? {}) as { name?: unknown; args?: unknown };
          const result = provider.action(String(record.name ?? ''), record.args);
          this.client.sendCommandAck(commandId, true, result ?? null);
          return;
        }
        default:
          this.client.sendCommandAck(commandId, false, undefined, `unknown action: ${action}`);
      }
    } catch (error) {
      this.client.sendCommandAck(
        commandId,
        false,
        undefined,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private teardownStack(): void {
    if (!this.stack) {
      return;
    }

    this.stack.disposeFrameSubscription();
    this.stack.runner.stop();
    this.stack.renderer.dispose();
    this.stack = null;
  }

  private onFrameSample(sample: SceneRunnerFrameSample, renderer: RuntimeRenderer): void {
    this.frameCount += 1;
    this.frameMsSum += sample.totalFrameMs;
    this.logicMsSum += sample.logicMs;
    this.renderMsSum += sample.renderMs;
    this.lastSample = sample;

    if (this.pendingScreenshotRequestId !== undefined) {
      const requestId = this.pendingScreenshotRequestId ?? null;
      this.pendingScreenshotRequestId = undefined;
      // Capture synchronously after render() so the WebGL back buffer is
      // still valid (no preserveDrawingBuffer).
      renderer.domElement.toBlob(
        blob => {
          if (blob) {
            this.client.sendScreenshot(blob, requestId);
          }
        },
        'image/jpeg',
        0.8
      );
    }

    const now = performance.now();
    if (now - this.lastMetricsFlush >= METRICS_INTERVAL_MS) {
      const seconds = (now - this.lastMetricsFlush) / 1000;
      const metrics: PreviewMetricsSample = {
        fps: Math.round((this.frameCount / seconds) * 10) / 10,
        frameMs: round2(this.frameMsSum / Math.max(1, this.frameCount)),
        logicMs: round2(this.logicMsSum / Math.max(1, this.frameCount)),
        renderMs: round2(this.renderMsSum / Math.max(1, this.frameCount)),
        drawCalls: this.lastSample?.rendererStats.calls ?? 0,
        triangles: this.lastSample?.rendererStats.triangles ?? 0,
        geometries: this.lastSample?.rendererStats.geometries ?? 0,
        textures: this.lastSample?.rendererStats.textures ?? 0,
        elapsedTime: round2(this.lastSample?.elapsedTime ?? 0),
        frameNumber: this.lastSample?.frameNumber ?? 0,
      };
      this.client.reportMetrics(metrics);
      this.resetMetricsWindow();
    }
  }

  private resetMetricsWindow(): void {
    this.frameCount = 0;
    this.frameMsSum = 0;
    this.logicMsSum = 0;
    this.renderMsSum = 0;
    this.lastMetricsFlush = performance.now();
  }

  private interceptConsole(): void {
    const forward = (level: 'debug' | 'info' | 'warn' | 'error', args: unknown[]): void => {
      try {
        this.client.reportLog(level, args.map(stringifyLogArgument).join(' '));
      } catch {
        // Never let log forwarding break the game.
      }
    };

    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        original(...args);
        forward(level, args);
      };
    }

    const originalLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      originalLog(...args);
      forward('info', args);
    };
  }

  private showOverlay(title: string, detail: string): void {
    this.ui.statusTitle.textContent = title;
    this.ui.statusDetail.textContent = detail;
    this.ui.overlay.style.display = 'flex';
  }

  private hideOverlay(): void {
    this.ui.overlay.style.display = 'none';
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function stringifyLogArgument(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function bootstrap(): void {
  const app = document.getElementById('app');
  const overlay = document.getElementById('player-overlay');
  const statusTitle = document.getElementById('player-status-title');
  const statusDetail = document.getElementById('player-status-detail');

  if (!app || !overlay || !statusTitle || !statusDetail) {
    throw new Error('Player shell markup is missing.');
  }

  const ui: PlayerUi = { app, overlay, statusTitle, statusDetail };
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session') ?? '';
  const token = params.get('token') ?? '';
  const relayParam = (params.get('relay') ?? '').trim().replace(/\/+$/, '');
  const relayOrigin = /^https?:\/\//i.test(relayParam) ? relayParam : null;

  if (!sessionId || !token) {
    ui.statusTitle.textContent = 'Missing session';
    ui.statusDetail.textContent =
      'This page needs ?session=…&token=… — scan the QR code from the Pix3 editor.';
    return;
  }

  const playerApp = new PreviewPlayerApp(ui, sessionId, token, relayOrigin);
  playerApp.start();
}

bootstrap();
