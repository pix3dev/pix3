import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_COMPONENT_TYPE_PREFIX, type ScriptErrorInfo } from '@pix3/runtime';
import { RuntimeErrorBridgeService } from '@/services/play/RuntimeErrorBridgeService';
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
