import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGameDebug } from '@pix3/runtime';
import { appState } from '@/state';
import { clearErrors } from '@/core/agent-introspection';
import { GameInputService, type GameInputStep } from './GameInputService';
import {
  InMemoryReachabilityStore,
  REACHABILITY_JOURNAL_VERSION,
  type ReachabilityStore,
} from './reachability-journal';

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
  scale: { x: number; y: number; z: number };
  opacity?: number;
  /** Ancestor chain, walked to decide whether the node is actually on screen. */
  parent?: { visible: boolean; name: string; parent?: unknown } | null;
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
    scale: { x: 1, y: 1, z: 1 },
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
    findLiveNodesByName: (name: string, limit = Number.POSITIVE_INFINITY) =>
      nodes.filter(n => n.name.toLowerCase() === name.toLowerCase()).slice(0, limit),
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

const buildService = (
  runtime: ReturnType<typeof makeRuntime> | null,
  store: ReachabilityStore = new InMemoryReachabilityStore()
) => {
  const setFocusPauseSuppressed = vi.fn();
  // Input needs a running game, so a run releases any host-held pause (the one
  // `game_run` leaves on its outcome frame) before it starts sending events.
  const setPauseRequested = vi.fn();
  const service = new GameInputService();
  Object.defineProperty(service, 'playSession', {
    value: { getActiveRuntime: () => runtime, setFocusPauseSuppressed, setPauseRequested },
    configurable: true,
  });
  // Every service in a spec journals into memory, never into a project on disk.
  service.setReachabilityStore(store);
  return { service, setFocusPauseSuppressed, setPauseRequested, store };
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

  it('flags a tap target whose name matches more than one live node', async () => {
    // The exact shape an agent leaves behind: an abandoned scratch node reusing a real node's
    // name. Both ids are generated, so the name is all the caller has to go on.
    const real = makeLiveNode({
      nodeId: 'button2d-111',
      name: 'Cell',
      position: { x: 0, y: 0, z: 0 },
    });
    const stray = makeLiveNode({
      nodeId: 'button2d-222',
      name: 'Cell',
      position: { x: 200, y: 0, z: 0 },
    });
    const runtime = makeRuntime([real, stray]);
    const { service } = buildService(runtime);

    const result = await service.run([{ type: 'tap', target: 'Cell', holdMs: 20 }]);

    expect(result.ok).toBe(true);
    expect(result.ambiguousTargets).toEqual(['Cell']);
  });

  describe('scene swaps', () => {
    /**
     * A tap that navigates: the live roots are replaced mid-window, exactly as
     * `SceneRunner.runGraph` does on `changeScene`. Verified live in the editor first — tapping
     * "Menu Button" in the tic-tac-toe prototype swapped the roots Game Root → Menu Root.
     */
    const runtimeThatNavigatesOnTap = () => {
      const button = makeLiveNode({ nodeId: 'menu-button', name: 'Menu Button' });
      const roots = [button];
      const runtime = makeRuntime(roots);
      window.addEventListener(
        'pointerdown',
        () => {
          roots.splice(0, roots.length, makeLiveNode({ nodeId: 'menu-root', name: 'Menu Root' }));
        },
        { once: true }
      );
      return runtime;
    };

    it('reports SCENE CHANGED rather than NO ACTIVITY when the input navigates away', async () => {
      const { service } = buildService(runtimeThatNavigatesOnTap());

      const result = await service.run([{ type: 'tap', target: 'Menu Button', holdMs: 20 }], {
        observe: ['Menu Button'],
      });

      expect(result.ok).toBe(true);
      expect(result.sceneChanged).toEqual({
        fromRoots: ['Menu Button'],
        toRoots: ['Menu Root'],
      });
      expect(result.verdict).toMatch(/^SCENE CHANGED/);
      expect(result.verdict).not.toMatch(/NO ACTIVITY/);
    });

    it('produces a verdict on a scene swap even with nothing observed', async () => {
      const { service } = buildService(runtimeThatNavigatesOnTap());

      const result = await service.run([{ type: 'tap', target: 'Menu Button', holdMs: 20 }]);

      expect(result.verdict).toMatch(/^SCENE CHANGED/);
    });

    it('does not cry scene-swap when the same scene keeps running', async () => {
      const runtime = makeRuntime([makeLiveNode({ name: 'Player' })]);
      const { service } = buildService(runtime);

      const result = await service.run([{ type: 'wait', ms: 10 }], { observe: ['Player'] });

      expect(result.sceneChanged).toBeUndefined();
      expect(result.verdict).not.toMatch(/SCENE CHANGED/);
    });
  });

  it('reports a UI control as disabled, which is why its press never registers', async () => {
    // The RETRY button case: the recipe binds the handler and leaves the button disabled until its
    // own game-over path re-enables it. A script that shows the overlay itself skips that, so the
    // button is on screen, the tap is dispatched, and nothing happens — indistinguishable from a
    // broken handler until the snapshot says `enabled: false`.
    const button = makeLiveNode({ nodeId: 'retry-button', name: 'Retry Button', visible: true });
    Object.assign(button, { enabled: false, isHovering: false, isPressed: false });
    const runtime = makeRuntime([button]);
    const { service } = buildService(runtime);

    const result = await service.run([{ type: 'tap', target: 'Retry Button', holdMs: 20 }], {
      observe: ['Retry Button'],
    });

    expect(result.ok).toBe(true);
    expect(result.observed?.['Retry Button'].after?.control).toEqual({
      enabled: false,
      hovering: false,
      pressed: false,
    });
  });

  it('omits control state for a node that is not a UI control', async () => {
    const runtime = makeRuntime([makeLiveNode({ name: 'Player' })]);
    const { service } = buildService(runtime);

    const result = await service.run([{ type: 'wait', ms: 10 }], { observe: ['Player'] });

    expect(result.observed?.Player.after?.control).toBeUndefined();
  });

  it('does not flag a target resolved by a unique nodeId', async () => {
    const runtime = makeRuntime([
      makeLiveNode({ nodeId: 'cell-0', name: 'Cell', position: { x: 0, y: 0, z: 0 } }),
      makeLiveNode({ nodeId: 'cell-1', name: 'Cell', position: { x: 200, y: 0, z: 0 } }),
    ]);
    const { service } = buildService(runtime);

    const result = await service.run([{ type: 'tap', target: 'cell-0', holdMs: 20 }]);

    expect(result.ok).toBe(true);
    expect(result.ambiguousTargets).toBeUndefined();
  });

  it('refuses to tap a node whose ancestor is hidden, naming the ancestor', async () => {
    // The retry-button shape: the button and label were set visible, the parent overlay was not, so
    // the tap landed in empty space and the turn read it as dead game logic.
    const overlay = { visible: false, name: 'Result Overlay', parent: null };
    const button = makeLiveNode({
      nodeId: 'retry-button',
      name: 'Retry Button',
      visible: true,
      parent: overlay,
    });
    const runtime = makeRuntime([button]);
    const { service } = buildService(runtime);

    const result = await service.run([{ type: 'tap', target: 'Retry Button' }]);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Result Overlay/);
    expect(result.error).toMatch(/cannot reach it|not on screen/i);
  });

  it('refuses to tap a node that is itself invisible', async () => {
    const node = makeLiveNode({ name: 'Hidden', visible: false });
    const runtime = makeRuntime([node]);
    const { service } = buildService(runtime);

    const result = await service.run([{ type: 'tap', target: 'Hidden' }]);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/visible: false/);
  });

  it('reports an off-screen watched node in the verdict instead of plain NO ACTIVITY', async () => {
    const overlay = { visible: false, name: 'Result Overlay', parent: null };
    const label = makeLiveNode({
      nodeId: 'result-label',
      name: 'Result Label',
      visible: true,
      parent: overlay,
    });
    const tappable = makeLiveNode({ nodeId: 'cell-0', name: 'cell-0', visible: true });
    const runtime = makeRuntime([label, tappable]);
    const { service } = buildService(runtime);

    const result = await service.run([{ type: 'tap', target: 'cell-0', holdMs: 20 }], {
      observe: ['Result Label'],
    });

    expect(result.ok).toBe(true);
    expect(result.observed?.['Result Label'].after?.hiddenByAncestor).toBe('Result Overlay');
    expect(result.verdict).toMatch(/NOT ON SCREEN/);
  });

  it('leaves hiddenByAncestor absent when the whole chain is visible', async () => {
    const layer = { visible: true, name: 'HUD', parent: null };
    const node = makeLiveNode({ name: 'Score Label', visible: true, parent: layer });
    const runtime = makeRuntime([node]);
    const { service } = buildService(runtime);

    const result = await service.run([{ type: 'wait', ms: 10 }], { observe: ['Score Label'] });

    expect(result.observed?.['Score Label'].after?.hiddenByAncestor).toBeUndefined();
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
    const forwardPlayer = forward.observed?.Player;
    if (!forwardPlayer) {
      throw new Error('expected an observation for Player');
    }

    expect(forwardPlayer.moved).toBe(true);
    expect(forwardPlayer.alignForward!).toBeGreaterThan(0.9);
    expect(Math.abs(forwardPlayer.alignRight!)).toBeLessThan(0.1);

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
    const sidewaysPlayer = sideways.observed?.Player;
    if (!sidewaysPlayer) {
      throw new Error('expected an observation for Player');
    }

    expect(Math.abs(sidewaysPlayer.alignForward!)).toBeLessThan(0.1);
    expect(Math.abs(sidewaysPlayer.alignRight!)).toBeGreaterThan(0.9);
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

  it('snapshot carries scale and delta reports scaled/ratio for a hover-scale', async () => {
    const node = makeLiveNode({ scale: { x: 1, y: 1, z: 1 } });
    const runtime = makeRuntime([node]);
    const { service } = buildService(runtime);

    // Grow the node while the window is open and keep it grown (endpoint reads the new scale).
    const grow = setInterval(() => {
      node.scale = { x: 1.08, y: 1.08, z: 1 };
    }, 5);
    const result = await service.run([{ type: 'wait', ms: 40 }], {
      observe: ['Player'],
      settleMs: 0,
    });
    clearInterval(grow);

    expect(result.observed?.Player.before?.scale).toEqual({ x: 1, y: 1, z: 1 });
    expect(result.observed?.Player.after?.scale.x).toBeCloseTo(1.08, 3);
    expect(result.observed?.Player.scaled).toBe(true);
    expect(result.observed?.Player.scaleDelta?.ratio).toBeCloseTo(1.08, 2);
  });

  it('omits opacity for a plain node that does not expose it', async () => {
    const node = makeLiveNode();
    const runtime = makeRuntime([node]);
    const { service } = buildService(runtime);

    const result = await service.observe(['Player'], 0);
    expect(result.nodes?.Player?.scale).toEqual({ x: 1, y: 1, z: 1 });
    expect(result.nodes?.Player?.opacity).toBeUndefined();
  });

  it('hover dispatches exactly one buttons:0 pointermove (no down/up), default 800ms', async () => {
    const button = makeLiveNode({ nodeId: 'btn', name: 'PlayButton' });
    const runtime = makeRuntime([button]);
    const { service } = buildService(runtime);

    const events: Array<{ type: string; buttons: number }> = [];
    const record = (e: Event) =>
      events.push({ type: e.type, buttons: (e as PointerEvent).buttons });
    runtime.canvas.addEventListener('pointerdown', record);
    runtime.canvas.addEventListener('pointermove', record);
    runtime.canvas.addEventListener('pointerup', record);

    const start = Date.now();
    const result = await service.run([{ type: 'hover', target: 'PlayButton' }], { settleMs: 0 });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    expect(events).toEqual([{ type: 'pointermove', buttons: 0 }]);
    // Default hover hold is 800ms — the call cannot have finished much sooner.
    expect(elapsed).toBeGreaterThanOrEqual(700);
  });

  it('hover + expect activity proves a hover-scale end-to-end', async () => {
    const button = makeLiveNode({ nodeId: 'btn', name: 'PlayButton', scale: { x: 1, y: 1, z: 1 } });
    const runtime = makeRuntime([button]);
    const { service } = buildService(runtime);

    // Simulate a hover-scale: the pointer moving over the canvas grows the node.
    runtime.canvas.addEventListener('pointermove', () => {
      button.scale = { x: 1.08, y: 1.08, z: 1 };
    });

    const result = await service.run([{ type: 'hover', target: 'PlayButton', ms: 60 }], {
      expect: { PlayButton: 'activity' },
      settleMs: 20,
    });

    expect(result.observed?.PlayButton.scaled).toBe(true);
    expect(result.observed?.PlayButton.directionOk).toBe(true);
    expect(result.observed?.PlayButton.activity?.maxScaleDelta).toBeGreaterThan(0.05);
    expect(result.verdict).toMatch(/GAMEPLAY REACTED/);
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

/** A live node carrying the input service the game polls (`NodeBase.input`). */
const withInput = (node: FakeLiveNode, input: unknown): FakeLiveNode =>
  Object.assign(node, { input });

/** Minimal poll-recording input surface, shaped like the runtime's InputService. */
const makeFakeInput = () => {
  let polled: Set<string> | null = null;
  let locked = false;
  return {
    recordingWindows: 0,
    poll(name: string): void {
      polled?.add(name);
    },
    setLocked(value: boolean): void {
      locked = value;
    },
    startPollRecording(): void {
      polled = new Set();
      this.recordingWindows += 1;
    },
    stopPollRecording(): void {
      polled = null;
    },
    takeObservedPolls() {
      const observedPolls = polled ? [...polled] : [];
      polled?.clear();
      return { observedPolls, locked, lockedDuringWindow: locked, truncated: false };
    },
  };
};

describe('GameInputService frame denomination', () => {
  beforeEach(() => {
    clearErrors();
    appState.ui.isPlaying = true;
  });

  afterEach(() => {
    appState.ui.isPlaying = false;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('holds a key for `frames` ticks using the runner tick length, ignoring ms', async () => {
    const runtime = makeRuntime([makeLiveNode()]);
    // 20ms per tick, one tick per animation frame → 10 frames ≈ 200ms.
    Object.assign(runtime.runner, {
      getTimeMode: () => ({ mode: 'fixed', fixedDeltaSec: 0.02, ticksPerFrame: 1 }),
    });
    const { service } = buildService(runtime);

    const downAt: number[] = [];
    const upAt: number[] = [];
    window.addEventListener('keydown', () => downAt.push(Date.now()));
    window.addEventListener('keyup', () => upAt.push(Date.now()));

    const result = await service.run([{ type: 'key', code: 'ArrowLeft', frames: 10, ms: 5000 }], {
      settleMs: 0,
    });

    expect(result.ok).toBe(true);
    const held = upAt[0] - downAt[0];
    expect(held).toBeGreaterThanOrEqual(150);
    expect(held).toBeLessThan(600); // nowhere near the 5000ms `ms` it overrode
  });

  it('speeds the wall clock up with ticksPerFrame — same frames, fewer animation frames', async () => {
    const runtime = makeRuntime([makeLiveNode()]);
    // 60 ticks packed 4-per-frame → 60 ticks cost 15 animation frames of wall clock.
    Object.assign(runtime.runner, {
      getTimeMode: () => ({ mode: 'fixed', fixedDeltaSec: 1 / 60, ticksPerFrame: 4 }),
    });
    const { service } = buildService(runtime);

    const start = Date.now();
    const result = await service.run([{ type: 'wait', frames: 60 }], { settleMs: 0 });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    // 60 ticks at ×1 would be ~1000ms; at ×4 it is ~250ms.
    expect(elapsed).toBeLessThan(700);
  });

  it('falls back to 1/60 when the runner exposes no time contract', async () => {
    const runtime = makeRuntime([makeLiveNode()]); // fake runner has no getTimeMode
    const { service } = buildService(runtime);

    const start = Date.now();
    const result = await service.run([{ type: 'wait', frames: 30 }], { settleMs: 0 });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(350); // 30 / 60 s ≈ 500ms
  });

  it('counts `frames` against the total-duration cap', async () => {
    const runtime = makeRuntime([makeLiveNode()]);
    const { service } = buildService(runtime);

    // 3000 frames at 1/60 s is ~50s — well past the 15s cap, and it must be
    // refused before anything is dispatched rather than run for a minute.
    const result = await service.run([{ type: 'wait', frames: 3000 }], { settleMs: 0 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('too long');
  });

  it('keeps `ms` working as the default denomination', async () => {
    const runtime = makeRuntime([makeLiveNode()]);
    const { service } = buildService(runtime);

    const start = Date.now();
    const result = await service.run([{ type: 'wait', ms: 120 }], { settleMs: 0 });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(500);
  });
});

/**
 * Give a fake runner the per-tick hook the real `SceneRunner` exposes, and a handle
 * to pump ticks from the test. Returns a `stop()` so a pumping window never outlives
 * the test that started it.
 */
const withFrameTicks = (runner: object, intervalMs: number | null) => {
  const listeners = new Set<(sample: { frameNumber: number }) => void>();
  let frameNumber = 0;
  const tick = () => {
    frameNumber += 1;
    for (const listener of [...listeners]) listener({ frameNumber });
  };
  Object.assign(runner, {
    subscribeFrameStats(listener: (sample: { frameNumber: number }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const handle = intervalMs === null ? null : setInterval(tick, intervalMs);
  return { tick, stop: () => (handle === null ? undefined : clearInterval(handle)) };
};

describe('GameInputService observe frame budget', () => {
  beforeEach(() => {
    clearErrors();
    appState.ui.isPlaying = true;
  });

  afterEach(() => {
    appState.ui.isPlaying = false;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('measures the window in ticks, not on the clock', async () => {
    const runtime = makeRuntime([makeLiveNode()]);
    const ticks = withFrameTicks(runtime.runner, 5);
    const { service } = buildService(runtime);

    const result = await service.observe(['Player'], 0, 6);
    ticks.stop();

    expect(result.ok).toBe(true);
    expect(result.frames).toBe(6);
    expect(result.frameBudget).toEqual({ requested: 6, observed: 6, endedBy: 'frames' });
    // 6 ticks at 5ms is ~30ms — nothing like the 100ms a 6-frame budget nominally costs.
    expect(result.sampleMs!).toBeLessThan(100);
  });

  it('lets `frames` win over `sampleMs`', async () => {
    const runtime = makeRuntime([makeLiveNode()]);
    const ticks = withFrameTicks(runtime.runner, 5);
    const { service } = buildService(runtime);

    const start = Date.now();
    const result = await service.observe(['Player'], 3000, 5);
    const elapsed = Date.now() - start;
    ticks.stop();

    expect(result.frames).toBe(5);
    expect(result.frameBudget?.endedBy).toBe('frames');
    expect(elapsed).toBeLessThan(1000); // nowhere near the 3000ms it overrode
  });

  it('does not hang when nothing ticks — with or without a frame hook', async () => {
    // A host that exposes the hook but never fires it (paused runner, manual time mode).
    const silent = makeRuntime([makeLiveNode()]);
    withFrameTicks(silent.runner, null);
    const startSilent = Date.now();
    const stalled = await buildService(silent).service.observe(['Player'], 0, 30);
    const silentElapsed = Date.now() - startSilent;

    expect(stalled.ok).toBe(true);
    expect(stalled.frameBudget?.endedBy).toBe('no-ticks');
    expect(stalled.frameBudget?.observed).toBe(0);
    expect(stalled.hint).toMatch(/degraded/i);
    expect(silentElapsed).toBeLessThan(3000);

    // A host with no per-tick hook at all — the fake runner as it ships.
    const bare = makeRuntime([makeLiveNode()]);
    const startBare = Date.now();
    const degraded = await buildService(bare).service.observe(['Player'], 0, 6);
    const bareElapsed = Date.now() - startBare;

    expect(degraded.ok).toBe(true);
    expect(degraded.frameBudget?.endedBy).toBe('no-ticks');
    expect(degraded.frameBudget?.note).toMatch(/wall clock/i);
    expect(bareElapsed).toBeLessThan(3000);
  });

  it('still ends the window on the duration cap when the runner cannot fill the budget', async () => {
    const runtime = makeRuntime([makeLiveNode()]);
    // Nominal 1ms per tick, so 100 ticks "should" take 100ms — but they arrive at 20ms.
    Object.assign(runtime.runner, {
      getTimeMode: () => ({ mode: 'fixed', fixedDeltaSec: 0.001, ticksPerFrame: 1 }),
    });
    const ticks = withFrameTicks(runtime.runner, 20);
    const { service } = buildService(runtime);

    const start = Date.now();
    const result = await service.observe(['Player'], 0, 100);
    const elapsed = Date.now() - start;
    ticks.stop();

    expect(result.ok).toBe(true);
    expect(result.frameBudget?.endedBy).toBe('cap');
    expect(result.frameBudget?.observed).toBeLessThan(100);
    expect(result.frames!).toBeLessThan(100);
    expect(result.hint).toMatch(/cut short/i);
    expect(elapsed).toBeLessThan(3000);
  });

  it('leaves a plain sampleMs window untouched (no frame budget reported)', async () => {
    const runtime = makeRuntime([makeLiveNode()]);
    const { service } = buildService(runtime);

    const result = await service.observe(['Player'], 30);

    expect(result.ok).toBe(true);
    expect(result.sampleMs).toBe(30);
    expect(result.frameBudget).toBeUndefined();
  });
});

describe('GameInputService observedPolls', () => {
  beforeEach(() => {
    clearErrors();
    appState.ui.isPlaying = true;
  });

  afterEach(() => {
    appState.ui.isPlaying = false;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('reports what the game polled and closes the window afterwards', async () => {
    const input = makeFakeInput();
    const player = withInput(makeLiveNode(), input);
    const runtime = makeRuntime([player]);
    const { service } = buildService(runtime);
    // The game polls its own bindings each tick while the key is held.
    window.addEventListener('keydown', () => {
      input.poll('Key_KeyA');
      input.poll('Key_KeyD');
    });

    const result = await service.run([{ type: 'key', code: 'ArrowLeft', ms: 20 }], {
      settleMs: 0,
      observe: ['Player'],
    });

    expect(result.input?.observedPolls).toEqual(['Key_KeyA', 'Key_KeyD']);
    expect(result.input?.note).toContain('not proof');
    expect(input.recordingWindows).toBe(1);
    // The window is closed again, so a later game tick cannot bleed into it.
    expect(input.takeObservedPolls().observedPolls).toEqual([]);
  });

  it('names the unpolled key in a NO ACTIVITY verdict', async () => {
    const input = makeFakeInput();
    const player = withInput(makeLiveNode(), input);
    const runtime = makeRuntime([player]);
    const { service } = buildService(runtime);
    window.addEventListener('keydown', () => input.poll('Key_KeyA'));

    const result = await service.run([{ type: 'key', code: 'ArrowLeft', ms: 20 }], {
      settleMs: 0,
      observe: ['Player'],
    });

    expect(result.verdict).toContain('NO ACTIVITY');
    expect(result.verdict).toContain('INPUT NOT POLLED');
    expect(result.verdict).toContain('Key_ArrowLeft');
    expect(result.verdict).toContain('Key_KeyA');
  });

  it('calls out an input lock instead of blaming the binding', async () => {
    const input = makeFakeInput();
    input.setLocked(true);
    const player = withInput(makeLiveNode(), input);
    const runtime = makeRuntime([player]);
    const { service } = buildService(runtime);

    const result = await service.run([{ type: 'key', code: 'ArrowLeft', ms: 20 }], {
      settleMs: 0,
      observe: ['Player'],
    });

    expect(result.input?.inputLocked).toBe(true);
    expect(result.verdict).toContain('INPUT LOCKED');
  });

  it('runs unchanged against a runtime whose nodes carry no input service', async () => {
    const runtime = makeRuntime([makeLiveNode()]);
    const { service } = buildService(runtime);

    const result = await service.run([{ type: 'key', code: 'ArrowLeft', ms: 20 }], {
      settleMs: 0,
      observe: ['Player'],
    });

    expect(result.ok).toBe(true);
    expect(result.input).toBeUndefined();
  });
});

/**
 * A live node that offers semantic interactions. `record` collects what was invoked, so a test can
 * tell "the funnel was driven" from "nothing happened" — and the refusal tests can make the runtime
 * answer `false` the way a real gate does.
 */
const makeControl = (
  over: Partial<FakeLiveNode>,
  options: {
    interactions?: Array<{ name: string; description?: string; args?: unknown[] }>;
    enabled?: boolean;
    invoke?: (name: string, args?: Record<string, unknown>) => boolean;
    record?: Array<{ name: string; args?: Record<string, unknown> }>;
  } = {}
): FakeLiveNode => {
  const node = Object.assign(makeLiveNode(over), {
    enabled: options.enabled ?? true,
    isHovering: false,
    isPressed: false,
    getInteractions: () =>
      options.interactions ?? [
        { name: 'hover' },
        { name: 'press' },
        { name: 'release' },
        { name: 'click', description: 'Press and release inside the control' },
      ],
    invokeInteraction: (name: string, args?: Record<string, unknown>) => {
      options.record?.push({ name, ...(args ? { args } : {}) });
      if (options.invoke) return options.invoke(name, args);
      // Mirrors the real gate: a disabled control accepts nothing.
      return (options.enabled ?? true) && ['hover', 'press', 'release', 'click'].includes(name);
    },
  });
  return node as unknown as FakeLiveNode;
};

describe('GameInputService control discovery (game_controls)', () => {
  beforeEach(() => {
    clearErrors();
    appState.ui.isPlaying = true;
  });

  afterEach(() => {
    appState.ui.isPlaying = false;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('refuses when the game is not running', async () => {
    appState.ui.isPlaying = false;
    expect((await buildService(null).service.listControls()).error).toMatch(/play_start/);
  });

  it('lists interactive nodes with their interactions and skips plain ones', async () => {
    const button = makeControl({ nodeId: 'btn-1', name: 'PlayButton', type: 'Button2D' });
    const plain = makeLiveNode({ nodeId: 'bg-1', name: 'Background', type: 'Sprite2D' });
    const { service } = buildService(makeRuntime([button, plain]));

    const result = await service.listControls();

    expect(result.ok).toBe(true);
    expect(result.controls?.map(entry => entry.nodeId)).toEqual(['btn-1']);
    const entry = result.controls![0];
    expect(entry).toMatchObject({ name: 'PlayButton', type: 'Button2D', enabled: true });
    expect(entry.interactions.map(i => i.name)).toEqual(['hover', 'press', 'release', 'click']);
    // The rule that decides which channel to use travels with the listing.
    expect(result.note).toMatch(/tap/);
    expect(result.note).toMatch(/COVERED/);
  });

  it('finds interactions declared by a SCRIPT COMPONENT and flattens their arguments', async () => {
    const node = makeLiveNode({ nodeId: 'gem-1', name: 'Gem', type: 'Sprite2D' });
    Object.assign(node, {
      components: [
        {
          type: 'user:Collectible',
          getInteractions: () => [
            {
              name: 'collect',
              description: 'Pick the gem up',
              args: [
                { name: 'count', type: 'number', ui: { min: 1, max: 9 } },
                { name: 'silent', type: 'boolean', defaultValue: false },
              ],
            },
          ],
          invokeInteraction: () => true,
        },
      ],
    });
    const { service } = buildService(makeRuntime([node]));

    const entry = (await service.listControls()).controls![0];

    expect(entry.interactions).toHaveLength(1);
    expect(entry.interactions[0].fromComponent).toBe('user:Collectible');
    expect(entry.interactions[0].args).toEqual([
      { name: 'count', type: 'number', required: true, min: 1, max: 9 },
      { name: 'silent', type: 'boolean', required: false, defaultValue: false },
    ]);
    // A component-declared interaction is addressed by NODE name, like any other.
    expect(entry.name).toBe('Gem');
  });

  it('reports reachability honestly: hidden by an ancestor, off screen, in frame, proven', async () => {
    const hiddenByParent = makeControl({
      nodeId: 'c-hidden-parent',
      name: 'RetryButton',
      parent: { visible: false, name: 'ResultOverlay' },
    });
    const selfHidden = makeControl({ nodeId: 'c-self', name: 'SecretButton', visible: false });
    const offScreen = makeControl({
      nodeId: 'c-off',
      name: 'FarButton',
      position: { x: 5000, y: 0, z: 0 },
    });
    const onScreen = makeControl({ nodeId: 'c-on', name: 'MuteButton' });
    const runtime = makeRuntime([hiddenByParent, selfHidden, offScreen, onScreen]);
    const { service } = buildService(runtime);

    const byId = async (id: string) =>
      (await service.listControls()).controls!.find(entry => entry.nodeId === id)!;

    expect(await byId('c-hidden-parent')).toMatchObject({
      reach: 'hidden-by-ancestor',
      hiddenByAncestor: 'ResultOverlay',
    });
    expect((await byId('c-self')).reach).toBe('hidden');
    expect((await byId('c-off')).reach).toBe('off-screen');
    expect((await byId('c-on')).reach).toBe('in-frame-unproven');

    // A physical tap is the ONLY thing that proves reachability — and only when the control itself
    // witnesses the pointer (its own bounds check is what sets isHovering).
    runtime.canvas.addEventListener('pointerdown', () => {
      (onScreen as unknown as { isHovering: boolean }).isHovering = true;
    });
    await service.run([{ type: 'tap', target: 'MuteButton', holdMs: 10 }], { settleMs: 0 });

    expect((await byId('c-on')).reach).toBe('reachable');
    expect((await byId('c-off')).reach).toBe('off-screen');
  });
});

/**
 * The journal (plan §5.6.2). What is being pinned down here is the balance the plan calls narrow:
 * a proof must burn when the control moved, and must NOT burn merely because the window changed
 * size — which is why the viewport/DPR/camera enter the stamped context only as "does it land in
 * the frame", never as pixels.
 */
describe('GameInputService reachability journal', () => {
  beforeEach(() => {
    clearErrors();
    appState.ui.isPlaying = true;
    appState.scenes.activeSceneId = 'res://scenes/Main.pix3scene';
  });

  afterEach(() => {
    appState.ui.isPlaying = false;
    appState.scenes.activeSceneId = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  /** Tap a control that witnesses the pointer, the way a real `UIControl2D` does. */
  const proveByTap = async (
    service: GameInputService,
    runtime: ReturnType<typeof makeRuntime>,
    control: FakeLiveNode,
    name: string
  ) => {
    const witness = () => {
      (control as unknown as { isHovering: boolean }).isHovering = true;
    };
    runtime.canvas.addEventListener('pointerdown', witness);
    const result = await service.run([{ type: 'tap', target: name, holdMs: 10 }], { settleMs: 0 });
    runtime.canvas.removeEventListener('pointerdown', witness);
    (control as unknown as { isHovering: boolean }).isHovering = false;
    return result;
  };

  const reachOf = async (service: GameInputService, nodeId: string) => {
    const listing = await service.listControls();
    return listing.controls!.find(entry => entry.nodeId === nodeId)!;
  };

  it('writes the proof to the project journal and survives a reload (a new service, same storage)', async () => {
    const store = new InMemoryReachabilityStore();
    const button = makeControl({ nodeId: 'btn-1', name: 'PlayButton', type: 'Button2D' });
    const runtime = makeRuntime([button]);
    const { service } = buildService(runtime, store);

    await proveByTap(service, runtime, button, 'PlayButton');
    expect((await reachOf(service, 'btn-1')).reach).toBe('reachable');

    // What landed on disk is the documented shape, not an opaque blob.
    const saved = JSON.parse(store.peek()!) as {
      version: number;
      proven: Array<{ nodeId: string; sceneId: string; hash: string; context: unknown }>;
    };
    expect(saved.version).toBe(REACHABILITY_JOURNAL_VERSION);
    expect(saved.proven).toHaveLength(1);
    expect(saved.proven[0]).toMatchObject({
      nodeId: 'btn-1',
      name: 'PlayButton',
      sceneId: 'res://scenes/Main.pix3scene',
    });
    expect(saved.proven[0].hash).toMatch(/^[0-9a-f]{8}$/);

    // The reload: a brand-new service (nothing in memory) over the same storage.
    const reloadedRuntime = makeRuntime([makeControl({ nodeId: 'btn-1', name: 'PlayButton' })]);
    const { service: reloaded } = buildService(reloadedRuntime, store);
    const entry = await reachOf(reloaded, 'btn-1');
    expect(entry.reach).toBe('reachable');
    expect(entry.reachNote).toMatch(/journal/);
  });

  it('burns the proof when the control MOVED, and says where it went', async () => {
    const store = new InMemoryReachabilityStore();
    const button = makeControl({ nodeId: 'btn-1', name: 'PlayButton' });
    const runtime = makeRuntime([button]);
    const { service } = buildService(runtime, store);

    await proveByTap(service, runtime, button, 'PlayButton');
    expect((await reachOf(service, 'btn-1')).reach).toBe('reachable');

    button.position.x = 400; // still on screen, but not where the finger landed
    const entry = await reachOf(service, 'btn-1');
    expect(entry.reach).toBe('in-frame-unproven');
    expect(entry.reachNote).toMatch(/BURNED/);
    expect(entry.reachNote).toMatch(/moved/);
  });

  it('keeps the proof across a plain window RESIZE (viewport, DPR and canvas size are normalized out)', async () => {
    const store = new InMemoryReachabilityStore();
    const button = makeControl({ nodeId: 'btn-1', name: 'PlayButton' });
    const runtime = makeRuntime([button]);
    // Project through the LIVE canvas size, as the real runner does — so a resize/DPR change here
    // really does move the control's pixel position, and the test is about that not mattering.
    runtime.runner.projectNodeToCanvas = (node: FakeLiveNode) => ({
      x: ((node.position.x + 960) / 1920) * runtime.canvas.width,
      y: ((540 - node.position.y) / 1080) * runtime.canvas.height,
    });
    const { service } = buildService(runtime, store);

    await proveByTap(service, runtime, button, 'PlayButton');
    expect((await reachOf(service, 'btn-1')).reach).toBe('reachable');

    // The resize: the backing store doubles in width and grows taller (a DPR bump plus a reshaped
    // window). The control's pixel position moves from 480,270 to 960,600 — and nothing about the
    // control itself changed, so the proof must hold.
    runtime.canvas.width = 1920;
    runtime.canvas.height = 1200;

    const entry = await reachOf(service, 'btn-1');
    expect(entry.reach).toBe('reachable');
  });

  it('burns the proof when a resize pushes the control out of frame, and when a parent hides it', async () => {
    const store = new InMemoryReachabilityStore();
    const button = makeControl({ nodeId: 'btn-1', name: 'PlayButton' });
    const runtime = makeRuntime([button]);
    const { service } = buildService(runtime, store);
    await proveByTap(service, runtime, button, 'PlayButton');

    // Same control, same world position — the frame shrank to nothing around it.
    runtime.canvas.width = 0;
    runtime.canvas.height = 0;
    expect((await reachOf(service, 'btn-1')).reach).toBe('unknown');

    runtime.canvas.width = 960;
    runtime.canvas.height = 540;
    button.parent = { visible: false, name: 'Overlay' };
    expect((await reachOf(service, 'btn-1')).reach).toBe('hidden-by-ancestor');
  });

  it('burns the proof when an ancestor SCROLL container scrolled the control away', async () => {
    const store = new InMemoryReachabilityStore();
    const list = { visible: true, name: 'ItemList', nodeId: 'list-1', scrollY: 0, parent: null };
    const button = makeControl({ nodeId: 'btn-1', name: 'BuyButton' });
    button.parent = list as unknown as FakeLiveNode['parent'];
    const runtime = makeRuntime([button]);
    const { service } = buildService(runtime, store);

    await proveByTap(service, runtime, button, 'BuyButton');
    expect((await reachOf(service, 'btn-1')).reach).toBe('reachable');

    list.scrollY = 240;
    const entry = await reachOf(service, 'btn-1');
    expect(entry.reach).toBe('in-frame-unproven');
    expect(entry.reachNote).toMatch(/scroll/i);
  });

  it('starts from a clean journal on a corrupt or foreign file — and says so instead of throwing', async () => {
    const button = makeControl({ nodeId: 'btn-1', name: 'PlayButton' });

    for (const [label, text] of [
      ['not JSON', '{ this is not json'],
      ['another tool’s file', JSON.stringify({ version: 7, entries: [] })],
      ['a wrong shape', JSON.stringify({ version: 1, proven: 'nope' })],
    ] as const) {
      const runtime = makeRuntime([button]);
      const { service } = buildService(runtime, new InMemoryReachabilityStore(text));
      const listing = await service.listControls();

      expect(listing.ok, label).toBe(true);
      expect(listing.controls![0].reach, label).toBe('in-frame-unproven');
      expect(listing.journalNote, label).toMatch(/fresh journal/);
      document.body.innerHTML = '';
    }
  });

  it('reports the reset in the past tense once a fresh journal has actually been written', async () => {
    const store = new InMemoryReachabilityStore('{ not json');
    const button = makeControl({ nodeId: 'btn-1', name: 'PlayButton' });
    const runtime = makeRuntime([button]);
    const { service } = buildService(runtime, store);

    expect((await service.listControls()).journalNote).toMatch(/is being ignored/);
    await proveByTap(service, runtime, button, 'PlayButton');

    const listing = await service.listControls();
    expect(listing.journalNote).toMatch(/has been replaced/);
    expect(JSON.parse(store.peek()!).proven).toHaveLength(1);
  });

  it('drops only the unreadable entries of an otherwise valid journal', async () => {
    const good = {
      nodeId: 'btn-1',
      name: 'PlayButton',
      sceneId: 'res://scenes/Main.pix3scene',
      hash: 'deadbeef',
      context: {
        ancestors: '',
        hiddenAncestors: '',
        visible: true,
        enabled: true,
        collapsed: false,
        frame: 'in',
        world: [0, 0, 0],
        size: null,
        scroll: [],
      },
      provenAt: '2026-08-01T00:00:00.000Z',
    };
    const store = new InMemoryReachabilityStore(
      JSON.stringify({ version: 1, proven: [good, { nodeId: 'btn-2' }, null] })
    );
    const runtime = makeRuntime([makeControl({ nodeId: 'btn-1', name: 'PlayButton' })]);
    const { service } = buildService(runtime, store);

    const listing = await service.listControls();
    expect(listing.controls![0].reach).toBe('reachable');
    expect(listing.journalNote).toMatch(/2 unreadable entries were dropped/);
  });

  it('does not journal a tap that landed on nothing — the control is the only witness', async () => {
    const store = new InMemoryReachabilityStore();
    const button = makeControl({ nodeId: 'btn-1', name: 'PlayButton' });
    const runtime = makeRuntime([button]);
    const { service } = buildService(runtime, store);

    // No witness wired: the control never reports hovering/pressed, so the tap projected onto
    // empty space as far as anyone can tell.
    await service.run([{ type: 'tap', target: 'PlayButton', holdMs: 10 }], { settleMs: 0 });

    expect((await reachOf(service, 'btn-1')).reach).toBe('in-frame-unproven');
    expect(store.peek()).toBeNull();
  });

  it('writes ONCE per game_input call, however many controls it taps', async () => {
    const store = new InMemoryReachabilityStore();
    const writes = vi.spyOn(store, 'write');
    const a = makeControl({ nodeId: 'btn-a', name: 'ButtonA' });
    const b = makeControl({ nodeId: 'btn-b', name: 'ButtonB', position: { x: 200, y: 0, z: 0 } });
    const runtime = makeRuntime([a, b]);
    const { service } = buildService(runtime, store);
    runtime.canvas.addEventListener('pointerdown', () => {
      (a as unknown as { isHovering: boolean }).isHovering = true;
      (b as unknown as { isHovering: boolean }).isHovering = true;
    });

    await service.run(
      [
        { type: 'tap', target: 'ButtonA', holdMs: 5 },
        { type: 'tap', target: 'ButtonB', holdMs: 5 },
      ],
      { settleMs: 0 }
    );

    expect(writes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.peek()!).proven).toHaveLength(2);
    // A run that proves nothing new does not touch the file at all.
    await service.run([{ type: 'wait', ms: 1 }], { settleMs: 0 });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('reports a failing write instead of failing the run', async () => {
    const store: ReachabilityStore = {
      read: async () => null,
      write: async () => {
        throw new Error('project is read-only');
      },
    };
    const button = makeControl({ nodeId: 'btn-1', name: 'PlayButton' });
    const runtime = makeRuntime([button]);
    const { service } = buildService(runtime, store);

    const result = await proveByTap(service, runtime, button, 'PlayButton');

    expect(result.ok).toBe(true);
    const listing = await service.listControls();
    // The proof still holds for this session; only its survival of a reload is in doubt.
    expect(listing.controls![0].reach).toBe('reachable');
    expect(listing.journalNote).toMatch(/read-only/);
  });
});

describe('GameInputService invoke step', () => {
  beforeEach(() => {
    clearErrors();
    appState.ui.isPlaying = true;
  });

  afterEach(() => {
    appState.ui.isPlaying = false;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('drives the interaction by name and stays an ordinary step of the sequence', async () => {
    const record: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const slider = makeControl(
      { nodeId: 's-1', name: 'Volume', type: 'Slider2D' },
      {
        record,
        interactions: [{ name: 'setValue', args: [{ name: 'value', type: 'number' }] }],
        invoke: () => true,
      }
    );
    const { service } = buildService(makeRuntime([slider]));

    const result = await service.run(
      [
        { type: 'invoke', target: 'Volume', interaction: 'setValue', args: { value: 0.5 } },
        { type: 'wait', ms: 5 },
      ],
      { settleMs: 0, observe: ['Volume'] }
    );

    expect(result.ok).toBe(true);
    expect(result.stepsRun).toBe(2);
    expect(record).toEqual([{ name: 'setValue', args: { value: 0.5 } }]);
    // Observation and the fused verdict apply to an invoke run exactly as to a tap run.
    expect(result.observed?.Volume).toBeDefined();
    expect(result.verdict).toBeTruthy();
  });

  it('refuses a node that is not interactive, naming the physical alternative', async () => {
    const { service } = buildService(makeRuntime([makeLiveNode({ name: 'Background' })]));
    const result = await service.run(
      [{ type: 'invoke', target: 'Background', interaction: 'click' }],
      { settleMs: 0 }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not interactive/);
    expect(result.error).toMatch(/tap/);
  });

  it('refuses an unknown interaction and lists the ones that exist', async () => {
    const { service } = buildService(makeRuntime([makeControl({ name: 'PlayButton' })]));
    const result = await service.run(
      [{ type: 'invoke', target: 'PlayButton', interaction: 'toggle' }],
      { settleMs: 0 }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no interaction "toggle"/);
    expect(result.error).toMatch(/hover, press, release, click/);
  });

  it('refuses a disabled control by saying so, not by silence', async () => {
    const { service } = buildService(
      makeRuntime([makeControl({ name: 'BuyButton' }, { enabled: false })])
    );
    const result = await service.run(
      [{ type: 'invoke', target: 'BuyButton', interaction: 'click' }],
      { settleMs: 0 }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/enabled:false/);
  });

  it('blames the ancestor scroll container when the gesture was taken away', async () => {
    const gated = makeControl(
      {
        name: 'ItemButton',
        parent: { visible: true, name: 'ShopList', type: 'ScrollContainer2D' } as never,
      },
      { invoke: () => false }
    );
    const { service } = buildService(makeRuntime([gated]));
    const result = await service.run(
      [{ type: 'invoke', target: 'ItemButton', interaction: 'click' }],
      { settleMs: 0 }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ShopList/);
    expect(result.error).toMatch(/scrollTo/);
  });

  it('names a missing required argument instead of failing anonymously', async () => {
    const checkbox = makeControl(
      { name: 'Music' },
      {
        interactions: [{ name: 'setChecked', args: [{ name: 'checked', type: 'boolean' }] }],
        invoke: () => true,
      }
    );
    const { service } = buildService(makeRuntime([checkbox]));
    const result = await service.run(
      [{ type: 'invoke', target: 'Music', interaction: 'setChecked' }],
      { settleMs: 0 }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/needs argument\(s\) checked/);
  });

  it('reports an unresolvable target and an incomplete step', async () => {
    const { service } = buildService(makeRuntime([makeControl({ name: 'PlayButton' })]));
    const missing = await service.run([{ type: 'invoke', target: 'Nope', interaction: 'click' }], {
      settleMs: 0,
    });
    expect(missing.error).toMatch(/No live node/);
    const noInteraction = await service.run([{ type: 'invoke', target: 'PlayButton' }], {
      settleMs: 0,
    });
    expect(noInteraction.error).toMatch(/needs `interaction`/);
  });
});
