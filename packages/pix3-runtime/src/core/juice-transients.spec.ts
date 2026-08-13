import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Material, Mesh, Object3D } from 'three';

import { SceneService, type SceneServiceDelegate } from './SceneService';
import { GameTime } from './GameTime';
import { InputService } from './InputService';
import { BURST_MAX_PARTICLES, FloatText2D, ParticleBurst2D } from './juice-transients';
import { NodeBase } from '../nodes/NodeBase';
import { Group2D } from '../nodes/2D/Group2D';
import { CanvasLayer2D } from '../nodes/2D/CanvasLayer2D';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { LAYER_2D } from '../constants';
import type { AudioService } from './AudioService';
import type { AssetLoader } from './AssetLoader';
import type { ResourceManager } from './ResourceManager';

interface Harness {
  service: SceneService;
  root: Group2D;
  hud: CanvasLayer2D;
  target: Sprite2D;
}

function makeHarness(): Harness {
  const gameTime = new GameTime();
  const root = new Group2D({ id: 'world', name: 'World' });
  const target = new Sprite2D({ id: 'bumper', name: 'bumper' });
  target.position.set(120, -40, 0);
  root.adoptChild(target);
  const hud = new CanvasLayer2D({ id: 'hud', name: 'HUD' });
  const roots: NodeBase[] = [root, hud];

  const service = new SceneService();
  const delegate: SceneServiceDelegate = {
    getActiveCameraNode: () => null,
    getActiveCamera2DNode: () => null,
    getInputService: () => new InputService(),
    getUICamera: () => null,
    getLogicalCameraSize: () => ({ width: 1080, height: 1920 }),
    setActiveCameraNode: () => undefined,
    findNodeById: id => roots.map(node => node.findById(id)).find(Boolean) ?? null,
    getRootNodes: () => roots,
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

  return { service, root, hud, target };
}

/** Advance every root a frame at a time, draining queueFree like the SceneRunner does. */
function advance(roots: NodeBase[], seconds: number, step = 1 / 60): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    for (const root of roots) {
      root.tick(step);
    }
    NodeBase.flushFreeQueue();
  }
}

describe('scene.juice.burst', () => {
  it('spawns into the 2D tree at the target position and frees itself when the particles die', () => {
    const { service, root } = makeHarness();

    // Resolved by node NAME — the same query form a script would use.
    const burst = service.juice.burst('bumper', { lifeSec: 0.2, count: 6 });

    expect(burst).toBeInstanceOf(ParticleBurst2D);
    // Hosted by the target's top-most 2D ancestor (so it outlives the target and
    // paints above the root's content as the last child), positioned on the target.
    expect(burst!.parent).toBe(root);
    expect(root.children[root.children.length - 1]).toBe(burst);
    expect(burst!.position.x).toBeCloseTo(120, 6);
    expect(burst!.position.y).toBeCloseTo(-40, 6);
    // 2D pass invariants: on the 2D layer, no depth test (paint order only).
    // `children` is declared NodeBase[] but also holds the node's plain visual meshes.
    const visuals = burst!.children as unknown as Object3D[];
    const mesh = visuals.find(child => !(child instanceof NodeBase)) as Mesh | undefined;
    expect(mesh).toBeDefined();
    expect(mesh!.layers.isEnabled(LAYER_2D)).toBe(true);
    const material = mesh!.material as Material;
    expect(material.depthTest).toBe(false);
    expect(material.transparent).toBe(true);

    // Longest particle lives 1.3× lifeSec; a second of frames buries that.
    advance([root], 1);

    expect(burst!.aliveCount).toBe(0);
    expect(root.children).not.toContain(burst);
  });

  it('clamps the options instead of trusting them', () => {
    const { service } = makeHarness();

    const huge = service.juice.burst('bumper', { count: 100000 });
    expect(huge!.particleCount).toBe(BURST_MAX_PARTICLES);

    const tiny = service.juice.burst('bumper', { count: -5 });
    expect(tiny!.particleCount).toBe(1);

    const garbage = service.juice.burst('bumper', {
      count: Number.NaN,
      lifeSec: Number.NaN,
      speed: Number.POSITIVE_INFINITY,
    });
    // Non-finite input falls back to the defaults rather than producing NaN geometry.
    expect(garbage!.particleCount).toBe(14);
    const positions = (
      garbage as unknown as {
        positionAttribute: { array: Float32Array };
      }
    ).positionAttribute.array;
    expect(Array.from(positions).every(value => Number.isFinite(value))).toBe(true);
  });

  it('moves the particles along the requested cone and applies gravity', () => {
    const { service, root } = makeHarness();

    // A degenerate cone (spread 0, direction 0) makes the motion predictable:
    // every particle flies along +X at 55–100% of `speed`.
    const burst = service.juice.burst(
      { x: 0, y: 0 },
      { spread: 0, direction: 0, speed: 1000, gravityY: -2000, count: 8, lifeSec: 5 }
    )!;

    const centers = (): { x: number; y: number }[] => {
      const array = (burst as unknown as { positionAttribute: { array: Float32Array } })
        .positionAttribute.array;
      const result: { x: number; y: number }[] = [];
      for (let i = 0; i < burst.particleCount; i++) {
        let x = 0;
        let y = 0;
        for (let corner = 0; corner < 4; corner++) {
          x += array[(i * 4 + corner) * 3];
          y += array[(i * 4 + corner) * 3 + 1];
        }
        result.push({ x: x / 4, y: y / 4 });
      }
      return result;
    };

    expect(centers().every(p => p.x === 0 && p.y === 0)).toBe(true);

    advance([root], 0.1, 0.05); // two 50 ms frames

    for (const point of centers()) {
      // 0.1 s at 550–1000 px/s along +X.
      expect(point.x).toBeGreaterThan(50);
      expect(point.x).toBeLessThan(101);
      // Gravity is the only vertical force, and it pulls down.
      expect(point.y).toBeLessThan(0);
    }
  });

  it('accepts a raw 2D world point and keeps the effect out of the HUD band', () => {
    const { service, root, hud } = makeHarness();

    const burst = service.juice.burst({ x: -200, y: 300 });

    // No anchor node → the last non-CanvasLayer2D root (game content, so it blooms).
    expect(burst!.parent).toBe(root);
    expect(hud.children).toHaveLength(0);
    expect(burst!.position.x).toBeCloseTo(-200, 6);
    expect(burst!.position.y).toBeCloseTo(300, 6);
  });

  it('keeps a HUD-anchored burst inside the overlay band', () => {
    const { service, hud } = makeHarness();
    const chip = new Sprite2D({ id: 'score-chip', name: 'score-chip' });
    hud.adoptChild(chip);

    const burst = service.juice.burst(chip);

    expect(burst!.parent).toBe(hud);
  });

  it('returns null for an unresolvable target', () => {
    const { service } = makeHarness();
    expect(service.juice.burst('does-not-exist')).toBeNull();
  });
});

