import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectRenderabilityIssues,
  registerProjectScriptExports,
  SceneLoader,
  SceneValidationError,
  type ScriptRegistry,
} from '@pix3/runtime';
import {
  collectLoaderWarnings,
  DiskResourceManager,
  installCanvasOnlyDocument,
  MissingResourceError,
  NodeAssetLoader,
} from '@pix3/runtime/node';
import type { Plugin } from 'esbuild';

import { diagnostic, type Diagnostic } from './diagnostics.ts';
import { checkComponentConfig, type Level1Environment } from './level1.ts';
import type { ProjectFiles } from './project.ts';
import { isRecord, type DocPath, type ParsedYaml } from './yaml-doc.ts';

/**
 * Level 2 of `pix3 validate`: the real `SceneLoader`, with the project's scripts compiled by native
 * esbuild and imported — the path the editor takes, minus the browser.
 *
 * It needs no DOM beyond the canvas-only `document` shim (`@pix3/runtime/node`): measured on every
 * template scene in `.plans/measurements/external-agent-phase0-strict-profile.md`. It does run the
 * project's code (module top level and component constructors), which is why it is separate and
 * can be turned off (`--no-hydrate`).
 */

/** What a compiled user script's bare imports are rewritten to. */
export interface ScriptImportMap {
  /** Specifier for `@pix3/runtime` — must be the very instance the validator uses. */
  readonly runtime: string;
  /** Specifier for `three`. */
  readonly three: string;
}

/** Bare specifiers kept as-is: right when the host resolves them itself (vitest's aliases). */
export const BARE_SCRIPT_IMPORTS: ScriptImportMap = { runtime: '@pix3/runtime', three: 'three' };

export type ScriptLoadResult =
  | { readonly status: 'none' }
  | { readonly status: 'loaded'; readonly registered: readonly string[] }
  | { readonly status: 'failed'; readonly diagnostics: Diagnostic[] }
  | { readonly status: 'unavailable'; readonly reason: string };

type EsbuildModule = typeof import('esbuild');

const loadEsbuild = async (specifier: string): Promise<EsbuildModule | null> => {
  try {
    return (await import(specifier)) as EsbuildModule;
  } catch {
    return null;
  }
};

/**
 * Mirrors the editor's script compiler: `@pix3/runtime` and `three` are provided by the host,
 * `?raw` / `?url` / shader / CSS imports work as in the editor, and every other bare import (three
 * addons, rapier, …) becomes an empty module — it exists in the editor's import map, not here, and
 * validation only needs the classes to be defined, not to run.
 */
