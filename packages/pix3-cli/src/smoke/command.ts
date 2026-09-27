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
} from './report.ts';

/**
 * `pix3 smoke [scene] [--frames N] [--timeout S] [--json] [--project <dir>]` — run the game headless
 * in Node for N fixed 1/60 s frames and report what threw.
 *
 * This file is plain Node (no runtime import): it resolves the project and the scene, then runs the
 * game in a worker thread from the smoke bundle (`entry.ts`, `worker.ts`, `smoke.ts`) under a
 * wall-clock timeout. Exit codes: 0 = ran clean, 1 = at least one error, 2 = could not run.
 */

export const SMOKE_USAGE = `Usage: pix3 smoke [scene] [--frames N] [--timeout S] [--json] [--project <dir>]

  Run the game headless in Node — no browser, no editor: the project's scripts compiled, the scene
  loaded by the real loader, N frames of 1/60 s stepped by the real SceneRunner. Reports every
  script throw (onAttach/onStart/onUpdate, with script name, frame and stack), console.error/warn,
  unhandled rejections, missing res:// files and per-frame step time. Nothing is rendered; audio,
  input and network are inert.

  scene          .pix3scene to run (res://, project-relative or a path). Default: the manifest's
                 defaultExportScenePath, else scenes/main.pix3scene, else the only top-level scene.
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
  return { scene, frames, timeoutSec, json, project, help };
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

const INSTANCE_LINE = /^\s*(?:-\s+)?instance:\s*["']?(?:res:\/\/)?([^"'\s#]+)/gm;

/** Scenes no other scene instances, outside prefabs/ and ui/ folders — the ones a game starts in. */
const topLevelScenes = (project: ProjectFiles): string[] => {
  const scenes = project.scenes();
  const instanced = new Set<string>();
  for (const scene of scenes) {
    let text: string;
    try {
      text = project.readText(scene);
    } catch {
      continue;
    }
    for (const match of text.matchAll(INSTANCE_LINE)) instanced.add(match[1].replace(/^\/+/, ''));
  }
  return scenes.filter(scene => !instanced.has(scene) && !/(^|\/)(prefabs?|ui)\//i.test(scene));
};

/** Project-relative scene path from the argument / manifest / convention, or a failure. */
export const resolveSmokeScene = (
  project: ProjectFiles,
  cwd: string,
  requested: string | undefined,
  manifestDefault: string | undefined
): string | SmokeFailure => {
  if (requested !== undefined) {
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
  }
  if (manifestDefault) {
    if (project.has(manifestDefault)) return manifestDefault;
    return failure(
      'E_SMOKE_NO_SCENE',
      `pix3project.yaml names defaultExportScenePath ${manifestDefault}, which does not exist.`
    );
  }
  if (project.has('scenes/main.pix3scene')) return 'scenes/main.pix3scene';
  const top = topLevelScenes(project);
  if (top.length === 1) return top[0];
  if (project.scenes().length === 0)
    return failure('E_SMOKE_NO_SCENE', 'the project has no .pix3scene files.');
  return failure(
    'E_SMOKE_NO_SCENE',
    `no default scene (no defaultExportScenePath, no scenes/main.pix3scene) and ${top.length === 0 ? 'no' : top.length} top-level scene${top.length === 1 ? '' : 's'}${top.length > 0 ? ` (${top.join(', ')})` : ''} — name one: pix3 smoke <scene>.`
  );
};

export interface RunSmokeOptions {
  readonly projectRoot: string;
  readonly scene?: string;
  readonly frames?: number;
  readonly timeoutSec?: number;
  readonly cwd?: string;
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

/** Resolve the scene and run the game headless; the outcome is the report (or why it could not run). */
export const runSmoke = async (options: RunSmokeOptions): Promise<SmokeOutcome> => {
  const root = resolve(options.projectRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return failure('E_SMOKE_NO_PROJECT', `${root} is not a folder.`);
  }
  const project = new ProjectFiles(root);
  const manifest = readManifest(root);
  const scene = resolveSmokeScene(
    project,
    options.cwd ?? root,
    options.scene,
    manifest.defaultScene
  );
  if (typeof scene !== 'string') return scene;
  const job: SmokeJob = {
    projectRoot: root,
    scene,
    frames: options.frames ?? DEFAULT_FRAMES,
    viewport: manifest.viewport,
    localization: manifest.localization,
    esbuildSpecifier: resolveEsbuild(),
    fallbackResolveDir: cliPackageRoot(),
  };
  try {
    return await withSmokeBundle(dir =>
      runInWorker(dir, job, options.timeoutSec ?? DEFAULT_TIMEOUT_SEC)
    );
  } catch (error) {
    return failure(
      'E_SMOKE_BUNDLE',
      `could not build or load the smoke bundle: ${error instanceof Error ? error.message : String(error)}`,
      scene
    );
  }
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
    const snapshot = JSON.stringify(report.game.snapshot) ?? 'null';
    lines.push(
      `  game "${report.game.name}" snapshot: ${snapshot.length > 160 ? `${snapshot.slice(0, 159)}…` : snapshot}`
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
  let outcome: SmokeOutcome;
  if (!root) {
    outcome = failure(
      'E_SMOKE_NO_PROJECT',
      `no pix3project.yaml in ${io.cwd} or above — run inside a project or pass --project <dir>.`
    );
  } else {
    outcome = await runSmoke({
      projectRoot: root,
      scene: args.scene,
      frames: args.frames,
      timeoutSec: args.timeoutSec,
      cwd: io.cwd,
    });
  }
  const shownRoot = root ?? io.cwd;
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
