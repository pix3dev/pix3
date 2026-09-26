import { registerBuiltInScripts, ScriptRegistry } from '@pix3/runtime';

import { compareDiagnostics, diagnostic, type Diagnostic } from './diagnostics.ts';
import {
  checkSceneLevel1,
  PrefabCache,
  type Level1Environment,
  type SceneCheckResult,
} from './level1.ts';
import {
  BARE_SCRIPT_IMPORTS,
  hydrateScene,
  loadUserScripts,
  type ScriptImportMap,
} from './level2.ts';
import { ProjectFiles, readManifestInfo, sha256 } from './project.ts';
import { scanUserScripts } from './user-scripts.ts';

export interface ValidateOptions {
  /** Project folder (the one holding `pix3project.yaml`, or any folder `res://` is relative to). */
  readonly projectRoot: string;
  /** Project-relative scene paths; all `.pix3scene` files in the project when omitted. */
  readonly files?: readonly string[];
  /** Level 2 (real loader + compiled scripts). Default true. */
  readonly hydrate?: boolean;
  /** How compiled user scripts import the runtime; bare specifiers by default. */
  readonly scriptImports?: ScriptImportMap;
  /** Resolved `esbuild` module URL for level 2 (default: resolve `esbuild` from here). */
  readonly esbuildSpecifier?: string;
}

export interface ValidatedFile {
  readonly file: string;
  /** Of the exact bytes validated — what `pix3 ack` / `expect` take. */
  readonly sha256: string;
}

export type Level2Status =
  | { readonly state: 'ran'; readonly filesHydrated: number; readonly filesSkipped: number }
  | { readonly state: 'disabled' }
  | { readonly state: 'skipped'; readonly reason: string };

export interface ValidateReport {
  readonly projectRoot: string;
  readonly files: readonly ValidatedFile[];
  readonly diagnostics: readonly Diagnostic[];
  readonly errorCount: number;
  readonly warningCount: number;
  readonly level2: Level2Status;
  /** Plain-language caveats about what was not checked. */
  readonly notes: readonly string[];
}

export const USER_PROPERTIES_NOT_CHECKED = '(user: component properties not checked)';

/** Text files that can reference an asset by path. */
const REFERENCING_EXTENSIONS = [
  '.pix3scene',
  '.ts',
  '.js',
  '.json',
  '.pix3anim',
  '.atlas',
  '.yaml',
  '.yml',
  '.html',
  '.css',
];

const ASSET_DIRECTORIES = ['sprites/', 'audio/'];

const unusedAssets = (
  project: ProjectFiles,
  sceneReferences: ReadonlySet<string>
): Diagnostic[] => {
  const texts = project.files
    .filter(file => REFERENCING_EXTENSIONS.some(ext => file.endsWith(ext)))
    .map(file => {
      try {
        return { file, text: project.readText(file) };
      } catch {
        return { file, text: '' };
      }
    });
  const out: Diagnostic[] = [];
  for (const asset of project.files) {
    if (!ASSET_DIRECTORIES.some(dir => asset.startsWith(dir))) continue;
    const base = asset.slice(asset.lastIndexOf('/') + 1);
    if (base.startsWith('.') || REFERENCING_EXTENSIONS.some(ext => asset.endsWith(ext))) continue;
    if (sceneReferences.has(asset)) continue;
    const dir = asset.slice(0, asset.lastIndexOf('/') + 1);
    const referenced = texts.some(
      ({ file, text }) =>
        file !== asset &&
        (text.includes(asset) ||
          // atlases, animations and kit manifests name their pages relative to themselves
          (file.startsWith(dir) &&
            file.slice(dir.length).indexOf('/') === -1 &&
            text.includes(base)))
    );
    if (!referenced) {
      out.push(
        diagnostic({
          code: 'W_UNUSED_ASSET',
          file: asset,
          message: `${asset} is not referenced by any scene, script or resource file.`,
          fix: 'use it, or delete it to keep exports small',
        })
      );
    }
  }
  return out;
};

