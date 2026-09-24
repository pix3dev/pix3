import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appState } from '@/state';
import type { GameRunResult } from '@/services/agent/GameTestService';
import { FlowPlaytestService } from './FlowPlaytestService';
import { decodeTerminalFrame, terminalVisualChange } from './terminal-visual';

vi.mock('./terminal-visual', () => ({
  decodeTerminalFrame: vi.fn(),
  terminalVisualChange: vi.fn(),
}));

const runResult = (kind: NonNullable<GameRunResult['outcome']>['kind']): GameRunResult => ({
  ok: true,
  verdict: kind.toUpperCase(),
  outcome: { kind, frame: 600, gameTimeMs: 10_000, detail: kind },
  artifact: { written: true, path: 'design/tests/reports/smoke.json', bytes: 50, contains: 'run' },
});

const build = (
  run: GameRunResult | GameRunResult[],
  start: unknown = { ok: true },
  recipe = '',
  routineOutcome: unknown = {
    ok: true,
    routine: { name: 'terminal-retry', description: 'Tap RETRY', macro: false },
    expectations: [{ index: 0, assertion: 'phase playing', met: true, detail: 'playing' }],
  },
  storageMock: unknown = { listDirectory: vi.fn(async () => []) }
) => {
  const service = new FlowPlaytestService();
  const execute = vi.fn(async (name: string, args?: unknown) => {
    if (typeof start === 'function') {
      const res = (start as (n: string, a?: unknown) => unknown)(name, args);
      if (res !== undefined) return res;
    }
    if (name === 'fs_read') return { content: recipe };
    if (name === 'game_run') return routineOutcome;
    if (name === 'play_stop') return { ok: true };
    return start;
  });
  const results = Array.isArray(run) ? [...run] : [run];
  const gameRun = vi.fn(
    async (_spec: unknown, _signal?: AbortSignal) => results.shift() ?? runResult('error')
  );
  const prepareRunProtocolStore = vi.fn();
  Object.defineProperty(service, 'tools', {
    value: { execute, prepareRunProtocolStore },
    configurable: true,
  });
  Object.defineProperty(service, 'gameTest', {
    value: { run: gameRun },
    configurable: true,
  });
  Object.defineProperty(service, 'playSession', {
    value: {
      getActiveRuntime: () => ({ runner: { running: true } }),
      captureScreenshot: () => ({ dataBase64: '', mimeType: 'image/png', width: 1, height: 1 }),
    },
    configurable: true,
  });
  Object.defineProperty(service, 'storage', { value: storageMock, configurable: true });
  return { service, execute, gameRun, prepareRunProtocolStore };
};

