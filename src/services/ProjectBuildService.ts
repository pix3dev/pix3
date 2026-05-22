import { injectable, inject } from '@/fw/di';
import { ProjectStorageService } from './ProjectStorageService';
import type { CommandContext } from '@/core/command';

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
const PROJECT_SOURCE_IMPORT_SUFFIXES = ['', '.ts', '.js', '.json', '/index.ts', '/index.js', '/index.json'] as const;

const templateFiles = import.meta.glob('../templates/build/**/*.tpl', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const runtimeSourceFiles = import.meta.glob(
  [
    '../../packages/pix3-runtime/src/main.ts',
    '../../packages/pix3-runtime/src/register-project-scripts.ts',
  ],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  }
) as Record<string, string>;

// Entry-point files that ship in the user's src/ folder (not part of the library).
const RUNTIME_SRC_ENTRY_FILES = new Set(['main.ts', 'register-project-scripts.ts']);

@injectable()
export class ProjectBuildService {
  @inject(ProjectStorageService)
  private readonly fs!: ProjectStorageService;

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

    return {
      projectName,
      scenePaths,
      entryScenePath,
      assetPaths,
      projectScriptFiles,
      files: this.buildGeneratedFiles(projectName, scenePaths, entryScenePath, assetPaths),
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
      warnings.push(`Requested entry scene was not found in build inputs: ${requestedEntryScenePath}`);
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

  private async collectScenePaths(context: CommandContext): Promise<string[]> {
    const descriptors = Object.values(context.state.scenes.descriptors);
    const fromState = descriptors
      .map(descriptor => this.normalizeResourcePath(descriptor.filePath))
      .filter(path => path.length > 0);

    if (fromState.length > 0) {
      return Array.from(new Set(fromState)).sort((a, b) => a.localeCompare(b));
    }

    const discovered = await this.discoverFilesByExtension('.', '.pix3scene');
    return discovered.sort((a, b) => a.localeCompare(b));
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

    for (const scenePath of scenePaths) {
      files.add(scenePath);

      try {
        const sceneContents = await this.fs.readTextFile(scenePath);
        this.collectResourcePathsFromText(sceneContents, files);
      } catch {
        warnings.push(`Failed to scan scene for asset references: ${scenePath}`);
      }
    }

    const projectSourceFiles = await this.collectProjectSourceDependencies(projectScriptFiles);
    for (const sourceContents of projectSourceFiles.values()) {
      this.collectResourcePathsFromText(sourceContents, files);
    }

    return Array.from(files).sort((a, b) => a.localeCompare(b));
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

  private collectResourcePathsFromText(contents: string, files: Set<string>): void {
    for (const match of contents.matchAll(RESOURCE_PATH_PATTERN)) {
      const resourcePath = (match[1] ?? '').trim();
      if (this.isConcreteResourcePath(resourcePath)) {
        files.add(resourcePath);
      }
    }
  }

  private isConcreteResourcePath(resourcePath: string): boolean {
    return resourcePath.length > 0 && !resourcePath.includes('${') && !resourcePath.includes('`');
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
    assetPaths: readonly string[]
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

    files.set('src/generated/scene-manifest.ts', this.buildSceneManifestTs(scenePaths, entryScenePath));
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
    const marker = '../templates/build/';
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

  private buildSceneManifestTs(scenePaths: string[], activeScenePath: string): string {
    const scenePathsJson = JSON.stringify(scenePaths, null, 2);
    const activeJson = JSON.stringify(activeScenePath);

    return [
      'export const scenePaths = ' + scenePathsJson + ' as const;',
      'export const activeScenePath = ' + activeJson + ';',
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
