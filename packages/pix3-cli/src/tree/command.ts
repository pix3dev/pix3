import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { findProjectRoot, PROJECT_MANIFEST_FILE } from '../manifest.ts';
import { ProjectFiles } from '../validate/project.ts';
import { isRecord } from '../validate/yaml-doc.ts';
import { scanUserScriptIds } from './scripts.ts';
import {
  buildTree,
  countTreeNodes,
  formatSceneSummary,
  formatTree,
  parseSceneText,
  SceneParseError,
  sceneTypes,
  summarizeScene,
  type SceneSummary,
  type TypeDefaults,
} from './tree.ts';

/**
 * `pix3 tree [scene] [--depth N] [--types A,B] [--props] [--json] [--project <dir>]`.
 *
 * With a scene: one line per node, indented by depth. Without: a project overview — every scene
 * and prefab with its node count, node types, components and instances. Both read the YAML only
 * (no loader, no project code), so they are instant; `--props` additionally loads the runtime's
 * node classes from the smoke bundle to leave out properties that equal the type's default.
 * Exit: 0 = ok, 1 = a scene does not parse, 2 = bad arguments / no such file.
 */

export const TREE_USAGE = `Usage: pix3 tree [scene] [--depth N] [--types A,B] [--props] [--json] [--project <dir>]

  One line per node — type#id "name", position, size, anchor layout, components, prefab
  instances (↳ instance res://… (N overrides, M properties)) — indented by depth. Read this instead of the
  whole .pix3scene when you need to find your way around a scene.

  scene          .pix3scene (res://, project-relative or a path). Without one: every scene and
                 prefab in the project with node counts, node types and components.
  --depth N      stop N levels below the roots (0 = roots only); cut subtrees show "… +K below"
  --types A,B    only nodes of these types (or carrying these components; \`instance\` = prefab
                 instances), with their ancestors as "·" context lines
  --props        also print each node's properties that differ from the type's defaults
  --json         the same as nested JSON
  --project dir  project folder (default: nearest folder with pix3project.yaml, else cwd)
`;

export interface TreeIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface TreeArgs {
  readonly scene?: string;
  readonly depth?: number;
  readonly types?: string[];
  readonly props: boolean;
  readonly json: boolean;
  readonly project?: string;
  readonly help: boolean;
}

const parseTreeArgs = (argv: readonly string[]): TreeArgs | { error: string } => {
  let scene: string | undefined;
  let depth: number | undefined;
  let types: string[] | undefined;
  let props = false;
  let json = false;
  let project: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (arg === '--json') json = true;
    else if (arg === '--props') props = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (name === '--depth' || name === '--types' || name === '--project') {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: `${name} needs a value` };
      if (name === '--depth') {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 0)
          return { error: '--depth needs a whole number ≥ 0' };
        depth = number;
      } else if (name === '--types') {
        types = value
          .split(',')
          .map(t => t.trim())
          .filter(Boolean);
      } else project = value;
    } else if (arg.startsWith('-')) return { error: `unknown argument ${arg}` };
    else if (scene === undefined) scene = arg;
    else return { error: `one scene at a time (got ${scene} and ${arg})` };
  }
  return { scene, depth, types, props, json, project, help };
};

