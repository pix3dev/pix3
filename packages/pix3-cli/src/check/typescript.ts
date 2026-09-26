import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as TS from 'typescript';

/**
 * Where `pix3 check` gets TypeScript from. TypeScript (~20 MB) is **not** a dependency of
 * `@pix3/cli` — `new`, `kit`, `validate`, `mcp`, `serve` never need it and must stay instant — so
 * it is found, in this order (plan §5 A "Откуда TypeScript"):
 *
 * 1. the project's own install (`node_modules/typescript` in the project or above it) — a Vite
 *    project such as DeepCore type-checks with the compiler it pinned;
 * 2. the CLI's sibling install (`import.meta.resolve('typescript')`) — present in the monorepo, or
 *    wherever a user installed `typescript` next to `@pix3/cli`;
 * 3. `~/.pix3/typescript/<PINNED>/` — installed there once, lazily, with
 *    `npm install --prefix <dir> typescript@<PINNED>` (printed before it runs). `--offline` refuses
 *    to install and says which command would.
 *
 * Loaded with a dynamic `import()` of the resolved file, never a static import. `PIX3_TYPESCRIPT`
 * (a path to a `typescript` package directory) overrides the search — for tests and odd setups.
 */

export const PINNED_TYPESCRIPT_VERSION = '5.8.3';

export type TypeScriptModule = typeof TS;

export type TypeScriptSource = 'env' | 'project' | 'cli' | 'cache' | 'installed';

export interface ResolvedTypeScript {
  readonly ts: TypeScriptModule;
  readonly source: TypeScriptSource;
  /** The package directory it was loaded from. */
  readonly dir: string;
  readonly version: string;
}

export interface ResolveTypeScriptOptions {
  readonly projectRoot: string;
  readonly offline?: boolean;
  /** Where the lazy install goes (default `~/.pix3/typescript`). */
  readonly cacheRoot?: string;
  readonly log?: (line: string) => void;
  /** Replaces `npm install` (specs). Returns an error message, or null on success. */
  readonly install?: (prefix: string, version: string) => string | null;
  /** Skip the CLI's sibling install (specs: the monorepo always has one). */
  readonly skipCliSibling?: boolean;
}

export class TypeScriptUnavailableError extends Error {
  readonly command: string;
  constructor(message: string, command: string) {
    super(message);
    this.command = command;
  }
}

export const defaultTypeScriptCacheRoot = (): string => join(homedir(), '.pix3', 'typescript');

export const installCommand = (prefix: string, version = PINNED_TYPESCRIPT_VERSION): string =>
  `npm install --prefix ${JSON.stringify(prefix)} typescript@${version} --no-save --no-package-lock --no-audit --no-fund --loglevel=error`;

const packageDirFromRequire = (require: ReturnType<typeof createRequire>): string | null => {
  try {
    return join(require.resolve('typescript/package.json'), '..');
  } catch {
    return null;
  }
};

const fromProject = (projectRoot: string): string | null =>
  packageDirFromRequire(createRequire(join(projectRoot, '__pix3_check__.js')));

const fromCli = (): string | null => {
  try {
    const resolved = import.meta.resolve('typescript');
    // …/node_modules/typescript/lib/typescript.js → the package directory
    return join(fileURLToPath(resolved), '..', '..');
  } catch {
    return null;
  }
};

const npmInstall = (prefix: string, version: string): string | null => {
  mkdirSync(prefix, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npm,
    [
      'install',
      '--prefix',
      prefix,
      `typescript@${version}`,
      '--no-save',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' }
  );
  if (result.error) return result.error.message;
  if (result.status !== 0)
    return (result.stderr || result.stdout || `exit ${result.status}`).trim();
  return null;
};

const load = async (dir: string): Promise<{ ts: TypeScriptModule; version: string }> => {
  const require = createRequire(join(dir, 'package.json'));
  const entry = require.resolve('typescript');
  const imported = (await import(pathToFileURL(entry).href)) as {
    default?: TypeScriptModule;
  } & Partial<TypeScriptModule>;
  const ts = (imported.default ?? imported) as TypeScriptModule;
  if (typeof ts.createProgram !== 'function') {
    throw new Error(`${entry} is not the TypeScript compiler API`);
  }
  return { ts, version: ts.version };
};

export const resolveTypeScript = async (
  options: ResolveTypeScriptOptions
): Promise<ResolvedTypeScript> => {
  const override = process.env.PIX3_TYPESCRIPT;
  if (override) {
    const { ts, version } = await load(override);
    return { ts, version, source: 'env', dir: override };
  }
  const project = fromProject(options.projectRoot);
  if (project) return { ...(await load(project)), source: 'project', dir: project };
  const cli = options.skipCliSibling ? null : fromCli();
  if (cli && existsSync(join(cli, 'package.json'))) {
    return { ...(await load(cli)), source: 'cli', dir: cli };
  }
  const prefix = join(options.cacheRoot ?? defaultTypeScriptCacheRoot(), PINNED_TYPESCRIPT_VERSION);
  const cached = join(prefix, 'node_modules', 'typescript');
  const command = installCommand(prefix);
  if (existsSync(join(cached, 'package.json'))) {
    return { ...(await load(cached)), source: 'cache', dir: cached };
  }
  if (options.offline) {
    throw new TypeScriptUnavailableError(
      `TypeScript is not installed for pix3 check, and --offline forbids installing it. Run once:\n  ${command}`,
      command
    );
  }
  options.log?.(
    `pix3 check: installing TypeScript ${PINNED_TYPESCRIPT_VERSION} once into ${prefix}\n  $ ${command}`
  );
  const failure = (options.install ?? npmInstall)(prefix, PINNED_TYPESCRIPT_VERSION);
  if (failure !== null || !existsSync(join(cached, 'package.json'))) {
    throw new TypeScriptUnavailableError(
      `Could not install TypeScript (${failure ?? 'npm reported success but nothing was installed'}). Run it yourself:\n  ${command}`,
      command
    );
  }
  return { ...(await load(cached)), source: 'installed', dir: cached };
};
