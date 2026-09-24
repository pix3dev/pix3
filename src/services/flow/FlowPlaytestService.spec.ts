import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appState } from '@/state';
import type { GameRunResult } from '@/services/agent/GameTestService';
import { FlowPlaytestService } from './FlowPlaytestService';

const runResult = (kind: NonNullable<GameRunResult['outcome']>['kind']): GameRunResult => ({
  ok: true,
  verdict: kind.toUpperCase(),
  outcome: { kind, frame: 600, gameTimeMs: 10_000, detail: kind },
  artifact: { written: true, path: 'design/tests/reports/smoke.json', bytes: 50, contains: 'run' },
});

const build = (run: GameRunResult, start: unknown = { ok: true }) => {
  const service = new FlowPlaytestService();
  const execute = vi.fn(async (name: string) => (name === 'play_stop' ? { ok: true } : start));
  const gameRun = vi.fn(async () => run);
  Object.defineProperty(service, 'tools', { value: { execute }, configurable: true });
  Object.defineProperty(service, 'gameTest', { value: { run: gameRun }, configurable: true });
  return { service, execute, gameRun };
};

describe('FlowPlaytestService', () => {
  const priorProjectId = appState.project.id;
  const priorPlaying = appState.ui.isPlaying;

  beforeEach(() => {
    appState.project.id = 'smoke-project';
    appState.ui.isPlaying = false;
  });

  afterEach(() => {
    appState.project.id = priorProjectId;
    appState.ui.isPlaying = priorPlaying;
  });

  it('runs a seeded bounded monkey probe and restores stopped play mode', async () => {
    const { service, execute, gameRun } = build(runResult('until'));
    const result = await service.smoke();

    expect(result).toMatchObject({
      status: 'passed',
      seed: 42117,
      reportPath: 'design/tests/reports/smoke.json',
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
  });

  it('keeps an already running game in play mode and classifies a crash as failed', async () => {
    appState.ui.isPlaying = true;
    const { service, execute } = build(runResult('fail'));
    expect((await service.smoke()).status).toBe('failed');
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
});
