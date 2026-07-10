import { describe, expect, it } from 'vitest';
import { SceneService, type SceneServiceDelegate } from './SceneService';
import { GameTime } from './GameTime';
import { Camera3D } from '../nodes/3D/Camera3D';
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
