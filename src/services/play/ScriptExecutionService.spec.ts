import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeBase, Script, type SceneGraph, type SceneManager } from '@pix3/runtime';
import { ScriptExecutionService } from '@/services/play/ScriptExecutionService';
import { appState, resetAppState } from '@/state';

class LifecycleScript extends Script {
  detachCalls = 0;

  override onDetach(): void {
    this.detachCalls += 1;
  }
}

const createSceneFixture = (): { scene: SceneGraph; script: LifecycleScript } => {
  const node = new NodeBase({ id: 'node-1', name: 'Node 1' });
  const script = new LifecycleScript('script-1', 'LifecycleScript');
  node.addComponent(script);

  const scene: SceneGraph = {
    version: '1.0',
    description: 'test',
    rootNodes: [node],
    nodeMap: new Map([[node.nodeId, node]]),
    metadata: {},
  };

  return { scene, script };
};

const createService = (scene: SceneGraph): ScriptExecutionService => {
  const sceneManagerMock: Pick<SceneManager, 'getActiveSceneGraph' | 'getSceneGraph'> = {
    getActiveSceneGraph: () => scene,
    getSceneGraph: (_sceneId: string) => scene,
  };

  const service = new ScriptExecutionService();
  Object.defineProperty(service, 'sceneManager', {
    value: sceneManagerMock,
    configurable: true,
  });
  Object.defineProperty(service, 'input', {
    value: { beginFrame: vi.fn() },
    configurable: true,
  });
  Object.defineProperty(service, 'autoloadService', {
    value: {
      getGlobalRoot: () => new NodeBase({ id: 'autoload-root', name: 'Autoload Root' }),
      getAutoloadInstances: () => [],
    },
    configurable: true,
  });
  Object.defineProperty(service, 'audioService', {
    value: { stopAll: vi.fn() },
    configurable: true,
  });

  return service;
};

describe('ScriptExecutionService lifecycle teardown', () => {
  beforeEach(() => {
    resetAppState();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAppState();
  });

  it('detaches scripts and resets started state when stopping a known scene', () => {
    const { scene, script } = createSceneFixture();
    const service = createService(scene);

    service.onSceneChanged('scene-1');
    script._started = true;

    service.start();
    service.stop();

    expect(script.detachCalls).toBe(1);
    expect(script._started).toBe(false);
  });

  it('detaches scripts when stopping without currentSceneId (active-scene fallback)', () => {
    const { scene, script } = createSceneFixture();
    const service = createService(scene);

    script._started = true;

    service.start();
    service.stop();

    expect(script.detachCalls).toBe(1);
    expect(script._started).toBe(false);
  });

  it('does not schedule frames while the page is hidden', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    const { scene } = createSceneFixture();
    const service = createService(scene);

    service.start();

    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('resumes scheduling after the page becomes visible again', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    const { scene } = createSceneFixture();
    const service = createService(scene);

    service.start();
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    hasFocusSpy.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));

    expect(vi.mocked(requestAnimationFrame).mock.calls.length).toBeGreaterThan(0);
  });

  it('keeps running in background when pause-on-unfocus is disabled', () => {
    appState.ui.pauseRenderingOnUnfocus = false;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    const { scene } = createSceneFixture();
    const service = createService(scene);

    service.start();

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
});
