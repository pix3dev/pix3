import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { parse as parseYaml } from 'yaml';

import { findProjectRoot, PROJECT_MANIFEST_FILE } from '../manifest.ts';
import { ProjectFiles } from '../validate/project.ts';
import { isRecord } from '../validate/yaml-doc.ts';
import { cliPackageRoot, resolveEsbuild, SMOKE_WORKER_FILE, withSmokeBundle } from './entry.ts';
import {
  isSmokeFailure,
  type SmokeFailure,
  type SmokeFailureCode,
  type SmokeJob,
  type SmokeOutcome,
  type SmokeReport,
  type SmokeRunSet,
} from './report.ts';
import { selectSmokeScenes, type SmokeSelection } from './select-scenes.ts';

/**
 * `pix3 smoke [scene] [--changed|--all] [--frames N] [--timeout S] [--json] [--project <dir>]` —
 * run the game headless in Node for N fixed 1/60 s frames and report what threw. With no scene it
 * runs several, one after another (`select-scenes.ts` decides which).
 *
 * This file is plain Node (no runtime import): it resolves the project and the scene, then runs the
 * game in a worker thread from the smoke bundle (`entry.ts`, `worker.ts`, `smoke.ts`) under a
 * wall-clock timeout. Exit codes: 0 = ran clean, 1 = at least one error, 2 = could not run.
 */

export const SMOKE_USAGE = `Usage: pix3 smoke [scene] [--changed | --all] [--frames N] [--timeout S] [--json] [--project <dir>]

  Run the game headless in Node — no browser, no editor: the project's scripts compiled, the scene
  loaded by the real loader, N frames of 1/60 s stepped by the real SceneRunner. Reports every
  script throw (onAttach/onStart/onUpdate, with script name, frame and stack), console.error/warn,
  unhandled rejections, missing res:// files and per-frame step time. Nothing is rendered; audio,
  input and network are inert.

  scene          .pix3scene to run (res://, project-relative or a path) — the surest way to test
                 the game: pix3 smoke scenes/main.pix3scene. With no scene, several run one after
                 another, a line each: in a git repo with uncommitted changes, the top-level scenes
                 those changes reach (the scene, a prefab/overlay it instances, a user: script it
                 attaches); otherwise — or when a changed scene/script reaches none — every
                 top-level scene (not a prefab, not scenes/ui), scenes/main.pix3scene first.
  --changed      only the scenes changed files reach (needs git; exit 2 when nothing changed)
  --all          every top-level scene, whatever git says
  --frames N     frames to step (default 120 = 2 s of game time)
  --timeout S    wall-clock limit in seconds (default 20) → exit 2, E_SMOKE_TIMEOUT
  --json         machine-readable report
  --project dir  project folder (default: nearest folder with pix3project.yaml)

  Exit: 0 = no errors, 1 = errors, 2 = could not run (no scene, bundle failure, unsupported, timeout).
`;

export interface SmokeIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface SmokeArgs {
  readonly scene?: string;
  readonly changed: boolean;
  readonly all: boolean;
  readonly frames: number;
  readonly timeoutSec: number;
  readonly json: boolean;
  readonly project?: string;
  readonly help: boolean;
}

const DEFAULT_FRAMES = 120;
const DEFAULT_TIMEOUT_SEC = 20;

const parseSmokeArgs = (argv: readonly string[]): SmokeArgs | { error: string } => {
  let scene: string | undefined;
  let frames = DEFAULT_FRAMES;
  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  let json = false;
  let changed = false;
  let all = false;
  let project: string | undefined;
  let help = false;
  const valueOf = (arg: string, index: number): { value?: string; next: number } => {
    const eq = arg.indexOf('=');
    if (eq > 0) return { value: arg.slice(eq + 1), next: index };
    return { value: argv[index + 1], next: index + 1 };
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.split('=')[0];
    if (arg === '--json') json = true;
    else if (arg === '--changed') changed = true;
    else if (arg === '--all') all = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (name === '--frames' || name === '--timeout' || name === '--project') {
      const { value, next } = valueOf(arg, i);
      i = next;
      if (value === undefined || value.startsWith('--')) return { error: `${name} needs a value` };
      if (name === '--project') project = value;
      else {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0)
          return { error: `${name} needs a positive number` };
        if (name === '--frames') frames = Math.floor(number);
        else timeoutSec = number;
      }
    } else if (arg.startsWith('-')) return { error: `unknown argument ${arg}` };
    else if (scene === undefined) scene = arg;
    else return { error: `one scene at a time (got ${scene} and ${arg})` };
  }
  if (changed && all) return { error: '--changed and --all exclude each other' };
  if (scene !== undefined && (changed || all))
    return {
      error: `${changed ? '--changed' : '--all'} picks the scenes; drop ${scene} or the flag`,
    };
  return { scene, changed, all, frames, timeoutSec, json, project, help };
};

