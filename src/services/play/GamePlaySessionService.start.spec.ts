import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOperationContext, type Operation } from '@/core/Operation';
import { appState } from '@/state';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { RuntimeErrorBridgeService } from '@/services/play/RuntimeErrorBridgeService';

const runtime = vi.hoisted(() => {
  const startScene = vi.fn<() => Promise<void>>();
  const runners: FakeRunner[] = [];
  const renderers: FakeRenderer[] = [];

  class FakeRunner {
    running = false;
    paused = false;
    startScene = vi.fn(async (_sceneId: string) => {
      await startScene();
      this.running = true;
    });
    stop = vi.fn(() => {
      this.running = false;
    });
    pause = vi.fn(() => {
      this.paused = true;
    });
    resume = vi.fn(() => {
      this.paused = false;
    });
    setFrameScheduler = vi.fn();
    setNetworkService = vi.fn();
    setBatching2DEnabled = vi.fn();
    setEditorPeekMask = vi.fn();
    setProjectFonts = vi.fn();
    setLocalizationConfig = vi.fn();
    getLiveRootNodes = vi.fn(() => []);

    constructor() {
      runners.push(this);
    }
  }

  class FakeRenderer {
    domElement = document.createElement('canvas');
    attach = vi.fn((mount: HTMLElement) => mount.append(this.domElement));
    dispose = vi.fn(() => this.domElement.remove());

    constructor() {
      renderers.push(this);
    }
  }

  return { startScene, runners, renderers, FakeRunner, FakeRenderer };
});

// Exercise the session's real lifecycle and state operations without creating a WebGL context.
vi.mock('@pix3/runtime', async importOriginal => ({
  ...(await importOriginal<typeof import('@pix3/runtime')>()),
  SceneRunner: runtime.FakeRunner,
  RuntimeRenderer: runtime.FakeRenderer,
}));

interface SessionInternals {
  initialized: boolean;
  networkService: unknown;
  tabHost: {
    kind: 'tab';
    mount: HTMLElement;
    windowRef: Window;
    setRunningState: (running: boolean) => void;
  };
  startRuntime(host: SessionInternals['tabHost']): Promise<void>;
  syncRuntimeToUiState(): Promise<void>;
}

function makeSession() {
  const service = new GamePlaySessionService();
  const internals = service as unknown as SessionInternals;
  const errorBridge = new RuntimeErrorBridgeService();
  Object.defineProperty(errorBridge, 'loggingService', { value: { error: vi.fn() } });
  const invoke = vi.fn(async (operation: Operation) => operation.perform(createOperationContext()));
  const setAtlasResolver = vi.fn();
  const setRuntimeSink = vi.fn();
  const endSession = vi.fn();
  const disconnect = vi.fn();

  Object.defineProperties(service, {
    sceneManager: { value: {} },
    audioService: { value: {} },
    assetLoader: { value: { setAtlasResolver } },
    operationService: { value: { invoke } },
    runtimeErrorBridge: { value: errorBridge },
    profilerSessionService: {
      value: { beginSession: vi.fn(), bindRuntime: vi.fn(), endSession },
    },
    textureAtlasService: { value: { prepareForPlay: vi.fn(async () => {}) } },
    localizationEditorService: { value: { getRuntimeConfig: () => null } },
    peekService: { value: { setRuntimeSink } },
  });
  // Keep state subscriptions out of the harness; tests explicitly drain the follow-up sync.
  internals.initialized = true;
  internals.networkService = { disconnect, dispose: vi.fn() };
  internals.tabHost = {
    kind: 'tab',
    mount: document.createElement('div'),
    windowRef: window,
    setRunningState: vi.fn(),
  };

  return { service, internals, invoke, setAtlasResolver, setRuntimeSink, endSession, disconnect };
}

