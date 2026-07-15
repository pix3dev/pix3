import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scene as ThreeScene } from 'three';

import { AudioService } from './AudioService';
import type { RuntimeRenderer } from './RuntimeRenderer';
import type { SceneGraph } from './SceneManager';
import { SceneManager } from './SceneManager';
import { SceneLoader } from './SceneLoader';
import { SceneSaver } from './SceneSaver';
import { ScriptRegistry } from './ScriptRegistry';
import { SceneRunner } from './SceneRunner';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { Script } from './ScriptComponent';
import type { FrameProfilerActivity } from './SceneService';
import { Camera3D } from '../nodes/3D/Camera3D';
import { NodeBase } from '../nodes/NodeBase';

function createRendererStub(width: number, height: number): RuntimeRenderer {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: height, configurable: true });

  return {
    beginStatsFrame: vi.fn(),
    domElement: canvas,
    render: vi.fn(),
    setAutoClear: vi.fn(),
    clear: vi.fn(),
    clearDepth: vi.fn(),
    getStatsSnapshot: vi.fn(() => ({
      calls: 0,
      triangles: 0,
      points: 0,
      lines: 0,
      geometries: 0,
      textures: 0,
    })),
  } as unknown as RuntimeRenderer;
}

function createSceneManagerStub(): SceneManager {
  return {} as unknown as SceneManager;
}

function createGraph(cameraNode: Camera3D): SceneGraph {
  return {
    version: '1.0.0',
    metadata: {},
    rootNodes: [cameraNode],
    nodeMap: new Map([[cameraNode.nodeId, cameraNode]]),
  };
}

class FrameProfilerScript extends Script {
  constructor(private readonly activities: readonly FrameProfilerActivity[]) {
    super('frame-profiler-script', 'FrameProfilerScript');
  }

  onUpdate(): void {
    this.scene?.reportFrameProfilerActivities(this.activities);
  }
}

class LifecycleScript extends Script {
  detachCalls = 0;

  override onDetach(): void {
    this.detachCalls += 1;
  }
}

class DtRecordingScript extends Script {
  readonly received: number[] = [];

  constructor() {
    super('dt-recording-script', 'DtRecordingScript');
  }

  override onUpdate(dt: number): void {
    this.received.push(dt);
  }
}

