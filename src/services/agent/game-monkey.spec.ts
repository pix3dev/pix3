import { describe, expect, it } from 'vitest';

import type { LiveControlEntry } from './GameInputService';
import type { AssertionFrame } from './game-assertions';
import {
  MonkeyDriver,
  MonkeyInvariantMonitor,
  MONKEY_EMPTY_NOTE,
  makeSeededRandom,
  parseMonkeySpec,
  usableControls,
  type MonkeyInventory,
  type NormalizedMonkeySpec,
} from './game-monkey';

/**
 * The monkey is judged on three properties, and they are the three that make a
 * finding actionable: the same seed replays the same run, the invariants notice
 * the two failures that need no understanding of the game, and the log says what
 * was pressed. Everything here is literals — no runner, no scene.
 */

const control = (name: string, over: Partial<LiveControlEntry> = {}): LiveControlEntry => ({
  nodeId: `id-${name}`,
  name,
  type: 'Button2D',
  visible: true,
  reach: 'in-frame-unproven',
  interactions: [{ name: 'click' }],
  ...over,
});

const inventory = (over: Partial<MonkeyInventory> = {}): MonkeyInventory => ({
  controls: [control('Play'), control('Retry'), control('Settings')],
  commands: ['game.start', 'settings.toggle-music'],
  actions: ['Key_ArrowLeft', 'Key_Space'],
  ...over,
});

const spec = (over: Partial<NormalizedMonkeySpec> = {}): NormalizedMonkeySpec => ({
  seed: 42,
  actions: [],
  everyFrames: 10,
  holdFrames: 8,
  maxActions: 200,
  invariants: {},
  ...over,
});

const runDriver = (seed: number, steps = 12, world = inventory()): string[] => {
  const driver = new MonkeyDriver(spec({ seed }));
  const sent: string[] = [];
  for (let frame = 1; frame <= steps * 10; frame += 1) {
    if (!driver.shouldAct(frame)) continue;
    const action = driver.decide(world);
    if (!action) continue;
    driver.log(frame, action);
    sent.push(JSON.stringify(action));
  }
  return sent;
};

const frame = (over: Partial<AssertionFrame> = {}): AssertionFrame => ({
  frame: 0,
  gameTimeMs: 0,
  gameState: null,
  presentNodes: new Set<string>(),
  newErrorCount: 0,
  ...over,
});

const nodeMap = (
  name: string,
  world: { x?: number; y?: number; z?: number },
  scale = 1,
  rotationZ = 0
): AssertionFrame['nodes'] =>
  new Map([
    [
      name,
      {
        nodeId: `id-${name}`,
        name,
        type: 'Sprite2D',
        visible: true,
        position: { x: world.x ?? 0, y: world.y ?? 0, z: world.z ?? 0 },
        worldPosition: { x: world.x ?? 0, y: world.y ?? 0, z: world.z ?? 0 },
        rotationZ,
        scale: { x: scale, y: scale, z: scale },
        childCount: 0,
        visibleChildCount: 0,
      },
    ],
  ]);

describe('makeSeededRandom', () => {
  it('replays the same stream for the same seed and differs across seeds', () => {
    const a = makeSeededRandom(7);
    const b = makeSeededRandom(7);
    const c = makeSeededRandom(8);
    const first = [a(), a(), a(), a()];
    expect([b(), b(), b(), b()]).toEqual(first);
    expect([c(), c(), c(), c()]).not.toEqual(first);
    expect(first.every(value => value >= 0 && value < 1)).toBe(true);
  });
});

describe('MonkeyDriver determinism', () => {
  it('produces an identical action sequence for the same seed and inventory', () => {
    expect(runDriver(42)).toEqual(runDriver(42));
  });

  it('produces a different sequence for a different seed', () => {
    expect(runDriver(42)).not.toEqual(runDriver(1337));
  });
});

