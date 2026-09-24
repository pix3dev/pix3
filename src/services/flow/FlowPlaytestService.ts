import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { AgentToolRegistry } from '@/services/agent/AgentToolRegistry';
import { GameTestService, type GameRunResult } from '@/services/agent/GameTestService';

export type FlowSmokeStatus = 'passed' | 'failed' | 'inconclusive' | 'skipped';

export interface FlowSmokeResult {
  readonly status: FlowSmokeStatus;
  readonly reason: string;
  readonly seed: number;
  readonly reportPath: string | null;
}

const SMOKE_SEED = 42117;
const SMOKE_FRAMES = 600;

/**
 * A bounded, model-free crash and input smoke test between autonomous increments.
 * `game_run` owns and restores the clock and input it drives; this service restores whether play
 * mode was open on entry. A missing control inventory is inconclusive, never a green run.
 */
@injectable()
export class FlowPlaytestService {
  @inject(AgentToolRegistry)
  private readonly tools!: AgentToolRegistry;

  @inject(GameTestService)
  private readonly gameTest!: GameTestService;

  private busy = false;

  async smoke(signal?: AbortSignal): Promise<FlowSmokeResult> {
    if (signal?.aborted) {
      return this.result('skipped', 'The playtest was cancelled before it started.');
    }
    if (this.busy) {
      return this.result('skipped', 'Another playtest still owns the game runtime.');
    }
    const projectId = appState.project.id;
    if (!projectId) {
      return this.result('inconclusive', 'There is no open project to playtest.');
    }
    this.busy = true;
    const wasPlaying = appState.ui.isPlaying;
    try {
      const start = await this.tools.execute(wasPlaying ? 'play_restart' : 'play_start');
      if (appState.project.id !== projectId) {
        return this.result('inconclusive', 'The project changed before the smoke run started.');
      }
      if (signal?.aborted) {
        return this.result('skipped', 'The playtest was cancelled before the frame probe.');
      }
      if (!isSuccessfulToolResult(start)) {
        return this.result('failed', 'The game did not start for the smoke run.');
      }
      const parsed = GameTestService.parseSpec({
        until: [{ kind: 'frames', n: SMOKE_FRAMES }],
        fail: [{ kind: 'newErrors' }],
        monkey: { seed: SMOKE_SEED },
        maxFrames: SMOKE_FRAMES,
        maxWallMs: 20_000,
        pauseOnOutcome: false,
      });
      if ('error' in parsed) {
        return this.result('inconclusive', `The smoke contract is invalid: ${parsed.error}`);
      }
      const run = await this.gameTest.run(parsed.spec, signal);
      if (appState.project.id !== projectId) {
        return this.result('inconclusive', 'The project changed during the smoke run.');
      }
      return this.classify(run);
    } catch (error) {
      if (signal?.aborted) {
        return this.result('skipped', 'The playtest was cancelled by the user.');
      }
      return this.result(
        'inconclusive',
        `The smoke harness stopped: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (!wasPlaying && appState.project.id === projectId) {
        await this.tools.execute('play_stop').catch(() => undefined);
      }
      this.busy = false;
    }
  }

  private classify(run: GameRunResult): FlowSmokeResult {
    const reportPath = run.artifact?.written ? run.artifact.path : null;
    if (!run.ok || !run.outcome) {
      return this.result(
        'inconclusive',
        run.error ?? 'The game_run probe returned no outcome.',
        reportPath
      );
    }
    switch (run.outcome.kind) {
      case 'until':
        return this.result(
          'passed',
          `Seed ${SMOKE_SEED}: ${run.verdict ?? 'frame budget reached without a crash'}`,
          reportPath
        );
      case 'fail':
      case 'error':
        return this.result('failed', run.verdict ?? run.outcome.detail, reportPath);
      default:
        return this.result('inconclusive', run.verdict ?? run.outcome.detail, reportPath);
    }
  }

  private result(
    status: FlowSmokeStatus,
    reason: string,
    reportPath: string | null = null
  ): FlowSmokeResult {
    return { status, reason, seed: SMOKE_SEED, reportPath };
  }
}

const isSuccessfulToolResult = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && 'ok' in value && value.ok === true;