describe('SceneRunner camera projection updates', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the project viewport base size for the 2D camera without a legacy viewport node', () => {
    const renderer = createRendererStub(300, 150);
    const runner = new SceneRunner(
      createSceneManagerStub(),
      renderer,
      new AudioService(),
      new AssetLoader(new ResourceManager('/'), new AudioService()),
      { width: 1920, height: 1080 }
    );
    const cameraNode = new Camera3D({
      id: 'runtime-perspective-base',
      name: 'Camera',
      projection: 'perspective',
    });

    (
      runner as unknown as {
        runtimeGraph: SceneGraph;
        render: () => void;
      }
    ).runtimeGraph = createGraph(cameraNode);

    (runner as unknown as { render: () => void }).render();

    const overlayCamera = (
      runner as unknown as { orthographicCamera: import('three').OrthographicCamera }
    ).orthographicCamera;
    expect(overlayCamera.left).toBe(-1080);
    expect(overlayCamera.right).toBe(1080);
    expect(overlayCamera.top).toBe(540);
    expect(overlayCamera.bottom).toBe(-540);
  });

  it('updates orthographic active camera bounds from viewport aspect and size', () => {
    const renderer = createRendererStub(300, 150);
    const runner = new SceneRunner(
      createSceneManagerStub(),
      renderer,
      new AudioService(),
      new AssetLoader(new ResourceManager('/'), new AudioService())
    );
    const cameraNode = new Camera3D({
      id: 'runtime-ortho',
      name: 'Camera',
      projection: 'orthographic',
      orthographicSize: 8,
    });

    (
      runner as unknown as {
        activeCamera: Camera3D;
        runtimeGraph: SceneGraph;
        scene: ThreeScene;
        render: () => void;
      }
    ).activeCamera = cameraNode;
    (runner as unknown as { runtimeGraph: SceneGraph }).runtimeGraph = createGraph(cameraNode);

    (runner as unknown as { render: () => void }).render();

    const camera = cameraNode.camera as import('three').OrthographicCamera;
    expect(camera.top).toBe(4);
    expect(camera.bottom).toBe(-4);
    expect(camera.left).toBe(-8);
    expect(camera.right).toBe(8);
  });

  it('keeps perspective camera aspect updates unchanged', () => {
    const renderer = createRendererStub(320, 160);
    const runner = new SceneRunner(
      createSceneManagerStub(),
      renderer,
      new AudioService(),
      new AssetLoader(new ResourceManager('/'), new AudioService())
    );
    const cameraNode = new Camera3D({
      id: 'runtime-perspective',
      name: 'Camera',
      projection: 'perspective',
    });

    (
      runner as unknown as {
        activeCamera: Camera3D;
        runtimeGraph: SceneGraph;
        scene: ThreeScene;
        render: () => void;
      }
    ).activeCamera = cameraNode;
    (runner as unknown as { runtimeGraph: SceneGraph }).runtimeGraph = createGraph(cameraNode);

    (runner as unknown as { render: () => void }).render();

    const camera = cameraNode.camera as import('three').PerspectiveCamera;
    expect(camera.aspect).toBe(2);
  });

  it('includes per-frame profiler activities in frame samples and resets missing reports', () => {
    const renderer = createRendererStub(320, 160);
    const audioService = {
      getActivePlaybackSnapshot: vi
        .fn()
        .mockReturnValueOnce([
          {
            id: 'playback-17',
            label: 'hitStone',
            startedAtMs: 1000,
            elapsedMs: 125,
            loop: false,
            volume: 0.35,
            playbackRate: 1.05,
            pan: -0.1,
          },
        ])
        .mockReturnValueOnce([]),
      stopAll: vi.fn(),
      resetBuses: vi.fn(),
      applySnapshot: vi.fn(),
    } as unknown as AudioService;
    const runner = new SceneRunner(
      createSceneManagerStub(),
      renderer,
      audioService,
      new AssetLoader(new ResourceManager('/'))
    );
    const cameraNode = new Camera3D({
      id: 'runtime-profiler',
      name: 'Camera',
      projection: 'perspective',
    });
    const reporter = new FrameProfilerScript([
      { label: 'Physics', selfTimeMs: 1.5, totalTimeMs: 2.25 },
      { label: 'Audio', selfTimeMs: 0.25 },
    ]);
    cameraNode.addComponent(reporter);

    const runnerInternals = runner as unknown as {
      activeCamera: Camera3D;
      runtimeGraph: SceneGraph;
      sceneService: import('./SceneService').SceneService;
      isRunning: boolean;
      tick: () => void;
      clock: { getDelta: () => number };
    };

    cameraNode.scene = runnerInternals.sceneService;
    runnerInternals.activeCamera = cameraNode;
    runnerInternals.runtimeGraph = createGraph(cameraNode);
    runnerInternals.isRunning = true;

    vi.spyOn(runnerInternals.clock, 'getDelta').mockReturnValue(1 / 60);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);

    const samples: import('./SceneRunner').SceneRunnerFrameSample[] = [];
    runner.subscribeFrameStats(sample => {
      samples.push(sample);
    });

    runnerInternals.tick();
    cameraNode.removeComponent(reporter);
    runnerInternals.tick();

    expect(samples).toHaveLength(2);
    expect(samples[0]?.profilerActivities).toEqual([
      { label: 'Physics', selfTimeMs: 1.5, totalTimeMs: 2.25 },
      { label: 'Audio', selfTimeMs: 0.25 },
    ]);
    expect(samples[0]?.activeAudioPlaybacks).toEqual([
      {
        id: 'playback-17',
        label: 'hitStone',
        startedAtMs: 1000,
        elapsedMs: 125,
        loop: false,
        volume: 0.35,
        playbackRate: 1.05,
        pan: -0.1,
      },
    ]);
    expect(samples[1]?.profilerActivities).toBeUndefined();
    expect(samples[1]?.activeAudioPlaybacks).toBeUndefined();
  });

  it('hot-reloads a property edit onto the running clone by nodeId', () => {
    const runner = new SceneRunner(
      createSceneManagerStub(),
      createRendererStub(320, 160),
      new AudioService(),
      new AssetLoader(new ResourceManager('/'), new AudioService())
    );
    const node = new NodeBase({ id: 'live-node', name: 'Original' });

    (runner as unknown as { runtimeGraph: SceneGraph; isRunning: boolean }).runtimeGraph = {
      version: '1.0.0',
      metadata: {},
      rootNodes: [node],
      nodeMap: new Map([[node.nodeId, node]]),
    };
    (runner as unknown as { isRunning: boolean }).isRunning = true;

    const applied = runner.applyLivePropertyUpdate('live-node', 'name', 'Renamed');

    expect(applied).toBe(true);
    expect(node.name).toBe('Renamed');
  });

  it('returns false for an unknown node id or an unknown property', () => {
    const runner = new SceneRunner(
      createSceneManagerStub(),
      createRendererStub(320, 160),
      new AudioService(),
      new AssetLoader(new ResourceManager('/'), new AudioService())
    );
    const node = new NodeBase({ id: 'live-node', name: 'Original' });

    (runner as unknown as { runtimeGraph: SceneGraph; isRunning: boolean }).runtimeGraph = {
      version: '1.0.0',
      metadata: {},
      rootNodes: [node],
      nodeMap: new Map([[node.nodeId, node]]),
    };
    (runner as unknown as { isRunning: boolean }).isRunning = true;

    expect(runner.applyLivePropertyUpdate('missing', 'name', 'x')).toBe(false);
    expect(runner.applyLivePropertyUpdate('live-node', 'notARealProp', 'x')).toBe(false);
    expect(node.name).toBe('Original');
  });

  it('does not apply live property updates when the runner is not running', () => {
    const runner = new SceneRunner(
      createSceneManagerStub(),
      createRendererStub(320, 160),
      new AudioService(),
      new AssetLoader(new ResourceManager('/'), new AudioService())
    );
    const node = new NodeBase({ id: 'live-node', name: 'Original' });

    (runner as unknown as { runtimeGraph: SceneGraph }).runtimeGraph = {
      version: '1.0.0',
      metadata: {},
      rootNodes: [node],
      nodeMap: new Map([[node.nodeId, node]]),
    };
    // isRunning stays false.

    expect(runner.applyLivePropertyUpdate('live-node', 'name', 'Renamed')).toBe(false);
    expect(node.name).toBe('Original');
  });

  it('scales the gameplay delta by the global Time.scale (slow-mo and hitstop)', () => {
    const audioService = {
      stopAll: vi.fn(),
      resetBuses: vi.fn(),
      applySnapshot: vi.fn(),
      getActivePlaybackSnapshot: vi.fn(() => []),
    } as unknown as AudioService;
    const runner = new SceneRunner(
      createSceneManagerStub(),
      createRendererStub(320, 160),
      audioService,
      new AssetLoader(new ResourceManager('/'), new AudioService())
    );
    const cameraNode = new Camera3D({
      id: 'runtime-timescale',
      name: 'Camera',
      projection: 'perspective',
    });
    const recorder = new DtRecordingScript();
    cameraNode.addComponent(recorder);

    const internals = runner as unknown as {
      activeCamera: Camera3D;
      runtimeGraph: SceneGraph;
      sceneService: import('./SceneService').SceneService;
      isRunning: boolean;
      tick: () => void;
      clock: { getDelta: () => number };
      gameTime: import('./GameTime').GameTime;
    };

    cameraNode.scene = internals.sceneService;
    internals.activeCamera = cameraNode;
    internals.runtimeGraph = createGraph(cameraNode);
    internals.isRunning = true;

    vi.spyOn(internals.clock, 'getDelta').mockReturnValue(1 / 60);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);

    // Frame 1: normal speed.
    internals.tick();
    // Frame 2: half speed.
    internals.gameTime.setScale(0.5);
    internals.tick();
    // Frame 3: frozen by a hitstop.
    internals.gameTime.hitstop(1000);
    internals.tick();

    expect(recorder.received).toHaveLength(3);
    expect(recorder.received[0]).toBeCloseTo(1 / 60, 6);
    expect(recorder.received[1]).toBeCloseTo(1 / 120, 6);
    expect(recorder.received[2]).toBe(0);
  });

  it('auto-muffles audio in slow motion and restores at normal speed', () => {
    const applySnapshot = vi.fn();
    const audioService = {
      stopAll: vi.fn(),
      resetBuses: vi.fn(),
      applySnapshot,
      getActivePlaybackSnapshot: vi.fn(() => []),
    } as unknown as AudioService;
    const runner = new SceneRunner(
      createSceneManagerStub(),
      createRendererStub(320, 160),
      audioService,
      new AssetLoader(new ResourceManager('/'), new AudioService())
    );
    const cameraNode = new Camera3D({
      id: 'runtime-muffle',
      name: 'Camera',
      projection: 'perspective',
    });

    const internals = runner as unknown as {
      activeCamera: Camera3D;
      runtimeGraph: SceneGraph;
      sceneService: import('./SceneService').SceneService;
      isRunning: boolean;
      tick: () => void;
      clock: { getDelta: () => number };
      gameTime: import('./GameTime').GameTime;
    };

    cameraNode.scene = internals.sceneService;
    internals.activeCamera = cameraNode;
    internals.runtimeGraph = createGraph(cameraNode);
    internals.isRunning = true;

    vi.spyOn(internals.clock, 'getDelta').mockReturnValue(1 / 60);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);

    // Normal speed → no snapshot change.
    internals.tick();
    expect(applySnapshot).not.toHaveBeenCalled();

    // Enter slow-mo → muffle exactly once.
    internals.gameTime.setScale(0.5);
    internals.tick();
    expect(applySnapshot).toHaveBeenCalledTimes(1);
    expect(applySnapshot).toHaveBeenLastCalledWith('muffled');

    // Still slow → guarded, no repeat ramp.
    internals.tick();
    expect(applySnapshot).toHaveBeenCalledTimes(1);

    // A hitstop forces scale to 0 but baseScale stays 0.5 → still no new call.
    internals.gameTime.hitstop(1000);
    internals.tick();
    expect(applySnapshot).toHaveBeenCalledTimes(1);

    // Back to normal speed → restore default (clears the hitstop first).
    internals.gameTime.reset();
    internals.tick();
    expect(applySnapshot).toHaveBeenCalledTimes(2);
    expect(applySnapshot).toHaveBeenLastCalledWith('default');
  });

  it('does not muffle audio for a hitstop from normal speed', () => {
    const applySnapshot = vi.fn();
    const audioService = {
      stopAll: vi.fn(),
      resetBuses: vi.fn(),
      applySnapshot,
      getActivePlaybackSnapshot: vi.fn(() => []),
    } as unknown as AudioService;
    const runner = new SceneRunner(
      createSceneManagerStub(),
      createRendererStub(320, 160),
      audioService,
      new AssetLoader(new ResourceManager('/'), new AudioService())
    );
    const cameraNode = new Camera3D({
      id: 'runtime-hitstop',
      name: 'Camera',
      projection: 'perspective',
    });

    const internals = runner as unknown as {
      activeCamera: Camera3D;
      runtimeGraph: SceneGraph;
      sceneService: import('./SceneService').SceneService;
      isRunning: boolean;
      tick: () => void;
      clock: { getDelta: () => number };
      gameTime: import('./GameTime').GameTime;
    };

    cameraNode.scene = internals.sceneService;
    internals.activeCamera = cameraNode;
    internals.runtimeGraph = createGraph(cameraNode);
    internals.isRunning = true;

    vi.spyOn(internals.clock, 'getDelta').mockReturnValue(1 / 60);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);

    internals.tick();
    internals.gameTime.hitstop(50);
    internals.tick();

    expect(applySnapshot).not.toHaveBeenCalled();
  });

  it('detaches runtime scripts and resets started state when stopping', () => {
    const audioService = {
      stopAll: vi.fn(),
      resetBuses: vi.fn(),
      applySnapshot: vi.fn(),
      getActivePlaybackSnapshot: vi.fn(() => []),
    } as unknown as AudioService;
    const runner = new SceneRunner(
      createSceneManagerStub(),
      createRendererStub(320, 160),
      audioService,
      new AssetLoader(new ResourceManager('/'), new AudioService())
    );
    const rootNode = new NodeBase({ id: 'runtime-root', name: 'Runtime Root' });
    const script = new LifecycleScript('lifecycle-script', 'LifecycleScript');
    rootNode.addComponent(script);
    script._started = true;

    (runner as unknown as { runtimeGraph: SceneGraph; isRunning: boolean }).runtimeGraph = {
      version: '1.0.0',
      metadata: {},
      rootNodes: [rootNode],
      nodeMap: new Map([[rootNode.nodeId, rootNode]]),
    };
    (runner as unknown as { isRunning: boolean }).isRunning = true;

    runner.stop();

    expect(script.detachCalls).toBe(1);
    expect(script._started).toBe(false);
    expect(vi.mocked(audioService.stopAll)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audioService.resetBuses)).toHaveBeenCalledTimes(1);
  });

  it('resets the AO-suppression memo on stop so the next scene re-applies it', () => {
    const runner = new SceneRunner(
      createSceneManagerStub(),
      createRendererStub(320, 160),
      new AudioService(),
      new AssetLoader(new ResourceManager('/'), new AudioService())
    );
    (runner as unknown as { lastAOSuppress: boolean | null }).lastAOSuppress = true;

    runner.stop();

    expect((runner as unknown as { lastAOSuppress: boolean | null }).lastAOSuppress).toBeNull();
  });
});

