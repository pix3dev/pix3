import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

import { findProjectRoot, PROJECT_MANIFEST_FILE } from '../manifest.ts';
import {
  CHECK_TSCONFIG,
  hasOwnTsconfig,
  installProjectTypes,
  projectTypesCurrent,
  ROOT_TSCONFIG,
} from '../types/project-types.ts';
import type { BundledDiagnostic, BundledValidateReport } from '../validate/entry.ts';
import { CLI_VERSION } from '../version.ts';
import { runTypecheck, type TypecheckResult } from './typecheck.ts';
import {
  resolveTypeScript,
  TypeScriptUnavailableError,
  type ResolvedTypeScript,
  type ResolveTypeScriptOptions,
} from './typescript.ts';

/**
 * `pix3 check [--json] [--no-hydrate] [--offline] [--project <dir>]` (plan §5 A): everything
 * `pix3 validate` checks (both levels), plus a TypeScript type-check of the project's scripts, the
 * newest `.pix3/merge-log.jsonl` entries (the editor kept a human's value over the agent's), and
 * whether the agent kit and the project's `@pix3/runtime` match this CLI.
 *
 * Diagnostics share one list with validate's: tsc errors become `E_TYPE`. Exit codes as validate:
 * 0 = no errors, 1 = at least one error, 2 = could not run (bad arguments, no project).
 *
 * Imports nothing heavy at load time: the validator bundle, TypeScript and the runtime types are
 * all reached lazily.
 */

export const CHECK_USAGE = `Usage: pix3 check [--json] [--no-hydrate] [--offline] [--project <dir>]

  Everything \`pix3 validate\` checks, plus a TypeScript type-check of the project's scripts
  (tsc --noEmit), the newest .pix3/merge-log.jsonl entries and a version check.

  --json         machine-readable report (diagnostics, sha256 of every checked file, typecheck,
                 mergeLog, kit)
  --no-hydrate   validate level 1 only (user: component properties not checked)
  --offline      never install TypeScript (fails with the command to run instead)
  --project dir  project root (default: nearest folder with pix3project.yaml)
`;

/** Codes `check` adds to validate's (`src/validate/diagnostics.ts`). */
export const CHECK_CODES = {
  E_TYPE: { severity: 'error', summary: 'a TypeScript error in a project script' },
  E_DEPENDENCIES_MISSING: {
    severity: 'error',
    summary:
      'the project has its own tsconfig.json but no node_modules: run npm install (the type-check was skipped)',
  },
  E_TYPECHECK_UNAVAILABLE: {
    severity: 'error',
    summary: 'TypeScript could not be found or installed, so the scripts were not type-checked',
  },
  W_RUNTIME_VERSION_MISMATCH: {
    severity: 'warning',
    summary: "the project's own node_modules/@pix3/runtime is not this CLI's version",
  },
  W_RUNTIME_NOT_INSTALLED: {
    severity: 'warning',
    summary:
      'the project has its own tsconfig.json and node_modules, but no node_modules/@pix3/runtime',
  },
  W_KIT_OUTDATED: {
    severity: 'warning',
    summary: 'the agent kit in this project was written by another CLI version',
  },
} as const;

export type CheckCode = keyof typeof CHECK_CODES;

export type CheckDiagnostic = Omit<BundledDiagnostic, 'code'> & { readonly code: string };

/** How many of the newest merge-log lines `check` reports. */
export const MERGE_LOG_TAIL = 10;
const MERGE_LOG_FILE = '.pix3/merge-log.jsonl';
/** Human output lists at most this many diagnostics of one code before summarising. */
const HUMAN_LIMIT_PER_CODE = 40;

