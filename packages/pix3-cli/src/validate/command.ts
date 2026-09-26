import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { findProjectRoot } from '../manifest.ts';
import { DIAGNOSTIC_CODES, type Diagnostic } from './diagnostics.ts';
import type { ScriptImportMap } from './level2.ts';
import { ProjectFiles, SCENE_EXTENSION } from './project.ts';
import { validateProject, type ValidateReport } from './validate.ts';

/**
 * `pix3 validate [paths…] [--json] [--no-hydrate]` — argument handling and output. The checks
 * themselves are `validate.ts` (`validateProject`); this file is only the CLI face of it.
 *
 * Exit codes: 0 = no errors (warnings allowed), 1 = at least one error, 2 = could not run
 * (bad arguments, no project found).
 */

export const VALIDATE_USAGE = `Usage: pix3 validate [paths…] [--json] [--no-hydrate] [--project <dir>]

  paths          .pix3scene files or folders (default: every scene in the project)
  --json         machine-readable report (diagnostics + sha256 of each validated file)
  --no-hydrate   level 1 only: no project code runs (user: component properties not checked)
  --project dir  project root (default: nearest folder with pix3project.yaml)
`;

export interface ValidateIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Set by the bundled entry; the specs leave it bare. */
  readonly scriptImports?: ScriptImportMap;
  /** Resolved URL of `esbuild`, when the caller can see one (level 2 needs it). */
  readonly esbuildSpecifier?: string;
}

interface ValidateArgs {
  readonly paths: string[];
  readonly json: boolean;
  readonly hydrate: boolean;
  readonly project?: string;
  readonly help: boolean;
}

const parseValidateArgs = (argv: readonly string[]): ValidateArgs | { error: string } => {
  const paths: string[] = [];
  let json = false;
  let hydrate = true;
  let project: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--no-hydrate') hydrate = false;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--project') {
      project = argv[++i];
      if (!project) return { error: '--project needs a folder' };
    } else if (arg.startsWith('--project=')) project = arg.slice('--project='.length);
    else if (arg.startsWith('-')) return { error: `unknown option ${arg}` };
    else paths.push(arg);
  }
  return { paths, json, hydrate, project, help };
};

/** Scene files named by the arguments: files as given, folders searched recursively. */
const resolveTargets = (
  project: ProjectFiles,
  cwd: string,
  paths: readonly string[]
): { files: string[] } | { error: string } => {
  const files = new Set<string>();
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    const rel = project.relativeOf(absolute);
    if (rel === null) return { error: `${path} is outside the project ${project.root}` };
    if (existsSync(absolute) && statSync(absolute).isDirectory()) {
      const prefix = rel === '' ? '' : `${rel}/`;
      for (const scene of project.scenes()) if (scene.startsWith(prefix)) files.add(scene);
    } else if (!rel.endsWith(SCENE_EXTENSION)) {
      return { error: `${path} is not a ${SCENE_EXTENSION} file` };
    } else {
      files.add(rel);
    }
  }
  return { files: [...files] };
};

const formatDiagnostic = (d: Diagnostic): string => {
  const where = `${d.file}${d.line !== undefined ? `:${d.line}` : ''}`;
  const node = d.nodeId !== undefined ? ` [${d.nodeId}]` : '';
  let text = `${where}  ${d.severity}  ${d.code}${node}  ${d.message}\n`;
  if (d.path) text += `    at ${d.path}\n`;
  if (d.fix) text += `    fix: ${d.fix}\n`;
  return text;
};

export const formatHumanReport = (report: ValidateReport): string => {
  let out = '';
  for (const d of report.diagnostics) out += formatDiagnostic(d);
  for (const note of report.notes) out += `note: ${note}\n`;
  const level2 =
    report.level2.state === 'ran'
      ? `level 2 hydrated ${report.level2.filesHydrated} file(s)`
      : report.level2.state === 'disabled'
        ? 'level 2 off'
        : `level 2 skipped: ${report.level2.reason}`;
  out +=
    `${report.files.length} file(s) checked, ${report.errorCount} error(s), ` +
    `${report.warningCount} warning(s); ${level2}.\n`;
  return out;
};

export const formatJsonReport = (report: ValidateReport): string =>
  `${JSON.stringify(
    {
      ok: report.errorCount === 0,
      projectRoot: report.projectRoot,
      errorCount: report.errorCount,
      warningCount: report.warningCount,
      level2: report.level2,
      files: report.files,
      diagnostics: report.diagnostics,
      notes: report.notes,
    },
    null,
    2
  )}\n`;

/** Entry for `pix3 validate …`; returns the process exit code. */
export const runValidate = async (argv: readonly string[], io: ValidateIo): Promise<number> => {
  const args = parseValidateArgs(argv);
  if ('error' in args) {
    io.stderr(`pix3 validate: ${args.error}\n\n${VALIDATE_USAGE}`);
    return 2;
  }
  if (args.help) {
    io.stdout(
      `${VALIDATE_USAGE}\nCodes:\n${Object.entries(DIAGNOSTIC_CODES)
        .map(([code, info]) => `  ${code.padEnd(26)} L${info.level}  ${info.summary}`)
        .join('\n')}\n`
    );
    return 0;
  }
  const start = args.project
    ? resolve(io.cwd, args.project)
    : args.paths.length > 0
      ? resolve(io.cwd, args.paths[0])
      : io.cwd;
  const projectRoot = args.project ? start : findProjectRoot(start);
  if (!projectRoot) {
    io.stderr(
      `pix3 validate: no pix3project.yaml in ${start} or any parent folder. Run it inside a Pix3 project, or pass --project <dir>.\n`
    );
    return 2;
  }
  const project = new ProjectFiles(projectRoot);
  const targets = args.paths.length > 0 ? resolveTargets(project, io.cwd, args.paths) : null;
  if (targets && 'error' in targets) {
    io.stderr(`pix3 validate: ${targets.error}\n`);
    return 2;
  }
  const report = await validateProject({
    projectRoot,
    files: targets?.files,
    hydrate: args.hydrate,
    scriptImports: io.scriptImports,
    esbuildSpecifier: io.esbuildSpecifier,
  });
  io.stdout(args.json ? formatJsonReport(report) : formatHumanReport(report));
  return report.errorCount > 0 ? 1 : 0;
};
