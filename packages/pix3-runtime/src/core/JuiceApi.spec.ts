import { describe, expect, it } from 'vitest';
import { Vector2 } from 'three';
import { SceneService, type SceneServiceDelegate } from './SceneService';
import { GameTime } from './GameTime';
import { InputService } from './InputService';
import { Camera3D } from '../nodes/3D/Camera3D';
import { Camera2D } from '../nodes/2D/Camera2D';
import { ShakeBehavior } from '../behaviors/ShakeBehavior';
import type { AudioService } from './AudioService';
import type { AssetLoader } from './AssetLoader';
import type { ResourceManager } from './ResourceManager';

interface Harness {
  service: SceneService;
  camera: Camera3D;
  gameTime: GameTime;
  parent: HTMLDivElement;
}

function makeHarness(): Harness {
  const gameTime = new GameTime();
  const camera = new Camera3D({ id: 'cam', name: 'Camera', projection: 'perspective' });
  const service = new SceneService();

  const delegate: SceneServiceDelegate = {
    getActiveCameraNode: () => camera,
    getActiveCamera2DNode: () => null,
    getInputService: () => new InputService(),
    getUICamera: () => null,
    getLogicalCameraSize: () => ({ width: 1920, height: 1080 }),
    setActiveCameraNode: () => undefined,
    findNodeById: id => (id === camera.nodeId ? camera : null),
    getRootNodes: () => [camera],
    getAudioService: () => null as unknown as AudioService,
    getAssetLoader: () => null as unknown as AssetLoader,
    getResourceManager: () => null as unknown as ResourceManager,
    getECSService: () => null,
    getGameTime: () => gameTime,
    raycastViewport: () => null,
    reportFrameProfilerActivities: () => undefined,
    loadAndStartScene: () => Promise.resolve(),
  };
  service.setDelegate(delegate);

  // Attach a canvas with a parent so the flash overlay can mount.
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  service.attachCanvas(canvas);

  return { service, camera, gameTime, parent };
}

describe('JuiceApi / impact combo (P0.3 acceptance)', () => {
  it('assembles a juicy hit from three calls: hitstop + camera shake + flash', () => {
    const { service, camera, gameTime, parent } = makeHarness();

    // 1) Freeze
    service.time.hitstop(80);
    expect(service.time.isFrozen).toBe(true);

    // 2) Camera shake
    const shake = service.juice.shake('camera', { amplitude: 12, duration: 0.3 });
    expect(shake).toBeInstanceOf(ShakeBehavior);
    expect(camera.getComponent(ShakeBehavior)).toBe(shake);

    // 3) Flash — a colored overlay mounts under the canvas parent at `intensity`.
    service.juice.flash({ intensity: 0.9, durationSec: 0.2 });
    const flashEl = parent.querySelector('div') as HTMLDivElement | null;
    expect(flashEl).not.toBeNull();
    expect(Number(flashEl?.style.opacity)).toBeCloseTo(0.9, 2);

    // The freeze actually zeroes gameplay dt once the frame advances.
    gameTime.advance(0.016);
    expect(gameTime.scale).toBe(0);
  });

  it('reuses one effect component per node across repeated calls', () => {
    const { service, camera } = makeHarness();

    const first = service.juice.shake('camera', { amplitude: 8 });
    const second = service.juice.shake('camera', { amplitude: 20 });

    expect(second).toBe(first);
    expect(camera.components.filter(c => c instanceof ShakeBehavior)).toHaveLength(1);
  });

  it('returns null when the juice target cannot be resolved', () => {
    const { service } = makeHarness();

    expect(service.juice.shake('does-not-exist')).toBeNull();
    expect(service.juice.punchScale('nope')).toBeNull();
  });
});

describe('JuiceApi / 2D camera shake targets', () => {
  function makeService(opts: {
    active3D: Camera3D | null;
    active2D: Camera2D | null;
  }): SceneService {
    const gameTime = new GameTime();
    const service = new SceneService();
    const delegate: SceneServiceDelegate = {
      getActiveCameraNode: () => opts.active3D,
      getActiveCamera2DNode: () => opts.active2D,
      getInputService: () => new InputService(),
      getUICamera: () => null,
      getLogicalCameraSize: () => ({ width: 1920, height: 1080 }),
      setActiveCameraNode: () => undefined,
      findNodeById: () => null,
      getRootNodes: () => [],
      getAudioService: () => null as unknown as AudioService,
      getAssetLoader: () => null as unknown as AssetLoader,
      getResourceManager: () => null as unknown as ResourceManager,
      getECSService: () => null,
      getGameTime: () => gameTime,
      raycastViewport: () => null,
      reportFrameProfilerActivities: () => undefined,
      loadAndStartScene: () => Promise.resolve(),
    };
    service.setDelegate(delegate);
    return service;
  }

  // Camera2D shake is its own additive state (not a ShakeBehavior component), so
  // "did it start?" = a solved offset becomes non-zero.
  function isShaking(cam: Camera2D): boolean {
    cam.solve(0.05);
    const off = cam.getShakeOffset(new Vector2());
    return off.x !== 0 || off.y !== 0;
  }

  it("'camera2d' shakes the active Camera2D and returns null", () => {
    const cam2d = new Camera2D({ id: 'c2', name: 'Cam2D' });
    const service = makeService({ active3D: null, active2D: cam2d });

    const result = service.juice.shake('camera2d', { amplitude: 12, duration: 1 });
    expect(result).toBeNull();
    expect(isShaking(cam2d)).toBe(true);
  });

  it("'camera' falls back to the active Camera2D only when there is no active Camera3D", () => {
    const cam2d = new Camera2D({ id: 'c2', name: 'Cam2D' });
    const service = makeService({ active3D: null, active2D: cam2d });

    const result = service.juice.shake('camera', { amplitude: 12, duration: 1 });
    expect(result).toBeNull();
    expect(isShaking(cam2d)).toBe(true);
  });

  it("'camera' targets the Camera3D (not the Camera2D) when a Camera3D is active", () => {
    const camera3d = new Camera3D({ id: 'cam', name: 'Camera', projection: 'perspective' });
    const cam2d = new Camera2D({ id: 'c2', name: 'Cam2D' });
    const service = makeService({ active3D: camera3d, active2D: cam2d });

    const result = service.juice.shake('camera', { amplitude: 12, duration: 1 });
    expect(result).toBeInstanceOf(ShakeBehavior);
    expect(camera3d.getComponent(ShakeBehavior)).toBe(result);
    expect(isShaking(cam2d)).toBe(false);
  });

  it("'camera2d' returns null when no Camera2D is active", () => {
    const service = makeService({ active3D: null, active2D: null });
    expect(service.juice.shake('camera2d')).toBeNull();
  });
});
