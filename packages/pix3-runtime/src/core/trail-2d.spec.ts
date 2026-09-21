import { describe, expect, it } from 'vitest';
import type { BufferGeometry, Mesh } from 'three';

import { SceneService, type SceneServiceDelegate } from './SceneService';
import { GameTime } from './GameTime';
import { InputService } from './InputService';
import { Trail2D } from './trail-2d';
import { NodeBase } from '../nodes/NodeBase';
import { Group2D } from '../nodes/2D/Group2D';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import { LAYER_2D } from '../constants';
import type { AudioService } from './AudioService';
import type { AssetLoader } from './AssetLoader';
import type { ResourceManager } from './ResourceManager';

interface Harness {
  service: SceneService;
  root: Group2D;
  ball: Sprite2D;
  /** Advance every root a frame at a time, draining queueFree like the SceneRunner does. */
  advance(seconds: number, step?: number): void;
  /** Move the ball and tick one frame, so the trail samples a new position. */
  moveAndTick(dx: number, dy: number, step?: number): void;
}

function makeHarness(): Harness {
  const gameTime = new GameTime();
  const root = new Group2D({ id: 'world', name: 'World' });
  const ball = new Sprite2D({ id: 'ball', name: 'ball' });
  root.adoptChild(ball);
  const roots: NodeBase[] = [root];

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

  const advance = (seconds: number, step = 1 / 60): void => {
    for (let elapsed = 0; elapsed < seconds; elapsed += step) {
      for (const node of roots) {
        node.tick(step);
      }
      NodeBase.flushFreeQueue();
    }
  };

  const moveAndTick = (dx: number, dy: number, step = 1 / 60): void => {
    ball.position.x += dx;
    ball.position.y += dy;
    advance(step, step);
  };

  return { service, root, ball, advance, moveAndTick };
}

/**
 * The node's own visual mesh. `children` is typed `NodeBase[]` but at runtime also
 * holds the plain Object3D visuals a node adds, so the hop through `unknown` is
 * the honest spelling of that.
 */
function trailMesh(trail: Trail2D): Mesh {
  const mesh = trail.children.find(child => !(child instanceof NodeBase));
  expect(mesh).toBeDefined();
  return mesh as unknown as Mesh;
}

describe('scene.juice.trail', () => {
  it('spawns into the target 2D root as a non-pickable overlay mesh', () => {
    const { service, root } = makeHarness();

    const trail = service.juice.trail('ball', { widthPx: 20 });

    expect(trail).toBeInstanceOf(Trail2D);
    // Hosted by the target's top-most 2D ancestor, as the last child (so it paints on top).
    expect(trail!.parent).toBe(root);
    expect(root.children[root.children.length - 1]).toBe(trail);
    expect(trail!.isContainer).toBe(false);

    const mesh = trailMesh(trail!);
    // Node2D.add stamps LAYER_2D so the 2D pass picks it up.
    expect(mesh.layers.isEnabled(LAYER_2D)).toBe(true);
    // The ribbon's vertices are baked per frame, so culling would pop it in and out.
    expect(mesh.frustumCulled).toBe(false);
  });

  it('accumulates points as the target moves and expires the old ones', () => {
    const { service, ball, moveAndTick } = makeHarness();
    const trail = service.juice.trail(ball, { lifeSec: 0.1, maxPoints: 48 })!;

    for (let i = 0; i < 6; i++) {
      moveAndTick(10, 0);
    }
    const grown = trail.pointCount;
    expect(grown).toBeGreaterThanOrEqual(2);
    // Two vertices per point, one strip quad per segment.
    const geometry = trailMesh(trail).geometry as BufferGeometry;
    expect(geometry.drawRange.count).toBe((grown - 1) * 6);

    // Keep moving past `lifeSec`: the history is bounded, not unbounded.
    for (let i = 0; i < 30; i++) {
      moveAndTick(10, 0);
    }
    // 0.1 s of life at 1/60 s per sample = ~6 points, never 36.
    expect(trail.pointCount).toBeLessThanOrEqual(8);
  });

  it('never keeps more than maxPoints, however long it runs', () => {
    const { service, ball, moveAndTick } = makeHarness();
    const trail = service.juice.trail(ball, { lifeSec: 10, maxPoints: 5 })!;

    for (let i = 0; i < 40; i++) {
      moveAndTick(3, 1);
    }

    expect(trail.pointCount).toBe(5);
  });

  it('stop() lets the ribbon fade, then frees the node', () => {
    const { service, ball, advance, moveAndTick } = makeHarness();
    const trail = service.juice.trail(ball, { lifeSec: 0.2 })!;

    for (let i = 0; i < 6; i++) {
      moveAndTick(10, 0);
    }
    expect(trail.pointCount).toBeGreaterThan(0);

    trail.stop();
    expect(trail.isFollowing).toBe(false);
    // Still on screen right after stop — a trail must not vanish mid-air.
    expect(trail.parent).not.toBeNull();

    advance(0.3);
    expect(trail.pointCount).toBe(0);
    expect(trail.parent).toBeNull();
    expect(trail.isDisposed).toBe(true);
  });

  it('freeing the target stops the trail, which then frees itself', () => {
    const { service, ball, advance, moveAndTick } = makeHarness();
    const trail = service.juice.trail(ball, { lifeSec: 0.15 })!;

    for (let i = 0; i < 4; i++) {
      moveAndTick(12, 4);
    }

    ball.queueFree();
    NodeBase.flushFreeQueue();
    expect(ball.isDisposed).toBe(true);

    // One tick to notice, then the fade-out.
    advance(1 / 60);
    expect(trail.isFollowing).toBe(false);

    advance(0.3);
    expect(trail.isDisposed).toBe(true);
  });

  it('returns null for a target that cannot be resolved', () => {
    const { service } = makeHarness();
    expect(service.juice.trail('no-such-node')).toBeNull();
  });
});