export interface CheckReport {
  readonly ok: boolean;
  readonly projectRoot: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly level2: BundledValidateReport['level2'];
  /** Every file checked (scenes validated + scripts type-checked), sha256 of the raw bytes. */
  readonly files: readonly { readonly file: string; readonly sha256: string }[];
  readonly diagnostics: readonly CheckDiagnostic[];
  readonly notes: readonly string[];
  readonly typecheck: {
    readonly ok: boolean;
    /**
     * Number of `E_TYPE` / `E_TYPECHECK_UNAVAILABLE` / `E_DEPENDENCIES_MISSING` diagnostics (they
     * are in `diagnostics`).
     */
    readonly errors: number;
    readonly tsconfig: string | null;
    /** `project` = the project's own tsconfig; `pix3-types` = `.pix3/tsconfig.check.json`. */
    readonly mode: 'project' | 'pix3-types';
    readonly files: number;
    readonly typescript: { readonly version: string; readonly source: string } | null;
    /** Why tsc did not run at all (null when it ran, or was attempted and failed). */
    readonly skipped: string | null;
  };
  /** The newest {@link MERGE_LOG_TAIL} lines of `.pix3/merge-log.jsonl`, oldest first. */
  readonly mergeLog: readonly Record<string, unknown>[];
  readonly kit: {
    readonly version: string | null;
    readonly cliVersion: string;
    readonly upToDate: boolean;
  };
  readonly timingsMs: {
    readonly validate: number;
    readonly typecheck: number;
    readonly total: number;
  };
}

/** The validator, as `check` calls it (the bundle; specs can pass the source function). */
export type ValidateFn = (options: {
  projectRoot: string;
  hydrate: boolean;
}) => Promise<BundledValidateReport>;

export interface CheckIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly validate?: ValidateFn;
  readonly typescript?: Partial<Omit<ResolveTypeScriptOptions, 'projectRoot' | 'offline'>>;
  readonly now?: () => Date;
}

interface CheckArgs {
  readonly json: boolean;
  readonly hydrate: boolean;
  readonly offline: boolean;
  readonly project?: string;
  readonly help: boolean;
}

const parseCheckArgs = (argv: readonly string[]): CheckArgs | { error: string } => {
  let json = false;
  let hydrate = true;
  let offline = false;
  let project: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--no-hydrate') hydrate = false;
    else if (arg === '--offline') offline = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--project') {
      project = argv[++i];
      if (!project) return { error: '--project needs a folder' };
    } else if (arg.startsWith('--project=')) project = arg.slice('--project='.length);
    else return { error: `unknown argument ${arg}` };
  }
  return { json, hydrate, offline, project, help };
};

const defaultValidate: ValidateFn = async options => {
  const { withValidateBundle } = await import('../validate/entry.ts');
  return withValidateBundle((bundle, esbuildSpecifier) =>
    bundle.validateBundledProject({ ...options, esbuildSpecifier })
  );
};

const sha256File = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const diag = (
  code: CheckCode,
  fields: Omit<CheckDiagnostic, 'severity' | 'code'>
): CheckDiagnostic => ({ severity: CHECK_CODES[code].severity, code, ...fields });

