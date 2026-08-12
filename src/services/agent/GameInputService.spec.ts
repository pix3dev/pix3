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
