import { injectable, inject } from '@/fw/di';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';
import type { CommandContext } from '@/core/command';
import {
  createDefaultQualitySettings,
  DEFAULT_TARGET_PLATFORM,
  type QualitySettings,
} from '@/core/ProjectManifest';

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

export interface RuntimeProjectBuildModel {
  readonly projectName: string;
  readonly scenePaths: readonly string[];
  readonly entryScenePath: string;
  readonly assetPaths: readonly string[];
  readonly projectScriptFiles: ReadonlyMap<string, string>;
  readonly files: ReadonlyMap<string, string>;
  readonly warnings: readonly string[];
}

const RUNTIME_BUILD_COMMAND = 'vite build';
const RUNTIME_DEV_COMMAND = 'vite';
const PROJECT_SCRIPT_DIRECTORIES = ['scripts', 'src/scripts'] as const;
const EXCLUDED_PROJECT_SCRIPT_SUFFIXES = ['.spec.ts', '.test.ts', '.d.ts'] as const;
const RESOURCE_PATH_PATTERN = /res:\/\/([^\s"'\])]+)/g;
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
    const scenePaths = await this.collectScenePaths(context);
    const warnings: string[] = [];
    const entryScenePath = this.resolveEntryScenePath(context, scenePaths, options, warnings);
    const projectScriptFiles = await this.collectProjectScriptFiles();
    const assetPaths = await this.collectAssetPaths(scenePaths, projectScriptFiles, warnings);
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
      scenePaths,
      entryScenePath,
      assetPaths,
      projectScriptFiles,
      files: this.buildGeneratedFiles(
        projectName,
        scenePaths,
        entryScenePath,
        assetPaths,
        quality,
        localization
      ),
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

    const packageJsonUpdated = await this.mergePackageJsonPatch();
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

  private async collectAssetPaths(
    scenePaths: string[],
    projectScriptFiles: ReadonlyMap<string, string>,
    warnings: string[]
  ): Promise<string[]> {
    const files = new Set<string>();

    // Reference-carrying resources (scenes, prefabs, `.pix3anim` flipbooks) must be
    // scanned transitively: a scene references prefab `.pix3scene` files, those
    // prefabs reference textures / nested prefabs / `.pix3anim` resources, and a
    // `.pix3anim` in turn lists its frame textures. Scanning only the top-level
    // scenes embeds those files but not the assets declared inside them (which is
    // why nested prefab sprites and AnimatedSprite2D frames rendered as white
    // squares in exports).
    const scanQueue: string[] = [];
    const queuedForScan = new Set<string>();
    const addResourcePath = (resourcePath: string): void => {
      files.add(resourcePath);
      if (this.isScannableResource(resourcePath) && !queuedForScan.has(resourcePath)) {
        queuedForScan.add(resourcePath);
        scanQueue.push(resourcePath);
      }
    };

    // Seed with EVERY scene and prefab on disk, not just the navigable manifest
    // scenes: a game can load any scene/prefab dynamically at runtime (e.g.
    // `scene.instantiate('res://…/explosion.pix3scene')` or a computed level
    // path), and each must ship with its own nested assets embedded.
    const allSceneLikeFiles = await this.discoverFilesByExtension('.', '.pix3scene');
    for (const sceneLikePath of allSceneLikeFiles) {
      addResourcePath(this.normalizeResourcePath(sceneLikePath));
    }
    for (const scenePath of scenePaths) {
      addResourcePath(scenePath);
    }

    const projectSourceFiles = await this.collectProjectSourceDependencies(projectScriptFiles);
    for (const sourceContents of projectSourceFiles.values()) {
      this.collectResourcePathsFromText(sourceContents, addResourcePath);
    }

    while (scanQueue.length > 0) {
      const scannablePath = scanQueue.shift();
      if (!scannablePath) {
        continue;
      }

      try {
        const contents = await this.fs.readTextFile(scannablePath);
        this.collectResourcePathsFromText(contents, addResourcePath);
      } catch {
        warnings.push(`Failed to scan resource for asset references: ${scannablePath}`);
      }
    }

    await this.collectLocaleAssetPaths(files, warnings);

    const resolved = await this.resolveAssetDirectoryReferences(files);
    return Array.from(resolved).sort((a, b) => a.localeCompare(b));
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
   * Expand directory `res://` references into the concrete files they contain.
   *
   * Scripts frequently reference an asset *base directory* (e.g.
   * `const BASE = 'res://src/assets/textures/enemy/air'`) and build individual
   * frame paths dynamically (`` `${BASE}/transporter/${i}.png` ``). The static
   * `res://` scan can only see the base directory, never the interpolated file
   * paths. A directory cannot be embedded as a single asset, so we recursively
   * enumerate its files — this both silences the "failed to embed" warnings and
   * ensures runtime-constructed asset paths actually ship in the bundle. Bare
   * paths that are neither a file nor a real directory (e.g. `res://…`
   * placeholders in comments) are dropped silently.
   */
  private async resolveAssetDirectoryReferences(paths: Set<string>): Promise<Set<string>> {
    const resolved = new Set<string>();

    for (const path of paths) {
      if (this.hasFileExtension(path)) {
        resolved.add(path);
        continue;
      }

      const nestedFiles = await this.discoverFilesByExtension(path, '');
      for (const nested of nestedFiles) {
        resolved.add(nested);
      }
    }

    return resolved;
  }

  private hasFileExtension(path: string): boolean {
    return /\.[a-zA-Z0-9]+$/.test(path);
  }

  /**
   * Add `locales/*.json` tables and every texture path referenced in their
   * `sprites` sections to the build's file set. The sprite paths are the one
   * class of assets invisible to the `res://` regex scan of scenes/scripts —
   * they are referenced only through localization keys.
   */
  private async collectLocaleAssetPaths(files: Set<string>, warnings: string[]): Promise<void> {
    const localeFiles = await this.discoverFilesByExtension('locales', '.json');
    for (const localePath of localeFiles) {
      files.add(localePath);
      try {
        const contents = await this.fs.readTextFile(localePath);
        const parsed = JSON.parse(contents) as { sprites?: Record<string, unknown> };
        for (const value of Object.values(parsed.sprites ?? {})) {
          if (typeof value !== 'string') {
            continue;
          }
          const resourcePath = this.normalizeResourcePath(value.trim());
          if (this.isConcreteResourcePath(resourcePath)) {
            files.add(resourcePath);
          }
        }
      } catch {
        warnings.push(`Failed to scan locale table for sprite references: ${localePath}`);
      }
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
    addResourcePath: (resourcePath: string) => void
  ): void {
    for (const match of contents.matchAll(RESOURCE_PATH_PATTERN)) {
      const resourcePath = (match[1] ?? '').trim();
      if (this.isConcreteResourcePath(resourcePath)) {
        addResourcePath(resourcePath);
        continue;
      }

      // Dynamically-built path (e.g. `` `res://…/sfx/boom1/ex${i}.png` ``). The
      // interpolated filename is unknowable statically, but the literal PREFIX
      // reveals the containing directory. Emit that directory so the directory
      // resolver embeds the whole frame sequence — otherwise programmatic
      // frame animations render as white squares in the export.
      const directoryPrefix = this.staticDirectoryPrefix(resourcePath);
      if (directoryPrefix) {
        addResourcePath(directoryPrefix);
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

  private async mergePackageJsonPatch(): Promise<boolean> {
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
    this.mergeStringMap(existing, 'devDependencies', patch.devDependencies ?? {});

    const json = JSON.stringify(existing, null, 2) + '\n';
    await this.fs.writeTextFile('package.json', json);
    return true;
  }

  private buildGeneratedFiles(
    projectName: string,
    scenePaths: readonly string[],
    entryScenePath: string,
    assetPaths: readonly string[],
    quality: QualitySettings,
    localization: RuntimeLocalizationConfig
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
      this.buildSceneManifestTs(scenePaths, entryScenePath, quality, localization)
    );
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

  private buildSceneManifestTs(
    scenePaths: readonly string[],
    activeScenePath: string,
    quality: QualitySettings,
    localization: RuntimeLocalizationConfig
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

    return [
      'export const scenePaths = ' + scenePathsJson + ' as const;',
      'export const activeScenePath = ' + activeJson + ';',
      'export const runtimeQuality = ' + qualityJson + ' as const;',
      'export const runtimeLocalization = ' + localizationJson + ' as const;',
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
