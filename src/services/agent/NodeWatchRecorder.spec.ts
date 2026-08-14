import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import {
  NodeWatchRecorder,
  type WatchChildLike,
  type WatchFrameSource,
  type WatchNodeLike,
} from './NodeWatchRecorder';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface FakeChild extends WatchChildLike {
  uuid: string;
  visible: boolean;
  wx: number;
  wy: number;
}

const makeChild = (over: Partial<FakeChild> = {}): FakeChild => {
  const child: FakeChild = {
    uuid: 'child',
    visible: true,
    wx: 0,
    wy: 0,
    getWorldPosition(target: Vector3) {
      target.set(child.wx, child.wy, 0);
      return { x: child.wx, y: child.wy, z: 0 };
    },
    ...over,
  };
  return child;
};

/** Fake node with a tiny EventDispatcher so childadded/childremoved fire exactly like three. */
class FakeNode implements WatchNodeLike {
  nodeId: string;
  visible = true;
  wx = 0;
  wy = 0;
  scale?: { x: number; y: number; z: number };
  opacity?: number;
  children: FakeChild[] = [];
  components: unknown[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(nodeId: string, children: FakeChild[] = []) {
    this.nodeId = nodeId;
    this.children = children;
  }

  getWorldPosition(target: Vector3): { x: number; y: number; z: number } {
    target.set(this.wx, this.wy, 0);
    return { x: this.wx, y: this.wy, z: 0 };
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  addChild(child: FakeChild): void {
    this.children.push(child);
    this.dispatch('childadded', child);
  }

  removeChild(child: FakeChild): void {
    this.children = this.children.filter(c => c !== child);
    this.dispatch('childremoved', child);
  }

  private dispatch(type: string, child: FakeChild): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, child });
  }
}

/**
 * A `SceneRunner`-shaped frame hook: `tick()` drives one logic tick, exactly as
 * the runner's per-frame listener dispatch does.
 */
class FakeFrameSource implements WatchFrameSource {
  private readonly listeners = new Set<(sample: { frameNumber: number }) => void>();
  private frameNumber = 0;
  subscribed = 0;
  unsubscribed = 0;

  subscribeFrameStats(listener: (sample: { frameNumber: number }) => void): () => void {
    this.listeners.add(listener);
    this.subscribed += 1;
    return () => {
      this.listeners.delete(listener);
      this.unsubscribed += 1;
    };
  }

  tick(count = 1): void {
    for (let i = 0; i < count; i++) {
      this.frameNumber += 1;
      for (const listener of this.listeners) listener({ frameNumber: this.frameNumber });
    }
  }
}

/** Timer-driven recorder (no frame source) — the degraded path. */
const recorderFor = (node: WatchNodeLike, queries: string[], idlePollMs = 10_000) =>
  new NodeWatchRecorder(query => (queries.includes(query) ? node : null), queries, { idlePollMs });

/** Frame-driven recorder — the normal path against a live runner. */
const frameRecorderFor = (node: WatchNodeLike, queries: string[], frameSource: FakeFrameSource) =>
  new NodeWatchRecorder(query => (queries.includes(query) ? node : null), queries, {
    frameSource,
    // Long enough that the watchdog never fires during a synchronous test.
    idlePollMs: 10_000,
  });