const failure = (code: SmokeFailureCode, reason: string, scene?: string): SmokeFailure => ({
  ok: false,
  code,
  reason,
  ...(scene ? { scene } : {}),
});

interface ManifestBits {
  readonly defaultScene?: string;
  readonly viewport: { width: number; height: number };
  readonly localization: unknown;
}

const readManifest = (root: string): ManifestBits => {
  const fallback: ManifestBits = { viewport: { width: 1920, height: 1080 }, localization: null };
  try {
    const data = parseYaml(readFileSync(join(root, PROJECT_MANIFEST_FILE), 'utf8')) as unknown;
    if (!isRecord(data)) return fallback;
    const size = isRecord(data.viewportBaseSize) ? data.viewportBaseSize : {};
    const width = typeof size.width === 'number' && size.width > 0 ? size.width : 1920;
    const height = typeof size.height === 'number' && size.height > 0 ? size.height : 1080;
    const defaultScene =
      typeof data.defaultExportScenePath === 'string' && data.defaultExportScenePath.trim()
        ? data.defaultExportScenePath
            .trim()
            .replace(/^res:\/\//i, '')
            .replace(/^\/+/, '')
        : undefined;
    return {
      viewport: { width, height },
      localization: isRecord(data.localization) ? data.localization : null,
      ...(defaultScene ? { defaultScene } : {}),
    };
  } catch {
    return fallback;
  }
};

/** Project-relative path of the scene the argument names, or a failure. */
export const resolveSmokeScene = (
  project: ProjectFiles,
  cwd: string,
  requested: string
): string | SmokeFailure => {
  const candidates: string[] = [];
  const stripped = requested.replace(/^res:\/\//i, '').replace(/^\/+/, '');
  candidates.push(stripped.split(sep).join('/'));
  const fromCwd = project.relativeOf(isAbsolute(requested) ? requested : resolve(cwd, requested));
  if (fromCwd) candidates.push(fromCwd);
  const found = candidates.find(candidate => project.has(candidate));
  if (!found)
    return failure(
      'E_SMOKE_NO_SCENE',
      `${requested} is not a file in the project (${project.root}).`
    );
  if (!found.endsWith('.pix3scene'))
    return failure('E_SMOKE_NO_SCENE', `${found} is not a .pix3scene.`);
  return found;
};

export interface RunSmokeOptions {
  readonly projectRoot: string;
  readonly frames?: number;
  readonly timeoutSec?: number;
  readonly cwd?: string;
}

export interface RunOneSmokeOptions extends RunSmokeOptions {
  /** The scene to run (res://, project-relative or a path). */
  readonly scene: string;
}

export interface RunSmokeSetOptions extends RunSmokeOptions {
  /** `--changed`: only the scenes changed files reach. */
  readonly changedOnly?: boolean;
  /** `--all`: every top-level scene. */
  readonly all?: boolean;
  /** Test seam for the git answer (null = no git); default asks git. */
  readonly changedFiles?: readonly string[] | null;
}

/** Run one smoke job in a worker from the bundle in `bundleDir`. */
const runInWorker = (bundleDir: string, job: SmokeJob, timeoutSec: number): Promise<SmokeOutcome> =>
  new Promise(resolveOutcome => {
    let settled = false;
    const worker = new Worker(pathToFileURL(join(bundleDir, SMOKE_WORKER_FILE)), {
      workerData: job,
      stdout: true,
      stderr: true,
    });
    // A script writing to process.stdout directly must not interleave with the report.
    worker.stdout.resume();
    worker.stderr.resume();
    const settle = (outcome: SmokeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolveOutcome(outcome);
    };
    const timer = setTimeout(() => {
      settle(
        failure(
          'E_SMOKE_TIMEOUT',
          `the run did not finish within ${timeoutSec} s (a script stuck in a loop, or a scene too heavy for ${job.frames} frames; try --frames or --timeout).`,
          job.scene
        )
      );
    }, timeoutSec * 1000);
    worker.once('message', (outcome: SmokeOutcome) => settle(outcome));
    worker.once('error', (error: unknown) =>
      settle(
        failure(
          'E_SMOKE_CRASH',
          `the smoke worker crashed: ${error instanceof Error ? error.message : String(error)}`,
          job.scene
        )
      )
    );
    worker.once('exit', code =>
      settle(
        failure(
          'E_SMOKE_CRASH',
          `the smoke worker exited (code ${code}) without a report.`,
          job.scene
        )
      )
    );
  });

interface Prepared {
  readonly root: string;
  readonly project: ProjectFiles;
  readonly manifest: ManifestBits;
}

const prepare = (projectRoot: string): Prepared | SmokeFailure => {
  const root = resolve(projectRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return failure('E_SMOKE_NO_PROJECT', `${root} is not a folder.`);
  }
  return { root, project: new ProjectFiles(root), manifest: readManifest(root) };
};

const jobFor = (prepared: Prepared, scene: string, options: RunSmokeOptions): SmokeJob => ({
  projectRoot: prepared.root,
  scene,
  frames: options.frames ?? DEFAULT_FRAMES,
  viewport: prepared.manifest.viewport,
  localization: prepared.manifest.localization,
  esbuildSpecifier: resolveEsbuild(),
  fallbackResolveDir: cliPackageRoot(),
});

/** Run each scene in its own worker, one after another, from one smoke bundle. */
const runScenes = async (
  prepared: Prepared,
  scenes: readonly string[],
  options: RunSmokeOptions
): Promise<SmokeOutcome[]> => {
  const timeoutSec = options.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  try {
    return await withSmokeBundle(async dir => {
      const outcomes: SmokeOutcome[] = [];
      for (const scene of scenes) {
        outcomes.push(await runInWorker(dir, jobFor(prepared, scene, options), timeoutSec));
      }
      return outcomes;
    });
  } catch (error) {
    const reason = `could not build or load the smoke bundle: ${error instanceof Error ? error.message : String(error)}`;
    return scenes.map(scene => failure('E_SMOKE_BUNDLE', reason, scene));
  }
};

/** Run one named scene headless; the outcome is the report (or why it could not run). */
export const runSmoke = async (options: RunOneSmokeOptions): Promise<SmokeOutcome> => {
  const prepared = prepare(options.projectRoot);
  if ('code' in prepared) return prepared;
  const scene = resolveSmokeScene(prepared.project, options.cwd ?? prepared.root, options.scene);
  if (typeof scene !== 'string') return scene;
  const [outcome] = await runScenes(prepared, [scene], options);
  return outcome;
};

/** Which scenes a run with no scene argument covers (see `select-scenes.ts`). */
export const selectScenesFor = (options: RunSmokeSetOptions): SmokeSelection | SmokeFailure => {
  const prepared = prepare(options.projectRoot);
  if ('code' in prepared) return prepared;
  const selection = selectSmokeScenes(prepared.project, {
    manifestDefault: prepared.manifest.defaultScene,
    changedOnly: options.changedOnly,
    all: options.all,
    ...(options.changedFiles !== undefined ? { changedFiles: options.changedFiles } : {}),
  });
  return 'error' in selection ? failure('E_SMOKE_NO_SCENE', selection.error) : selection;
};

/** No scene argument: run every selected scene; `ok` only when each ran clean. */
export const runSmokeSet = async (
  options: RunSmokeSetOptions
): Promise<SmokeRunSet | SmokeFailure> => {
  const prepared = prepare(options.projectRoot);
  if ('code' in prepared) return prepared;
  const selection = selectScenesFor(options);
  if ('code' in selection) return selection;
  const runs = await runScenes(prepared, selection.scenes, options);
  return {
    ok: runs.every(run => !isSmokeFailure(run) && run.errors.length === 0),
    selection: selection.mode,
    reason: selection.reason,
    ...(selection.changed ? { changed: selection.changed } : {}),
    runs,
  };
};

// --- Output --------------------------------------------------------------------------------------

/** Stack lines with the project root stripped, the engine's own frames dropped past the first few. */
const trimStack = (stack: string | undefined, root: string, maxLines: number): string[] => {
  if (!stack) return [];
  const rootUrl = pathToFileURL(root).href;
  return stack
    .split('\n')
    .slice(1)
    .map(line =>
      line
        .trim()
        .replaceAll(`${rootUrl}/`, '')
        .replaceAll(`${root}${sep}`, '')
        .replaceAll(`${root}/`, '')
    )
    .filter(line => line.startsWith('at '))
    .slice(0, maxLines);
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Longest `game` snapshot printed by the human report; `--json` always carries it whole. */
const SNAPSHOT_HUMAN_LIMIT = 4000;

export const formatGameSnapshot = (snapshot: unknown): string => {
  const compact = JSON.stringify(snapshot) ?? 'null';
  if (compact.length <= 120) return compact;
  const pretty = JSON.stringify(snapshot, null, 2) ?? 'null';
  const shown =
    pretty.length > SNAPSHOT_HUMAN_LIMIT
      ? `${pretty.slice(0, SNAPSHOT_HUMAN_LIMIT)}\n… (${pretty.length - SNAPSHOT_HUMAN_LIMIT} more characters; pix3 smoke --json has it whole)`
      : pretty;
  return `\n${shown
    .split('\n')
    .map(line => `    ${line}`)
    .join('\n')}`;
};

export const formatSmokeHuman = (outcome: SmokeOutcome, root: string): string => {
  if (isSmokeFailure(outcome)) {
    return `pix3 smoke${outcome.scene ? ` ${outcome.scene}` : ''}: could not run — ${outcome.code}: ${outcome.reason}\n`;
  }
  const report: SmokeReport = outcome;
  const lines: string[] = [];
  const t = report.timingsMs;
  lines.push(
    `pix3 smoke ${report.scene} — ${report.frames}/${report.framesRequested} frames at 1/60 s: ${plural(report.errors.length, 'error')}, ${plural(report.warnings.length, 'warning')}`
  );
  lines.push(
    `  first frame ${report.firstFrameOk ? 'ok' : 'NOT ok'} · nodes ${report.nodes.start} → ${report.nodes.end} · scripts ${report.scripts.length}`
  );
  lines.push(
    `  compile ${t.compile} ms · load+onStart ${t.load} ms · frame 1 ${t.firstFrame} ms · step mean ${t.step.mean} / p95 ${t.step.p95} / max ${t.step.max} ms · total ${t.total} ms`
  );
  if (report.game) {
    // The snapshot is the one line of the report that says what the game DID (score, phase,
    // ready flag); it used to be cut at 160 characters, which on a real game ended mid-key.
    // Printed whole, pretty when it does not fit a line, capped only far beyond any HUD.
    lines.push(
      `  game "${report.game.name}" snapshot: ${formatGameSnapshot(report.game.snapshot)}`
    );
  }
  if (report.errors.length > 0) {
    lines.push('errors:');
    for (const error of report.errors) {
      const where = [
        error.script,
        error.nodeName ? `on "${error.nodeName}"` : error.nodeId ? `on ${error.nodeId}` : undefined,
        error.phase ? `(${error.phase})` : undefined,
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(
        `  frame ${error.frame}  ${error.code}${where ? ` ${where}` : ''}: ${error.message}`
      );
      if (error.domAccess && error.domAccess.length > 0) {
        lines.push(`      missing browser API read just before: ${error.domAccess.join(', ')}`);
      }
      for (const line of trimStack(error.stack, root, 3)) lines.push(`      ${line}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push('warnings:');
    for (const warning of report.warnings) {
      lines.push(
        `  ${warning.frame !== undefined ? `frame ${warning.frame}  ` : ''}${warning.code}: ${warning.message}${warning.count ? ` (×${warning.count})` : ''}`
      );
    }
  }
  if (report.notes.length > 0) {
    lines.push('notes:');
    for (const note of report.notes) lines.push(`  ${note}`);
  }
  return `${lines.join('\n')}\n`;
};

export const formatSmokeJson = (outcome: SmokeOutcome, root: string): string => {
  if (isSmokeFailure(outcome)) return `${JSON.stringify(outcome, null, 2)}\n`;
  return `${JSON.stringify(
    {
      ...outcome,
      errors: outcome.errors.map(error => ({
        ...error,
        ...(error.stack ? { stack: trimStack(error.stack, root, 12).join('\n') } : {}),
      })),
    },
    null,
    2
  )}\n`;
};

export const smokeExitCode = (outcome: SmokeOutcome): number =>
  isSmokeFailure(outcome) ? 2 : outcome.errors.length > 0 ? 1 : 0;

/** The worst run decides: 2 if any could not run, else 1 if any reported errors, else 0. */
export const smokeSetExitCode = (set: SmokeRunSet): number =>
  set.runs.reduce((worst, run) => Math.max(worst, smokeExitCode(run)), 0);

const runStatus = (run: SmokeOutcome): string => {
  if (isSmokeFailure(run)) return `could not run (${run.code})`;
  const parts = [plural(run.errors.length, 'error'), plural(run.warnings.length, 'warning')];
  return `${run.errors.length > 0 ? 'FAILED' : 'ok'} — ${run.frames} frames, ${parts.join(', ')}`;
};

export const formatSmokeSetHuman = (set: SmokeRunSet, root: string): string => {
  const lines: string[] = [];
  lines.push(`pix3 smoke: ${plural(set.runs.length, 'scene')} — ${set.reason}`);
  for (const run of set.runs) {
    lines.push(`  ${(run.scene ?? '?').padEnd(32)} ${runStatus(run)}`);
  }
  const details = set.runs.filter(
    run =>
      isSmokeFailure(run) ||
      run.errors.length > 0 ||
      run.warnings.length > 0 ||
      set.runs.length === 1
  );
  for (const run of details) lines.push('', formatSmokeHuman(run, root).trimEnd());
  if (set.runs.length > 1 && details.length === 0) {
    lines.push('Run one scene for its details: pix3 smoke <scene>.');
  }
  return `${lines.join('\n')}\n`;
};

export const formatSmokeSetJson = (set: SmokeRunSet, root: string): string =>
  `${JSON.stringify(
    { ...set, runs: set.runs.map(run => JSON.parse(formatSmokeJson(run, root)) as unknown) },
    null,
    2
  )}\n`;

export const runSmokeCli = async (argv: readonly string[], io: SmokeIo): Promise<number> => {
  const args = parseSmokeArgs(argv);
  if ('error' in args) {
    io.stderr(`pix3 smoke: ${args.error}\n\n${SMOKE_USAGE}`);
    return 2;
  }
  if (args.help) {
    io.stdout(SMOKE_USAGE);
    return 0;
  }
  const root = args.project ? resolve(io.cwd, args.project) : findProjectRoot(io.cwd);
  const shownRoot = root ?? io.cwd;
  const common = { frames: args.frames, timeoutSec: args.timeoutSec, cwd: io.cwd };
  let outcome: SmokeOutcome | SmokeRunSet;
  if (!root) {
    outcome = failure(
      'E_SMOKE_NO_PROJECT',
      `no pix3project.yaml in ${io.cwd} or above — run inside a project or pass --project <dir>.`
    );
  } else if (args.scene !== undefined) {
    outcome = await runSmoke({ projectRoot: root, scene: args.scene, ...common });
  } else {
    outcome = await runSmokeSet({
      projectRoot: root,
      changedOnly: args.changed,
      all: args.all,
      ...common,
    });
  }
  if ('runs' in outcome) {
    io.stdout(
      args.json ? formatSmokeSetJson(outcome, shownRoot) : formatSmokeSetHuman(outcome, shownRoot)
    );
    return smokeSetExitCode(outcome);
  }
  if (args.json) io.stdout(formatSmokeJson(outcome, shownRoot));
  else io.stdout(formatSmokeHuman(outcome, shownRoot));
  return smokeExitCode(outcome);
};

/** For specs: a report's error list as `frame code script: message` lines. */
export const errorSummary = (outcome: SmokeOutcome): string[] =>
  isSmokeFailure(outcome)
    ? [`${outcome.code}: ${outcome.reason}`]
    : outcome.errors.map(
        e => `${e.frame} ${e.code}${e.script ? ` ${e.script}` : ''}: ${e.message}`
      );
