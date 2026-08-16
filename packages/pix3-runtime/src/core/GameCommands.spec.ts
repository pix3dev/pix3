import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { GameCommandRegistry, type GameCommandArgs } from './GameCommands';
import { registerScriptErrorSink, type ScriptErrorInfo } from './game-debug';
import { SceneService } from './SceneService';
import { SceneRunner } from './SceneRunner';
import { AssetLoader } from './AssetLoader';
import { AudioService } from './AudioService';
import { ResourceManager } from './ResourceManager';
import type { RuntimeRenderer } from './RuntimeRenderer';
import type { SceneGraph, SceneManager } from './SceneManager';
import { Camera3D } from '../nodes/3D/Camera3D';

/**
 * The command layer's contract (§5.8.2 of `.plans/done/agent-gameplay-testing.md`).
 * Each block below is one clause of it: names, argument serialisability, the
 * error boundary, the recursion cap, the journal's caps and frame stamps, undo,
 * and the lifetime tie to the scene.
 */

describe('GameCommandRegistry — names', () => {
  let registry: GameCommandRegistry;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    registry = new GameCommandRegistry();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts kebab-case, with or without a dotted namespace', () => {
    registry.register('restart', () => {});
    registry.register('start-game', () => {});
    registry.register('settings.toggle-music', () => {});
    registry.register('ui.hud.toggle', () => {});

    expect(registry.list().map(command => command.name)).toEqual([
      'restart',
      'settings.toggle-music',
      'start-game',
      'ui.hud.toggle',
    ]);
    expect(registry.log).toEqual([]);
  });

  it.each([
    ['StartGame', 'camelCase/PascalCase'],
    ['start_game', 'snake_case'],
    ['start game', 'a space'],
    ['start--game', 'a doubled separator'],
    ['-start', 'a leading separator'],
    ['start-', 'a trailing separator'],
    ['settings.', 'an empty namespace segment'],
    ['2fast', 'a leading digit'],
    ['', 'an empty name'],
  ])('refuses %j (%s) loudly instead of silently accepting it', invalid => {
    registry.register(invalid, () => {});

    expect(registry.list()).toEqual([]);
    expect(registry.dispatch(invalid)).toBe(false);
    // Refusal is audible in both places an operator looks.
    expect(registry.log[0]).toMatchObject({ status: 'rejected' });
    expect(consoleError).toHaveBeenCalled();
  });

  it('refuses a duplicate name and keeps the first handler', () => {
    const first = vi.fn();
    const second = vi.fn();
    registry.register('restart', first);
    registry.register('restart', second);

    expect(registry.list()).toHaveLength(1);
    expect(registry.log.at(-1)).toMatchObject({ name: 'restart', status: 'rejected' });

    registry.dispatch('restart');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('registration refusal returns a disposer that is a no-op, not a foot-gun', () => {
    const handler = vi.fn();
    registry.register('restart', handler);
    const disposeRejected = registry.register('restart', vi.fn());

    disposeRejected();

    // The refused registration must not be able to unregister the winner.
    expect(registry.dispatch('restart')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('the disposer unregisters, so a prefab freed mid-scene leaves no dead intent', () => {
    const dispose = registry.register('restart', vi.fn());
    dispose();

    expect(registry.list()).toEqual([]);
    expect(registry.dispatch('restart')).toBe(false);
    expect(registry.log.at(-1)).toMatchObject({ name: 'restart', status: 'unknown' });
  });
});

describe('GameCommandRegistry — arguments', () => {
  let registry: GameCommandRegistry;
  let handler: Mock<(args?: GameCommandArgs) => void>;

  beforeEach(() => {
    registry = new GameCommandRegistry();
    handler = vi.fn<(args?: GameCommandArgs) => void>();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    registry.register('buy-item', handler);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes JSON-serialisable args through', () => {
    expect(
      registry.dispatch('buy-item', { slot: 2, tags: ['a'], nested: { ok: true, none: null } })
    ).toBe(true);
    expect(handler).toHaveBeenCalledWith({
      slot: 2,
      tags: ['a'],
      nested: { ok: true, none: null },
    });
  });

  it.each([
    ['a function', { onDone: () => {} }, 'args.onDone'],
    ['NaN', { amount: Number.NaN }, 'args.amount'],
    ['Infinity', { amount: Number.POSITIVE_INFINITY }, 'args.amount'],
    ['undefined', { slot: undefined }, 'args.slot'],
    ['a Map', { lookup: new Map() }, 'args.lookup'],
    ['a class instance', { node: new Camera3D({ id: 'c', name: 'C' }) }, 'args.node'],
    ['a symbol', { key: Symbol('k') }, 'args.key'],
    ['a nested function', { deep: { list: [() => {}] } }, 'args.deep.list[0]'],
  ])('refuses %s before the handler runs, naming the offending path', (_label, args, path) => {
    expect(registry.dispatch('buy-item', args as Record<string, unknown>)).toBe(false);

    expect(handler).not.toHaveBeenCalled();
    const entry = registry.log.at(-1);
    expect(entry).toMatchObject({ name: 'buy-item', status: 'rejected' });
    expect(entry?.error).toContain(path);
  });

  it('refuses a circular structure rather than looping', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(registry.dispatch('buy-item', cycle)).toBe(false);
    expect(registry.log.at(-1)?.error).toContain('circular');
  });

  it('refuses args that are not a plain object', () => {
    expect(registry.dispatch('buy-item', [1, 2] as unknown as Record<string, unknown>)).toBe(false);
    expect(registry.log.at(-1)?.error).toContain('plain object');
    expect(handler).not.toHaveBeenCalled();
  });

  it('logs a deep copy, so mutating the args later cannot rewrite history', () => {
    const args = { slot: 1 };
    registry.dispatch('buy-item', args);
    args.slot = 99;

    expect(registry.log.at(-1)?.args).toEqual({ slot: 1 });
  });

  it('marks oversized args as omitted instead of storing them', () => {
    registry.dispatch('buy-item', { blob: 'x'.repeat(500) });

    const entry = registry.log.at(-1);
    expect(entry).toMatchObject({ name: 'buy-item', status: 'ok', argsOmitted: true });
    expect(entry?.args).toBeUndefined();
  });
});

describe('GameCommandRegistry — error boundary and recursion', () => {
  let registry: GameCommandRegistry;
  let errors: ScriptErrorInfo[];
  let disposeSink: () => void;

  beforeEach(() => {
    registry = new GameCommandRegistry();
    errors = [];
    disposeSink = registerScriptErrorSink(error => errors.push(error));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    disposeSink();
    vi.restoreAllMocks();
  });

  it('contains a throwing handler: no throw at the caller, logged and reported', () => {
    registry.register('explode', () => {
      throw new Error('boom');
    });
    const healthy = vi.fn();
    registry.register('restart', healthy);

    expect(() => registry.dispatch('explode')).not.toThrow();
    expect(registry.dispatch('explode')).toBe(false);
    expect(registry.log.at(-1)).toMatchObject({ name: 'explode', status: 'error' });
    expect(registry.log.at(-1)?.error).toContain('boom');
    expect(errors.at(-1)).toMatchObject({ phase: 'command' });
    expect(errors.at(-1)?.message).toContain('explode');

    // The registry stays usable — one bad intent does not take the game down.
    expect(registry.dispatch('restart')).toBe(true);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('reports an unknown command instead of failing silently', () => {
    expect(registry.dispatch('no-such-thing')).toBe(false);
    expect(registry.log.at(-1)).toMatchObject({ name: 'no-such-thing', status: 'unknown' });
  });

  it('caps recursive dispatch and says so in the journal', () => {
    let depth = 0;
    registry.register('recurse', () => {
      depth += 1;
      registry.dispatch('recurse');
    });

    registry.dispatch('recurse');

    expect(depth).toBeLessThanOrEqual(8);
    const rejected = registry.log.filter(entry => entry.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ name: 'recurse' });
    expect(rejected[0].error).toContain('nested deeper');
  });

  it('recovers its depth budget after the cap trips, so later dispatches still run', () => {
    registry.register('recurse', () => {
      registry.dispatch('recurse');
    });
    registry.register('restart', vi.fn());
    registry.dispatch('recurse');

    expect(registry.dispatch('restart')).toBe(true);
  });

  it('lets one command dispatch another, in order', () => {
    registry.register('inner', vi.fn());
    registry.register('outer', () => {
      registry.dispatch('inner');
    });

    registry.dispatch('outer');

    expect(registry.log.map(entry => entry.name)).toEqual(['outer', 'inner']);
  });
});

describe('GameCommandRegistry — journal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stamps every entry with the frame the runner reports', () => {
    let frame = 0;
    const registry = new GameCommandRegistry(() => frame);
    registry.register('restart', vi.fn());

    frame = 12;
    registry.dispatch('restart');
    frame = 214;
    registry.dispatch('restart');

    expect(registry.log.map(entry => entry.frame)).toEqual([12, 214]);
  });

  it('stamps 0 when nothing supplies a frame (no scene running)', () => {
    const registry = new GameCommandRegistry();
    registry.register('restart', vi.fn());
    registry.dispatch('restart');

    expect(registry.log[0].frame).toBe(0);
  });

  it('caps its size, keeps the newest, and counts what it dropped', () => {
    const registry = new GameCommandRegistry();
    registry.register('restart', vi.fn());
    for (let i = 0; i < 60; i++) {
      registry.dispatch('restart', { i });
    }

    expect(registry.log).toHaveLength(50);
    expect(registry.droppedLogEntries).toBe(10);
    expect(registry.log[0].args).toEqual({ i: 10 });
    expect(registry.log.at(-1)?.args).toEqual({ i: 59 });
  });
});

describe('GameCommandRegistry — undo', () => {
  let registry: GameCommandRegistry;

  beforeEach(() => {
    registry = new GameCommandRegistry();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reverses the last command that declared a reverse step', () => {
    const opened: string[] = [];
    registry.register(
      'open-settings',
      () => {
        opened.push('open');
        return { undo: () => opened.push('close') };
      },
      { description: 'Show the settings window.', undoable: true }
    );

    registry.dispatch('open-settings');
    expect(registry.canUndo).toBe(true);
    expect(registry.undo()).toBe(true);

    expect(opened).toEqual(['open', 'close']);
    expect(registry.log.at(-1)).toMatchObject({ name: 'open-settings', status: 'undo' });
    expect(registry.canUndo).toBe(false);
  });

  it('refuses when nothing declared one, and a command without undo declares nothing', () => {
    registry.register('restart', vi.fn());
    registry.dispatch('restart');

    expect(registry.canUndo).toBe(false);
    expect(registry.undo()).toBe(false);
    expect(registry.log.at(-1)).toMatchObject({ status: 'rejected' });
  });

  it('contains a throwing undo the same way it contains a handler', () => {
    registry.register('open-settings', () => ({
      undo: () => {
        throw new Error('undo boom');
      },
    }));
    registry.dispatch('open-settings');

    expect(() => registry.undo()).not.toThrow();
    expect(registry.log.at(-1)).toMatchObject({ status: 'error' });
    expect(registry.log.at(-1)?.error).toContain('undo boom');
  });

  it('reports `undoable` in the listing so an agent can discover it', () => {
    registry.register('open-settings', () => ({ undo: () => {} }), {
      description: 'Show the settings window.',
      undoable: true,
    });
    registry.register('restart', vi.fn());

    expect(registry.list()).toEqual([
      {
        name: 'open-settings',
        description: 'Show the settings window.',
        undoable: true,
      },
      { name: 'restart', undoable: false },
    ]);
  });
});

describe('GameCommandRegistry — lifetime', () => {
  it('clear() drops commands, journal and pending undo', () => {
    const registry = new GameCommandRegistry();
    registry.register('open-settings', () => ({ undo: () => {} }));
    registry.dispatch('open-settings');

    registry.clear();

    expect(registry.list()).toEqual([]);
    expect(registry.log).toEqual([]);
    expect(registry.canUndo).toBe(false);
    expect(registry.droppedLogEntries).toBe(0);
  });
});

/** Renderer stub: the lifetime test is about registry contents, not pixels. */
function createRendererStub(): RuntimeRenderer {
  const canvas = document.createElement('canvas');
  return {
    beginStatsFrame: vi.fn(),
    domElement: canvas,
    render: vi.fn(),
    setAutoClear: vi.fn(),
    clear: vi.fn(),
    clearDepth: vi.fn(),
    getStatsSnapshot: vi.fn(() => ({
      calls: 0,
      triangles: 0,
      points: 0,
      lines: 0,
      geometries: 0,
      textures: 0,
    })),
  } as unknown as RuntimeRenderer;
}

interface RunnerInternals {
  sceneService: SceneService;
  runtimeGraph: SceneGraph | null;
  activeCamera: Camera3D;
  isRunning: boolean;
  frameNumber: number;
}

describe('scene.commands lifetime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createRunner(): { runner: SceneRunner; internals: RunnerInternals } {
    const runner = new SceneRunner(
      {} as unknown as SceneManager,
      createRendererStub(),
      new AudioService(),
      new AssetLoader(new ResourceManager('/'), new AudioService())
    );
    const cameraNode = new Camera3D({ id: 'camera', name: 'Camera', projection: 'perspective' });
    const internals = runner as unknown as RunnerInternals;
    cameraNode.scene = internals.sceneService;
    internals.activeCamera = cameraNode;
    internals.runtimeGraph = {
      version: '1.0.0',
      metadata: {},
      rootNodes: [cameraNode],
      nodeMap: new Map([[cameraNode.nodeId, cameraNode]]),
    };
    internals.isRunning = true;
    return { runner, internals };
  }

  it('stamps the journal with the runner frame number', () => {
    const { internals } = createRunner();
    const scene = internals.sceneService;
    scene.commands.register('restart', vi.fn());

    internals.frameNumber = 96;
    scene.commands.dispatch('restart');

    expect(scene.commands.log.at(-1)?.frame).toBe(96);
  });

  it('stopping the scene leaves no command of the previous scene visible', () => {
    const { runner, internals } = createRunner();
    const scene = internals.sceneService;
    scene.commands.register('start-game', vi.fn());
    scene.commands.dispatch('start-game');
    expect(scene.commands.list()).toHaveLength(1);

    runner.stop();

    expect(scene.commands.list()).toEqual([]);
    expect(scene.commands.log).toEqual([]);
  });
});
