import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { NodeWatchRecorder, type WatchChildLike, type WatchNodeLike } from './NodeWatchRecorder';

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

const recorderFor = (node: WatchNodeLike, queries: string[], intervalMs = 10_000) =>
  new NodeWatchRecorder(query => (queries.includes(query) ? node : null), queries, intervalMs);

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
});