const CAMERA_SCENE_YAML = `version: 1.0.0
root:
  - id: cam-a
    type: Camera3D
    name: Scene A Camera
`;

const SCENE_B_YAML = `version: 1.0.0
root:
  - id: b-root
    type: Group2D
    name: SceneB Root
    properties:
      width: 100
      height: 100
`;

/** ResourceManager that serves scene text from an in-memory map (no network). */
class InMemoryResourceManager extends ResourceManager {
  constructor(private readonly files: Record<string, string>) {
    super('/');
  }

  override async readText(resource: string): Promise<string> {
    const key = resource.replace(/^res:\/\//i, '');
    const text = this.files[key];
    if (text === undefined) {
      throw new Error(`InMemoryResourceManager: no file at ${resource}`);
    }
    return text;
  }
}

function createRealSceneManager(
  resourceManager: ResourceManager,
  audioService: AudioService
): { sceneManager: SceneManager; assetLoader: AssetLoader } {
  const assetLoader = new AssetLoader(resourceManager, audioService);
  const sceneLoader = new SceneLoader(assetLoader, new ScriptRegistry(), resourceManager);
  return { sceneManager: new SceneManager(sceneLoader, new SceneSaver()), assetLoader };
}

describe('SceneRunner scene transitions (loadAndStartScene)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs a scene through the extracted runGraph path via startScene', async () => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1 as unknown as number);
    const audioService = new AudioService();
    const resourceManager = new InMemoryResourceManager({});
    const { sceneManager, assetLoader } = createRealSceneManager(resourceManager, audioService);
    const runner = new SceneRunner(
      sceneManager,
      createRendererStub(320, 160),
      audioService,
      assetLoader
    );