describe('scene.juice.floatText', () => {
  // happy-dom has no canvas 2D context, so Label2D text layout needs a stub.
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeAll(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function stub(kind: string) {
      if (kind !== '2d') {
        return null;
      }
      return {
        setTransform: () => {},
        scale: () => {},
        fillRect: () => {},
        fillText: () => {},
        strokeText: () => {},
        clearRect: () => {},
        save: () => {},
        restore: () => {},
        measureText: (text: string) => ({ width: text.length * 8 }),
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 0,
        shadowColor: '',
        shadowBlur: 0,
        font: '',
        textAlign: 'center',
        textBaseline: 'middle',
      } as unknown as CanvasRenderingContext2D;
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it('rises, fades and frees itself with the default options', () => {
    const { service, root, target } = makeHarness();

    const popup = service.juice.floatText('+100', { at: target });

    expect(popup).toBeInstanceOf(FloatText2D);
    expect(popup!.parent).toBe(root);
    expect(popup!.getDisplayText()).toBe('+100');
    expect(popup!.position.y).toBeCloseTo(-40, 6);

    // Half the default 0.8 s life: risen part-way, still fully opaque or fading.
    advance([root], 0.4);
    expect(popup!.position.y).toBeGreaterThan(-40);
    expect(root.children).toContain(popup);

    advance([root], 0.6);
    expect(root.children).not.toContain(popup);
  });

  it('never participates in picking', () => {
    const { service, target } = makeHarness();
    const popup = service.juice.floatText('MISS', { at: target })!;
    expect(popup.isPointInBounds()).toBe(false);
  });

  it('applies the style options and pads the canvas for the glow', () => {
    const { service } = makeHarness();

    const plain = service.juice.floatText('+1', { fontSizePx: 40 })!;
    const glowing = service.juice.floatText('+1', {
      fontSizePx: 40,
      color: '#ffcf33',
      glow: true,
      glowStrength: 3,
    })!;

    expect(glowing.labelColor).toBe('#ffcf33');
    expect(glowing.glowColor).toBe('#ffcf33');
    expect(glowing.glowStrength).toBe(3);
    expect(plain.glowStrength).toBe(0);
    // The glow bleed grows the label box so the blur is not clipped.
    const boxOf = (label: FloatText2D): number =>
      (label as unknown as { renderState: { boxWidth: number } | null }).renderState?.boxWidth ?? 0;
    expect(boxOf(glowing)).toBeGreaterThan(boxOf(plain));
  });

  it('drops an empty string and an unresolvable anchor', () => {
    const { service } = makeHarness();
    expect(service.juice.floatText('')).toBeNull();
    expect(service.juice.floatText('+1', { at: 'nope' })).toBeNull();
  });
});