describe('FlowPlaytestService', () => {
  const priorProjectId = appState.project.id;
  const priorPlaying = appState.ui.isPlaying;

  beforeEach(() => {
    appState.project.id = 'smoke-project';
    appState.ui.isPlaying = false;
    vi.mocked(decodeTerminalFrame).mockReset();
    vi.mocked(terminalVisualChange).mockReset();
  });

  afterEach(() => {
    appState.project.id = priorProjectId;
    appState.ui.isPlaying = priorPlaying;
  });

  it('runs a seeded bounded monkey probe and restores stopped play mode', async () => {
    const { service, execute, gameRun, prepareRunProtocolStore } = build(runResult('until'));
    const result = await service.smoke();

    expect(result).toMatchObject({
      status: 'passed',
      seed: 42117,
      reportPath: 'design/tests/reports/smoke.json',
      terminal: { status: 'inconclusive' },
    });
    expect(execute.mock.calls.map(call => call[0])).toEqual([
      'play_start',
      'game_controls',
      'fs_read',
      'play_stop',
    ]);
    expect(gameRun).toHaveBeenCalledWith(
      expect.objectContaining({
        maxFrames: 600,
        pauseOnOutcome: false,
        monkey: expect.objectContaining({ seed: 42117 }),
      }),
      undefined
    );
    expect(prepareRunProtocolStore).toHaveBeenCalledTimes(1);
  });

  it('keeps an already running game in play mode and classifies a crash as failed', async () => {
    appState.ui.isPlaying = true;
    const { service, execute } = build({
      ...runResult('fail'),
      newErrors: [{ source: 'script', message: 'wave crash' }],
    });
    expect(await service.smoke()).toMatchObject({
      status: 'failed',
      findingKey: 'runtime:script:wave crash',
    });
    expect(execute.mock.calls.map(call => call[0])).toEqual(['play_restart']);
  });

  it('does not call an empty monkey inventory a pass', async () => {
    const { service } = build(runResult('monkey-empty'));
    expect((await service.smoke()).status).toBe('inconclusive');
  });

  it('stops after a failed game start and never drives the frame loop', async () => {
    const { service, gameRun } = build(runResult('until'), { ok: false });
    expect((await service.smoke()).status).toBe('failed');
    expect(gameRun).not.toHaveBeenCalled();
  });

  it('waits for the actual runner after play_start before driving frames', async () => {
    const { service, gameRun } = build(runResult('until'));
    let reads = 0;
    Object.defineProperty(service, 'playSession', {
      value: {
        getActiveRuntime: () => ({ runner: { running: ++reads >= 3 } }),
      },
      configurable: true,
    });

    expect((await service.smoke()).status).toBe('passed');
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(gameRun).toHaveBeenCalledTimes(1);
  });

  it('checks a known end screen for stability and a working restart', async () => {
    const first = {
      ...runResult('until'),
      game: { provider: 'recipe-arena-2d', snapshot: { phase: 'lost' } },
    };
    const stable = { ...runResult('until'), game: first.game };
    const restarted = {
      ...runResult('until'),
      game: { provider: 'recipe-arena-2d', snapshot: { phase: 'playing' } },
    };
    const { service, execute, gameRun } = build([first, stable, restarted]);
    const result = await service.smoke();

    expect(result.status).toBe('passed');
    expect(result.terminal?.status).toBe('passed');
    expect(gameRun).toHaveBeenCalledTimes(3);
    expect(gameRun.mock.calls[1]?.[0]).toMatchObject({
      maxFrames: 120,
      fail: expect.arrayContaining([
        expect.objectContaining({ kind: 'gameState', path: 'phase', op: 'ne', value: 'lost' }),
      ]),
    });
    expect(execute.mock.calls.map(call => call[0])).toEqual([
      'play_start',
      'game_controls',
      'fs_read',
      'play_restart',
      'play_stop',
    ]);
  });

  it('finds a large pulse under a static terminal contract after sampling game frames', async () => {
    const ended = {
      ...runResult('until'),
      game: { provider: 'recipe-tapper-2d', snapshot: { phase: 'lost' } },
    };
    const restarted = {
      ...runResult('until'),
      game: { provider: 'recipe-tapper-2d', snapshot: { phase: 'playing' } },
    };
    vi.mocked(decodeTerminalFrame).mockResolvedValue({
      width: 1,
      height: 1,
      pixels: new Uint8ClampedArray(4),
    });
    vi.mocked(terminalVisualChange).mockReturnValue([0.02, 0.25, 0.24, 0.02]);
    const { service, gameRun } = build(
      [ended, ended, ended, ended, ended, ended, restarted],
      { ok: true },
      '## Playtest contract\nterminalVisual: static\n## Verify'
    );
    const result = await service.smoke();
    expect(result).toMatchObject({
      status: 'failed',
      findingKey: 'terminal-visual-large-change',
      terminal: { status: 'failed' },
      visual: { status: 'failed', changedFractions: [0.02, 0.25, 0.24, 0.02] },
    });
    expect(gameRun).toHaveBeenCalledTimes(7);
    expect(gameRun.mock.calls[2]?.[0]).toMatchObject({ maxFrames: 15 });
  });

  it('accepts permitted terminal animation without pixel sampling', async () => {
    const ended = {
      ...runResult('until'),
      game: { provider: 'recipe-tapper-2d', snapshot: { phase: 'lost' } },
    };
    const restarted = {
      ...runResult('until'),
      game: { provider: 'recipe-tapper-2d', snapshot: { phase: 'playing' } },
    };
    const { service, gameRun } = build(
      [ended, ended, restarted],
      { ok: true },
      '## Playtest contract\nterminalVisual: animated\n## Verify'
    );
    expect(await service.smoke()).toMatchObject({
      status: 'passed',
      visual: { status: 'inconclusive' },
      terminal: { status: 'passed' },
    });
    expect(gameRun).toHaveBeenCalledTimes(3);
    expect(decodeTerminalFrame).not.toHaveBeenCalled();
  });

  it('uses the contracted physical RETRY routine and verifies the restarted phase', async () => {
    const ended = {
      ...runResult('until'),
      game: { provider: 'recipe-tapper-2d', snapshot: { phase: 'lost' } },
    };
    const restarted = {
      ...runResult('until'),
      game: { provider: 'recipe-tapper-2d', snapshot: { phase: 'playing' } },
    };
    const { service, execute } = build(
      [ended, ended, restarted],
      { ok: true },
      '## Playtest contract\nterminalVisual: animated\nterminalRestartRoutine: terminal-retry\n## Verify'
    );
    expect(await service.smoke()).toMatchObject({
      status: 'passed',
      terminal: { status: 'passed', reason: expect.stringContaining('RETRY') },
    });
    expect(execute).toHaveBeenCalledWith('game_run', { routine: 'terminal-retry' });
    expect(execute.mock.calls.map(call => call[0])).toEqual([
      'play_start',
      'game_controls',
      'fs_read',
      'game_run',
      'play_stop',
    ]);
  });

  it('files a stable defect when the physical RETRY routine cannot prove its control', async () => {
    const ended = {
      ...runResult('until'),
      game: { provider: 'recipe-tapper-2d', snapshot: { phase: 'lost' } },
    };
    const { service } = build(
      [ended, ended],
      { ok: true },
      '## Playtest contract\nterminalRestartRoutine: terminal-retry\n## Verify',
      {
        ok: true,
        verdict: 'ROUTINE FAIL terminal-retry — phase = lost',
        routine: { name: 'terminal-retry', description: 'Tap RETRY', macro: false },
        expectations: [{ index: 0, assertion: 'phase playing', met: false, detail: 'lost' }],
        artifact: { written: true, path: 'design/tests/reports/retry-fail.json' },
      }
    );
    expect(await service.smoke()).toMatchObject({
      status: 'failed',
      findingKey: 'terminal-restart-control',
      reportPath: 'design/tests/reports/retry-fail.json',
      terminal: { status: 'failed' },
    });
  });

  it('treats a phase change after game over as a failed terminal probe', async () => {
    const first = {
      ...runResult('until'),
      game: { provider: 'playable-2d', snapshot: { phase: 'ended' } },
    };
    const { service, execute } = build([first, runResult('fail')]);
    const result = await service.smoke();

    expect(result.status).toBe('failed');
    expect(result.terminal?.status).toBe('failed');
    expect(execute.mock.calls.map(call => call[0])).toEqual([
      'play_start',
      'game_controls',
      'fs_read',
      'play_stop',
    ]);
  });

  it('does not call a terminal probe green without a terminal snapshot', async () => {
    const first = {
      ...runResult('until'),
      game: { provider: 'recipe-tapper-2d', snapshot: { phase: 'lost' } },
    };
    const { service } = build([first, runResult('until')]);
    const result = await service.smoke();

    expect(result.status).toBe('inconclusive');
    expect(result.terminal?.status).toBe('inconclusive');
  });

  it('continues a known recipe without input until its end screen appears', async () => {
    const provider = 'recipe-bouncer-2d';
    const first = { ...runResult('until'), game: { provider, snapshot: { phase: 'playing' } } };
    const ended = { ...runResult('until'), game: { provider, snapshot: { phase: 'lost' } } };
    const restarted = { ...runResult('until'), game: { provider, snapshot: { phase: 'playing' } } };
    const { service, gameRun } = build([first, ended, ended, restarted]);

    expect((await service.smoke()).terminal?.status).toBe('passed');
    expect(gameRun).toHaveBeenCalledTimes(4);
    expect(gameRun.mock.calls[1]?.[0]).toMatchObject({
      maxFrames: 1800,
      until: expect.arrayContaining([
        expect.objectContaining({ kind: 'gameState', path: 'phase', value: 'lost' }),
      ]),
    });
  });

  it('leaves an unreached terminal state inconclusive without failing the crash smoke', async () => {
    const first = {
      ...runResult('until'),
      game: { provider: 'recipe-arena-2d', snapshot: { phase: 'playing' } },
    };
    const { service } = build([first, runResult('timeout')]);
    const result = await service.smoke();

    expect(result.status).toBe('passed');
    expect(result.terminal?.status).toBe('inconclusive');
  });

  it('does not pass the suite when terminal discovery could not run', async () => {
    const first = {
      ...runResult('until'),
      game: { provider: 'recipe-arena-2d', snapshot: { phase: 'playing' } },
    };
    const { service } = build([first, { ok: false, error: 'runtime detached' }]);
    const result = await service.smoke();

    expect(result.status).toBe('inconclusive');
    expect(result.terminal?.status).toBe('inconclusive');
  });

  it('calls a runner detached at frame zero inconclusive instead of filing a game defect', async () => {
    const detached: GameRunResult = {
      ...runResult('error'),
      outcome: {
        kind: 'error',
        frame: 0,
        gameTimeMs: 0,
        detail: 'the runner stopped at frame 0 (the scene is no longer running)',
      },
    };
    const { service } = build(detached);
    expect((await service.smoke()).status).toBe('inconclusive');
  });

  it('fails smoke when an active control is reported with unknown reach', async () => {
    const { service } = build(runResult('until'), (name: string) => {
      if (name === 'game_controls') {
        return {
          ok: true,
          controls: [{ name: 'jump-btn', visible: true, enabled: true, reach: 'unknown' }],
        };
      }
      return { ok: true };
    });
    const result = await service.smoke();
    expect(result).toMatchObject({
      status: 'failed',
      findingKey: 'control-unreachable:jump-btn',
      reason: 'Control "jump-btn" is visible but has unknown reach.',
    });
  });

  it('executes non-terminal routine files and reports failures', async () => {
    const storageMock = {
      listDirectory: vi.fn(async () => [
        { name: 'score-routine.json', path: 'design/tests/routines/score-routine.json', kind: 'file' },
        { name: 'terminal-retry.json', path: 'design/tests/routines/terminal-retry.json', kind: 'file' },
      ]),
    };
    const { service, execute } = build(
      runResult('until'),
      (name: string, args: unknown) => {
        if (name === 'game_run' && (args as { routine?: string })?.routine === 'score-routine') {
          return {
            ok: false,
            verdict: 'FAIL score',
            routine: { name: 'score-routine', description: 'Score check', macro: false },
            expectations: [{ index: 0, assertion: 'score > 0', met: false, detail: '0' }],
            artifact: { written: true, path: 'design/tests/reports/score-fail.json' },
          };
        }
        return { ok: true };
      },
      '## Playtest contract\nterminalRestartRoutine: terminal-retry\n## Verify',
      undefined,
      storageMock
    );

    const result = await service.smoke();
    expect(result).toMatchObject({
      status: 'failed',
      findingKey: 'routine:score-routine',
      reason: 'FAIL score',
      reportPath: 'design/tests/reports/score-fail.json',
    });
    expect(execute).toHaveBeenCalledWith('game_run', { routine: 'score-routine' });
    // terminal-retry should be skipped during routine probe because it matches terminalRestartRoutine
    expect(execute).not.toHaveBeenCalledWith('game_run', { routine: 'terminal-retry' });
  });

  it('classifies a failed negative control as control:negative-failed', async () => {
    const runWithFailedControl: GameRunResult = {
      ...runResult('until'),
      control: {
        verdict: 'failed',
        outcome: { kind: 'fail', frame: 10, gameTimeMs: 160, detail: 'jump occurred without tap' },
        note: 'jump occurred without tap',
        isolation: { method: 'reset', ok: true, detail: 'reset ok' },
        gesture: 'tap away from button',
        frames: { main: 60, control: 60 },
      },
      verdict: 'Negative control failed: jumped without tap',
    };
    const { service } = build(runWithFailedControl);
    const result = await service.smoke();
    expect(result).toMatchObject({
      status: 'failed',
      findingKey: 'control:negative-failed:fail',
      reason: 'Negative control failed: jumped without tap',
    });
  });

  describe('recipe template controls scan and routines', () => {
    it('verifies recipe-bouncer-2d controls and terminal-retry routine pass', async () => {
      const storageMock = {
        listDirectory: vi.fn(async () => [
          { name: 'terminal-retry.json', path: 'design/tests/routines/terminal-retry.json', kind: 'file' },
        ]),
      };
      const { service, execute } = build(
        runResult('until'),
        (name: string) => {
          if (name === 'game_controls') {
            return {
              ok: true,
              controls: [
                { name: 'paddle-drag', visible: true, enabled: true, reach: 'reachable' },
                { name: 'retry-button', visible: true, enabled: true, reach: 'hidden-by-ancestor' },
              ],
            };
          }
          return { ok: true };
        },
        '## Playtest contract\nterminalRestartRoutine: terminal-retry\n## Verify',
        undefined,
        storageMock
      );
      const result = await service.smoke();
      expect(result.status).toBe('passed');
      expect(execute).toHaveBeenCalledWith('game_controls');
    });

    it('verifies recipe-arena-2d controls and terminal-retry routine pass', async () => {
      const storageMock = {
        listDirectory: vi.fn(async () => [
          { name: 'terminal-retry.json', path: 'design/tests/routines/terminal-retry.json', kind: 'file' },
        ]),
      };
      const { service, execute } = build(
        runResult('until'),
        (name: string) => {
          if (name === 'game_controls') {
            return {
              ok: true,
              controls: [
                { name: 'virtual-joystick', visible: true, enabled: true, reach: 'reachable' },
                { name: 'fire-button', visible: true, enabled: true, reach: 'reachable' },
                { name: 'retry-button', visible: true, enabled: true, reach: 'hidden-by-ancestor' },
              ],
            };
          }
          return { ok: true };
        },
        '## Playtest contract\nterminalRestartRoutine: terminal-retry\n## Verify',
        undefined,
        storageMock
      );
      const result = await service.smoke();
      expect(result.status).toBe('passed');
      expect(execute).toHaveBeenCalledWith('game_controls');
    });

    it('verifies recipe-blank-2d controls and runs its extra restart routine', async () => {
      const storageMock = {
        listDirectory: vi.fn(async () => [
          { name: 'restart.json', path: 'design/tests/routines/restart.json', kind: 'file' },
          { name: 'terminal-retry.json', path: 'design/tests/routines/terminal-retry.json', kind: 'file' },
        ]),
      };
      const { service, execute } = build(
        runResult('until'),
        (name: string, args: unknown) => {
          if (name === 'game_controls') {
            return {
              ok: true,
              controls: [
                { name: 'retry-button', visible: true, enabled: true, reach: 'hidden-by-ancestor' },
              ],
            };
          }
          if (name === 'game_run' && (args as { routine?: string })?.routine === 'restart') {
            return {
              ok: true,
              routine: { name: 'restart', description: 'Restart check', macro: false },
              expectations: [{ index: 0, assertion: 'phase playing', met: true, detail: 'playing' }],
            };
          }
          return { ok: true };
        },
        '## Playtest contract\nterminalRestartRoutine: terminal-retry\n## Verify',
        undefined,
        storageMock
      );
      const result = await service.smoke();
      expect(result.status).toBe('passed');
      expect(execute).toHaveBeenCalledWith('game_controls');
      expect(execute).toHaveBeenCalledWith('game_run', { routine: 'restart' });
    });

    it('fails smoke when an enabled visible control is off-screen', async () => {
      const { service } = build(
        runResult('until'),
        (name: string) => {
          if (name === 'game_controls') {
            return {
              ok: true,
              controls: [
                { name: 'escape-btn', visible: true, enabled: true, reach: 'off-screen' },
              ],
            };
          }
          return { ok: true };
        }
      );
      const result = await service.smoke();
      expect(result).toMatchObject({
        status: 'failed',
        findingKey: 'control-off-screen:escape-btn',
        reason: 'Control "escape-btn" is visible but off-screen.',
      });
    });

    it('fails smoke when an enabled visible control is in-frame-unproven', async () => {
      const { service } = build(
        runResult('until'),
        (name: string) => {
          if (name === 'game_controls') {
            return {
              ok: true,
              controls: [
                { name: 'unproven-btn', visible: true, enabled: true, reach: 'in-frame-unproven' },
              ],
            };
          }
          return { ok: true };
        }
      );
      const result = await service.smoke();
      expect(result).toMatchObject({
        status: 'failed',
        findingKey: 'control-unproven:unproven-btn',
        reason: 'Control "unproven-btn" is visible but in-frame-unproven (no physical proof in reachability.json or session).',
      });
    });

    it('returns inconclusive if reading routines directory fails with storage error', async () => {
      const storageMock = {
        listDirectory: vi.fn(async () => {
          throw new Error('EACCES: permission denied');
        }),
      };
      const { service } = build(
        runResult('until'),
        { ok: true },
        '',
        undefined,
        storageMock
      );
      const result = await service.smoke();
      expect(result).toMatchObject({
        status: 'inconclusive',
        reason: expect.stringContaining('Failed to read routines directory: EACCES'),
      });
    });
  });
});