describe('GamePlaySessionService — failed launch cleanup', () => {
  let session: ReturnType<typeof makeSession>;

  beforeEach(() => {
    runtime.startScene.mockReset().mockResolvedValue(undefined);
    runtime.runners.length = 0;
    runtime.renderers.length = 0;
    appState.scenes.activeSceneId = 'scene-under-test';
    appState.ui.isPlaying = true;
    appState.ui.playModeStatus = 'playing';
    appState.ui.playModeError = null;
    appState.ui.pauseRenderingOnUnfocus = false;
    session = makeSession();
  });

  afterEach(() => {
    session.service.dispose();
    appState.scenes.activeSceneId = null;
    appState.ui.isPlaying = false;
    appState.ui.playModeStatus = 'stopped';
    appState.ui.playModeError = null;
    appState.ui.pauseRenderingOnUnfocus = true;
    vi.restoreAllMocks();
  });

  it('releases a rejected launch, preserves its error, and can start successfully on retry', async () => {
    const failure = new Error('Failed to clone scene');
    runtime.startScene.mockRejectedValueOnce(failure);
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');

    await expect(session.service.restart()).rejects.toBe(failure);

    expect(runtime.runners[0].stop).toHaveBeenCalledOnce();
    expect(runtime.renderers[0].dispose).toHaveBeenCalledOnce();
    expect(session.internals.tabHost.mount.childElementCount).toBe(0);
    expect(session.service.getActiveRuntime()).toBeNull();
    expect(session.setRuntimeSink).toHaveBeenLastCalledWith(null);
    expect(session.setAtlasResolver).toHaveBeenLastCalledWith(null);
    expect(removeWindowListener).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(session.internals.tabHost.setRunningState).toHaveBeenLastCalledWith(false);
    expect(appState.ui.isPlaying).toBe(false);
    expect(appState.ui.playModeStatus).toBe('stopped');
    expect(appState.ui.playModeError?.message).toBe(
      'Failed to start the scene: Failed to clone scene'
    );

    // The state subscription's follow-up stop must not erase the only visible failure reason.
    await session.internals.syncRuntimeToUiState();
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(appState.ui.playModeError?.message).toBe(
      'Failed to start the scene: Failed to clone scene'
    );

    appState.ui.isPlaying = true;
    appState.ui.playModeStatus = 'playing';
    await session.service.restart();

    expect(runtime.runners[1].running).toBe(true);
    expect(session.service.getActiveRuntime()?.runner).toBe(runtime.runners[1]);
    expect(session.internals.tabHost.setRunningState).toHaveBeenLastCalledWith(true);
    expect(appState.ui.isPlaying).toBe(true);
    expect(appState.ui.playModeError).toBeNull();
  });

  it('does not abort the current session when a superseded launch rejects late', async () => {
    let rejectOldStart!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    runtime.startScene.mockImplementationOnce(() => {
      markStarted();
      return new Promise<void>((_resolve, reject) => {
        rejectOldStart = reject;
      });
    });

    // Direct calls model a teardown/new generation while the old scene clone is still awaiting.
    const oldLaunch = session.internals.startRuntime(session.internals.tabHost);
    await started;
    await session.internals.startRuntime(session.internals.tabHost);
    const current = session.service.getActiveRuntime();
    session.endSession.mockClear();
    session.setRuntimeSink.mockClear();
    session.setAtlasResolver.mockClear();

    rejectOldStart(new Error('Old scene clone failed'));
    await oldLaunch;

    expect(session.service.getActiveRuntime()).toEqual(current);
    expect(runtime.runners[1].running).toBe(true);
    expect(runtime.runners[1].stop).not.toHaveBeenCalled();
    expect(runtime.renderers[1].dispose).not.toHaveBeenCalled();
    expect(session.endSession).not.toHaveBeenCalled();
    expect(session.setRuntimeSink).not.toHaveBeenCalled();
    expect(session.setAtlasResolver).not.toHaveBeenCalled();
    expect(session.invoke).not.toHaveBeenCalled();
    expect(appState.ui.isPlaying).toBe(true);
    expect(appState.ui.playModeError).toBeNull();
  });
});
