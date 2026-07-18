import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGameDebug } from '@pix3/runtime';
import { appState } from '@/state';
import { clearErrors } from '@/core/agent-introspection';
import { GameInputService, type GameInputStep } from './GameInputService';

interface FakeChild {
  uuid: string;
  visible: boolean;
  getWorldPosition(target: { set(x: number, y: number, z: number): unknown }): {
    x: number;
    y: number;
    z: number;
  };
}

interface FakeLiveNode {
  nodeId: string;
  name: string;
  type: string;
  visible: boolean;
  position: { x: number; y: number; z: number };
  rotation: { z: number };
  children: FakeChild[];
  getWorldPosition(target: { set(x: number, y: number, z: number): unknown }): {
    x: number;
    y: number;
    z: number;
  };
}

let childSeq = 0;
const makeChild = (over: Partial<FakeChild> = {}): FakeChild => ({
  uuid: `child-${++childSeq}`,
  visible: true,
  getWorldPosition(target) {
    target.set(0, 0, 0);
    return { x: 0, y: 0, z: 0 };
  },
  ...over,
});

const makeLiveNode = (over: Partial<FakeLiveNode> = {}): FakeLiveNode => {
  const node: FakeLiveNode = {
    nodeId: 'player-1',
    name: 'Player',
    type: 'Sprite2D',
    visible: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { z: 0 },
    children: [],
    getWorldPosition(target) {
      target.set(node.position.x, node.position.y, node.position.z);
      return { x: node.position.x, y: node.position.y, z: node.position.z };
    },
    ...over,
  };
  return node;
};

/** NodeBase instanceof checks in the service are bypassed via nodeId/name lookups on the fake runner. */
const makeRuntime = (nodes: FakeLiveNode[]) => {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 540;
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    value: () => ({ left: 100, top: 50, width: 480, height: 270, right: 580, bottom: 320 }),
  });
  document.body.appendChild(canvas);
  const runner = {
    paused: false,
    getLiveNodeById: (id: string) => nodes.find(n => n.nodeId === id) ?? null,
    findLiveNodeByName: (name: string) =>
      nodes.find(n => n.name.toLowerCase() === name.toLowerCase()) ?? null,
    getLiveRootNodes: () => nodes,
    // Project world (x, y) with the plain logical mapping of a 1920x1080 view onto the 960x540 backing store.
    projectWorldPointToCanvas: (x: number, y: number) => ({
      x: ((x + 960) / 1920) * 960,
      y: ((540 - y) / 1080) * 540,
    }),
    projectNodeToCanvas: (node: FakeLiveNode) => ({
      x: ((node.position.x + 960) / 1920) * 960,
      y: ((540 - node.position.y) / 1080) * 540,
    }),
  };
  return { runner, canvas, windowRef: window };
};

const buildService = (runtime: ReturnType<typeof makeRuntime> | null) => {
  const setFocusPauseSuppressed = vi.fn();
  const service = new GameInputService();
  Object.defineProperty(service, 'playSession', {
    value: { getActiveRuntime: () => runtime, setFocusPauseSuppressed },
    configurable: true,
  });
  return { service, setFocusPauseSuppressed };
};

