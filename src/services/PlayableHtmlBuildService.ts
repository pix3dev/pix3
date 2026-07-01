import { injectable, inject } from '@/fw/di';
import type { CommandContext } from '@/core/command';
import {
  ProjectBuildService,
  type ProjectBuildOptions,
  type RuntimeProjectBuildModel,
} from './ProjectBuildService';
import { ProjectStorageService } from './ProjectStorageService';
import {
  ScriptCompilerService,
  type CompilationResult,
  type VirtualBundleOptions,
  type VirtualFileLoadContext,
} from './ScriptCompilerService';

export interface PlayableHtmlBuildOptions extends ProjectBuildOptions {
  readonly title?: string;
}

export interface PlayableHtmlAssetSizeEntry {
  readonly path: string;
  readonly rawBytes: number;
  readonly base64Bytes: number;
}

export interface PlayableHtmlBundleSizeReport {
  readonly outputHtmlBytes: number;
  readonly rawAssetsBytes: number;
  readonly base64AssetsBytes: number;
  readonly base64ExpansionBytes: number;
  readonly codeAndWrapperBytes: number;
  readonly assetEntries: readonly PlayableHtmlAssetSizeEntry[];
}

export interface PlayableHtmlBuildArtifact {
  readonly html: string;
  readonly runtimeBundleCode: string;
  readonly entryScenePath: string;
  readonly sceneCount: number;
  readonly assetCount: number;
  readonly fileCount: number;
  readonly sizeReport: PlayableHtmlBundleSizeReport;
  readonly warnings: readonly string[];
  readonly bundleWarnings: readonly string[];
  readonly externalModuleIds: readonly string[];
}

interface EmbeddedAssetsBuildStats {
  readonly entries: PlayableHtmlAssetSizeEntry[];
  readonly rawTotalBytes: number;
  readonly base64TotalBytes: number;
}

interface PreparedBundlerFiles {
  readonly files: Map<string, string>;
  readonly warnings: string[];
  readonly embeddedAssetsStats: EmbeddedAssetsBuildStats;
}

const RUNTIME_SOURCE_LOADERS = import.meta.glob(
  [
    '../../packages/pix3-runtime/src/**/*.ts',
    '../../packages/pix3-runtime/src/**/*.js',
    '../../packages/pix3-runtime/src/**/*.json',
  ],
  {
    query: '?raw',
    import: 'default',
  }
) as Record<string, () => Promise<string>>;

const THREE_VENDOR_SOURCE_LOADERS = {
  ...import.meta.glob('../../node_modules/three/build/**/*.js', {
    query: '?raw',
    import: 'default',
  }),
  ...import.meta.glob('../../node_modules/three/examples/jsm/**/*.js', {
    query: '?raw',
    import: 'default',
  }),
} as Record<string, () => Promise<string>>;

const RAPIER_VENDOR_SOURCE_LOADERS = import.meta.glob(
  '../../node_modules/@dimforge/rapier3d-compat/*.mjs',
  {
    query: '?raw',
    import: 'default',
  }
) as Record<string, () => Promise<string>>;

const RAPIER_VENDOR_WASM_URL_LOADERS = import.meta.glob(
  '../../node_modules/@dimforge/rapier3d-compat/*.wasm',
  {
    query: '?url',
    import: 'default',
  }
) as Record<string, () => Promise<string>>;