/** Validate scenes of one project. Never throws for problems in the project; returns them. */
export const validateProject = async (options: ValidateOptions): Promise<ValidateReport> => {
  const project = new ProjectFiles(options.projectRoot);
  const registry = new ScriptRegistry();
  // `registerBuiltInScripts` announces itself through console.log; not output of ours.
  const log = console.log;
  console.log = () => {};
  try {
    registerBuiltInScripts(registry);
  } finally {
    console.log = log;
  }
  const env: Level1Environment = {
    project,
    registry,
    userScripts: scanUserScripts(project),
    prefabs: new PrefabCache(project),
  };
  const wholeProject = options.files === undefined;
  const targets = [...(options.files ?? project.scenes())].sort();
  const diagnostics: Diagnostic[] = [];
  const files: ValidatedFile[] = [];
  const results = new Map<string, SceneCheckResult>();
  const texts = new Map<string, string>();

  for (const file of targets) {
    if (!project.has(file)) {
      diagnostics.push(diagnostic({ code: 'E_SHAPE', file, message: `${file} does not exist.` }));
      continue;
    }
    const text = project.readText(file);
    texts.set(file, text);
    files.push({ file, sha256: sha256(text) });
    const result = checkSceneLevel1(env, file, text);
    results.set(file, result);
    diagnostics.push(...result.diagnostics);
  }

  if (wholeProject) {
    const references = new Set<string>();
    for (const result of results.values()) for (const ref of result.references) references.add(ref);
    diagnostics.push(...unusedAssets(project, references));
  }

  const usesUserComponents = [...results.values()].some(result => result.usesUserComponents);
  const notes: string[] = [];
  let level2: Level2Status;

  if (options.hydrate === false) {
    level2 = { state: 'disabled' };
    if (usesUserComponents)
      notes.push(`Level 2 disabled (--no-hydrate) ${USER_PROPERTIES_NOT_CHECKED}.`);
  } else {
    const cleanFiles = targets.filter(file => {
      const result = results.get(file);
      return result?.parsed && !result.diagnostics.some(d => d.severity === 'error');
    });
    const scripts = await loadUserScripts(
      project,
      env.userScripts.entries,
      registry,
      options.scriptImports ?? BARE_SCRIPT_IMPORTS,
      options.esbuildSpecifier
    );
    let userSchemasAvailable = true;
    let skipUserScenes = false;
    if (scripts.status === 'unavailable') {
      userSchemasAvailable = false;
      skipUserScenes = true;
      diagnostics.push(
        diagnostic({
          code: 'W_HYDRATE_SKIPPED',
          file: 'scripts',
          message: `Level 2 skipped for scenes with user: components: ${scripts.reason} ${USER_PROPERTIES_NOT_CHECKED}.`,
          fix: 'npm install esbuild next to @pix3/cli, or run with --no-hydrate',
        })
      );
    } else if (scripts.status === 'failed') {
      userSchemasAvailable = false;
      skipUserScenes = true;
      diagnostics.push(...scripts.diagnostics);
    }
    const prefabTargets = new Set<string>();
    for (const scene of project.scenes()) {
      for (const target of env.prefabs.instanceTargets(scene)) prefabTargets.add(target);
    }
    const { targetPlatform } = readManifestInfo(project);
    let hydrated = 0;
    for (const file of cleanFiles) {
      const result = results.get(file);
      if (!result?.parsed) continue;
      if (skipUserScenes && result.usesUserComponents) continue;
      diagnostics.push(
        ...(await hydrateScene({
          env,
          registry,
          file,
          text: texts.get(file) ?? '',
          parsed: result.parsed,
          targetPlatform,
          isPrefab: prefabTargets.has(file),
          checkUserConfig: userSchemasAvailable,
        }))
      );
      hydrated += 1;
    }
    level2 = { state: 'ran', filesHydrated: hydrated, filesSkipped: targets.length - hydrated };
    if (targets.length - hydrated > 0) {
      notes.push(
        `Level 2 did not hydrate ${targets.length - hydrated} of ${targets.length} file(s): it runs only on files with no level-1 errors${skipUserScenes ? ' and, while scripts cannot be loaded, without user: components' : ''}.`
      );
    }
    if (!userSchemasAvailable && usesUserComponents) {
      notes.push(`Project scripts could not be loaded ${USER_PROPERTIES_NOT_CHECKED}.`);
    }
  }

  diagnostics.sort(compareDiagnostics);
  return {
    projectRoot: project.root,
    files,
    diagnostics,
    errorCount: diagnostics.filter(d => d.severity === 'error').length,
    warningCount: diagnostics.filter(d => d.severity === 'warning').length,
    level2,
    notes,
  };
};
