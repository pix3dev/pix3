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
  }
) => {
  const service = new FlowPlaytestService();
  const execute = vi.fn(async (name: string) =>
    name === 'fs_read'
      ? { content: recipe }
      : name === 'game_run'
        ? routineOutcome
        : name === 'play_stop'
          ? { ok: true }
          : start
  );
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
    expect(execute.mock.calls.map(call => call[0])).toEqual(['play_start', 'play_stop']);
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
    expect(execute.mock.calls.map(call => call[0])).toEqual(['play_start', 'play_stop']);
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
});