const YAML_VENDOR_SOURCE_LOADERS = import.meta.glob('../../node_modules/yaml/browser/**/*.js', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const GENERATED_EMBEDDED_ASSETS_MODULE_PATH = 'virtual/generated/runtime-embedded-assets.ts';
const GENERATED_REFLECT_METADATA_MODULE_PATH = 'virtual/generated/reflect-metadata.ts';
const GENERATED_IOS_HAPTICS_MODULE_PATH = 'virtual/generated/ios-haptics.ts';
const GENERATED_LIT_DECORATORS_MODULE_PATH = 'virtual/generated/lit-decorators.ts';
const REGISTER_PROJECT_SCRIPTS_PATH = 'src/register-project-scripts.ts';
const RUNTIME_SOURCE_PREFIX = 'pix3-runtime/src/';
const RAPIER_VENDOR_MODULE_PATH = 'vendor/rapier/rapier.mjs';
const THREE_VENDOR_PREFIX = 'vendor/three/';
const YAML_VENDOR_PREFIX = 'vendor/yaml/';
const RAPIER_VENDOR_WASM_URL_PATTERN = /new URL\("rapier_wasm3d_bg\.wasm","<deleted>"\)/g;

@injectable()
export class PlayableHtmlBuildService {
  @inject(ProjectBuildService)
  private readonly projectBuildService!: ProjectBuildService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(ScriptCompilerService)
  private readonly scriptCompiler!: ScriptCompilerService;

  async buildPlayableHtml(
    context: CommandContext,
    options: PlayableHtmlBuildOptions = {}
  ): Promise<PlayableHtmlBuildArtifact> {
    const model = await this.projectBuildService.buildRuntimeProjectModel(context, options);
    const prepared = await this.prepareBundlerFiles(model);
    const compileOptions = this.createCompileOptions();
    const compilation = await this.scriptCompiler.bundleVirtualProject(prepared.files, {
      ...compileOptions,
      fileLoader: (filePath, loadContext) => this.loadBundlerDependency(filePath, loadContext),
    });

    const warnings = [...model.warnings, ...prepared.warnings];
    const html = this.renderHtmlDocument(
      options.title?.trim() || model.projectName,
      compilation.code
    );

    return {
      html,
      runtimeBundleCode: compilation.code,
      entryScenePath: model.entryScenePath,
      sceneCount: model.scenePaths.length,
      assetCount: model.assetPaths.length,
      fileCount: prepared.files.size,
      sizeReport: this.buildBundleSizeReport(html, prepared.embeddedAssetsStats),
      warnings,
      bundleWarnings: compilation.warnings,
      externalModuleIds: compileOptions.externalModules ?? [],
    };
  }

  private createCompileOptions(): Omit<VirtualBundleOptions, 'fileLoader'> {
    return {
      entryFiles: ['src/main.ts'],
      entryStrategy: 'import-only',
      externalModules: [],
      moduleAliases: {
        '@pix3/runtime': 'pix3-runtime/src/index.ts',
        '@pix3/runtime/*': 'pix3-runtime/src/*',
        '@dimforge/rapier3d-compat': RAPIER_VENDOR_MODULE_PATH,
        three: `${THREE_VENDOR_PREFIX}build/three.module.js`,
        'three/*': `${THREE_VENDOR_PREFIX}*`,
        yaml: `${YAML_VENDOR_PREFIX}browser/index.js`,
        'lit/decorators.js': GENERATED_LIT_DECORATORS_MODULE_PATH,
        'virtual:runtime-embedded-assets': GENERATED_EMBEDDED_ASSETS_MODULE_PATH,
        'reflect-metadata': GENERATED_REFLECT_METADATA_MODULE_PATH,
        'ios-haptics': GENERATED_IOS_HAPTICS_MODULE_PATH,
      },
    };
  }

  private async prepareBundlerFiles(
    model: RuntimeProjectBuildModel
  ): Promise<PreparedBundlerFiles> {
    const files = new Map(model.files);
    const warnings: string[] = [];
    const embeddedAssetsModule = await this.buildEmbeddedAssetsModule(model.assetPaths, warnings);

    files.set(
      REGISTER_PROJECT_SCRIPTS_PATH,
      this.buildStaticProjectScriptRegistrar(model.projectScriptFiles)
    );
    files.set(GENERATED_REFLECT_METADATA_MODULE_PATH, 'export {};\n');
    files.set(
      GENERATED_IOS_HAPTICS_MODULE_PATH,
      [
        'export const haptic = Object.assign(() => undefined, {',
        '  confirm: () => undefined,',
        '  error: () => undefined,',
        '});',
        'export default { haptic };',
        '',
      ].join('\n')
    );
    files.set(
      GENERATED_LIT_DECORATORS_MODULE_PATH,
      [
        'type Decorator = (value: unknown, context?: unknown) => void;',
        'const createDecorator = (): Decorator => () => undefined;',
        'export const property = (_options?: unknown): Decorator => createDecorator();',
        'export const state = (_options?: unknown): Decorator => createDecorator();',
        '',
      ].join('\n')
    );
    files.set(GENERATED_EMBEDDED_ASSETS_MODULE_PATH, embeddedAssetsModule.moduleSource);

    return {
      files,
      warnings,
      embeddedAssetsStats: embeddedAssetsModule.stats,
    };
  }

  private buildStaticProjectScriptRegistrar(
    projectScriptFiles: ReadonlyMap<string, string>
  ): string {
    const scriptPaths = Array.from(projectScriptFiles.keys()).sort((a, b) => a.localeCompare(b));
    const imports: string[] = [];
    const moduleEntries: string[] = [];

    for (const [index, scriptPath] of scriptPaths.entries()) {
      const identifier = `module_${index}`;
      const relativeImportPath = this.toRelativeImportPath(
        REGISTER_PROJECT_SCRIPTS_PATH,
        scriptPath
      );
      imports.push(`import * as ${identifier} from '${relativeImportPath}';`);
      moduleEntries.push(`  ${JSON.stringify(scriptPath)}: ${identifier},`);
    }

    return [
      "import { Script, type PropertySchemaProvider, type ScriptComponent, ScriptRegistry } from '@pix3/runtime';",
      '',
      'function isScriptCtor(value: unknown): value is (new (id: string, type: string) => ScriptComponent) & PropertySchemaProvider {',
      "  if (typeof value !== 'function') {",
      '    return false;',
      '  }',
      '',
      '  const ctor = value as { prototype?: object; getPropertySchema?: unknown };',
      "  const hasSchema = typeof ctor.getPropertySchema === 'function';",
      '  if (!hasSchema) {',
      '    return false;',
      '  }',
      '',
      '  const baseProto = (Script as unknown as { prototype?: object }).prototype;',
      '  let current = ctor.prototype;',
      '  while (current) {',
      '    if (current === baseProto) {',
      '      return true;',
      '    }',
      '    current = Object.getPrototypeOf(current);',
      '  }',
      '',
      '  return false;',
      '}',
      '',
      ...imports,
      '',
      'const modules = {',
      ...moduleEntries,
      '} as const;',
      '',
      'export function registerProjectScripts(registry: ScriptRegistry): void {',
      '  for (const [sourceFile, exportsMap] of Object.entries(modules)) {',
      '    for (const [exportName, value] of Object.entries(exportsMap as Record<string, unknown>)) {',
      '      if (!isScriptCtor(value)) {',
      '        continue;',
      '      }',
      '',
      '      const scriptId = `user:${exportName}`;',
      '      registry.registerComponent({',
      '        id: scriptId,',
      '        displayName: exportName,',
      '        description: `Project component from ${sourceFile}` ,',
      "        category: 'Project',",
      '        componentClass: value,',
      "        keywords: ['project', 'component', exportName.toLowerCase()],",
      '      });',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
  }

  private async buildEmbeddedAssetsModule(
    assetPaths: readonly string[],
    warnings: string[]
  ): Promise<{
    readonly moduleSource: string;
    readonly stats: EmbeddedAssetsBuildStats;
  }> {
    const embeddedAssets: Record<string, { base64: string; mimeType: string }> = {};
    const entries: PlayableHtmlAssetSizeEntry[] = [];

    for (const assetPath of assetPaths) {
      try {
        const blob = await this.storage.readBlob(assetPath);
        const base64 = await this.encodeBlobToBase64(blob);

        embeddedAssets[assetPath] = {
          base64,
          mimeType: this.resolveMimeType(assetPath, blob),
        };
        entries.push({
          path: assetPath,
          rawBytes: blob.size,
          base64Bytes: this.measureUtf8Bytes(base64),
        });
      } catch {
        warnings.push(`Failed to embed asset for playable export: ${assetPath}`);
      }
    }

    return {
      moduleSource: `export const embeddedAssets = ${JSON.stringify(embeddedAssets)};\n`,
      stats: {
        entries,
        rawTotalBytes: entries.reduce((sum, entry) => sum + entry.rawBytes, 0),
        base64TotalBytes: entries.reduce((sum, entry) => sum + entry.base64Bytes, 0),
      },
    };
  }

  private buildBundleSizeReport(
    html: string,
    embeddedAssetsStats: EmbeddedAssetsBuildStats
  ): PlayableHtmlBundleSizeReport {
    const outputHtmlBytes = this.measureUtf8Bytes(html);
    const rawAssetsBytes = embeddedAssetsStats.rawTotalBytes;
    const base64AssetsBytes = embeddedAssetsStats.base64TotalBytes;

    return {
      outputHtmlBytes,
      rawAssetsBytes,
      base64AssetsBytes,
      base64ExpansionBytes: Math.max(0, base64AssetsBytes - rawAssetsBytes),
      codeAndWrapperBytes: Math.max(0, outputHtmlBytes - base64AssetsBytes),
      assetEntries: [...embeddedAssetsStats.entries].sort((left, right) => {
        if (right.rawBytes !== left.rawBytes) {
          return right.rawBytes - left.rawBytes;
        }

        return left.path.localeCompare(right.path);
      }),
    };
  }

  private async loadBundlerDependency(
    filePath: string,
    context: VirtualFileLoadContext
  ): Promise<string | null> {
    if (context.namespace === 'virtual-css') {
      return '';
    }

    if (context.namespace === 'virtual-url') {
      return null;
    }

    const runtimeSource = await this.loadRuntimeModuleSource(filePath);
    if (runtimeSource !== null) {
      return runtimeSource;
    }

    const vendorSource = await this.loadVendorModuleSource(filePath);
    if (vendorSource !== null) {
      return vendorSource;
    }

    try {
      return await this.storage.readTextFile(filePath);
    } catch {
      return null;
    }
  }

  private async loadRuntimeModuleSource(filePath: string): Promise<string | null> {
    if (!filePath.startsWith(RUNTIME_SOURCE_PREFIX)) {
      return null;
    }

    for (const candidatePath of this.getRuntimeSourceCandidates(filePath)) {
      const loader =
        RUNTIME_SOURCE_LOADERS[`../../packages/pix3-runtime/src/${candidatePath}`] ?? null;

      if (!loader) {
        continue;
      }

      return await loader();
    }

    return null;
  }

  private async loadVendorModuleSource(filePath: string): Promise<string | null> {
    if (filePath === RAPIER_VENDOR_MODULE_PATH) {
      return await this.loadRapierCompatModuleSource();
    }

    if (filePath.startsWith(YAML_VENDOR_PREFIX)) {
      const relativePath = filePath.slice(YAML_VENDOR_PREFIX.length);
      const loader = YAML_VENDOR_SOURCE_LOADERS[`../../node_modules/yaml/${relativePath}`] ?? null;

      if (!loader) {
        return null;
      }

      return await loader();
    }

    if (!filePath.startsWith(THREE_VENDOR_PREFIX)) {
      return null;
    }

    const relativePath = filePath.slice(THREE_VENDOR_PREFIX.length);
    const loader = THREE_VENDOR_SOURCE_LOADERS[`../../node_modules/three/${relativePath}`] ?? null;

    if (!loader) {
      return null;
    }

    return await loader();
  }

  private async loadRapierCompatModuleSource(): Promise<string | null> {
    const sourceLoader =
      RAPIER_VENDOR_SOURCE_LOADERS['../../node_modules/@dimforge/rapier3d-compat/rapier.mjs'] ??
      null;
    const wasmUrlLoader =
      RAPIER_VENDOR_WASM_URL_LOADERS[
        '../../node_modules/@dimforge/rapier3d-compat/rapier_wasm3d_bg.wasm'
      ] ?? null;

    if (!sourceLoader || !wasmUrlLoader) {
      return null;
    }

    const [source, wasmAssetUrl] = await Promise.all([sourceLoader(), wasmUrlLoader()]);
    const wasmBase64 = await this.loadBinaryUrlAsBase64(wasmAssetUrl);
    return source.replace(
      RAPIER_VENDOR_WASM_URL_PATTERN,
      JSON.stringify(`data:application/wasm;base64,${wasmBase64}`)
    );
  }

  private renderHtmlDocument(title: string, runtimeBundleCode: string): string {
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8" />',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      `  <title>${this.escapeHtml(title)}</title>`,
      '  <style>',
      '    html, body { margin: 0; width: 100%; height: 100%; background: #111; }',
      '    #app { width: 100%; height: 100%; }',
      '  </style>',
      '</head>',
      '<body>',
      '  <div id="app"></div>',
      '  <script type="module">',
      runtimeBundleCode,
      '  </script>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  private resolveMimeType(path: string, blob: Blob): string {
    if (blob.type) {
      return blob.type;
    }

    const lower = path.toLowerCase();
    if (lower.endsWith('.pix3scene') || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
      return 'text/plain;charset=utf-8';
    }
    if (lower.endsWith('.json') || lower.endsWith('.pix3anim')) {
      return 'application/json;charset=utf-8';
    }
    if (lower.endsWith('.png')) {
      return 'image/png';
    }
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
      return 'image/jpeg';
    }
    if (lower.endsWith('.webp')) {
      return 'image/webp';
    }
    if (lower.endsWith('.glb')) {
      return 'model/gltf-binary';
    }
    if (lower.endsWith('.gltf')) {
      return 'model/gltf+json';
    }
    if (lower.endsWith('.mp3')) {
      return 'audio/mpeg';
    }
    if (lower.endsWith('.ogg')) {
      return 'audio/ogg';
    }
    if (lower.endsWith('.wav')) {
      return 'audio/wav';
    }

    return 'application/octet-stream';
  }

  private async encodeBlobToBase64(blob: Blob): Promise<string> {
    return this.encodeBytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }

  private async loadBinaryUrlAsBase64(url: string): Promise<string> {
    const response = await fetch(url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return this.encodeBytesToBase64(bytes);
  }

  private encodeBytesToBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000;
    let binary = '';

    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
  }

  private getRuntimeSourceCandidates(filePath: string): string[] {
    const relativePath = filePath.slice(RUNTIME_SOURCE_PREFIX.length).replaceAll('\\', '/');
    if (!relativePath) {
      return [];
    }

    const candidates = [relativePath];
    if (!/\.[^/]+$/.test(relativePath)) {
      candidates.push(
        `${relativePath}.ts`,
        `${relativePath}.js`,
        `${relativePath}.json`,
        `${relativePath}/index.ts`,
        `${relativePath}/index.js`,
        `${relativePath}/index.json`
      );
    }

    return Array.from(
      new Set(candidates.map(candidate => candidate.replace(/^\/+/, '').replace(/\/+/g, '/')))
    );
  }

  private measureUtf8Bytes(value: string): number {
    return new TextEncoder().encode(value).length;
  }

  private toRelativeImportPath(fromPath: string, targetPath: string): string {
    const fromSegments = fromPath.split('/');
    const targetSegments = targetPath.split('/');
    const fromDirectory = fromSegments.slice(0, -1);

    let commonIndex = 0;
    while (
      commonIndex < fromDirectory.length &&
      commonIndex < targetSegments.length &&
      fromDirectory[commonIndex] === targetSegments[commonIndex]
    ) {
      commonIndex += 1;
    }

    const upward = fromDirectory.slice(commonIndex).map(() => '..');
    const downward = targetSegments.slice(commonIndex);
    const relativePath = [...upward, ...downward].join('/').replace(/\.ts$/, '');
    return relativePath.startsWith('../') ? relativePath : `./${relativePath}`;
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  dispose(): void {
    // No resources to release.
  }
}
