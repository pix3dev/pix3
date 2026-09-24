import { inject, injectable } from '@/fw/di';
import { appState } from '@/state';
import { AgentToolRegistry } from '@/services/agent/AgentToolRegistry';
import { GameTestService, type GameRunResult } from '@/services/agent/GameTestService';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { decodeTerminalFrame, terminalVisualChange } from './terminal-visual';

export type FlowSmokeStatus = 'passed' | 'failed' | 'inconclusive' | 'skipped';

export interface FlowSmokeResult {
  readonly status: FlowSmokeStatus;
  readonly reason: string;
  readonly seed: number;
  readonly reportPath: string | null;
  /** Stable finding identity, independent of frame number and verdict wording. */
  readonly findingKey?: string;
  readonly terminal?: { readonly status: FlowSmokeStatus; readonly reason: string };
  readonly visual?: {
    readonly status: FlowSmokeStatus;
    readonly reason: string;
    readonly changedFractions?: readonly number[];
  };
}

const SMOKE_SEED = 42117;
const SMOKE_FRAMES = 600;
const TERMINAL_FRAMES = 120;
const TERMINAL_DISCOVERY_FRAMES = 1800;
const START_READY_MS = 3000;
const VISUAL_SAMPLE_FRAMES = 15;
const VISUAL_SAMPLES = 5;
const LARGE_VISUAL_CHANGE = 0.12;
/** These shipped recipes explicitly keep their phase at the end screen until restart. */
const TERMINAL_PROVIDERS = new Set([
  'recipe-arena-2d',
  'recipe-bouncer-2d',
  'recipe-tapper-2d',
  'recipe-blank-2d',
  'recipe-grid-3d',
  'playable-2d',
  'playable-3d',
]);
const TERMINAL_PHASES = new Set(['won', 'lost', 'ended']);

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

  @inject(GamePlaySessionService)
  private readonly playSession!: GamePlaySessionService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

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
        return this.result(
          'failed',
          'The game did not start for the smoke run.',
          null,
          'play-start'
        );
      }
      if (!(await this.waitForRunner(projectId, signal))) {
        return this.result(
          'inconclusive',
          'Play mode started but its runner was not ready within 3 seconds.'
        );
      }
      this.tools.prepareRunProtocolStore();
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
      const core = this.classify(run);
      if (core.status !== 'passed') return core;
      const controls = await this.probeControls(projectId);
      if (controls && controls.status !== 'passed') return controls;
      const contract = await this.readPlaytestContract();
      const restartRoutine = contract.match(/^terminalRestartRoutine:\s*([a-z0-9-]+)\s*$/m)?.[1];
      const routines = await this.probeRoutines(projectId, restartRoutine, signal);
      if (routines && routines.status !== 'passed') return routines;
      return await this.probeTerminal(run, core, projectId, contract, restartRoutine, signal);
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

  private async probeTerminal(
    run: GameRunResult,
    core: FlowSmokeResult,
    projectId: string,
    contractText?: string,
    routineName?: string,
    signal?: AbortSignal
  ): Promise<FlowSmokeResult> {
    let phase = snapshotPhase(run);
    if (!run.game || !TERMINAL_PROVIDERS.has(run.game.provider)) {
      return {
        ...core,
        terminal: { status: 'inconclusive', reason: 'No known terminal-state contract.' },
      };
    }
    if (!phase || !TERMINAL_PHASES.has(phase)) {
      const discovery = GameTestService.parseSpec({
        until: [...TERMINAL_PHASES].map(value => ({
          kind: 'gameState',
          path: 'phase',
          op: 'eq',
          value,
        })),
        fail: [{ kind: 'newErrors' }],
        maxFrames: TERMINAL_DISCOVERY_FRAMES,
        maxWallMs: 20_000,
        pauseOnOutcome: false,
      });
      if ('error' in discovery) {
        return { ...core, terminal: { status: 'inconclusive', reason: discovery.error } };
      }
      const discovered = await this.gameTest.run(discovery.spec, signal);
      if (signal?.aborted || appState.project.id !== projectId) {
        return this.result('skipped', 'The terminal discovery was cancelled.');
      }
      const discoveryVerdict = this.classify(discovered);
      if (discoveryVerdict.status === 'failed') {
        return {
          ...discoveryVerdict,
          terminal: { status: 'failed', reason: discoveryVerdict.reason },
        };
      }
      if (!discovered.ok) {
        return {
          ...discoveryVerdict,
          terminal: { status: 'inconclusive', reason: discoveryVerdict.reason },
        };
      }
      phase = snapshotPhase(discovered);
      if (discoveryVerdict.status !== 'passed' || !phase || !TERMINAL_PHASES.has(phase)) {
        return {
          ...core,
          terminal: {
            status: 'inconclusive',
            reason: 'No end screen was reached in the bounded idle probe.',
          },
        };
      }
    }
    const parsed = GameTestService.parseSpec({
      until: [{ kind: 'frames', n: TERMINAL_FRAMES }],
      fail: [{ kind: 'newErrors' }, { kind: 'gameState', path: 'phase', op: 'ne', value: phase }],
      maxFrames: TERMINAL_FRAMES,
      maxWallMs: 10_000,
      pauseOnOutcome: false,
    });
    if ('error' in parsed) {
      return { ...core, terminal: { status: 'inconclusive', reason: parsed.error } };
    }
    const stable = await this.gameTest.run(parsed.spec, signal);
    if (signal?.aborted || appState.project.id !== projectId) {
      return this.result('skipped', 'The terminal probe was cancelled.');
    }
    const verdict = this.classify(stable);
    if (verdict.status !== 'passed') {
      return { ...verdict, terminal: { status: verdict.status, reason: verdict.reason } };
    }
    if (snapshotPhase(stable) !== phase) {
      return {
        ...this.result(
          'inconclusive',
          'The stability probe did not report the expected terminal phase.',
          verdict.reportPath
        ),
        terminal: {
          status: 'inconclusive',
          reason: 'No terminal snapshot at the end of the stability probe.',
        },
      };
    }
    const contract = contractText ?? (await this.readPlaytestContract());
    const visual = await this.probeVisual(phase, projectId, contract, signal);
    if (signal?.aborted || appState.project.id !== projectId) {
      return this.result('skipped', 'The visual probe was cancelled.');
    }
    const restartRoutine =
      routineName ?? contract.match(/^terminalRestartRoutine:\s*([a-z0-9-]+)\s*$/m)?.[1];
    const routineResult = restartRoutine
      ? await this.tools.execute('game_run', { routine: restartRoutine })
      : null;
    const routine =
      routineResult && typeof routineResult === 'object' && 'ok' in routineResult
        ? (routineResult as Awaited<ReturnType<GameTestService['runRoutine']>>)
        : null;
    const restarted = restartRoutine ? null : await this.tools.execute('play_restart');
    if (signal?.aborted || appState.project.id !== projectId) {
      return this.result('skipped', 'The restart probe was cancelled.');
    }
    if (
      restartRoutine &&
      (!routine ||
        !routine.ok ||
        routine.routine?.macro ||
        !routine.expectations?.length ||
        routine.expectations.some(expectation => !expectation.met) ||
        (routine.newErrors?.length ?? 0) > 0)
    ) {
      const reason =
        routine?.verdict ?? routine?.error ?? 'The terminal restart routine did not pass.';
      return {
        ...this.result(
          'failed',
          reason,
          routine?.artifact?.written ? routine.artifact.path : verdict.reportPath,
          'terminal-restart-control'
        ),
        terminal: { status: 'failed', reason },
      };
    }
    if (!routine && !isSuccessfulToolResult(restarted)) {
      return {
        ...this.result(
          'failed',
          'The game did not restart from its end screen.',
          verdict.reportPath,
          'terminal-restart'
        ),
        terminal: { status: 'failed', reason: 'Restart failed.' },
      };
    }
    if (!(await this.waitForRunner(projectId, signal))) {
      return {
        ...this.result(
          'inconclusive',
          'Restart did not attach a running scene within 3 seconds.',
          verdict.reportPath
        ),
        terminal: { status: 'inconclusive', reason: 'Restart readiness could not be verified.' },
      };
    }
    const restartSpec = GameTestService.parseSpec({
      until: [{ kind: 'frames', n: 1 }],
      fail: [{ kind: 'newErrors' }, { kind: 'gameState', path: 'phase', op: 'eq', value: phase }],
      maxFrames: 1,
      maxWallMs: 5_000,
      pauseOnOutcome: false,
    });
    if ('error' in restartSpec) {
      return { ...core, terminal: { status: 'inconclusive', reason: restartSpec.error } };
    }
    const restartedRun = await this.gameTest.run(restartSpec.spec, signal);
    if (signal?.aborted || appState.project.id !== projectId) {
      return this.result('skipped', 'The restart probe was cancelled.');
    }
    const restartVerdict = this.classify(restartedRun);
    if (restartVerdict.status !== 'passed') {
      return {
        ...restartVerdict,
        terminal: { status: restartVerdict.status, reason: restartVerdict.reason },
      };
    }
    const restartedPhase = snapshotPhase(restartedRun);
    if (!restartedPhase) {
      return {
        ...this.result(
          'inconclusive',
          'Restart returned no game phase.',
          restartVerdict.reportPath
        ),
        terminal: { status: 'inconclusive', reason: 'Restart state could not be read.' },
      };
    }
    if (restartedPhase === phase) {
      return {
        ...this.result(
          'failed',
          `Restart left the game in phase ${phase}.`,
          restartVerdict.reportPath,
          `terminal-restart-phase:${phase}`
        ),
        terminal: { status: 'failed', reason: 'Restart left the terminal phase active.' },
      };
    }
    return {
      ...(visual.status === 'failed'
        ? this.result('failed', visual.reason, verdict.reportPath, 'terminal-visual-large-change')
        : visual.status === 'inconclusive' &&
            visual.reason !== 'No static terminal visual contract.' &&
            visual.reason !== 'The terminal screen allows animation.'
          ? this.result('inconclusive', visual.reason, verdict.reportPath)
          : core),
      visual,
      terminal: {
        status: visual.status === 'failed' ? 'failed' : 'passed',
        reason:
          visual.status === 'failed'
            ? visual.reason
            : `The ${phase} screen held for ${TERMINAL_FRAMES} frames and ${restartRoutine ? 'RETRY' : 'restart'} cleared it.`,
      },
    };
  }

  private async readPlaytestContract(): Promise<string> {
    const recipe = await this.tools
      .execute('fs_read', { path: 'design/recipe.md' })
      .catch(() => null);
    const content =
      recipe &&
      typeof recipe === 'object' &&
      'content' in recipe &&
      typeof recipe.content === 'string'
        ? recipe.content
        : '';
    return content.split(/^## Playtest contract\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  }

  private async probeVisual(
    phase: string,
    projectId: string,
    contract: string,
    signal?: AbortSignal
  ): Promise<NonNullable<FlowSmokeResult['visual']>> {
    const mode = contract.match(/^terminalVisual:\s*(static|animated)\s*$/m)?.[1];
    if (mode !== 'static') {
      return {
        status: 'inconclusive',
        reason:
          mode === 'animated'
            ? 'The terminal screen allows animation.'
            : 'No static terminal visual contract.',
      };
    }
    const frames = [];
    for (let sample = 0; sample < VISUAL_SAMPLES; sample += 1) {
      if (signal?.aborted || appState.project.id !== projectId) {
        return { status: 'skipped', reason: 'The visual probe was cancelled.' };
      }
      if (sample > 0) {
        const parsed = GameTestService.parseSpec({
          until: [{ kind: 'frames', n: VISUAL_SAMPLE_FRAMES }],
          fail: [
            { kind: 'newErrors' },
            { kind: 'gameState', path: 'phase', op: 'ne', value: phase },
          ],
          maxFrames: VISUAL_SAMPLE_FRAMES,
          maxWallMs: 5_000,
          pauseOnOutcome: false,
        });
        if ('error' in parsed) return { status: 'inconclusive', reason: parsed.error };
        const run = await this.gameTest.run(parsed.spec, signal);
        const verdict = this.classify(run);
        if (verdict.status !== 'passed' || snapshotPhase(run) !== phase) {
          return {
            status: verdict.status === 'failed' ? 'failed' : 'inconclusive',
            reason: `Terminal visual sampling stopped: ${verdict.reason}`,
          };
        }
      }
      const shot = this.playSession.captureScreenshot({ maxSize: 256, mimeType: 'image/png' });
      const frame = shot ? await decodeTerminalFrame(shot) : null;
      if (!frame)
        return { status: 'inconclusive', reason: 'A terminal screenshot could not be decoded.' };
      frames.push(frame);
    }
    const changedFractions = terminalVisualChange(frames);
    if (!changedFractions) {
      return { status: 'inconclusive', reason: 'Terminal screenshots have incompatible sizes.' };
    }
    const peak = Math.max(...changedFractions);
    return peak >= LARGE_VISUAL_CHANGE
      ? {
          status: 'failed',
          reason: `The static end screen changed across ${Math.round(peak * 100)}% of pixels.`,
          changedFractions,
        }
      : {
          status: 'passed',
          reason: 'The static end screen stayed visually stable.',
          changedFractions,
        };
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
    if (run.control?.verdict === 'failed') {
      return this.result(
        'failed',
        run.verdict ?? 'Negative control failed: effect occurred without control.',
        reportPath,
        `control:negative-failed:${run.control.outcome?.kind ?? 'effect'}`
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
        return this.result(
          'failed',
          run.verdict ?? run.outcome.detail,
          reportPath,
          findingKey(run)
        );
      case 'error':
        return this.result(
          run.outcome.detail.includes('scene is no longer running') ? 'inconclusive' : 'failed',
          run.verdict ?? run.outcome.detail,
          reportPath,
          findingKey(run)
        );
      default:
        return this.result('inconclusive', run.verdict ?? run.outcome.detail, reportPath);
    }
  }

  private async probeControls(projectId: string): Promise<FlowSmokeResult | null> {
    const controlsResult = (await this.tools.execute('game_controls').catch(() => null)) as
      | {
          ok?: boolean;
          error?: string;
          controls?: Array<{
            name: string;
            visible?: boolean;
            enabled?: boolean;
            reach?: string;
            reachNote?: string;
          }>;
        }
      | null;
    if (appState.project.id !== projectId) {
      return this.result('skipped', 'The controls probe was cancelled.');
    }
    if (!controlsResult || controlsResult.ok !== true) {
      return this.result(
        'failed',
        controlsResult?.error ?? 'game_controls failed to scan the scene.',
        null,
        'controls:scan-failed'
      );
    }
    const controls = controlsResult.controls ?? [];
    for (const control of controls) {
      if (control.visible && control.enabled !== false) {
        if (control.reach === 'unknown') {
          return this.result(
            'failed',
            `Control "${control.name}" is visible but has unknown reach.`,
            null,
            `control-unreachable:${control.name}`
          );
        }
        if (control.reach === 'off-screen') {
          return this.result(
            'failed',
            `Control "${control.name}" is visible but off-screen.`,
            null,
            `control-off-screen:${control.name}`
          );
        }
        if (control.reach === 'in-frame-unproven') {
          return this.result(
            'failed',
            `Control "${control.name}" is visible but in-frame-unproven (no physical proof in reachability.json or session).`,
            null,
            `control-unproven:${control.name}`
          );
        }
        if (
          control.reach !== 'reachable' &&
          control.reach !== 'hidden' &&
          control.reach !== 'hidden-by-ancestor'
        ) {
          return this.result(
            'failed',
            `Control "${control.name}" is visible but has reach "${control.reach}".`,
            null,
            `control-unreachable:${control.name}`
          );
        }
      }
    }
    return null;
  }

  private async probeRoutines(
    projectId: string,
    skipRoutineName?: string,
    signal?: AbortSignal
  ): Promise<FlowSmokeResult | null> {
    if (!this.storage?.listDirectory) {
      return this.result('inconclusive', 'Storage service is not available to inspect routines.');
    }
    let entries: Array<{ name: string; path: string; kind: 'file' | 'directory' }> = [];
    try {
      entries = await this.storage.listDirectory('design/tests/routines');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNotFound =
        (error as { code?: string })?.code === 'ENOENT' ||
        (error as { name?: string })?.name === 'NotFoundError' ||
        /not found|enoent/i.test(message);
      if (isNotFound) {
        entries = [];
      } else {
        return this.result(
          'inconclusive',
          `Failed to read routines directory: ${message}`
        );
      }
    }
    const routineFiles = entries
      .filter(e => e.kind === 'file' && e.name.endsWith('.json'))
      .map(e => e.name.replace(/\.json$/i, ''))
      .filter(name => name !== skipRoutineName);

    for (const routineName of routineFiles) {
      if (signal?.aborted || appState.project.id !== projectId) {
        return this.result('skipped', 'The routine probe was cancelled.');
      }
      const routineResult = (await this.tools.execute('game_run', { routine: routineName }).catch(
        error => ({ ok: false, error: error instanceof Error ? error.message : String(error) })
      )) as
        | Awaited<ReturnType<GameTestService['runRoutine']>>
        | { ok: boolean; error?: string };
      if (signal?.aborted || appState.project.id !== projectId) {
        return this.result('skipped', 'The routine probe was cancelled.');
      }
      const ok =
        routineResult &&
        typeof routineResult === 'object' &&
        'ok' in routineResult &&
        routineResult.ok === true &&
        !('routine' in routineResult && routineResult.routine?.macro) &&
        !('expectations' in routineResult &&
          routineResult.expectations?.some(expectation => !expectation.met)) &&
        !('newErrors' in routineResult && (routineResult.newErrors?.length ?? 0) > 0);

      if (!ok) {
        const error =
          'verdict' in routineResult && typeof routineResult.verdict === 'string'
            ? routineResult.verdict
            : 'error' in routineResult && typeof routineResult.error === 'string'
              ? routineResult.error
              : `Routine ${routineName} failed.`;
        const reportPath =
          'artifact' in routineResult &&
          routineResult.artifact &&
          typeof routineResult.artifact === 'object' &&
          'path' in routineResult.artifact &&
          typeof routineResult.artifact.path === 'string'
            ? routineResult.artifact.path
            : null;
        return this.result('failed', error, reportPath, `routine:${routineName}`);
      }
    }
    return null;
  }

  private async waitForRunner(projectId: string, signal?: AbortSignal): Promise<boolean> {
    const deadline = performance.now() + START_READY_MS;
    while (!signal?.aborted && appState.project.id === projectId && performance.now() < deadline) {
      if (this.playSession.getActiveRuntime()?.runner.running) return true;
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
    return false;
  }

  private result(
    status: FlowSmokeStatus,
    reason: string,
    reportPath: string | null = null,
    findingKey?: string
  ): FlowSmokeResult {
    return { status, reason, seed: SMOKE_SEED, reportPath, ...(findingKey ? { findingKey } : {}) };
  }
}

const findingKey = (run: GameRunResult): string => {
  const error = run.newErrors?.[0];
  if (error) return `runtime:${error.source}:${error.message}`;
  const violation = run.monkey?.violation;
  if (violation) return `monkey:${violation.kind}`;
  return `${run.outcome?.kind ?? 'unknown'}:${run.outcome?.assertion ?? 'unclassified'}`;
};

const isSuccessfulToolResult = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && 'ok' in value && value.ok === true;

const snapshotPhase = (run: GameRunResult): string | null => {
  const snapshot = run.game?.snapshot;
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return typeof snapshot.phase === 'string' ? snapshot.phase : null;
};