describe('NodeWatchRecorder', () => {
  afterEach(() => vi.useRealTimers());

  it('counts a transient spawn+despawn that leaves both endpoints identical', () => {
    // The motivating bug: a cannonball spawns AND is destroyed inside the window;
    // endpoint child-count (0 -> 0) misses it, exact events do not. Interval never fires.
    const node = new FakeNode('pool');
    const recorder = recorderFor(node, ['pool']);
    recorder.start();
    const ball = makeChild({ uuid: 'ball-1' });
    node.addChild(ball);
    node.removeChild(ball);
    const activity = recorder.stop().get('pool')!;

    expect(activity.spawned).toBe(1);
    expect(activity.removed).toBe(1);
    expect(activity.active).toBe(true);
  });

  it('tracks a projectile pool that recycles by visibility (the container never moves)', async () => {
    // 3 pooled balls, all hidden at rest. Two go "in flight" (visible) mid-window.
    const balls = [
      makeChild({ uuid: 'b1', visible: false }),
      makeChild({ uuid: 'b2', visible: false }),
      makeChild({ uuid: 'b3', visible: false }),
    ];
    const node = new FakeNode('cannonballs', balls);
    const recorder = recorderFor(node, ['cannonballs'], 5);
    recorder.start();
    balls[0].visible = true;
    balls[1].visible = true;
    balls[0].wx = 400; // a ball flies while the container stays at (0,0)
    await sleep(40);
    balls[0].visible = false;
    balls[1].visible = false;
    const activity = recorder.stop().get('cannonballs')!;

    expect(activity.spawned).toBe(0); // no children added/removed — pure recycle
    expect(activity.visibleChildPeak).toBe(2);
    expect(activity.maxChildDistance).toBeGreaterThan(300);
    expect(activity.maxDistanceFromStart).toBe(0); // the container itself never moved
    expect(activity.active).toBe(true);
  });

  it('reports scalar component-state changes over the window', () => {
    const node = new FakeNode('gun');
    node.components = [{ constructor: { name: 'GunController' }, mag: 3, reloading: false }];
    const recorder = recorderFor(node, ['gun']);
    recorder.start();
    (node.components[0] as { mag: number; reloading: boolean }).mag = 0;
    (node.components[0] as { mag: number; reloading: boolean }).reloading = true;
    const activity = recorder.stop().get('gun')!;

    expect(activity.stateChanges?.['GunController.mag']).toEqual([3, 0]);
    expect(activity.stateChanges?.['GunController.reloading']).toEqual([false, true]);
    expect(activity.active).toBe(true);
  });

  it('reports active:false when nothing happened', () => {
    const node = new FakeNode('idle', [makeChild({ uuid: 'static', visible: true })]);
    const recorder = recorderFor(node, ['idle']);
    recorder.start();
    const activity = recorder.stop().get('idle')!;

    expect(activity.spawned).toBe(0);
    expect(activity.removed).toBe(0);
    expect(activity.maxChildDistance).toBe(0);
    expect(activity.active).toBe(false);
  });

  it('registers a scale pulse that fires AND returns to rest inside the window', async () => {
    // A PunchScale/hover-scale that pulses up and settles back — the endpoints alone
    // (1 -> 1) would miss it; the peak metric catches it.
    const node = new FakeNode('button');
    node.scale = { x: 1, y: 1, z: 1 };
    const recorder = recorderFor(node, ['button'], 5);
    recorder.start();
    node.scale = { x: 1.08, y: 1.08, z: 1 };
    await sleep(30);
    node.scale = { x: 1, y: 1, z: 1 }; // back to rest before the window ends
    await sleep(20);
    const activity = recorder.stop().get('button')!;

    expect(activity.maxScaleDelta).toBeGreaterThan(0.05);
    expect(activity.active).toBe(true);
    expect(activity.log?.some(e => e.kind === 'scale')).toBe(true);
  });

  it('captures an opacity dip via opacityRange', async () => {
    const node = new FakeNode('fader');
    node.opacity = 1;
    const recorder = recorderFor(node, ['fader'], 5);
    recorder.start();
    node.opacity = 0.3;
    await sleep(30);
    node.opacity = 1;
    await sleep(20);
    const activity = recorder.stop().get('fader')!;

    expect(activity.opacityRange).toBeDefined();
    expect(activity.opacityRange!.min).toBeLessThanOrEqual(0.3);
    expect(activity.opacityRange!.max).toBeGreaterThanOrEqual(1);
    expect(activity.active).toBe(true);
    expect(activity.log?.some(e => e.kind === 'fade')).toBe(true);
  });

  it('handles a node without scale/opacity fields (fakes stay valid)', () => {
    const node = new FakeNode('plain');
    const recorder = recorderFor(node, ['plain']);
    recorder.start();
    const activity = recorder.stop().get('plain')!;

    expect(activity.maxScaleDelta).toBe(0);
    expect(activity.opacityRange).toBeUndefined();
    expect(activity.active).toBe(false);
  });

  it('caps watched nodes at 8 and reports the overflow', () => {
    const node = new FakeNode('n');
    const queries = Array.from({ length: 11 }, (_, i) => `q${i}`);
    const recorder = new NodeWatchRecorder(() => node, queries);
    expect(recorder.droppedWatchCount).toBe(3);
  });

  describe('frame-driven sampling', () => {
    it('samples every logic tick, catching a peak that lives for one frame', () => {
      // The motivating gap: a bullet visible for a single tick. A 100 ms timer
      // sees it only by luck; the frame hook sees it by construction.
      const frames = new FakeFrameSource();
      const bullet = makeChild({ uuid: 'bullet', visible: false });
      const node = new FakeNode('gun', [bullet]);
      const recorder = frameRecorderFor(node, ['gun'], frames);
      recorder.start();

      frames.tick(3);
      bullet.visible = true;
      bullet.wx = 900;
      frames.tick(1); // the ONE tick the shot exists
      bullet.visible = false;
      bullet.wx = 0;
      frames.tick(3);
      const activity = recorder.stop().get('gun')!;

      expect(recorder.isFrameDriven).toBe(true);
      expect(recorder.framesObserved).toBe(7);
      expect(activity.visibleChildPeak).toBe(1);
      expect(activity.maxChildDistance).toBeGreaterThan(300);
      expect(activity.active).toBe(true);
    });

    it('stamps log entries with the frame the change first showed up on', () => {
      const frames = new FakeFrameSource();
      const node = new FakeNode('button');
      node.scale = { x: 1, y: 1, z: 1 };
      const recorder = frameRecorderFor(node, ['button'], frames);
      recorder.start();

      frames.tick(4);
      node.scale = { x: 1.2, y: 1.2, z: 1 };
      frames.tick(1);
      node.scale = { x: 1, y: 1, z: 1 };
      frames.tick(2);
      const entry = recorder
        .stop()
        .get('button')!
        .log?.find(e => e.kind === 'scale');

      expect(entry?.frame).toBe(5);
    });

    it('collapses repeats of a kind into one counted entry (log stays readable at 60Hz)', () => {
      const frames = new FakeFrameSource();
      const node = new FakeNode('spawner');
      const recorder = frameRecorderFor(node, ['spawner'], frames);
      recorder.start();

      for (let i = 0; i < 40; i++) {
        node.addChild(makeChild({ uuid: `e${i}` }));
        frames.tick(1);
      }
      const activity = recorder.stop().get('spawner')!;
      const spawnEntries = activity.log!.filter(e => e.kind === 'spawn');

      expect(activity.spawned).toBe(40);
      expect(spawnEntries).toHaveLength(1);
      expect(spawnEntries[0].count).toBe(40);
      expect(activity.log!.length).toBeLessThanOrEqual(10);
    });

    it('unsubscribes from the frame hook on stop', () => {
      const frames = new FakeFrameSource();
      const node = new FakeNode('n');
      const recorder = frameRecorderFor(node, ['n'], frames);
      recorder.start();
      frames.tick(2);
      recorder.stop();
      expect(frames.unsubscribed).toBe(1);

      // Ticks after stop must not reach a torn-down recorder.
      node.wx = 500;
      frames.tick(5);
      expect(recorder.framesObserved).toBe(2);
    });

    it('falls back to the timer when the runner exposes no usable frame hook', async () => {
      // Degradation, not failure: a host without subscribeFrameStats (or one
      // whose subscribe throws) still gets the old 100 ms sampling.
      const node = new FakeNode('fader');
      node.opacity = 1;
      const throwingSource = {
        subscribeFrameStats(): () => void {
          throw new Error('no frame hook here');
        },
      };
      const recorder = new NodeWatchRecorder(() => node, ['fader'], {
        frameSource: throwingSource,
        idlePollMs: 5,
      });
      recorder.start();
      node.opacity = 0.2;
      await sleep(30);
      node.opacity = 1;
      const activity = recorder.stop().get('fader')!;

      expect(recorder.isFrameDriven).toBe(false);
      expect(recorder.framesObserved).toBe(0);
      expect(activity.opacityRange!.min).toBeLessThanOrEqual(0.2);
      expect(activity.active).toBe(true);
    });

    it('keeps sampling through a window where the runner never ticks (paused)', async () => {
      // A subscribed but silent runner is the paused case: the watchdog must
      // still produce samples, or a paused-then-changed node reads as inert.
      const frames = new FakeFrameSource();
      const node = new FakeNode('idle');
      node.scale = { x: 1, y: 1, z: 1 };
      const recorder = new NodeWatchRecorder(() => node, ['idle'], {
        frameSource: frames,
        idlePollMs: 5,
      });
      recorder.start();
      node.scale = { x: 2, y: 2, z: 1 };
      await sleep(30);
      node.scale = { x: 1, y: 1, z: 1 };
      const activity = recorder.stop().get('idle')!;

      expect(recorder.framesObserved).toBe(0);
      expect(activity.maxScaleDelta).toBeGreaterThan(0.5);
    });
  });
});