/** Absolute path of the requested scene (res://, project-relative, cwd-relative or absolute). */
const locateScene = (requested: string, root: string, cwd: string): string | null => {
  const candidates = [
    join(root, requested.replace(/^res:\/\//i, '').replace(/^\/+/, '')),
    isAbsolute(requested) ? requested : resolve(cwd, requested),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
};

const toProjectRelative = (root: string, absolute: string): string => {
  const rel = relative(root, absolute);
  return rel.startsWith('..') || isAbsolute(rel) ? absolute : rel.split(sep).join('/');
};

type DefaultsModule = {
  defaultsForTypes(types: readonly string[]): Record<string, { defaults: Record<string, unknown> }>;
};

/** Per-type defaults from the smoke bundle, or null (with the reason) when it cannot load. */
const loadDefaults = async (
  types: readonly string[]
): Promise<TypeDefaults | { error: string }> => {
  try {
    const { TREE_DEFAULTS_FILE, withSmokeBundle } = await import('../smoke/entry.ts');
    return await withSmokeBundle(async dir => {
      const module = (await import(
        pathToFileURL(join(dir, TREE_DEFAULTS_FILE)).href
      )) as DefaultsModule;
      const byType = module.defaultsForTypes(types);
      return Object.fromEntries(
        Object.entries(byType).map(([type, entry]) => [type, entry.defaults])
      );
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

interface ManifestInfo {
  readonly name?: string;
  readonly projectType?: string;
  readonly viewport?: string;
  readonly entry?: string;
}

const readManifest = (root: string): ManifestInfo | null => {
  const path = join(root, PROJECT_MANIFEST_FILE);
  if (!existsSync(path)) return null;
  try {
    const data = parseYaml(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(data)) return {};
    const metadata = isRecord(data.metadata) ? data.metadata : {};
    const size = isRecord(data.viewportBaseSize) ? data.viewportBaseSize : null;
    return {
      ...(typeof metadata.projectName === 'string' ? { name: metadata.projectName } : {}),
      ...(typeof data.projectType === 'string' ? { projectType: data.projectType } : {}),
      ...(size && typeof size.width === 'number' && typeof size.height === 'number'
        ? { viewport: `${size.width}x${size.height}` }
        : {}),
      ...(typeof data.defaultExportScenePath === 'string' && data.defaultExportScenePath.trim()
        ? { entry: data.defaultExportScenePath.trim().replace(/^res:\/\//i, '') }
        : {}),
    };
  } catch {
    return {};
  }
};

const overview = (root: string, args: TreeArgs, io: TreeIo): number => {
  const project = new ProjectFiles(root);
  const manifest = readManifest(root);
  const summaries = project.scenes().map(path => summarizeScene(path, project.readText(path)));
  const instanced = new Set(summaries.flatMap(s => s.instances));
  const scenes: SceneSummary[] = summaries.map(summary => ({
    ...summary,
    kind: /(^|\/)ui\//.test(summary.path)
      ? 'overlay'
      : instanced.has(summary.path) || /(^|\/)prefabs?\//.test(summary.path)
        ? 'prefab'
        : 'scene',
    entry: manifest?.entry === summary.path,
  }));
  const scripts = scanUserScriptIds(project);
  const failed = scenes.filter(s => s.error).length;
  if (args.json) {
    io.stdout(
      `${JSON.stringify({ projectRoot: root, project: manifest, scripts, scenes }, null, 2)}\n`
    );
    return failed > 0 ? 1 : 0;
  }
  const lines: string[] = [];
  if (manifest) {
    const facts = [
      manifest.projectType,
      manifest.viewport,
      manifest.entry ? `entry ${manifest.entry} (*)` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`${manifest.name ? `"${manifest.name}"` : 'Project'}${facts ? ` — ${facts}` : ''}`);
  } else {
    lines.push(`${root} (no pix3project.yaml)`);
  }
  lines.push(
    scripts.length > 0
      ? `scripts: ${scripts.join(' ')}`
      : 'scripts: none (no Script classes under scripts/ or src/scripts/)'
  );
  if (scenes.length === 0) lines.push('no .pix3scene files');
  const width = Math.max(0, ...scenes.map(s => s.path.length + (s.entry ? 2 : 0)));
  for (const scene of scenes) lines.push(formatSceneSummary(scene, width));
  lines.push(`\n\`pix3 tree <scene>\` for one scene's nodes (--depth N, --types A,B, --props).`);
  io.stdout(`${lines.join('\n')}\n`);
  return failed > 0 ? 1 : 0;
};

export const runTreeCli = async (argv: readonly string[], io: TreeIo): Promise<number> => {
  const args = parseTreeArgs(argv);
  if ('error' in args) {
    io.stderr(`pix3 tree: ${args.error}\n\n${TREE_USAGE}`);
    return 2;
  }
  if (args.help) {
    io.stdout(TREE_USAGE);
    return 0;
  }
  const root = args.project
    ? resolve(io.cwd, args.project)
    : (findProjectRoot(io.cwd) ?? resolve(io.cwd));
  if (args.scene === undefined) return overview(root, args, io);

  const absolute = locateScene(args.scene, root, io.cwd);
  if (!absolute) {
    io.stderr(`pix3 tree: ${args.scene} not found (looked in ${root} and ${io.cwd}).\n`);
    return 2;
  }
  const scenePath = toProjectRelative(root, absolute);
  let scene: Record<string, unknown>;
  try {
    scene = parseSceneText(readFileSync(absolute, 'utf8'));
  } catch (error) {
    if (!(error instanceof SceneParseError)) throw error;
    io.stderr(`pix3 tree: ${scenePath} is ${error.message}.\n`);
    return 1;
  }
  let defaults: TypeDefaults | undefined;
  let defaultsNote: string | undefined;
  if (args.props) {
    const loaded = await loadDefaults(sceneTypes(scene));
    if ('error' in loaded) {
      defaultsNote = `defaults unavailable (${String(loaded.error)}): every authored property is shown`;
    } else {
      defaults = loaded as TypeDefaults;
    }
  }
  const nodes = buildTree(scene, {
    depth: args.depth,
    types: args.types,
    props: args.props,
    defaults,
    readPrefab: projectPath => {
      const path = join(root, projectPath);
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
  });
  if (args.json) {
    io.stdout(
      `${JSON.stringify({ scene: scenePath, nodes, ...(defaultsNote ? { note: defaultsNote } : {}) }, null, 2)}\n`
    );
    return 0;
  }
  const shown = countTreeNodes(nodes);
  const total = summarizeScene(scenePath, readFileSync(absolute, 'utf8')).nodes;
  const filters = [
    args.types ? `matching ${args.types.join(',')} (with ancestors)` : undefined,
    args.depth !== undefined ? `to depth ${args.depth}` : undefined,
  ].filter(Boolean);
  io.stdout(
    `${scenePath} — ${total} node${total === 1 ? '' : 's'}${shown !== total || filters.length > 0 ? `, ${shown} shown${filters.length > 0 ? ` ${filters.join(', ')}` : ''}` : ''}\n${formatTree(nodes)}${defaultsNote ? `(${defaultsNote})\n` : ''}`
  );
  return 0;
};