describe('MonkeyDriver action sourcing', () => {
  it('only ever presses what the scene actually offers', () => {
    const world = inventory();
    const names = new Set(world.controls.map(entry => entry.name));
    const driver = new MonkeyDriver(spec());
    for (let f = 10; f <= 400; f += 10) {
      const action = driver.decide(world);
      if (!action) continue;
      if (action.kind === 'interaction') expect(names.has(action.node)).toBe(true);
      if (action.kind === 'command') expect(world.commands).toContain(action.name);
      if (action.kind === 'action') expect(world.actions).toContain(action.name);
    }
  });

  it('skips controls a finger could not reach', () => {
    const usable = usableControls([
      control('Play'),
      control('Dead', { enabled: false }),
      control('Offscreen', { reach: 'off-screen' }),
      control('Hidden', { visible: false, reach: 'hidden' }),
      control('Veiled', { hiddenByAncestor: 'Overlay' }),
      control('Inert', { interactions: [] }),
    ]);
    expect(usable.map(entry => entry.name)).toEqual(['Play']);
  });

  it('draws argument values from the declared vocabulary', () => {
    const world = inventory({
      controls: [
        control('Stick', {
          type: 'Joystick2D',
          interactions: [
            {
              name: 'setStick',
              args: [
                { name: 'dir', type: 'string', required: true, options: ['left', 'right'] },
                { name: 'magnitude', type: 'number', required: true, min: 0, max: 1 },
              ],
            },
          ],
        }),
      ],
      commands: [],
      actions: [],
    });
    const driver = new MonkeyDriver(spec());
    for (let i = 0; i < 20; i += 1) {
      const action = driver.decide(world);
      expect(action?.kind).toBe('interaction');
      if (action?.kind !== 'interaction') continue;
      expect(['left', 'right']).toContain(action.args?.dir);
      const magnitude = action.args?.magnitude as number;
      expect(magnitude).toBeGreaterThanOrEqual(0);
      expect(magnitude).toBeLessThanOrEqual(1);
    }
  });

  it('refuses to invent a required argument it has no vocabulary for', () => {
    const world = inventory({
      controls: [
        control('Shop', {
          interactions: [
            { name: 'buy', args: [{ name: 'itemId', type: 'string', required: true }] },
          ],
        }),
      ],
      commands: [],
      actions: [],
    });
    const driver = new MonkeyDriver(spec());
    expect(driver.decide(world)).toBeNull();
  });

  it('stops deciding once the action cap is reached', () => {
    const driver = new MonkeyDriver(spec({ maxActions: 2, everyFrames: 5 }));
    let acted = 0;
    for (let f = 1; f <= 100; f += 1) {
      if (!driver.shouldAct(f)) continue;
      const action = driver.decide(inventory());
      if (action) {
        driver.log(f, action);
        acted += 1;
      }
    }
    expect(acted).toBe(2);
  });
});

describe('MonkeyDriver report', () => {
  it('always carries the seed and a non-empty press log', () => {
    const driver = new MonkeyDriver(spec({ seed: 99 }));
    for (let f = 10; f <= 60; f += 10) {
      const action = driver.decide(inventory());
      if (action) driver.log(f, action);
    }
    const report = driver.report();
    expect(report.seed).toBe(99);
    expect(report.log.length).toBeGreaterThan(0);
    expect(report.log[0]).toMatch(/^f10 /);
    expect(report.lastActions.length).toBeGreaterThan(0);
    expect(report.actions).toBe(report.log.length);
  });

  it('keeps the head and the tail when the log overflows, and says it cut', () => {
    const driver = new MonkeyDriver(spec({ maxActions: 500 }));
    for (let f = 1; f <= 200; f += 1) {
      driver.log(f, { kind: 'command', name: `cmd-${f}` });
    }
    const report = driver.report();
    expect(report.logTruncated).toBe(true);
    expect(report.log[0]).toContain('cmd-1');
    expect(report.log.some(line => line.includes('not shown'))).toBe(true);
    expect(report.log[report.log.length - 1]).toContain('cmd-200');
    // The reproduction hint is the tail, repeated so nobody has to scroll for it.
    expect(report.lastActions[report.lastActions.length - 1]).toContain('cmd-200');
  });

  it('counts refusals separately from presses', () => {
    const driver = new MonkeyDriver(spec());
    driver.log(10, { kind: 'command', name: 'game.start' });
    driver.log(
      20,
      { kind: 'interaction', node: 'Play', interaction: 'click' },
      'refused',
      'disabled'
    );
    const report = driver.report();
    expect(report.actions).toBe(1);
    expect(report.refused).toBe(1);
    expect(report.log[1]).toContain('[refused: disabled]');
  });

  it('refuses to look green when the scene offered nothing to press', () => {
    const driver = new MonkeyDriver(spec());
    expect(driver.decide({ controls: [], commands: [], actions: [] })).toBeNull();
    const report = driver.report();
    expect(report.actions).toBe(0);
    expect(report.note).toBe(MONKEY_EMPTY_NOTE);
  });
});

