import { isAbsolute, relative, resolve, sep } from 'node:path';

import type * as TS from 'typescript';

import type { TypeScriptModule } from './typescript.ts';

/**
 * One `tsc --noEmit` pass over a tsconfig, through the compiler API (same answer as the `tsc` CLI:
 * `getPreEmitDiagnostics` = options + syntactic + global + semantic diagnostics).
 */

export interface TypeCheckError {
  /** Project-relative (forward slashes) when inside the project, else absolute. */
  readonly file: string;
  /** 1-based; absent for diagnostics without a location (config, global). */
  readonly line?: number;
  readonly column?: number;
  /** `TS2339` etc. */
  readonly tsCode: string;
  readonly message: string;
}

export interface TypecheckResult {
  readonly tsconfig: string;
  /** Project-relative paths of the root files type-checked (the tsconfig's `include`). */
  readonly files: readonly string[];
  readonly errors: readonly TypeCheckError[];
  readonly durationMs: number;
}

const toProjectPath = (projectRoot: string, file: string): string => {
  const rel = relative(projectRoot, file);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : file;
};

export const runTypecheck = (
  ts: TypeScriptModule,
  projectRoot: string,
  tsconfigPath: string
): TypecheckResult => {
  const started = Date.now();
  const errors: TypeCheckError[] = [];
  const configFile = resolve(projectRoot, tsconfigPath);
  const tsconfig = toProjectPath(projectRoot, configFile);

  const describe = (diagnostic: TS.Diagnostic): TypeCheckError => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    const tsCode = `TS${diagnostic.code}`;
    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return {
        file: toProjectPath(projectRoot, diagnostic.file.fileName),
        line: line + 1,
        column: character + 1,
        tsCode,
        message,
      };
    }
    return {
      file: diagnostic.file ? toProjectPath(projectRoot, diagnostic.file.fileName) : tsconfig,
      tsCode,
      message,
    };
  };

  const configErrors: TS.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configFile,
    { noEmit: true },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: diagnostic => configErrors.push(diagnostic),
    }
  );
  if (!parsed) {
    return {
      tsconfig,
      files: [],
      errors: configErrors.map(describe),
      durationMs: Date.now() - started,
    };
  }
  // TS18003 "No inputs were found": a project without scripts is not a type error.
  const NO_INPUTS = 18003;
  for (const diagnostic of [...configErrors, ...parsed.errors]) {
    if (diagnostic.code !== NO_INPUTS) errors.push(describe(diagnostic));
  }
  const files = parsed.fileNames.map(file => toProjectPath(projectRoot, file)).sort();
  if (parsed.fileNames.length > 0) {
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: { ...parsed.options, noEmit: true },
      projectReferences: parsed.projectReferences,
    });
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) errors.push(describe(diagnostic));
  }
  return { tsconfig, files, errors, durationMs: Date.now() - started };
};