    const graph = await sceneManager.parseScene(CAMERA_SCENE_YAML, { filePath: 'a.pix3scene' });
    sceneManager.setActiveSceneGraph('a.pix3scene', graph);

    await runner.startScene('a.pix3scene');

    expect(runner.running).toBe(true);
    expect(runner.getLiveRootNodes()).toHaveLength(1);
    runner.stop();
  });

  it('reads + parses the target and hands it to runGraph WITHOUT registering it in the SceneManager', async () => {
    const audioService = new AudioService();
    const resourceManager = new InMemoryResourceManager({
      'scenes/b.pix3scene': SCENE_B_YAML,
    });
    const { sceneManager, assetLoader } = createRealSceneManager(resourceManager, audioService);
    const runner = new SceneRunner(
      sceneManager,
      createRendererStub(320, 160),
      audioService,
      assetLoader
    );
    // Isolate the read/parse contract from the heavy run path.
    const runGraphSpy = vi
      .spyOn(runner as unknown as { runGraph: (g: SceneGraph) => void }, 'runGraph')
      .mockImplementation(() => undefined);

    await runner.loadAndStartScene('res://scenes/b.pix3scene');

    expect(runGraphSpy).toHaveBeenCalledTimes(1);
    const passedGraph = runGraphSpy.mock.calls[0]?.[0] as SceneGraph;
    expect(passedGraph.rootNodes[0]?.name).toBe('SceneB Root');
    // The transient target must never pollute the shared SceneManager.
    expect(sceneManager.getSceneGraph('scenes/b.pix3scene')).toBeNull();
    expect(sceneManager.getActiveSceneGraph()).toBeNull();
  });

  it('accepts the target path with and without the res:// prefix', async () => {
    const audioService = new AudioService();
    const resourceManager = new InMemoryResourceManager({
      'scenes/b.pix3scene': SCENE_B_YAML,
    });
    const { sceneManager, assetLoader } = createRealSceneManager(resourceManager, audioService);
    const runner = new SceneRunner(
      sceneManager,
      createRendererStub(320, 160),
      audioService,
      assetLoader
    );
    vi.spyOn(
      runner as unknown as { runGraph: (g: SceneGraph) => void },
      'runGraph'
    ).mockImplementation(() => undefined);
    const readText = vi.spyOn(resourceManager, 'readText');

    await runner.loadAndStartScene('scenes/b.pix3scene');
    await runner.loadAndStartScene('res://scenes/b.pix3scene');

    expect(readText).toHaveBeenNthCalledWith(1, 'res://scenes/b.pix3scene');
    expect(readText).toHaveBeenNthCalledWith(2, 'res://scenes/b.pix3scene');
  });

  it('rejects and never touches runGraph when the target file is missing', async () => {
    const audioService = new AudioService();
    const resourceManager = new InMemoryResourceManager({});
    const { sceneManager, assetLoader } = createRealSceneManager(resourceManager, audioService);
    const runner = new SceneRunner(
      sceneManager,
      createRendererStub(320, 160),
      audioService,
      assetLoader
    );
    const runGraphSpy = vi
      .spyOn(runner as unknown as { runGraph: (g: SceneGraph) => void }, 'runGraph')
      .mockImplementation(() => undefined);

    await expect(runner.loadAndStartScene('scenes/missing.pix3scene')).rejects.toThrow();
    expect(runGraphSpy).not.toHaveBeenCalled();
  });

  it('rejects and never touches runGraph when the target YAML is invalid', async () => {
    const audioService = new AudioService();
    const resourceManager = new InMemoryResourceManager({
      'scenes/bad.pix3scene': 'root:\n  - : : not valid yaml : :\n',
    });
    const { sceneManager, assetLoader } = createRealSceneManager(resourceManager, audioService);
    const runner = new SceneRunner(
      sceneManager,
      createRendererStub(320, 160),
      audioService,
      assetLoader
    );
    const runGraphSpy = vi
      .spyOn(runner as unknown as { runGraph: (g: SceneGraph) => void }, 'runGraph')
      .mockImplementation(() => undefined);

    await expect(runner.loadAndStartScene('scenes/bad.pix3scene')).rejects.toThrow();
    expect(runGraphSpy).not.toHaveBeenCalled();
  });
});
