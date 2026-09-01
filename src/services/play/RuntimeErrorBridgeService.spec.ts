import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_COMPONENT_TYPE_PREFIX, type ScriptErrorInfo } from '@pix3/runtime';
import {
  isGameOriginatedStack,
  RuntimeErrorBridgeService,
} from '@/services/play/RuntimeErrorBridgeService';
import { appState } from '@/state';

/**
 * The split between "the game threw" and "the test harness threw".
 *
 * This is not a logging-taste question. The editor captures `console.error` into a ring
 * buffer, the gameplay harness counts that ring to decide `newErrors`, and a run may
 * carry `newErrors` as its crash net — checked BEFORE the bot's own verdict. Measured
 * live before the branch under test existed: a policy with a typo ended its run as
 * "the GAME threw 3 errors" on the frame it died. So a `test:`-prefixed failure has to
 * stay visible to a human and stay out of the error stream, and those are exactly the
 * two things asserted here.
 */
describe('RuntimeErrorBridgeService — harness errors vs game errors', () => {
  const logs: Array<{ level: 'warn' | 'error'; message: string; data?: unknown }> = [];

  const build = (): RuntimeErrorBridgeService => {
    const service = new RuntimeErrorBridgeService();
    Object.defineProperty(service, 'loggingService', {
      value: {
        warn: (message: string, data?: unknown) => logs.push({ level: 'warn', message, data }),
        error: (message: string, data?: unknown) => logs.push({ level: 'error', message, data }),
      },
      configurable: true,
    });
    return service;
  };

  /** Reach the sink the way the runtime does, without installing window listeners. */
  const report = (service: RuntimeErrorBridgeService, error: ScriptErrorInfo): void => {
    (service as unknown as { handleScriptError: (e: ScriptErrorInfo) => void }).handleScriptError(
      error
    );
  };

  beforeEach(() => {
    logs.length = 0;
    appState.ui.isPlaying = true;
    appState.ui.playModeError = null;
  });

  it('logs a game script error as an error and raises the Game-tab banner', () => {
    const service = build();
    report(service, {
      phase: 'update',
      message: 'TypeError: cannot read x',
      nodeName: 'Player',
      componentType: 'user:PlayerController',
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('error');
    expect(logs[0].message).toContain('Script error [update] in "Player" (user:PlayerController)');
    expect(appState.ui.playModeError?.message).toBe('TypeError: cannot read x');
  });

  it('logs a test-harness error as a WARNING, so it never enters the error ring', () => {
    const service = build();
    report(service, {
      phase: 'update',
      message: 'TypeError: hero is undefined',
      componentType: `${TEST_COMPONENT_TYPE_PREFIX}bot`,
      componentId: 'dodge',
    });

    expect(logs).toHaveLength(1);
    // `installErrorCapture` patches `console.error` only — the level IS the mechanism.
    expect(logs[0].level).toBe('warn');
    expect(logs[0].message).toContain('Test harness error [update]');
    expect(logs[0].message).toContain('hero is undefined');
  });

  it('raises no play-mode banner for a harness error', () => {
    const service = build();
    report(service, {
      phase: 'update',
      message: 'TypeError: hero is undefined',
      componentType: `${TEST_COMPONENT_TYPE_PREFIX}bot`,
    });

    // A banner announcing that the game failed would be the same lie in the UI.
    expect(appState.ui.playModeError).toBeNull();
  });

  it('says out loud that the harness failure is not counted as a runtime error', () => {
    const service = build();
    report(service, {
      phase: 'update',
      message: 'boom',
      componentType: `${TEST_COMPONENT_TYPE_PREFIX}bot`,
    });

    // The reader of the Logs panel has to be able to tell why this one is a warning.
    expect(JSON.stringify(logs[0].data)).toContain('not counted as a runtime error');
  });

  it('treats an unprefixed componentType as game code', () => {
    const service = build();
    report(service, { phase: 'start', message: 'boom', componentType: 'core:Follow' });
    expect(logs[0].level).toBe('error');
  });

  it('still logs a late harness error after play stopped, without a banner', () => {
    const service = build();
    appState.ui.isPlaying = false;
    report(service, {
      phase: 'detach',
      message: 'boom',
      componentType: `${TEST_COMPONENT_TYPE_PREFIX}bot`,
    });
    expect(logs[0].level).toBe('warn');
    expect(appState.ui.playModeError).toBeNull();
  });

  it('mocks nothing about the prefix — it comes from the runtime contract', () => {
    // A local copy of `'test:'` here would let the two sides drift apart silently.
    expect(TEST_COMPONENT_TYPE_PREFIX).toBe('test:');
    expect(vi.isMockFunction(report)).toBe(false);
  });
});

/**
 * Mirroring a running game's own output into the Logs panel. Before this, `console.log` from a
 * game and every signal it fired existed only in devtools — the panel could show you a game that
 * had crashed but never one that was quietly doing the wrong thing.
 */
describe('RuntimeErrorBridgeService — game console and signals', () => {
  const logs: Array<{ source: string; level: string; message: string; data?: unknown }> = [];

  const build = (): RuntimeErrorBridgeService => {
    const service = new RuntimeErrorBridgeService();
    Object.defineProperty(service, 'loggingService', {
      value: {
        warn: () => undefined,
        error: () => undefined,
        logFrom: (source: string, level: string, message: string, data?: unknown) =>
          logs.push({ source, level, message, data }),
      },
      configurable: true,
    });
    return service;
  };

  const emitSignal = (
    service: RuntimeErrorBridgeService,
    info: {
      nodeId: string;
      nodeName: string;
      signal: string;
      listenerCount: number;
      args: unknown[];
    }
  ): void => {
    (service as unknown as { handleSignalEmit: (i: typeof info) => void }).handleSignalEmit(info);
  };

  const syncConsole = (service: RuntimeErrorBridgeService): void => {
    (
      service as unknown as { syncGameConsoleInterception: () => void }
    ).syncGameConsoleInterception();
  };

  /**
   * Stand in for the stack sniffing. The bridge decides whether a console call came from the game
   * by looking for a `blob:` frame (where in-editor user scripts are imported from); V8 installs
   * `stack` as an own property at construction, so it cannot be faked from `Error.prototype`.
   */
  const setOrigin = (service: RuntimeErrorBridgeService, fromGame: boolean): void => {
    Object.defineProperty(service, 'isGameOriginatedLog', {
      value: () => fromGame,
      configurable: true,
    });
  };

  beforeEach(() => {
    logs.length = 0;
    appState.ui.isPlaying = false;
  });

  it('logs an emitted signal with its listener count', () => {
    const service = build();
    emitSignal(service, {
      nodeId: 'coin-1',
      nodeName: 'Coin',
      signal: 'collected',
      listenerCount: 2,
      args: [7],
    });

    expect(logs).toEqual([
      {
        source: 'game',
        level: 'debug',
        message: 'Signal "collected" from Coin → 2 listener(s)',
        data: { args: [7] },
      },
    ]);
  });

  it('shows a signal that fired into nothing — the case that is otherwise invisible', () => {
    const service = build();
    emitSignal(service, {
      nodeId: 'door-1',
      nodeName: 'Door',
      signal: 'opened',
      listenerCount: 0,
      args: [],
    });

    expect(logs[0].message).toContain('0 listener(s)');
    expect(logs[0].data).toBeUndefined();
  });

  it('mirrors the game console only while play mode is running', () => {
    const service = build();
    const pristineLog = console.log;

    // Not playing: the console is untouched and nothing is mirrored.
    syncConsole(service);
    expect(console.log).toBe(pristineLog);
    console.log('before play');
    expect(logs).toHaveLength(0);

    setOrigin(service, true);
    appState.ui.isPlaying = true;
    syncConsole(service);
    console.log('score is', 3);
    console.warn('low on lives');

    expect(logs).toEqual([
      { source: 'game', level: 'info', message: 'score is 3', data: undefined },
      { source: 'game', level: 'warn', message: 'low on lives', data: undefined },
    ]);

    // Stopping play puts the original methods back.
    appState.ui.isPlaying = false;
    syncConsole(service);
    expect(console.log).toBe(pristineLog);
    console.log('after play');
    expect(logs).toHaveLength(2);
  });

  it('drops editor chatter when the stack says the call did not come from a game script', () => {
    // The failure this prevents: `[LayoutManager]` / `[Atlas]` / `[InputService]` lines filed under
    // "game" — observed live before the filter existed. A label that lies is worse than no bridge.
    const service = build();
    setOrigin(service, false);
    appState.ui.isPlaying = true;
    syncConsole(service);

    console.log('[LayoutManager] Attempting async focus');

    appState.ui.isPlaying = false;
    syncConsole(service);
    expect(logs).toHaveLength(0);
  });

  it('keeps a log whose stack points at a user script bundle', () => {
    const service = build();
    setOrigin(service, true);
    appState.ui.isPlaying = true;
    syncConsole(service);

    console.log('board reset');

    appState.ui.isPlaying = false;
    syncConsole(service);
    expect(logs).toEqual([
      { source: 'game', level: 'info', message: 'board reset', data: undefined },
    ]);
  });

  it('does not loop when the logging service echoes back to the console', () => {
    const service = build();
    Object.defineProperty(service, 'loggingService', {
      value: {
        warn: () => undefined,
        error: () => undefined,
        // LoggingService writes to the console itself in DEV — straight back into the patch.
        logFrom: (source: string, level: string, message: string) => {
          logs.push({ source, level, message });
          console.log(`[Pix3 ${level.toUpperCase()}] ${message}`);
        },
      },
      configurable: true,
    });

    setOrigin(service, true);
    appState.ui.isPlaying = true;
    syncConsole(service);
    console.log('one line');
    appState.ui.isPlaying = false;
    syncConsole(service);

    // Exactly one entry: the echo is swallowed rather than re-forwarded forever.
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('one line');
  });
});

describe('isGameOriginatedStack', () => {
  it('accepts a frame from the user-script blob bundle', () => {
    expect(
      isGameOriginatedStack('Error\n    at GameRules.onUpdate (blob:http://localhost:8123/x:1:1)')
    ).toBe(true);
  });

  it('rejects a frame from the editor bundle', () => {
    expect(
      isGameOriginatedStack(
        'Error\n    at LayoutManager.focus (http://localhost:8123/src/x.ts:1:1)'
      )
    ).toBe(false);
  });

  it('fails open when there is no stack — losing the game log is the worse failure', () => {
    expect(isGameOriginatedStack(undefined)).toBe(true);
  });
});