describe('MonkeyInvariantMonitor', () => {
  const baseline = frame({ gameState: { score: 0 }, nodes: nodeMap('Player', { x: 0 }) });

  it('fires on a new runtime error', () => {
    const monitor = new MonkeyInvariantMonitor();
    const violation = monitor.check(frame({ frame: 12, newErrorCount: 2 }), baseline, 3);
    expect(violation?.kind).toBe('new-errors');
    expect(violation?.frame).toBe(12);
  });

  it('fires on a NaN transform', () => {
    const monitor = new MonkeyInvariantMonitor();
    const violation = monitor.check(
      frame({ frame: 30, nodes: nodeMap('Player', { x: Number.NaN }) }),
      baseline,
      4
    );
    expect(violation?.kind).toBe('non-finite-transform');
    expect(violation?.detail).toContain('Player');
  });

  it('fires when a node leaves the world, and honours a tighter radius', () => {
    expect(
      new MonkeyInvariantMonitor().check(
        frame({ frame: 40, nodes: nodeMap('Player', { x: 50_000 }) }),
        baseline,
        4
      )?.kind
    ).toBe('out-of-bounds');
    expect(
      new MonkeyInvariantMonitor({ boundsRadius: 100 }).check(
        frame({ frame: 40, nodes: nodeMap('Player', { x: 250 }) }),
        baseline,
        4
      )?.kind
    ).toBe('out-of-bounds');
    expect(
      new MonkeyInvariantMonitor({ boundsRadius: false }).check(
        frame({ frame: 40, nodes: nodeMap('Player', { x: 1e9 }) }),
        baseline,
        4
      )
    ).toBeNull();
  });

  it('measures the score against its peak, not against the start', () => {
    const monitor = new MonkeyInvariantMonitor();
    expect(monitor.check(frame({ frame: 10, gameState: { score: 5 } }), baseline, 2)).toBeNull();
    expect(monitor.check(frame({ frame: 20, gameState: { score: 9 } }), baseline, 3)).toBeNull();
    const violation = monitor.check(frame({ frame: 30, gameState: { score: 7 } }), baseline, 4);
    expect(violation?.kind).toBe('score-decreased');
    expect(violation?.detail).toContain('9');
  });

  it('leaves the score alone when the game says it may fall', () => {
    const monitor = new MonkeyInvariantMonitor({ scorePath: false });
    monitor.check(frame({ frame: 10, gameState: { score: 5 } }), baseline, 2);
    expect(monitor.check(frame({ frame: 20, gameState: { score: 1 } }), baseline, 3)).toBeNull();
  });

  it('skips the score check entirely when the game exposes none', () => {
    const monitor = new MonkeyInvariantMonitor();
    const noScore = frame({ gameState: { wave: 1 } });
    expect(monitor.check(frame({ frame: 10, gameState: { wave: 1 } }), noScore, 2)).toBeNull();
  });

  it('reports a frozen game as stuck only once enough was pressed', () => {
    const monitor = new MonkeyInvariantMonitor({ stallFrames: 30 });
    const frozen = (n: number, actions: number) =>
      monitor.check(
        frame({ frame: n, gameState: { score: 0 }, nodes: nodeMap('Player', { x: 0 }) }),
        baseline,
        actions
      );
    expect(frozen(1, 0)).toBeNull();
    // The window has passed but nothing was pressed: a still game nobody touched
    // is not stuck, it is idle.
    expect(frozen(40, 1)).toBeNull();
    expect(frozen(60, 6)?.kind).toBe('stalled');
  });

  it('does not call a moving game stuck', () => {
    const monitor = new MonkeyInvariantMonitor({ stallFrames: 10 });
    for (let f = 1; f <= 60; f += 1) {
      const violation = monitor.check(
        frame({ frame: f, gameState: { score: 0 }, nodes: nodeMap('Player', { x: f }) }),
        baseline,
        f
      );
      expect(violation).toBeNull();
    }
  });

  it('keeps reporting the first violation rather than moving on', () => {
    const monitor = new MonkeyInvariantMonitor();
    const first = monitor.check(frame({ frame: 5, newErrorCount: 1 }), baseline, 1);
    const later = monitor.check(
      frame({ frame: 9, nodes: nodeMap('Player', { x: Number.NaN }) }),
      baseline,
      2
    );
    expect(later).toBe(first);
    expect(monitor.firstViolation?.kind).toBe('new-errors');
  });
});

describe('parseMonkeySpec', () => {
  it('requires a seed and says why', () => {
    const result = parseMonkeySpec({ actions: ['Key_Space'] });
    expect('error' in result && result.error).toContain('cannot be reproduced');
    expect('error' in parseMonkeySpec({ seed: 1.5 })).toBe(true);
    expect('error' in parseMonkeySpec({ seed: -3 })).toBe(true);
  });

  it('fills the defaults around a bare seed', () => {
    const result = parseMonkeySpec({ seed: 7 });
    expect('spec' in result && result.spec).toMatchObject({
      seed: 7,
      actions: [],
      everyFrames: 12,
      holdFrames: 8,
    });
  });

  it('validates the action list and the numeric fields', () => {
    expect('error' in parseMonkeySpec({ seed: 1, actions: [3] })).toBe(true);
    expect('error' in parseMonkeySpec({ seed: 1, everyFrames: 0 })).toBe(true);
    expect('error' in parseMonkeySpec({ seed: 1, invariants: [] })).toBe(true);
    expect('spec' in parseMonkeySpec({ seed: 1, invariants: { boundsRadius: 500 } })).toBe(true);
  });

  it('rejects a non-object monkey block', () => {
    expect('error' in parseMonkeySpec('yes please')).toBe(true);
  });
});