/** `metadata.agentKit.version` of the manifest, or null. */
export const readKitVersion = (projectRoot: string): string | null => {
  try {
    const parsed = parse(readFileSync(join(projectRoot, PROJECT_MANIFEST_FILE), 'utf8')) as unknown;
    const metadata =
      parsed && typeof parsed === 'object'
        ? (parsed as { metadata?: { agentKit?: { version?: unknown } } }).metadata
        : undefined;
    const version = metadata?.agentKit?.version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
};

/** Whether a `node_modules` folder is reachable from the project (walking up), as Node resolves. */
export const hasNodeModules = (projectRoot: string): boolean => {
  let dir = resolve(projectRoot);
  for (;;) {
    if (existsSync(join(dir, 'node_modules'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
};

/** Version of the `@pix3/runtime` a project resolves from `node_modules` (walking up), or null. */
export const installedRuntimeVersion = (projectRoot: string): string | null => {
  let dir = resolve(projectRoot);
  for (;;) {
    const candidate = join(dir, 'node_modules', '@pix3', 'runtime', 'package.json');
    if (existsSync(candidate)) {
      try {
        const version = (JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown })
          .version;
        return typeof version === 'string' ? version : null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

export const readMergeLogTail = (
  projectRoot: string,
  limit = MERGE_LOG_TAIL
): Record<string, unknown>[] => {
  let text: string;
  try {
    text = readFileSync(join(projectRoot, MERGE_LOG_FILE), 'utf8');
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // a torn last line while the editor appends; skip it
    }
  }
  return out.slice(-limit);
};

const age = (at: unknown, now: Date): string => {
  const time = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.round((now.getTime() - time) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
};

/** Merge-log events the human output prints as notes: nothing for the agent to do. */
const INFORMATIONAL_EVENTS: ReadonlySet<unknown> = new Set(['ack-unknown']);

/** One line per merge-log entry, in words an agent acts on. */
export const describeMergeLogEntry = (entry: Record<string, unknown>, now: Date): string => {
  const file = typeof entry.file === 'string' ? entry.file : '(project)';
  const when = age(entry.at, now);
  const prefix = `${when ? `${when}  ` : ''}${file}  `;
  switch (entry.event) {
    case 'merge': {
      const decisions = Array.isArray(entry.decisions) ? entry.decisions : [];
      const kept = decisions.filter(
        d => d && typeof d === 'object' && (d as { kept?: unknown }).kept === 'human'
      ).length;
      const silent = decisions.filter(
        d =>
          d &&
          typeof d === 'object' &&
          (d as { kept?: unknown }).kept === 'human-unchanged-by-agent'
      ).length;
      const conflicts = Array.isArray(entry.conflicts) ? entry.conflicts.length : 0;
      if (entry.status === 'rejected') {
        const problems = Array.isArray(entry.problems) ? entry.problems.join('; ') : '';
        return `${prefix}REJECTED your version (${problems || 'unreadable'}); the editor kept its own. Fix the file and write it again.`;
      }
      const parts: string[] = [];
      if (kept > 0 || conflicts > 0) {
        parts.push(
          `the editor KEPT ${Math.max(kept, conflicts)} human value(s) over yours — \`pix3 read ${file}\`, then write again if yours is still meant`
        );
      }
      if (silent > 0) {
        parts.push(`${silent} human value(s) kept where your file carried the old value`);
      }
      return `${prefix}merged${parts.length ? `: ${parts.join('; ')}` : ' cleanly'}`;
    }
    case 'ack-applied':
      return `${prefix}your read confirmation was applied (released ${Array.isArray(entry.released) ? entry.released.length : 0} protected value(s))`;
    case 'ack-unknown':
      return `${prefix}read confirmation for a version the editor has not recorded — ignored (harmless: nothing is protected by it and there is nothing to do; it stops showing once the file changes)`;
    case 'accept-agent':
      return `${prefix}the human accepted your version`;
    case 'keep-mine':
      return `${prefix}the human kept their version over yours`;
    case 'restore-version':
      return `${prefix}the human restored an earlier version`;
    case 'reload':
      return `${prefix}reloaded your version`;
    default:
      return `${prefix}${String(entry.event ?? 'entry')}`;
  }
};

/** An `ack-unknown` entry whose `hash` is not the file's current version any more. */
const isAboutSupersededVersion = (
  entry: Record<string, unknown>,
  currentHashes: ReadonlyMap<string, string>
): boolean => {
  if (typeof entry.hash !== 'string' || typeof entry.file !== 'string') return false;
  const current = currentHashes.get(entry.file);
  return current !== undefined && current !== entry.hash;
};

const formatDiagnostic = (d: CheckDiagnostic): string => {
  const where = `${d.file}${d.line !== undefined ? `:${d.line}` : ''}`;
  const node = d.nodeId !== undefined ? ` [${d.nodeId}]` : '';
  let text = `${where}  ${d.severity}  ${d.code}${node}  ${d.message}\n`;
  if (d.path) text += `    at ${d.path}\n`;
  if (d.fix) text += `    fix: ${d.fix}\n`;
  return text;
};

export const formatCheckHuman = (report: CheckReport, now: Date): string => {
  let out = '';
  const perCode = new Map<string, number>();
  let hidden = 0;
  for (const d of report.diagnostics) {
    const seen = (perCode.get(d.code) ?? 0) + 1;
    perCode.set(d.code, seen);
    if (seen > HUMAN_LIMIT_PER_CODE) {
      hidden += 1;
      continue;
    }
    out += formatDiagnostic(d);
  }
  if (hidden > 0) out += `… ${hidden} more (pix3 check --json lists them all)\n`;
  for (const note of report.notes) out += `note: ${note}\n`;
  // An ignored read confirmation needs no action (the editor simply had no record of that
  // version), so it is a note, not a line in the list an agent is told to act on — and only while
  // it is about the file's CURRENT bytes: the log is a ring the entry sits in for a long time, and
  // one about a version the disk no longer holds is history, not a note to repeat on every run.
  const currentHashes = new Map(report.files.map(file => [file.file, file.sha256]));
  const informational = report.mergeLog.filter(
    entry =>
      INFORMATIONAL_EVENTS.has(entry.event) && !isAboutSupersededVersion(entry, currentHashes)
  );
  const actionable = report.mergeLog.filter(entry => !INFORMATIONAL_EVENTS.has(entry.event));
  for (const entry of informational) out += `note: ${describeMergeLogEntry(entry, now)}\n`;
  if (actionable.length > 0) {
    out += `merge-log (newest ${actionable.length}, .pix3/merge-log.jsonl):\n`;
    for (const entry of actionable) out += `  ${describeMergeLogEntry(entry, now)}\n`;
  }
  const tc = report.typecheck;
  const typecheckLine = tc.typescript
    ? `typecheck ${tc.files} file(s) with TypeScript ${tc.typescript.version} (${tc.typescript.source}, ${tc.tsconfig}): ${tc.errors} error(s)`
    : tc.skipped
      ? `typecheck skipped: ${tc.skipped}`
      : 'typecheck did not run';
  const level2 =
    report.level2.state === 'ran'
      ? `level 2 hydrated ${report.level2.filesHydrated} file(s)${
          report.level2.filesSkippedForScripts
            ? `, ${report.level2.filesSkippedForScripts} SKIPPED (scripts do not compile — user: components unchecked)`
            : ''
        }`
      : report.level2.state === 'disabled'
        ? 'level 2 off'
        : `level 2 skipped: ${report.level2.reason}`;
  out += `${typecheckLine}; ${level2}.\n`;
  if (report.kit.version === null) {
    out += `kit: none in this project (pix3 kit installs it).\n`;
  }
  out +=
    `${report.errorCount === 0 ? 'OK' : 'FAILED'}: ${report.files.length} file(s) checked, ` +
    `${report.errorCount} error(s), ${report.warningCount} warning(s) in ${report.timingsMs.total} ms.\n`;
  return out;
};

export const formatCheckJson = (report: CheckReport): string =>
  `${JSON.stringify(report, null, 2)}\n`;

const compare = (a: CheckDiagnostic, b: CheckDiagnostic): number =>
  a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.code.localeCompare(b.code);

/** Run the whole check; never throws for problems in the project (returns them). */
export const checkProject = async (
  projectRoot: string,
  options: {
    readonly hydrate: boolean;
    readonly offline: boolean;
    readonly validate?: ValidateFn;
    readonly typescript?: CheckIo['typescript'];
    readonly log?: (line: string) => void;
  }
): Promise<CheckReport> => {
  const started = Date.now();
  const validate = options.validate ?? defaultValidate;
  const validated = await validate({ projectRoot, hydrate: options.hydrate });
  const validateMs = Date.now() - started;

  const diagnostics: CheckDiagnostic[] = [];
  const notes: string[] = [...validated.notes];

  // --- the type-check layout ------------------------------------------------------------------
  const ownTsconfig = hasOwnTsconfig(projectRoot);
  let tsconfig: string | null;
  let skipped: string | null = null;
  if (ownTsconfig) {
    tsconfig = ROOT_TSCONFIG;
    const installed = installedRuntimeVersion(projectRoot);
    if (!hasNodeModules(projectRoot)) {
      // Without node_modules every import fails, and tsc reports each one as its own "Cannot find
      // module" — hundreds of E_TYPE lines that all mean `npm install`. Say that once instead.
      skipped = 'dependencies not installed (run npm install)';
      diagnostics.push(
        diag('E_DEPENDENCIES_MISSING', {
          file: existsSync(join(projectRoot, 'package.json')) ? 'package.json' : ROOT_TSCONFIG,
          message:
            'This project has its own tsconfig.json, so its scripts are type-checked against its own node_modules — and there is no node_modules. The type-check was skipped; the scenes were still validated.',
          fix: 'npm install',
        })
      );
    } else if (installed === null) {
      diagnostics.push(
        diag('W_RUNTIME_NOT_INSTALLED', {
          file: ROOT_TSCONFIG,
          message: `This project has its own tsconfig.json, so its scripts are type-checked against its own node_modules — and node_modules/@pix3/runtime is missing (this CLI ships ${CLI_VERSION}).`,
          fix: 'npm install in the project, then run pix3 check again',
        })
      );
    } else if (installed !== CLI_VERSION) {
      diagnostics.push(
        diag('W_RUNTIME_VERSION_MISMATCH', {
          file: 'node_modules/@pix3/runtime/package.json',
          message: `The project type-checks against @pix3/runtime ${installed}; this CLI (and its kit and validator) is ${CLI_VERSION}. APIs the kit describes may be missing, or behave differently.`,
          fix: `npm install @pix3/runtime@${CLI_VERSION}, or run the @pix3/cli@${installed} that matches it`,
        })
      );
    }
  } else {
    tsconfig = CHECK_TSCONFIG;
    const { ensureRuntimeTypes } = await import('../types/runtime-types.ts');
    const shipped = ensureRuntimeTypes({ log: options.log });
    if (!projectTypesCurrent(projectRoot, shipped.manifest)) {
      installProjectTypes(projectRoot, shipped);
      notes.push(
        `Wrote the @pix3/runtime ${shipped.manifest.runtimeVersion} types to .pix3/types/ (and ${CHECK_TSCONFIG}).`
      );
    }
  }

  // --- TypeScript -----------------------------------------------------------------------------
  const typecheckStarted = Date.now();
  let resolved: ResolvedTypeScript | null = null;
  let result: TypecheckResult | null = null;
  if (skipped === null) {
    try {
      resolved = await resolveTypeScript({
        projectRoot,
        offline: options.offline,
        log: options.log,
        ...options.typescript,
      });
      result = runTypecheck(resolved.ts, projectRoot, tsconfig);
    } catch (error) {
      const command = error instanceof TypeScriptUnavailableError ? error.command : undefined;
      diagnostics.push(
        diag('E_TYPECHECK_UNAVAILABLE', {
          file: tsconfig,
          message: error instanceof Error ? error.message : String(error),
          fix: command,
        })
      );
    }
  }
  const typecheckMs = Date.now() - typecheckStarted;
  const typeDiagnostics: CheckDiagnostic[] = (result?.errors ?? []).map(error =>
    diag('E_TYPE', {
      file: error.file,
      line: error.line,
      message: `${error.tsCode}: ${error.message}`,
    })
  );
  diagnostics.push(...typeDiagnostics);

  // --- kit ------------------------------------------------------------------------------------
  const kitVersion = readKitVersion(projectRoot);
  const kitUpToDate = kitVersion === CLI_VERSION;
  if (kitVersion !== null && !kitUpToDate) {
    diagnostics.push(
      diag('W_KIT_OUTDATED', {
        file: PROJECT_MANIFEST_FILE,
        path: 'metadata.agentKit.version',
        message: `The agent kit here is ${kitVersion}; this CLI is ${CLI_VERSION}.`,
        fix: `pix3 kit --update (it never overwrites kit files you edited)`,
      })
    );
  }

  // --- files and their hashes -----------------------------------------------------------------
  const files = new Map<string, string>();
  for (const file of validated.files) files.set(file.file, file.sha256);
  for (const file of result?.files ?? []) {
    if (file.startsWith('/') || /^[A-Za-z]:/.test(file)) continue; // outside the project
    const absolute = join(projectRoot, file);
    if (!files.has(file) && existsSync(absolute)) files.set(file, sha256File(absolute));
  }

  const all = [...validated.diagnostics, ...[...diagnostics].sort(compare)];
  const errorCount = all.filter(d => d.severity === 'error').length;
  const typeErrors = all.filter(
    d =>
      d.code === 'E_TYPE' ||
      d.code === 'E_TYPECHECK_UNAVAILABLE' ||
      d.code === 'E_DEPENDENCIES_MISSING'
  ).length;
  return {
    ok: errorCount === 0,
    projectRoot,
    errorCount,
    warningCount: all.filter(d => d.severity === 'warning').length,
    level2: validated.level2,
    files: [...files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([file, sha256]) => ({ file, sha256 })),
    diagnostics: all,
    notes,
    typecheck: {
      ok: typeErrors === 0,
      errors: typeErrors,
      tsconfig,
      mode: ownTsconfig ? 'project' : 'pix3-types',
      files: result?.files.length ?? 0,
      typescript: resolved ? { version: resolved.version, source: resolved.source } : null,
      skipped,
    },
    mergeLog: readMergeLogTail(projectRoot),
    kit: { version: kitVersion, cliVersion: CLI_VERSION, upToDate: kitUpToDate },
    timingsMs: { validate: validateMs, typecheck: typecheckMs, total: Date.now() - started },
  };
};

/** Entry for `pix3 check …`; returns the process exit code. */
export const runCheck = async (argv: readonly string[], io: CheckIo): Promise<number> => {
  const args = parseCheckArgs(argv);
  if ('error' in args) {
    io.stderr(`pix3 check: ${args.error}\n\n${CHECK_USAGE}`);
    return 2;
  }
  if (args.help) {
    io.stdout(
      `${CHECK_USAGE}\nCodes added to validate's (pix3 validate --help lists those):\n${Object.entries(
        CHECK_CODES
      )
        .map(([code, info]) => `  ${code.padEnd(28)} ${info.summary}`)
        .join('\n')}\n`
    );
    return 0;
  }
  const start = args.project ? resolve(io.cwd, args.project) : io.cwd;
  const projectRoot = args.project ? start : findProjectRoot(start);
  if (!projectRoot || !existsSync(join(projectRoot, PROJECT_MANIFEST_FILE))) {
    io.stderr(
      `pix3 check: no pix3project.yaml in ${start}${args.project ? '' : ' or any parent folder'}. Run it inside a Pix3 project, or pass --project <dir>.\n`
    );
    return 2;
  }
  const report = await checkProject(projectRoot, {
    hydrate: args.hydrate,
    offline: args.offline,
    validate: io.validate,
    typescript: io.typescript,
    log: line => io.stderr(`${line}\n`),
  });
  io.stdout(
    args.json ? formatCheckJson(report) : formatCheckHuman(report, io.now?.() ?? new Date())
  );
  return report.errorCount > 0 ? 1 : 0;
};
