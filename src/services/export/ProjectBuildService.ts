import { injectable, inject } from '@/fw/di';
import { parseSpineAtlasPageNames, resolveSpinePagePath } from '@pix3/runtime';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';
import type { CommandContext } from '@/core/command';
import {
  createDefaultQualitySettings,
  DEFAULT_TARGET_PLATFORM,
  resolveExportSettings,
  type ExportSettings,
  type QualitySettings,
} from '@/core/ProjectManifest';
import { createGlobMatcher } from '@/services/export/glob-match';
import { collectNetKindPrefabPaths } from '@/core/net-kind-paths';

interface BuildPackagePatch {
  sideEffects?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface ProjectBuildResult {
  readonly writtenFiles: number;
  readonly createdDirectories: number;
  readonly sceneCount: number;
  readonly assetCount: number;
  readonly packageJsonUpdated: boolean;
}

export interface ProjectBuildOptions {
  readonly entryScenePath?: string;
}

/** What pulled an asset into the build — see {@link AssetReachabilityEntry}. */
export type AssetInclusionReason =
  | 'project-scene'
  | 'entry-scene'
  | 'extra-root'
  | 'scene-reference'
  | 'script-reference'
  | 'directory-expansion'
  | 'atlas-page'
  | 'locale-table'
  | 'locale-sprite'
  | 'include-glob';

export interface AssetReachabilityEntry {
  readonly reason: AssetInclusionReason;
  /** The scene / script / atlas / directory that referenced it; `''` for roots. */
  readonly via: string;
}

export interface RuntimeProjectBuildModel {
  readonly projectName: string;
  readonly scenePaths: readonly string[];
  readonly entryScenePath: string;
  readonly assetPaths: readonly string[];
  /**
   * Why each {@link assetPaths} entry is in the build, keyed by asset path.
   * Bookkeeping only — it never changes the output, but it is what makes the
   * (deliberately over-inclusive) collector auditable: every shipped byte can be
   * traced back to the scene, script, atlas or glob that asked for it.
   */
  readonly reachability: ReadonlyMap<string, AssetReachabilityEntry>;
  readonly projectScriptFiles: ReadonlyMap<string, string>;
  readonly files: ReadonlyMap<string, string>;
  /**
   * True when a scene or prefab in the build places a `SpineSkeleton2D`. The
   * optional Spine runtime is only wired into the generated bundle in that case,
   * so projects that never use it ship none of its ~500 KB.
   */
  readonly usesSpine: boolean;
  readonly warnings: readonly string[];
}

/** Kept in sync with the editor's own dependency: the skeleton data format is minor-locked. */
const SPINE_RUNTIME_DEPENDENCY_RANGE = '~4.3';
const RUNTIME_BUILD_COMMAND = 'vite build';
const RUNTIME_DEV_COMMAND = 'vite';
const PROJECT_SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;
/** How many pruned scenes to name before collapsing into "and N more". */
const PRUNED_SCENE_WARNING_LIMIT = 10;
/** Never walked when resolving `includeGlobs` — tooling and build output. */
const NON_SHIPPABLE_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.yalc',
  '.vscode',
  '.idea',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
]);
const EXCLUDED_PROJECT_SCRIPT_SUFFIXES = ['.spec.ts', '.test.ts', '.d.ts'] as const;
const RESOURCE_PATH_PATTERN = /res:\/\/([^\s"'\])]+)/g;
/**
 * `type: SpineSkeleton2D` in a scene/prefab — one trigger for bundling Spine.
 * The optional tail allows a trailing YAML comment (`type: SpineSkeleton2D # hero`),
 * which would otherwise read as "no Spine" and produce an export that ships the
 * skeleton's assets but not the runtime that draws them.
 */
const SPINE_NODE_PATTERN = /(^|\s)type:\s*['"]?SpineSkeleton2D['"]?\s*(#.*)?$/m;
/**
 * The other trigger: a script that spawns / looks up the node type at runtime,
 * in a project whose authored scenes contain no skeleton yet.
 */
const SPINE_SCRIPT_PATTERN = /\bSpineSkeleton2D\b/;
const RELATIVE_IMPORT_PATTERN =
  /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const PROJECT_SOURCE_IMPORT_SUFFIXES = [
  '',
  '.ts',
  '.js',
  '.json',
  '/index.ts',
  '/index.js',
  '/index.json',
] as const;

const templateFiles = import.meta.glob('../../templates/build/**/*.tpl', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const runtimeSourceFiles = import.meta.glob(
  [
    '../../../packages/pix3-runtime/src/main.ts',
    '../../../packages/pix3-runtime/src/register-project-scripts.ts',
  ],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  }
) as Record<string, string>;

// Entry-point files that ship in the user's src/ folder (not part of the library).
const RUNTIME_SRC_ENTRY_FILES = new Set(['main.ts', 'register-project-scripts.ts']);

/** Runtime localization config baked into the generated scene manifest. */
type RuntimeLocalizationConfig = {
  defaultLocale: string;
  fallbackLocale?: string;
  locales: string[];
} | null;

@injectable()
export class ProjectBuildService {
  @inject(ProjectStorageService)
  private readonly fs!: ProjectStorageService;

  @inject(LocalizationEditorService)
  private readonly localizationEditor!: LocalizationEditorService;

  async buildRuntimeProjectModel(
    context: CommandContext,
    options: ProjectBuildOptions = {}
  ): Promise<RuntimeProjectBuildModel> {
    const exportSettings = resolveExportSettings(context.state.project.manifest);
    // A scene the project excludes from the build must also leave the navigable
    // manifest and the entry-scene picker — otherwise the export could name an
    // entry scene whose file it never ships.
    const isSceneExcluded = createGlobMatcher(exportSettings.excludeGlobs);
    const scenePaths = (await this.collectScenePaths(context)).filter(
      scenePath => !isSceneExcluded(scenePath)
    );
    const warnings: string[] = [];
    const entryScenePath = this.resolveEntryScenePath(context, scenePaths, options, warnings);
    const projectScriptFiles = await this.collectProjectScriptFiles();
    const { assetPaths, reachability } = await this.collectAssetPaths(
      scenePaths,
      entryScenePath,
      projectScriptFiles,
      exportSettings,
      warnings
    );
    const usesSpine = this.scanFoundSpineNode;
    // With pruning on, a scene that did not survive the reachability scan must
    // also leave the navigable manifest — listing a scene the bundle does not
    // carry would only produce a runtime load failure.
    const shippedScenePaths = exportSettings.pruneUnusedAssets
      ? scenePaths.filter(scenePath => assetPaths.includes(scenePath))
      : scenePaths;
    const projectName = context.state.project.projectName ?? 'Pix3 Project';
    const quality =
      context.state.project.manifest?.quality ??
      createDefaultQualitySettings(DEFAULT_TARGET_PLATFORM);
    // Effective localization (manifest block, else auto-discovered locales/) —
    // baked into the generated scene manifest so the exported game boots in
    // defaultLocale with the first frame already translated.
    const localization = this.localizationEditor.getRuntimeConfig();

    return {
      projectName,
      scenePaths: shippedScenePaths,
      entryScenePath,
      assetPaths,
      reachability,
      projectScriptFiles,
      files: this.buildGeneratedFiles(
        projectName,
        shippedScenePaths,
        entryScenePath,
        assetPaths,
        quality,
        localization,
        usesSpine
      ),
      usesSpine,
      warnings,
    };
  }

  async buildFromTemplates(
    context: CommandContext,
    options: ProjectBuildOptions = {}
  ): Promise<ProjectBuildResult> {
    const model = await this.buildRuntimeProjectModel(context, options);

    let createdDirectories = 0;
    const ensuredDirectories = new Set<string>();
    const writtenFiles = await this.writeGeneratedFiles(model.files, ensuredDirectories);

    const packageJsonUpdated = await this.mergePackageJsonPatch(model.usesSpine);
    createdDirectories = ensuredDirectories.size;

    return {
      writtenFiles,
      createdDirectories,
      sceneCount: model.scenePaths.length,
      assetCount: model.assetPaths.length,
      packageJsonUpdated,
    };
  }

  private resolveEntryScenePath(
    context: CommandContext,
    scenePaths: readonly string[],
    options: ProjectBuildOptions,
    warnings: string[]
  ): string {
    const requestedEntryScenePath = this.normalizeResourcePath(options.entryScenePath ?? '');
    const activeScenePath = this.getActiveScenePath(context);
    const configuredDefaultScenePath = this.getDefaultExportScenePath(context);

    if (requestedEntryScenePath && !scenePaths.includes(requestedEntryScenePath)) {
      warnings.push(
        `Requested entry scene was not found in build inputs: ${requestedEntryScenePath}`
      );
    }

    if (
      configuredDefaultScenePath &&
      !scenePaths.includes(configuredDefaultScenePath) &&
      configuredDefaultScenePath !== requestedEntryScenePath
    ) {
      warnings.push(
        `Configured default export scene was not found in build inputs: ${configuredDefaultScenePath}`
      );
    }

    return requestedEntryScenePath && scenePaths.includes(requestedEntryScenePath)
      ? requestedEntryScenePath
      : activeScenePath && scenePaths.includes(activeScenePath)
        ? activeScenePath
        : configuredDefaultScenePath && scenePaths.includes(configuredDefaultScenePath)
          ? configuredDefaultScenePath
          : (scenePaths[0] ?? '');
  }

  /**
   * Resolve the scene paths this project would export. ALL `.pix3scene` files on
   * disk are bundled, not just the ones open in the editor: games load scenes
   * dynamically at runtime (scene-per-level navigation, e.g.
   * `res://src/assets/scenes/level-${n}.pix3scene`), so a scene that is not
   * currently loaded must still ship. Loaded descriptor paths are unioned in to
   * cover scenes that live outside the discovery root.
   */
  async collectScenePaths(context: CommandContext): Promise<string[]> {
    const scenePaths = new Set<string>();

    const discovered = await this.discoverFilesByExtension('.', '.pix3scene');
    for (const path of discovered) {
      const normalized = this.normalizeResourcePath(path);
      // Prefabs share the `.pix3scene` extension but are instantiated, not
      // navigated to — keep them out of the navigable manifest / entry picker.
      // (They are still embedded as assets by collectAssetPaths.) pix3 has no
      // formal scene/prefab marker, so we fall back to the `prefabs/` folder
      // convention used across pix3 projects.
      if (!this.isPrefabPath(normalized)) {
        scenePaths.add(normalized);
      }
    }

    for (const descriptor of Object.values(context.state.scenes.descriptors)) {
      const path = this.normalizeResourcePath(descriptor.filePath);
      if (path.length > 0) {
        scenePaths.add(path);
      }
    }

    return Array.from(scenePaths).sort((a, b) => a.localeCompare(b));
  }

  private getActiveScenePath(context: CommandContext): string {
    const activeId = context.state.scenes.activeSceneId;
    if (!activeId) {
      return '';
    }

    const descriptor = context.state.scenes.descriptors[activeId];
    if (!descriptor) {
      return '';
    }

    return this.normalizeResourcePath(descriptor.filePath);
  }

  private getDefaultExportScenePath(context: CommandContext): string {
    const configured = context.state.project.manifest?.defaultExportScenePath;
    return typeof configured === 'string' ? this.normalizeResourcePath(configured) : '';
  }

  /**
   * Set while scanning scenes/prefabs in {@link collectAssetPaths} — see
   * {@link RuntimeProjectBuildModel.usesSpine}. Reading the texts again just to
   * answer this would double the scan cost, so the flag rides along.
   */
  private scanFoundSpineNode = false;

  private async collectAssetPaths(
    scenePaths: string[],
    entryScenePath: string,
    projectScriptFiles: ReadonlyMap<string, string>,
    exportSettings: ExportSettings,
    warnings: string[]
  ): Promise<{ assetPaths: string[]; reachability: Map<string, AssetReachabilityEntry> }> {
    const files = new Set<string>();
    const reachability = new Map<string, AssetReachabilityEntry>();
    const isExcluded = createGlobMatcher(exportSettings.excludeGlobs);
    const excludedPaths = new Set<string>();

    // Reference-carrying resources (scenes, prefabs, `.pix3anim` flipbooks) must be
    // scanned transitively: a scene references prefab `.pix3scene` files, those
    // prefabs reference textures / nested prefabs / `.pix3anim` resources, and a
    // `.pix3anim` in turn lists its frame textures. Scanning only the top-level
    // scenes embeds those files but not the assets declared inside them (which is
    // why nested prefab sprites and AnimatedSprite2D frames rendered as white
    // squares in exports).
    const scanQueue: string[] = [];
    const queuedForScan = new Set<string>();
    const directoryQueue: string[] = [];
    const queuedDirectories = new Set<string>();
    const addResourcePath = (
      resourcePath: string,
      reason: AssetInclusionReason,
      via = ''
    ): void => {
      // `excludeGlobs` gates the graph, not just the output: an excluded scene is
      // never scanned, so the assets only it referenced drop out with it.
      if (isExcluded(resourcePath)) {
        excludedPaths.add(resourcePath);
        return;
      }

      // A directory cannot ship as one asset — queue it for expansion instead of
      // adding it to the file set. See resolveDirectoryReference.
      if (!this.hasFileExtension(resourcePath)) {
        if (!queuedDirectories.has(resourcePath)) {
          queuedDirectories.add(resourcePath);
          directoryQueue.push(resourcePath);
        }
        return;
      }

      files.add(resourcePath);
      // First writer wins — the scan is breadth-first, so this records the
      // shortest path from a build root to the asset.
      if (!reachability.has(resourcePath)) {
        reachability.set(resourcePath, { reason, via });
      }
      if (this.isScannableResource(resourcePath) && !queuedForScan.has(resourcePath)) {
        queuedForScan.add(resourcePath);
        scanQueue.push(resourcePath);
      }
    };

    this.scanFoundSpineNode = false;

    const allSceneLikeFiles = (await this.discoverFilesByExtension('.', '.pix3scene')).map(path =>
      this.normalizeResourcePath(path)
    );

    if (exportSettings.pruneUnusedAssets) {
      // Reachability seeding: only the entry scene and the author-declared extra
      // roots start the scan, so scenes/prefabs nothing reaches — and the assets
      // only they referenced — stay out of the bundle.
      if (entryScenePath) {
        addResourcePath(entryScenePath, 'entry-scene');
      }
      for (const extraRoot of exportSettings.extraRootScenePaths) {
        addResourcePath(extraRoot, 'extra-root');
      }
    } else {
      // Default: seed with EVERY scene and prefab on disk, not just the navigable
      // manifest scenes. A game can load any scene/prefab dynamically at runtime
      // (e.g. `scene.instantiate('res://…/explosion.pix3scene')` or a computed
      // level path), and each must ship with its own nested assets embedded.
      for (const sceneLikePath of allSceneLikeFiles) {
        addResourcePath(sceneLikePath, 'project-scene');
      }
      for (const scenePath of scenePaths) {
        addResourcePath(scenePath, 'project-scene');
      }
    }

    // Force-included files join the scan as roots, so an `includeGlobs` scene
    // brings its own textures rather than shipping as an empty shell.
    for (const includedPath of await this.collectForcedIncludePaths(exportSettings)) {
      addResourcePath(includedPath, 'include-glob');
    }

    const projectSourceFiles = await this.collectProjectSourceDependencies(projectScriptFiles);
    for (const [sourcePath, sourceContents] of projectSourceFiles) {
      this.collectResourcePathsFromText(
        sourceContents,
        'script-reference',
        sourcePath,
        addResourcePath
      );
      if (!this.scanFoundSpineNode && SPINE_SCRIPT_PATTERN.test(sourceContents)) {
        this.scanFoundSpineNode = true;
      }
    }

    // One fixpoint over both queues. Directory expansion has to feed back into the
    // scan, not run after it: a `.pix3scene` or `.pix3anim` reached only through an
    // interpolated path (`level-${n}.pix3scene`) arrives via its directory, and if
    // it were never scanned its own prefabs/frame textures would silently go
    // missing from the build.
    await this.drainResourceScan(scanQueue, directoryQueue, addResourcePath, warnings);

    await this.collectLocaleAssetPaths(addResourcePath, warnings);
    await this.collectSpineAtlasPagePaths(files, addResourcePath, warnings);
    // Locale sprites and atlas pages can themselves name new resources/directories.
    await this.drainResourceScan(scanQueue, directoryQueue, addResourcePath, warnings);

    if (excludedPaths.size > 0) {
      warnings.push(
        `Excluded ${excludedPaths.size} file(s) matching the project's export excludeGlobs.`
      );
    }

    if (exportSettings.pruneUnusedAssets) {
      this.warnAboutPrunedScenes(allSceneLikeFiles, files, warnings);
    }

    return {
      assetPaths: Array.from(files).sort((a, b) => a.localeCompare(b)),
      reachability,
    };
  }

  /**
   * Alternate between scanning reference-carrying resources and expanding directory
   * references until neither queue has anything left. Each step can feed the other:
   * a scene names a directory, the directory yields a prefab, the prefab names more
   * textures.
   */
  private async drainResourceScan(
    scanQueue: string[],
    directoryQueue: string[],
    addResourcePath: (path: string, reason: AssetInclusionReason, via?: string) => void,
    warnings: string[]
  ): Promise<void> {
    while (scanQueue.length > 0 || directoryQueue.length > 0) {
      const scannablePath = scanQueue.shift();
      if (scannablePath) {
        try {
          const contents = await this.fs.readTextFile(scannablePath);
          this.collectResourcePathsFromText(
            contents,
            'scene-reference',
            scannablePath,
            addResourcePath
          );
          if (!this.scanFoundSpineNode && SPINE_NODE_PATTERN.test(contents)) {
            this.scanFoundSpineNode = true;
          }
        } catch {
          warnings.push(`Failed to scan resource for asset references: ${scannablePath}`);
        }
        continue;
      }

      const directoryPath = directoryQueue.shift();
      if (!directoryPath) {
        continue;
      }

      for (const nested of await this.discoverFilesByExtension(directoryPath, '')) {
        addResourcePath(nested, 'directory-expansion', directoryPath);
      }
    }
  }

  /**
   * Name every scene/prefab that reachability seeding dropped.
   *
   * This is the safety valve for the one way pruning can break a shipped game: a
   * scene loaded through a path no static scan can see (a computed level index,
   * a name read from save data) looks unreachable and silently stops shipping.
   * Listing them by name turns that into something an author notices before the
   * build leaves the editor — the fix is to add them to `extraRootScenePaths`.
   */
  private warnAboutPrunedScenes(
    allSceneLikeFiles: readonly string[],
    shipped: ReadonlySet<string>,
    warnings: string[]
  ): void {
    const pruned = allSceneLikeFiles.filter(scenePath => !shipped.has(scenePath));
    if (pruned.length === 0) {
      return;
    }

    const listed = pruned.slice(0, PRUNED_SCENE_WARNING_LIMIT).join(', ');
    const overflow = pruned.length - PRUNED_SCENE_WARNING_LIMIT;
    warnings.push(
      `Pruned ${pruned.length} scene/prefab file(s) not reachable from the entry scene: ` +
        `${listed}${overflow > 0 ? `, and ${overflow} more` : ''}. ` +
        `If the game loads any of them dynamically, declare it in the project's export extraRootScenePaths.`
    );
  }

  /**
   * Files pulled in by `includeGlobs` — the escape hatch for assets no static
   * scan can see (paths assembled from save data, scenes reached only through a
   * computed level index). Skipped entirely when no pattern is configured, so
   * the default export never pays for the project-wide walk.
   */
  private async collectForcedIncludePaths(exportSettings: ExportSettings): Promise<string[]> {
    if (exportSettings.includeGlobs.length === 0) {
      return [];
    }

    const isIncluded = createGlobMatcher(exportSettings.includeGlobs);
    const projectFiles = await this.collectShippableProjectFiles('.');
    return projectFiles.filter(filePath => isIncluded(filePath));
  }

  /**
   * Recursively list project files that could plausibly ship, skipping tooling
   * and build output. Unlike {@link discoverFilesByExtension} this must never
   * descend into `node_modules`, which would dwarf the project itself.
   */
  private async collectShippableProjectFiles(directoryPath: string): Promise<string[]> {
    const result: string[] = [];

    let entries: ReadonlyArray<{ name: string; kind: FileSystemHandleKind; path: string }>;
    try {
      entries = await this.fs.listDirectory(directoryPath);
    } catch {
      return result;
    }

    for (const entry of entries) {
      if (entry.kind === 'file') {
        result.push(entry.path);
        continue;
      }

      if (NON_SHIPPABLE_DIRECTORIES.has(entry.name)) {
        continue;
      }

      result.push(...(await this.collectShippableProjectFiles(entry.path)));
    }

    return result;
  }

  private isScannableResource(path: string): boolean {
    // Resources whose contents reference further `res://` assets: scenes and
    // prefabs (`.pix3scene`/`.prefab`) plus `.pix3anim` flipbooks (which list
    // their frame texture paths).
    return /\.(pix3scene|prefab|pix3anim)$/i.test(path);
  }

  private isPrefabPath(path: string): boolean {
    return /(^|\/)prefabs\//i.test(path) || /\.prefab$/i.test(path);
  }

  /**
   * A `res://` reference without a file extension is treated as a *directory*.
   *
   * Scripts frequently reference an asset base directory (e.g.
   * `const BASE = 'res://src/assets/textures/enemy/air'`) and build individual
   * frame paths dynamically (`` `${BASE}/transporter/${i}.png` ``). The static
   * `res://` scan can only see the base directory, never the interpolated file
   * paths, so {@link drainResourceScan} enumerates such directories recursively.
   * Bare paths that are neither a file nor a real directory (e.g. `res://…`
   * placeholders in comments) enumerate to nothing and are dropped silently.
   */
  private hasFileExtension(path: string): boolean {
    return /\.[a-zA-Z0-9]+$/.test(path);
  }

  /**
   * Add the page images every referenced Spine `.atlas` declares.
   *
   * The page file names live INSIDE the atlas text (relative to the atlas file),
   * so they are invisible to the `res://` scan of scenes and scripts — the same
   * class of miss as localized sprites. Without this a Spine skeleton ships with
   * its skeleton + atlas but no textures.
   */
  private async collectSpineAtlasPagePaths(
    files: ReadonlySet<string>,
    addResourcePath: (path: string, reason: AssetInclusionReason, via?: string) => void,
    warnings: string[]
  ): Promise<void> {
    const atlasPaths = Array.from(files).filter(path => /\.atlas$/i.test(path));
    for (const atlasPath of atlasPaths) {
      try {
        const contents = await this.fs.readTextFile(this.normalizeResourcePath(atlasPath));
        for (const pageName of parseSpineAtlasPageNames(contents)) {
          // Page names can be absolute/schemed, which resolveSpinePagePath passes
          // through — normalize so the set stays uniformly scheme-less.
          addResourcePath(
            this.normalizeResourcePath(resolveSpinePagePath(atlasPath, pageName)),
            'atlas-page',
            atlasPath
          );
        }
      } catch {
        warnings.push(`Failed to scan Spine atlas for page images: ${atlasPath}`);
      }
    }
  }

  /**
   * Add the `locales/*.json` tables the exported game can actually reach, plus
   * every texture path referenced in their `sprites` sections. The sprite paths
   * are the one class of assets invisible to the `res://` regex scan of
   * scenes/scripts — they are referenced only through localization keys.
   *
   * Only *declared* locales ship. The exported runtime fetches
   * `res://locales/<id>.json` exclusively for ids in the localization config
   * baked into the scene manifest, so a table outside that set is provably
   * unreachable — this is an exact match against the runtime's own config, not a
   * heuristic. A null config means localization is inert in the export, and the
   * whole `locales/` folder (plus its localized sprite variants) is dead weight.
   */
  private async collectLocaleAssetPaths(
    addResourcePath: (path: string, reason: AssetInclusionReason, via?: string) => void,
    warnings: string[]
  ): Promise<void> {
    const localeFiles = await this.discoverFilesByExtension('locales', '.json');
    if (localeFiles.length === 0) {
      return;
    }

    const localization = this.localizationEditor.getRuntimeConfig();
    const shippedLocaleFiles = new Set(
      localization
        ? [localization.defaultLocale, localization.fallbackLocale ?? '', ...localization.locales]
            .filter(locale => locale.length > 0)
            .map(locale => `locales/${locale}.json`)
        : []
    );

    const skipped: string[] = [];

    for (const localePath of localeFiles) {
      if (!shippedLocaleFiles.has(localePath)) {
        skipped.push(localePath);
        continue;
      }

      addResourcePath(localePath, 'locale-table');
      try {
        const contents = await this.fs.readTextFile(localePath);
        const parsed = JSON.parse(contents) as { sprites?: Record<string, unknown> };
        for (const value of Object.values(parsed.sprites ?? {})) {
          if (typeof value !== 'string') {
            continue;
          }
          const resourcePath = this.normalizeResourcePath(value.trim());
          if (this.isConcreteResourcePath(resourcePath)) {
            addResourcePath(resourcePath, 'locale-sprite', localePath);
          }
        }
      } catch {
        warnings.push(`Failed to scan locale table for sprite references: ${localePath}`);
      }
    }

    if (skipped.length > 0) {
      warnings.push(
        localization
          ? `Excluded ${skipped.length} locale table(s) not declared in the project localization settings: ${skipped.join(', ')}`
          : `Localization is not configured for this project — excluded ${skipped.length} unreachable locale table(s): ${skipped.join(', ')}`
      );
    }
  }

  private async collectProjectScriptFiles(): Promise<ReadonlyMap<string, string>> {
    const filePaths = new Set<string>();

    for (const directoryPath of PROJECT_SCRIPT_DIRECTORIES) {
      const discovered = await this.discoverFilesByExtension(directoryPath, '.ts');
      for (const filePath of discovered) {
        if (!this.isProjectRuntimeScriptPath(filePath)) {
          continue;
        }

        filePaths.add(filePath);
      }
    }

    const files = new Map<string, string>();
    const sortedPaths = Array.from(filePaths).sort((a, b) => a.localeCompare(b));

    for (const filePath of sortedPaths) {
      try {
        files.set(filePath, await this.fs.readTextFile(filePath));
      } catch {
        // Skip script files that disappear during discovery.
      }
    }

    return files;
  }

  private async discoverFilesByExtension(
    directoryPath: string,
    extension: string
  ): Promise<string[]> {
    const result: string[] = [];

    let entries: ReadonlyArray<{ name: string; kind: FileSystemHandleKind; path: string }>;
    try {
      entries = await this.fs.listDirectory(directoryPath);
    } catch {
      return result;
    }

    for (const entry of entries) {
      if (entry.kind === 'file' && entry.path.endsWith(extension)) {
        result.push(entry.path);
      }

      if (entry.kind === 'directory') {
        const nested = await this.discoverFilesByExtension(entry.path, extension);
        result.push(...nested);
      }
    }

    return result;
  }

  private async collectProjectSourceDependencies(
    entryFiles: ReadonlyMap<string, string>
  ): Promise<ReadonlyMap<string, string>> {
    const files = new Map(entryFiles);
    const queue = Array.from(entryFiles.keys());
    const visited = new Set<string>();

    while (queue.length > 0) {
      const filePath = queue.shift();
      if (!filePath || visited.has(filePath)) {
        continue;
      }

      visited.add(filePath);
      const contents = files.get(filePath);
      if (typeof contents !== 'string') {
        continue;
      }

      for (const importPath of this.collectRelativeImportSpecifiers(contents)) {
        const resolvedPath = await this.resolveProjectSourceImport(filePath, importPath);
        if (!resolvedPath || files.has(resolvedPath)) {
          continue;
        }

        try {
          files.set(resolvedPath, await this.fs.readTextFile(resolvedPath));
          queue.push(resolvedPath);
        } catch {
          // Ignore missing or non-text dependencies during asset discovery.
        }
      }
    }

    return files;
  }

  private collectRelativeImportSpecifiers(contents: string): string[] {
    const imports = new Set<string>();

    for (const match of contents.matchAll(RELATIVE_IMPORT_PATTERN)) {
      const importPath = (match[1] ?? match[2] ?? '').trim();
      if (!importPath.startsWith('./') && !importPath.startsWith('../')) {
        continue;
      }

      imports.add(importPath);
    }

    return Array.from(imports.values());
  }

  private async resolveProjectSourceImport(
    importerPath: string,
    importPath: string
  ): Promise<string | null> {
    const cleanImportPath = importPath.split('?')[0]?.split('#')[0]?.trim() ?? '';
    if (!cleanImportPath) {
      return null;
    }

    const basePath = this.resolveRelativeImportPath(importerPath, cleanImportPath);
    const candidates = new Set<string>();

    for (const suffix of PROJECT_SOURCE_IMPORT_SUFFIXES) {
      candidates.add(`${basePath}${suffix}`);
    }

    for (const candidate of candidates) {
      try {
        await this.fs.readTextFile(candidate);
        return candidate;
      } catch {
        // Try the next candidate path.
      }
    }

    return null;
  }

  private resolveRelativeImportPath(importerPath: string, importPath: string): string {
    const baseSegments = importerPath.split('/').slice(0, -1);
    const importSegments = importPath.split('/');
    const resolvedSegments = [...baseSegments];

    for (const segment of importSegments) {
      if (!segment || segment === '.') {
        continue;
      }

      if (segment === '..') {
        resolvedSegments.pop();
        continue;
      }

      resolvedSegments.push(segment);
    }

    return resolvedSegments.join('/');
  }

  private collectResourcePathsFromText(
    contents: string,
    reason: AssetInclusionReason,
    via: string,
    addResourcePath: (resourcePath: string, reason: AssetInclusionReason, via?: string) => void
  ): void {
    for (const match of contents.matchAll(RESOURCE_PATH_PATTERN)) {
      const resourcePath = (match[1] ?? '').trim();
      if (this.isConcreteResourcePath(resourcePath)) {
        addResourcePath(resourcePath, reason, via);
        continue;
      }

      // Dynamically-built path (e.g. `` `res://…/sfx/boom1/ex${i}.png` ``). The
      // interpolated filename is unknowable statically, but the literal PREFIX
      // reveals the containing directory. Emit that directory so the directory
      // resolver embeds the whole frame sequence — otherwise programmatic
      // frame animations render as white squares in the export.
      const directoryPrefix = this.staticDirectoryPrefix(resourcePath);
      if (directoryPrefix) {
        addResourcePath(directoryPrefix, reason, via);
      }
    }
  }

  private isConcreteResourcePath(resourcePath: string): boolean {
    return resourcePath.length > 0 && !resourcePath.includes('${') && !resourcePath.includes('`');
  }

  /**
   * Extract the static directory prefix of a dynamically-interpolated resource
   * path. `src/assets/textures/sfx/boom1/ex${String(59` → `src/assets/textures/sfx/boom1`.
   * Returns null when nothing static precedes the interpolation (a fully
   * computed path, e.g. `res://${scenePath}`), which cannot be resolved.
   */
  private staticDirectoryPrefix(resourcePath: string): string | null {
    const staticPrefix = resourcePath.split('${')[0] ?? '';
    const lastSlashIndex = staticPrefix.lastIndexOf('/');
    if (lastSlashIndex <= 0) {
      return null;
    }

    const directory = staticPrefix.slice(0, lastSlashIndex);
    return directory.length > 0 ? directory : null;
  }

  private isProjectRuntimeScriptPath(filePath: string): boolean {
    const normalized = filePath.trim().toLowerCase();
    return !EXCLUDED_PROJECT_SCRIPT_SUFFIXES.some(suffix => normalized.endsWith(suffix));
  }

  private async mergePackageJsonPatch(usesSpine: boolean): Promise<boolean> {
    const patchTemplate = this.getPackagePatchTemplate();
    if (!patchTemplate) {
      return false;
    }

    let existingRaw = '{}';
    try {
      existingRaw = await this.fs.readTextFile('package.json');
    } catch {
      existingRaw = '{}';
    }

    const existing = this.parseJsonRecord(existingRaw);
    const patch = this.parseJsonRecord(patchTemplate) as BuildPackagePatch;

    if (typeof patch.sideEffects === 'boolean' && typeof existing.sideEffects !== 'boolean') {
      existing.sideEffects = patch.sideEffects;
    }

    const scripts = this.ensureStringMap(existing, 'scripts');
    scripts.build = RUNTIME_BUILD_COMMAND;
    scripts.dev = RUNTIME_DEV_COMMAND;

    const patchedScripts = patch.scripts ?? {};
    for (const [name, command] of Object.entries(patchedScripts)) {
      scripts[name] = command;
    }

    this.mergeStringMap(existing, 'dependencies', patch.dependencies ?? {});
    if (usesSpine) {
      // Only projects that place a SpineSkeleton2D get the (separately licensed,
      // ~500 KB) Spine runtime as a dependency.
      this.mergeStringMap(existing, 'dependencies', {
        '@esotericsoftware/spine-threejs': SPINE_RUNTIME_DEPENDENCY_RANGE,
      });
    }
    this.mergeStringMap(existing, 'devDependencies', patch.devDependencies ?? {});

    const json = JSON.stringify(existing, null, 2) + '\n';
    await this.fs.writeTextFile('package.json', json);
    return true;
  }

  /**
   * Source of the generated `virtual:runtime-spine` module.
   *
   * It imports the Spine runtime STATICALLY on purpose: a dynamic import becomes
   * a separate chunk, which a single-file HTML export can never fetch. The module
   * is empty unless a scene actually places a `SpineSkeleton2D`, so projects that
   * do not use Spine ship none of its ~500 KB.
   */
  private buildSpineRuntimeModule(usesSpine: boolean): string {
    if (!usesSpine) {
      return [
        '// No SpineSkeleton2D in this project: Spine is not bundled.',
        'export {};',
        '',
      ].join('\n');
    }

    return [
      "import * as spine from '@esotericsoftware/spine-threejs';",
      "import { setSpineModuleLoader, type SpineModule } from '@pix3/runtime';",
      '',
      'setSpineModuleLoader(() => Promise.resolve(spine as unknown as SpineModule));',
      '',
    ].join('\n');
  }

  private buildGeneratedFiles(
    projectName: string,
    scenePaths: readonly string[],
    entryScenePath: string,
    assetPaths: readonly string[],
    quality: QualitySettings,
    localization: RuntimeLocalizationConfig,
    usesSpine: boolean
  ): ReadonlyMap<string, string> {
    const replacements: Record<string, string> = {
      PROJECT_NAME: projectName,
      ACTIVE_SCENE_PATH: entryScenePath,
    };
    const files = new Map<string, string>();

    for (const [templatePath, templateContents] of Object.entries(templateFiles)) {
      const relativeOutputPath = this.toOutputPath(templatePath);
      if (!relativeOutputPath) {
        continue;
      }

      files.set(relativeOutputPath, this.renderTemplate(templateContents, replacements));
    }

    files.set(
      'src/generated/scene-manifest.ts',
      this.buildSceneManifestTs(
        scenePaths,
        entryScenePath,
        quality,
        localization,
        this.collectNetKindPrefabPaths(assetPaths)
      )
    );
    files.set('src/generated/spine-runtime.ts', this.buildSpineRuntimeModule(usesSpine));
    files.set('asset-manifest.json', JSON.stringify({ files: assetPaths }, null, 2) + '\n');

    for (const [sourcePath, sourceContents] of Object.entries(runtimeSourceFiles)) {
      const outputPath = this.toRuntimeOutputPath(sourcePath);
      if (!outputPath) {
        continue;
      }

      files.set(outputPath, sourceContents);
    }

    return files;
  }

  private async writeGeneratedFiles(
    files: ReadonlyMap<string, string>,
    ensuredDirectories: Set<string>
  ): Promise<number> {
    let writtenFiles = 0;

    for (const [outputPath, contents] of files) {
      await this.ensureParentDirectory(outputPath, ensuredDirectories);
      await this.fs.writeTextFile(outputPath, contents);
      writtenFiles += 1;
    }

    return writtenFiles;
  }

  private mergeStringMap(
    target: Record<string, unknown>,
    key: string,
    patch: Record<string, string>
  ): void {
    const map = this.ensureStringMap(target, key);
    for (const [dep, version] of Object.entries(patch)) {
      map[dep] = version;
    }
  }

  private ensureStringMap(target: Record<string, unknown>, key: string): Record<string, string> {
    const current = target[key];
    if (this.isStringRecord(current)) {
      return current;
    }

    const created: Record<string, string> = {};
    target[key] = created;
    return created;
  }

  private isStringRecord(value: unknown): value is Record<string, string> {
    if (!value || typeof value !== 'object') {
      return false;
    }

    return Object.values(value).every(item => typeof item === 'string');
  }

  private parseJsonRecord(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to empty record.
    }
    return {};
  }

  private getPackagePatchTemplate(): string | null {
    for (const [templatePath, templateContents] of Object.entries(templateFiles)) {
      if (templatePath.includes('package.patch.json.tpl')) {
        return templateContents;
      }
    }

    return null;
  }

  private renderTemplate(template: string, replacements: Record<string, string>): string {
    let rendered = template;
    for (const [key, value] of Object.entries(replacements)) {
      rendered = rendered.replaceAll(`{{${key}}}`, value);
    }
    return rendered;
  }

  private normalizeResourcePath(path: string): string {
    return path.startsWith('res://') ? path.substring(6) : path;
  }

  private toOutputPath(templatePath: string): string | null {
    const marker = '../../templates/build/';
    const relative = templatePath.includes(marker) ? templatePath.split(marker)[1] : templatePath;
    const withoutTpl = relative.endsWith('.tpl') ? relative.slice(0, -4) : relative;
    if (withoutTpl === 'package.patch.json') {
      return null;
    }

    // Templates are written directly to project root.
    return withoutTpl;
  }

  private toRuntimeOutputPath(sourcePath: string): string | null {
    const sourceMarker = '/packages/pix3-runtime/src/';
    if (sourcePath.includes(sourceMarker)) {
      const relativePath = sourcePath.split(sourceMarker)[1];
      // Skip placeholder generated files — the service writes scene-manifest itself.
      if (relativePath.startsWith('generated/')) {
        return null;
      }
      // App entry-point files live at src/ in the target project.
      if (RUNTIME_SRC_ENTRY_FILES.has(relativePath)) {
        return `src/${relativePath}`;
      }
      // Runtime library code resolves from the linked @pix3/runtime package.
      return null;
    }

    return null;
  }

  /**
   * The multiplayer `kind ↔ prefab` table (plan decision D6).
   *
   * The wire `Kind` is a `u16` **index into this list**, and the room validates a spawn against an
   * allowlist that is the same index set — so the order is a contract, not a detail. Two rules keep
   * it one:
   *
   * - **Sorted by code point, not by locale.** `localeCompare` is locale- and ICU-version
   *   dependent; two machines exporting the same project must not produce different kinds.
   * - **Only shipped prefabs.** A path that reachability pruned is not in `assetPaths`, so it
   *   cannot be spawned and must not occupy an index.
   *
   * The rules themselves live in `@/core/net-kind-paths`, shared with the editor's Play Online
   * session, which derives the same table live from the project folder — two implementations of
   * "which files are prefabs, in what order" is exactly how the two halves would drift apart.
   *
   * The table is versioned with the `buildId`, and a later authored-binding segment (the Phase-3
   * mechanism that binds an authored scene node to an entity) appends *after* the prefabs so its
   * arrival cannot shift a single published kind.
   */
  private collectNetKindPrefabPaths(assetPaths: readonly string[]): string[] {
    return collectNetKindPrefabPaths(assetPaths);
  }

  private buildSceneManifestTs(
    scenePaths: readonly string[],
    activeScenePath: string,
    quality: QualitySettings,
    localization: RuntimeLocalizationConfig,
    netKindPrefabPaths: readonly string[]
  ): string {
    const scenePathsJson = JSON.stringify(scenePaths, null, 2);
    const activeJson = JSON.stringify(activeScenePath);
    const qualityJson = JSON.stringify(
      {
        antialias: quality.antialias,
        shadows: quality.shadows,
        maxPixelRatio: quality.maxPixelRatio,
      },
      null,
      2
    );
    const localizationJson = localization ? JSON.stringify(localization, null, 2) : 'null';

    const netKindTableJson = JSON.stringify({ prefabs: netKindPrefabPaths, authored: [] }, null, 2);

    return [
      'export const scenePaths = ' + scenePathsJson + ' as const;',
      'export const activeScenePath = ' + activeJson + ';',
      'export const runtimeQuality = ' + qualityJson + ' as const;',
      'export const runtimeLocalization = ' + localizationJson + ' as const;',
      '// Multiplayer kind table (D6): the wire Kind is the index into `prefabs`. Sorted by code',
      '// point so every export of this project agrees with the room allowlist; `authored` is the',
      '// reserved Phase-3 segment and appends after the prefabs so no kind ever shifts.',
      'export const netKindTable = ' + netKindTableJson + ' as const;',
      '',
    ].join('\n');
  }

  private async ensureParentDirectory(
    filePath: string,
    ensuredDirectories: Set<string>
  ): Promise<void> {
    const directory = this.getDirectoryPart(filePath);
    if (directory === '.' || ensuredDirectories.has(directory)) {
      return;
    }

    try {
      await this.fs.createDirectory(directory);
    } catch {
      // Directory likely already exists.
    }

    ensuredDirectories.add(directory);
  }

  private getDirectoryPart(path: string): string {
    const segments = path.split('/');
    if (segments.length <= 1) {
      return '.';
    }

    return segments.slice(0, -1).join('/');
  }

  dispose(): void {
    // No resources to release.
  }
}
