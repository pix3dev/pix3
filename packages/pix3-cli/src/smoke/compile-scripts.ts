import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { registerProjectScriptExports, type ScriptRegistry } from '@pix3/runtime';
import type { Plugin } from 'esbuild';

import type { ProjectFiles } from '../validate/project.ts';
import { isRecord } from '../validate/yaml-doc.ts';

/**
 * Compile the project's scripts for **running**, not just for registering.
 *
 * `pix3 validate` level 2 compiles the same entries but turns every bare import other than
 * `@pix3/runtime` / `three` into an empty module — it only needs the classes defined. A smoke run
 * executes them, so here a bare import is bundled for real from the project's own `node_modules`
 * (a consumer project such as one that uses Rapier directly has it installed), falling back to the
 * CLI's install for `three/*` addons. Only what resolves nowhere is stubbed, and every stub is
 * reported: a game whose physics library became `{}` is not the game.
 */

export interface ScriptImportUrls {
  readonly runtime: string;
  readonly three: string;
}

export type CompileResult =
  | {
      readonly status: 'loaded';
      readonly registered: readonly string[];
      readonly stubbed: readonly string[];
      readonly bundledPackages: readonly string[];
    }
  | { readonly status: 'none' }
  | {
      readonly status: 'compile-failed';
      readonly failures: readonly {
        readonly message: string;
        readonly file?: string;
        readonly line?: number;
      }[];
    }
  | {
      readonly status: 'import-failed';
      readonly error: unknown;
      readonly stubbed: readonly string[];
    }
  | { readonly status: 'unavailable'; readonly reason: string };

type EsbuildModule = typeof import('esbuild');

const packageNameOf = (specifier: string): string => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

const runPlugin = (
  imports: ScriptImportUrls,
  project: ProjectFiles,
  stubbed: Set<string>,
  bundled: Set<string>,
  fallbackDir: string | undefined
): Plugin => ({
  name: 'pix3-smoke-imports',
  setup(build) {
    build.onResolve({ filter: /^@pix3\/runtime$/ }, () => ({
      path: imports.runtime,
      external: true,
    }));
    build.onResolve({ filter: /^three$/ }, () => ({ path: imports.three, external: true }));
    build.onResolve({ filter: /\?(raw|url)$/ }, args => {
      const [path, query] = args.path.split('?');
      return {
        path: join(args.resolveDir, path),
        namespace: query === 'raw' ? 'pix3-raw' : 'pix3-url',
      };
    });
    build.onResolve({ filter: /^[^./]/ }, async args => {
      if (args.kind === 'entry-point' || args.pluginData === 'pix3-smoke') return undefined;
      if (args.path.startsWith('node:') || args.path.startsWith('virtual:')) {
        stubbed.add(args.path);
        return { path: args.path, namespace: 'pix3-stub' };
      }
      const attempt = async (resolveDir: string) =>
        build.resolve(args.path, { kind: args.kind, resolveDir, pluginData: 'pix3-smoke' });
      let result = await attempt(args.resolveDir);
      if (result.errors.length > 0 && fallbackDir && packageNameOf(args.path) === 'three') {
        result = await attempt(fallbackDir);
      }
      if (result.errors.length > 0 || !result.path) {
        stubbed.add(args.path);
        return { path: args.path, namespace: 'pix3-stub' };
      }
      bundled.add(packageNameOf(args.path));
      return { path: result.path, external: result.external };
    });
    build.onLoad({ filter: /.*/, namespace: 'pix3-stub' }, () => ({
      contents: 'module.exports = {};',
      loader: 'js',
    }));
    build.onLoad({ filter: /.*/, namespace: 'pix3-raw' }, async args => {
      const { readFile } = await import('node:fs/promises');
      return {
        contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))};`,
        loader: 'js',
      };
    });
    build.onLoad({ filter: /.*/, namespace: 'pix3-url' }, args => ({
      contents: `export default ${JSON.stringify(`res://${project.relativeOf(args.path) ?? args.path}`)};`,
      loader: 'js',
    }));
  },
});

export const compileAndImportScripts = async (
  project: ProjectFiles,
  entries: readonly string[],
  registry: ScriptRegistry,
  imports: ScriptImportUrls,
  options: {
    readonly esbuildSpecifier?: string;
    /** Where `three/*` addons resolve when the project has no `three` of its own. */
    readonly fallbackResolveDir?: string;
  } = {}
): Promise<CompileResult> => {
  const esbuildSpecifier = options.esbuildSpecifier ?? 'esbuild';
  if (entries.length === 0) return { status: 'none' };
  let esbuild: EsbuildModule;
  try {
    esbuild = (await import(esbuildSpecifier)) as EsbuildModule;
  } catch {
    return {
      status: 'unavailable',
      reason:
        'esbuild is not installed (it is an optional dependency of @pix3/cli), so the project scripts cannot be compiled',
    };
  }
  const stubbed = new Set<string>();
  const bundled = new Set<string>();
  let code: string;
  try {
    const result = await esbuild.build({
      stdin: {
        contents: entries
          .map(
            (file, index) =>
              `export * as __pix3_entry_${index} from ${JSON.stringify(`./${file}`)};`
          )
          .join('\n'),
        resolveDir: project.root,
        sourcefile: 'pix3-smoke-scripts.ts',
        loader: 'ts',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      logLevel: 'silent',
      // Stacks point at the project's own files (Node applies it: `setSourceMapsEnabled`).
      sourcemap: 'inline',
      // With a trailing separator: consumers concatenate sourceRoot + source, and without it
      // every stack read `<root>scripts/Foo.ts` (the root never stripped from the report).
      sourceRoot: `${project.root.replace(/[\\/]+$/, '')}/`,
      loader: {
        '.glsl': 'text',
        '.vert': 'text',
        '.frag': 'text',
        '.css': 'empty',
        '.wasm': 'binary',
      },
      define: {
        'import.meta.env.BASE_URL': JSON.stringify('/'),
        'import.meta.env.DEV': 'true',
        'import.meta.env.PROD': 'false',
        'import.meta.env.MODE': JSON.stringify('development'),
      },
      plugins: [runPlugin(imports, project, stubbed, bundled, options.fallbackResolveDir)],
    });
    code = result.outputFiles[0]?.text ?? '';
  } catch (error) {
    const failures =
      (
        error as {
          errors?: Array<{ text: string; location?: { file: string; line: number } | null }>;
        }
      ).errors ?? [];
    return {
      status: 'compile-failed',
      failures: (failures.length > 0 ? failures : [{ text: String(error), location: null }]).map(
        failure => ({
          message: failure.text,
          file: failure.location?.file,
          line: failure.location?.line,
        })
      ),
    };
  }
  const dir = mkdtempSync(join(tmpdir(), 'pix3-smoke-scripts-'));
  const modulePath = join(dir, 'scripts.mjs');
  try {
    writeFileSync(modulePath, code);
    const module = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
    const registered: string[] = [];
    entries.forEach((file, index) => {
      const namespace = module[`__pix3_entry_${index}`];
      if (isRecord(namespace))
        registered.push(...registerProjectScriptExports(registry, namespace, file));
    });
    return {
      status: 'loaded',
      registered,
      stubbed: [...stubbed].sort(),
      bundledPackages: [...bundled].sort(),
    };
  } catch (error) {
    return { status: 'import-failed', error, stubbed: [...stubbed].sort() };
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
};