describe('GameInputService', () => {
  beforeEach(() => {
    clearErrors();
    appState.ui.isPlaying = true;
  });

  afterEach(() => {
    appState.ui.isPlaying = false;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('refuses to run when the game is not playing', async () => {
    appState.ui.isPlaying = false;
    const { service } = buildService(null);
    const result = await service.run([{ type: 'key', code: 'KeyW', ms: 10 }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/play_start/);
  });

  it('holds a key for the requested duration and reports observed movement', async () => {
    const player = makeLiveNode();
    const runtime = makeRuntime([player]);
    const { service, setFocusPauseSuppressed } = buildService(runtime);

    const downs: string[] = [];
    const ups: string[] = [];
    const onDown = (e: Event) => downs.push((e as KeyboardEvent).code);
    const onUp = (e: Event) => ups.push((e as KeyboardEvent).code);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);

    // Simulate gameplay: the node moves while the key is held.
    const mover = setInterval(() => {
      player.position.x += 5;
    }, 5);

    const result = await service.run([{ type: 'key', code: 'ArrowUp', ms: 60 }], {
      observe: ['Player'],
      settleMs: 0,
    });

    clearInterval(mover);
    window.removeEventListener('keydown', onDown);
    window.removeEventListener('keyup', onUp);

    expect(result.ok).toBe(true);
    expect(downs).toEqual(['ArrowUp']);
    expect(ups).toEqual(['ArrowUp']);
    expect(result.observed?.Player.moved).toBe(true);
    expect(result.observed?.Player.delta!.x).toBeGreaterThan(0);
    // Focus pause must be suppressed for the run and restored afterwards.
    expect(setFocusPauseSuppressed).toHaveBeenNthCalledWith(1, true);
    expect(setFocusPauseSuppressed).toHaveBeenLastCalledWith(false);
  });

  it('taps a node by name: pointerdown/up land at its projected client position', async () => {
    const button = makeLiveNode({
      nodeId: 'btn-1',
      name: 'PlayButton',
      position: { x: 0, y: 0, z: 0 },
    });
    const runtime = makeRuntime([button]);
    const { service } = buildService(runtime);

    const events: Array<{ type: string; x: number; y: number }> = [];
    const record = (e: Event) => {
      const p = e as PointerEvent;
      events.push({ type: e.type, x: p.clientX, y: p.clientY });
    };
    runtime.canvas.addEventListener('pointerdown', record);
    runtime.canvas.addEventListener('pointerup', record);

    const result = await service.run([{ type: 'tap', target: 'PlayButton', holdMs: 20 }]);

    expect(result.ok).toBe(true);
    expect(events.map(e => e.type)).toEqual(['pointerdown', 'pointerup']);
    // Node at world (0,0) → backing (480, 270) → client: rect.left + 480/960*480 = 340, rect.top + 270/540*270 = 185.
    expect(events[0].x).toBeCloseTo(340, 3);
    expect(events[0].y).toBeCloseTo(185, 3);
  });

  it('names the missing node when a tap target is not found', async () => {
    const runtime = makeRuntime([makeLiveNode()]);
    const { service } = buildService(runtime);
    const result = await service.run([{ type: 'tap', target: 'Ghost' }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Ghost/);
  });

  it('rejects a script exceeding the total-duration cap without dispatching anything', async () => {
    const runtime = makeRuntime([makeLiveNode()]);
    const { service, setFocusPauseSuppressed } = buildService(runtime);
    const steps: GameInputStep[] = [{ type: 'wait', ms: 20_000 }];
    const result = await service.run(steps);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cap/);
    expect(setFocusPauseSuppressed).not.toHaveBeenCalled();
  });

  it('observe() samples twice and reports per-node motion', async () => {
    const car = makeLiveNode({ nodeId: 'car-1', name: 'AICar' });
    const rock = makeLiveNode({ nodeId: 'rock-1', name: 'Rock', position: { x: 9, y: 9, z: 0 } });
    const runtime = makeRuntime([car, rock]);
    const { service } = buildService(runtime);

    const mover = setInterval(() => {
      car.position.y += 4;
    }, 5);
    const result = await service.observe(['AICar', 'Rock'], 50);
    clearInterval(mover);

    expect(result.ok).toBe(true);
    expect(result.movement?.AICar.moved).toBe(true);
    expect(result.movement?.Rock.moved).toBe(false);
  });

  it('observe() explains a null snapshot: wrong name vs still warming up', async () => {
    // Live nodes exist, but the queried name is wrong → point at scene_tree.
    const present = buildService(makeRuntime([makeLiveNode()])).service;
    const wrongName = await present.observe(['Ghost'], 0);
    expect(wrongName.nodes?.Ghost).toBeNull();
    expect(wrongName.hint).toMatch(/scene_tree/);

    // No live nodes yet (play mode just started) → tell it to wait and retry.
    const empty = buildService(makeRuntime([])).service;
    const warming = await empty.observe(['Player'], 0);
    expect(warming.nodes?.Player).toBeNull();
    expect(warming.hint).toMatch(/warming up/i);
  });

  it('observe() without playing directs to play_start', async () => {
    appState.ui.isPlaying = false;
    const { service } = buildService(null);
    const result = await service.observe([]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/play_start/);
  });

  it('reports travel direction relative to the node facing (forward vs sideways)', async () => {
    // Nose = local +Y (rotation 0), and the node moves +Y → straight forward.
    const fwd = makeLiveNode({ rotation: { z: 0 } });
    const runtimeF = makeRuntime([fwd]);
    const moverF = setInterval(() => {
      fwd.position.y += 5;
    }, 5);
    const forward = await buildService(runtimeF).service.run(
      [{ type: 'key', code: 'KeyW', ms: 60 }],
      {
        observe: ['Player'],
        settleMs: 0,
      }
    );
    clearInterval(moverF);
    expect(forward.observed?.Player.moved).toBe(true);
    expect(forward.observed?.Player.alignForward!).toBeGreaterThan(0.9);
    expect(Math.abs(forward.observed?.Player.alignRight!)).toBeLessThan(0.1);

    // Same facing (rotation 0) but the node slides +X → sideways across the body.
    const side = makeLiveNode({ rotation: { z: 0 } });
    const runtimeS = makeRuntime([side]);
    const moverS = setInterval(() => {
      side.position.x += 5;
    }, 5);
    const sideways = await buildService(runtimeS).service.run(
      [{ type: 'key', code: 'KeyD', ms: 60 }],
      {
        observe: ['Player'],
        settleMs: 0,
      }
    );
    clearInterval(moverS);
    expect(Math.abs(sideways.observed?.Player.alignForward!)).toBeLessThan(0.1);
    expect(Math.abs(sideways.observed?.Player.alignRight!)).toBeGreaterThan(0.9);
  });

  it('expect: "forward" verdict passes along the nose and fails when sliding sideways', async () => {
    const good = makeLiveNode({ rotation: { z: 0 } });
    const runtimeG = makeRuntime([good]);
    const moverG = setInterval(() => {
      good.position.y += 5;
    }, 5);
    const passed = await buildService(runtimeG).service.run(
      [{ type: 'key', code: 'KeyW', ms: 60 }],
      {
        expect: { Player: 'forward' },
        settleMs: 0,
      }
    );
    clearInterval(moverG);
    expect(passed.observed?.Player.directionOk).toBe(true);

    const bad = makeLiveNode({ rotation: { z: 0 } });
    const runtimeB = makeRuntime([bad]);
    const moverB = setInterval(() => {
      bad.position.x += 5;
    }, 5);
    const failed = await buildService(runtimeB).service.run(
      [{ type: 'key', code: 'KeyD', ms: 60 }],
      {
        expect: { Player: 'forward' },
        settleMs: 0,
      }
    );
    clearInterval(moverB);
    expect(failed.observed?.Player.directionOk).toBe(false);
    expect(failed.observed?.Player.directionNote).toMatch(/forward alignment/);
  });

  it('recognises a spawner reacting even though its container never moves', async () => {
    // The motivating failure: a shot container stays at (0,0) — moved:false — but children spawn.
    const spawner = makeLiveNode({ nodeId: 'pool-1', name: 'Cannonballs', children: [] });
    const runtime = makeRuntime([spawner]);
    const { service } = buildService(runtime);

    // A cannonball appears while the input window is open, and stays.
    setTimeout(() => spawner.children.push(makeChild({ uuid: 'ball-1', visible: true })), 20);

    const result = await service.run([{ type: 'wait', ms: 60 }], {
      expect: { Cannonballs: 'activity' },
      settleMs: 20,
    });

    expect(result.observed?.Cannonballs.moved).toBe(false);
    expect(result.observed?.Cannonballs.childrenChanged).toBe(true);
    expect(result.observed?.Cannonballs.directionOk).toBe(true);
    expect(result.verdict).toMatch(/GAMEPLAY REACTED/);
  });

  it('auto-includes the game debug provider snapshot and diffs its state', async () => {
    let score = 0;
    const dispose = registerGameDebug({
      name: 'testgame',
      snapshot: () => ({ score: (score += 10), wave: 1 }),
    });
    try {
      const runtime = makeRuntime([makeLiveNode()]);
      const { service } = buildService(runtime);
      const result = await service.run([{ type: 'wait', ms: 10 }], { settleMs: 0 });

      expect(result.game?.provider).toBe('testgame');
      expect(result.game?.changed?.score).toEqual([10, 20]);
      expect(result.game?.changed?.wave).toBeUndefined(); // unchanged fields are omitted
      expect(result.verdict).toMatch(/GAMEPLAY REACTED/);
    } finally {
      dispose();
    }
  });

  it('verdict says NO ACTIVITY when a watched node does nothing', async () => {
    const idle = makeLiveNode({ name: 'Idle' });
    const runtime = makeRuntime([idle]);
    const { service } = buildService(runtime);

    const result = await service.run([{ type: 'wait', ms: 20 }], {
      observe: ['Idle'],
      settleMs: 0,
    });

    expect(result.observed?.Idle.moved).toBe(false);
    expect(result.observed?.Idle.after?.childCount).toBe(0);
    expect(result.verdict).toMatch(/NO ACTIVITY/);
  });
});