const hostImportsPlugin = (imports: ScriptImportMap, project: ProjectFiles): Plugin => ({
  name: 'pix3-validate-host-imports',
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
    build.onResolve({ filter: /^[^./]/ }, args =>
      args.kind === 'entry-point' ? undefined : { path: args.path, namespace: 'pix3-stub' }
    );
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

/** Compile the project's script entries, import them, register their Script exports. */
export const loadUserScripts = async (
  project: ProjectFiles,
  entries: readonly string[],
  registry: ScriptRegistry,
  imports: ScriptImportMap,
  /** Where `esbuild` resolves from; the bundle may live in a temp folder with no node_modules. */
  esbuildSpecifier = 'esbuild'
): Promise<ScriptLoadResult> => {
  if (entries.length === 0) return { status: 'none' };
  const esbuild = await loadEsbuild(esbuildSpecifier);
  if (!esbuild) {
    return {
      status: 'unavailable',
      reason:
        'esbuild is not installed (it is an optional dependency of @pix3/cli), so project scripts cannot be compiled',
    };
  }
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
        sourcefile: 'pix3-validate-scripts.ts',
        loader: 'ts',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      logLevel: 'silent',
      loader: { '.glsl': 'text', '.vert': 'text', '.frag': 'text', '.css': 'empty' },
      define: {
        'import.meta.env.BASE_URL': JSON.stringify('/'),
        'import.meta.env.DEV': 'true',
        'import.meta.env.PROD': 'false',
      },
      plugins: [hostImportsPlugin(imports, project)],
    });
    code = result.outputFiles[0]?.text ?? '';
  } catch (error) {
    const failures =
      (
        error as {
          errors?: Array<{ text: string; location?: { file: string; line: number } | null }>;
        }
      ).errors ?? [];
    const diagnostics = (
      failures.length > 0 ? failures : [{ text: String(error), location: null }]
    ).map(failure =>
      diagnostic({
        code: 'E_SCRIPT_COMPILE',
        file: failure.location?.file
          ? (project.relativeOf(join(project.root, failure.location.file)) ?? failure.location.file)
          : 'scripts',
        line: failure.location?.line,
        message: `Project scripts do not compile: ${failure.text}. The editor registers none of them, so every user: component stays unregistered.`,
      })
    );
    return { status: 'failed', diagnostics };
  }
  const dir = mkdtempSync(join(tmpdir(), 'pix3-validate-'));
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
    return { status: 'loaded', registered };
  } catch (error) {
    return {
      status: 'failed',
      diagnostics: [
        diagnostic({
          code: 'W_SCRIPT_IMPORT',
          file: 'scripts',
          message: `The compiled project scripts threw when imported in Node (${error instanceof Error ? error.message : String(error)}) — probably a browser global used at module top level. user: component properties not checked.`,
        }),
      ],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const PENDING = /Component type "(.*?)" is not registered yet — kept as pending on node "(.*?)"/;
const OVERRIDE_TARGET = /Override target "(.*?)" not found/;

export interface HydrateOptions {
  readonly env: Level1Environment;
  /** Registry with `core:` and the project's `user:` components. */
  readonly registry: ScriptRegistry;
  readonly file: string;
  readonly text: string;
  readonly parsed: ParsedYaml;
  readonly targetPlatform?: string;
  /** Prefabs (`instance:` targets) are not whole scenes — no renderability lint for them. */
  readonly isPrefab: boolean;
  /** `user:` schemas are available (scripts loaded), so their config can be checked. */
  readonly checkUserConfig: boolean;
}

/** Hydrate one scene through the real loader and report what it rejected, warned or parked. */
export const hydrateScene = async (options: HydrateOptions): Promise<Diagnostic[]> => {
  const { env, registry, file } = options;
  const out: Diagnostic[] = [];
  const disk = new DiskResourceManager(env.project.root);
  const loader = new SceneLoader(new NodeAssetLoader(disk), registry, disk);
  const uninstall = installCanvasOnlyDocument();
  try {
    const { result: graph, warnings } = await collectLoaderWarnings(() =>
      loader.parseScene(options.text, { filePath: `res://${file}` })
    );
    for (const warning of warnings) {
      const pending = PENDING.exec(warning.message);
      if (pending) {
        out.push(
          diagnostic({
            code: 'E_PENDING_COMPONENT',
            file,
            nodeId: pending[2],
            message: `Component ${pending[1]} on node "${pending[2]}" is still unregistered after compiling the project scripts; it never runs.`,
          })
        );
      } else if (warning.error instanceof MissingResourceError) {
        out.push(
          diagnostic({
            code: 'E_MISSING_RESOURCE',
            file,
            message: `${warning.error.resource} does not exist (the loader warned: ${warning.message.split(':')[0]}).`,
          })
        );
      } else if (OVERRIDE_TARGET.test(warning.message)) {
        out.push(
          diagnostic({
            code: 'E_UNKNOWN_OVERRIDE_TARGET',
            file,
            message: `${warning.message.replace(/^\[SceneLoader\]\s*/, '')} The override is dropped.`,
          })
        );
      } else {
        out.push(
          diagnostic({
            code: 'E_LOAD',
            file,
            message: `The loader warned: ${warning.message.replace(/^\[SceneLoader\]\s*/, '')}`,
          })
        );
      }
    }
    if (options.checkUserConfig) {
      walkComponents(options.parsed.data, (type, config, nodeId, at) => {
        if (!type.startsWith('user:')) return;
        const schema = registry.getComponentPropertySchema(type)?.properties;
        if (!schema) return;
        out.push(
          ...checkComponentConfig(env, file, options.parsed, type, schema, config, nodeId, at)
        );
      });
    }
    if (!options.isPrefab) {
      for (const issue of collectRenderabilityIssues(graph.rootNodes, {
        targetPlatform: options.targetPlatform,
      })) {
        if (issue.code === 'inert-nodes') continue; // level 1 reports E_UNKNOWN_NODE_TYPE
        out.push(
          diagnostic({
            code: `W_RENDERABILITY_${issue.code.toUpperCase().replace(/-/g, '_')}`,
            file,
            nodeId: issue.nodeIds[0],
            message: issue.message,
          })
        );
      }
    }
  } catch (error) {
    if (error instanceof SceneValidationError) {
      out.push(
        diagnostic({
          code: 'E_LOAD',
          file,
          message: `The loader rejects the scene: ${error.message}${error.details.length > 0 ? ` (${error.details.join('; ')})` : ''}`,
        })
      );
    } else if (error instanceof MissingResourceError) {
      out.push(
        diagnostic({
          code: 'E_MISSING_RESOURCE',
          file,
          message: `${error.resource} does not exist; the loader fails the whole scene.`,
        })
      );
    } else {
      out.push(
        diagnostic({
          code: 'E_LOAD',
          file,
          message: `The loader threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}.`,
        })
      );
    }
  } finally {
    uninstall();
  }
  return out;
};

const walkComponents = (
  data: unknown,
  visit: (
    type: string,
    config: Record<string, unknown>,
    nodeId: string | undefined,
    at: DocPath
  ) => void
): void => {
  const walkNode = (node: unknown, at: DocPath): void => {
    if (!isRecord(node)) return;
    const nodeId = typeof node.id === 'string' ? node.id : undefined;
    if (Array.isArray(node.components)) {
      node.components.forEach((component, index) => {
        if (isRecord(component) && typeof component.type === 'string') {
          visit(component.type, isRecord(component.config) ? component.config : {}, nodeId, [
            ...at,
            'components',
            index,
            'config',
          ]);
        }
      });
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child, index) => walkNode(child, [...at, 'children', index]));
    }
  };
  if (isRecord(data) && Array.isArray(data.root)) {
    data.root.forEach((node, index) => walkNode(node, ['root', index]));
  }
};
