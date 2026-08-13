import { parse as parseYaml } from 'yaml';
import { injectable, inject } from '@/fw/di';
import type { CommandContext } from '@/core/command';
import {
  buildStrippedModuleSource,
  resolveStrippableRuntimeModules,
} from '@/services/export/strippable-runtime-modules';
import {
  ProjectBuildService,
  type AssetReachabilityEntry,
  type ProjectBuildOptions,
  type RuntimeProjectBuildModel,
} from '@/services/export/ProjectBuildService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  ScriptCompilerService,
  type VirtualBundleOptions,
  type VirtualFileLoadContext,
} from '@/services/scripting/ScriptCompilerService';

export interface PlayableHtmlBuildOptions extends ProjectBuildOptions {
  readonly title?: string;
  /**
   * Ship the bundle gzip'd, with a small bootstrap that inflates it in the browser
   * (`DecompressionStream`) and runs it as a classic script.
   *
   * Cuts the **file** roughly in half, which is the budget ad networks measure. It
   * is the wrong trade whenever the delivery channel compresses for you (ordinary
   * hosting, our own publish flow with `Content-Encoding: gzip`, a network that
   * measures the zip): base64 of gzip cannot be re-compressed, so the wire size
   * grows by a third. Hence an option, not a default of the pipeline.
   */
  readonly compress?: boolean;
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
  /** Size of the bundle before compression; `0` when the export was not compressed. */
  readonly uncompressedBundleBytes: number;
  /** Size of the gzip payload actually embedded (before base64); `0` when uncompressed. */
  readonly compressedBundleBytes: number;
  /** What compression saved on the output file — `0` when the export was not compressed. */
  readonly compressionSavedBytes: number;
  /** Runtime modules left out because nothing in the project mentioned them. */
  readonly strippedModulePaths: readonly string[];
}

export interface PlayableHtmlBuildArtifact {
  readonly html: string;
  readonly runtimeBundleCode: string;
  readonly entryScenePath: string;
  readonly sceneCount: number;
  readonly assetCount: number;
  readonly fileCount: number;
  readonly sizeReport: PlayableHtmlBundleSizeReport;
  /** Why each shipped asset is in the bundle — see {@link RuntimeProjectBuildModel.reachability}. */
  readonly reachability: ReadonlyMap<string, AssetReachabilityEntry>;
  readonly warnings: readonly string[];
  readonly bundleWarnings: readonly string[];
  readonly externalModuleIds: readonly string[];
}

export interface PlayableZipBuildArtifact {
  readonly zipBlob: Blob;
  readonly entryScenePath: string;
  readonly sceneCount: number;
  readonly assetCount: number;
  readonly htmlBytes: number;
  readonly assetBytes: number;
  /** Packed size per asset — the zip counterpart of the HTML size report's entries. */
  readonly assetEntries: readonly PlayableZipAssetSizeEntry[];
  readonly reachability: ReadonlyMap<string, AssetReachabilityEntry>;
  readonly warnings: readonly string[];
  readonly bundleWarnings: readonly string[];
}

export interface PlayableZipAssetSizeEntry {
  readonly path: string;
  readonly rawBytes: number;
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
  /**
   * True when every shipped scene/prefab was rewritten as JSON, so the bundle can
   * alias `yaml` to a `JSON.parse` shim and drop the 96 KiB parser.
   */
  readonly scenesAreJson: boolean;
  /** Scene/prefab text as it will ship, keyed by asset path (JSON when converted). */
  readonly convertedSceneTexts: ReadonlyMap<string, string>;
}

/** What a project does and does not use — decides the conditional parts of the bundle. */
interface RuntimeUsage {
  readonly mentions: (name: string) => boolean;
  readonly strippedModulePaths: ReadonlySet<string>;
  readonly usesGltf: boolean;
  readonly usesPostProcessing: boolean;
  readonly projectImportsYaml: boolean;
}

const RUNTIME_SOURCE_LOADERS = import.meta.glob(
  [
    '../../../packages/pix3-runtime/src/**/*.ts',
    '../../../packages/pix3-runtime/src/**/*.js',
    '../../../packages/pix3-runtime/src/**/*.json',
  ],
  {
    query: '?raw',
    import: 'default',
  }
) as Record<string, () => Promise<string>>;

const THREE_VENDOR_SOURCE_LOADERS = {
  ...import.meta.glob('../../../node_modules/three/build/**/*.js', {
    query: '?raw',
    import: 'default',
  }),
  ...import.meta.glob('../../../node_modules/three/examples/jsm/**/*.js', {
    query: '?raw',
    import: 'default',
  }),
} as Record<string, () => Promise<string>>;

const RAPIER_VENDOR_SOURCE_LOADERS = import.meta.glob(
  '../../../node_modules/@dimforge/rapier3d-compat/*.mjs',
  {
    query: '?raw',
    import: 'default',
  }
) as Record<string, () => Promise<string>>;

const RAPIER_VENDOR_WASM_URL_LOADERS = import.meta.glob(
  '../../../node_modules/@dimforge/rapier3d-compat/*.wasm',
  {
    query: '?url',
    import: 'default',
  }
) as Record<string, () => Promise<string>>;

const YAML_VENDOR_SOURCE_LOADERS = import.meta.glob('../../../node_modules/yaml/browser/**/*.js', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

/**
 * The optional Spine runtime, as its prebuilt single-file ESM bundle (spine-core
 * is already inlined there; its only external is `three`, which the alias map
 * below points at the vendored copy). Loaded lazily by the bundler and only
 * reachable when the generated `virtual:runtime-spine` module imports it, i.e.
 * when the project actually places a SpineSkeleton2D.
 */
const SPINE_VENDOR_SOURCE_LOADERS = import.meta.glob(
  '../../../node_modules/@esotericsoftware/spine-threejs/dist/esm/spine-threejs.mjs',
  {
    query: '?raw',
    import: 'default',
  }
) as Record<string, () => Promise<string>>;

/**
 * The `postprocessing` effect stack, as its prebuilt ESM bundle (its only external
 * is `three`, which the alias map points at the vendored copy). Loaded only when a
 * project actually places a `PostProcess` node: ~314 KiB minified, and before this
 * existed the export left `import('postprocessing')` as an unresolvable bare
 * specifier, so the feature silently did nothing. See
 * `PostProcessingPipeline.setPostprocessingModuleLoader`.
 */
const POSTPROCESSING_VENDOR_SOURCE_LOADERS = import.meta.glob(
  '../../../node_modules/postprocessing/build/index.js',
  {
    query: '?raw',
    import: 'default',
  }
) as Record<string, () => Promise<string>>;

const GENERATED_EMBEDDED_ASSETS_MODULE_PATH = 'virtual/generated/runtime-embedded-assets.ts';
const GENERATED_REFLECT_METADATA_MODULE_PATH = 'virtual/generated/reflect-metadata.ts';
const GENERATED_IOS_HAPTICS_MODULE_PATH = 'virtual/generated/ios-haptics.ts';
const GENERATED_LIT_DECORATORS_MODULE_PATH = 'virtual/generated/lit-decorators.ts';
const GENERATED_SPINE_RUNTIME_MODULE_PATH = 'virtual/generated/runtime-spine.ts';
const GENERATED_YAML_SHIM_MODULE_PATH = 'virtual/generated/yaml-json-shim.ts';
const GENERATED_POSTPROCESSING_STUB_MODULE_PATH = 'virtual/generated/postprocessing-stub.ts';
const GENERATED_GLTF_LOADER_STUB_MODULE_PATH = 'virtual/generated/gltf-loader-stub.ts';
const GENERATED_POSTPROCESSING_RUNTIME_PATH = 'src/generated/postprocessing-runtime.ts';
const GENERATED_NETWORK_RUNTIME_PATH = 'src/generated/network-runtime.ts';
const REGISTER_PROJECT_SCRIPTS_PATH = 'src/register-project-scripts.ts';
const RUNTIME_SOURCE_PREFIX = 'pix3-runtime/src/';
const RAPIER_VENDOR_MODULE_PATH = 'vendor/rapier/rapier.mjs';
const THREE_VENDOR_PREFIX = 'vendor/three/';
const YAML_VENDOR_PREFIX = 'vendor/yaml/';
const SPINE_VENDOR_MODULE_PATH = 'vendor/spine/spine-threejs.mjs';
const POSTPROCESSING_VENDOR_MODULE_PATH = 'vendor/postprocessing/index.js';
const RAPIER_VENDOR_WASM_URL_PATTERN = /new URL\("rapier_wasm3d_bg\.wasm","<deleted>"\)/g;
/** Scene-shaped resources the export rewrites as JSON — see {@link PreparedBundlerFiles.scenesAreJson}. */
const SCENE_LIKE_ASSET_PATTERN = /\.(pix3scene|prefab)$/i;
/** A project script that imports `yaml` itself keeps the real parser in the bundle. */
const PROJECT_YAML_IMPORT_PATTERN = /(?:from|import)\s*\(?\s*['"]yaml['"]/;

@injectable()
export class PlayableHtmlBuildService {
  @inject(ProjectBuildService)
  private readonly projectBuildService!: ProjectBuildService;

  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(ScriptCompilerService)
  private readonly scriptCompiler!: ScriptCompilerService;

  /**
   * Zip variant of the playable export: the same compiled bundle in an
   * `index.html`, but assets ship as plain files next to it instead of being
   * base64-embedded — no 33% base64 overhead, and the archive can be unpacked
   * onto any static host.
   */
  async buildPlayableZip(
    context: CommandContext,
    options: PlayableHtmlBuildOptions = {}
  ): Promise<PlayableZipBuildArtifact> {
    const { default: JSZip } = await import('jszip');

    const model = await this.projectBuildService.buildRuntimeProjectModel(context, options);
    const usage = this.resolveRuntimeUsage(model);
    const prepared = await this.prepareBundlerFiles(model, usage, { embedAssets: false });
    const compileOptions = this.createCompileOptions(usage, prepared.scenesAreJson);
    const compilation = await this.scriptCompiler.bundleVirtualProject(prepared.files, {
      ...compileOptions,
      fileLoader: (filePath, loadContext) =>
        this.loadBundlerDependency(filePath, loadContext, usage),
    });

    const warnings = [...model.warnings, ...prepared.warnings];
    const html = this.renderHtmlDocument(
      options.title?.trim() || model.projectName,
      compilation.code
    );

    const zip = new JSZip();
    zip.file('index.html', html);

    let assetBytes = 0;
    const assetEntries: PlayableZipAssetSizeEntry[] = [];
    for (const assetPath of model.assetPaths) {
      try {
        // Scenes ship in whatever form the bundle's `yaml` alias expects — JSON when
        // the conversion succeeded, the original YAML otherwise.
        const converted = prepared.scenesAreJson
          ? prepared.convertedSceneTexts.get(assetPath)
          : undefined;
        const blob =
          converted === undefined
            ? await this.storage.readBlob(assetPath)
            : new Blob([converted], { type: 'text/plain;charset=utf-8' });
        zip.file(assetPath, blob);
        assetBytes += blob.size;
        assetEntries.push({ path: assetPath, rawBytes: blob.size });
      } catch {
        warnings.push(`Failed to pack asset into zip export: ${assetPath}`);
      }
    }

    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    return {
      zipBlob,
      entryScenePath: model.entryScenePath,
      sceneCount: model.scenePaths.length,
      assetCount: assetEntries.length,
      htmlBytes: this.measureUtf8Bytes(html),
      assetBytes,
      assetEntries: [...assetEntries].sort((left, right) => {
        if (right.rawBytes !== left.rawBytes) {
          return right.rawBytes - left.rawBytes;
        }

        return left.path.localeCompare(right.path);
      }),
      reachability: model.reachability,
      warnings,
      bundleWarnings: compilation.warnings,
    };
  }

  async buildPlayableHtml(
    context: CommandContext,
    options: PlayableHtmlBuildOptions = {}
  ): Promise<PlayableHtmlBuildArtifact> {
    const model = await this.projectBuildService.buildRuntimeProjectModel(context, options);
    const usage = this.resolveRuntimeUsage(model);
    const prepared = await this.prepareBundlerFiles(model, usage);
    const compress = options.compress === true;
    const compileOptions = this.createCompileOptions(usage, prepared.scenesAreJson, compress);
    const compilation = await this.scriptCompiler.bundleVirtualProject(prepared.files, {
      ...compileOptions,
      fileLoader: (filePath, loadContext) =>
        this.loadBundlerDependency(filePath, loadContext, usage),
    });

    const warnings = [...model.warnings, ...prepared.warnings];
    const title = options.title?.trim() || model.projectName;
    let compressedBundleBytes = 0;
    let html: string;

    if (compress) {
      const gzipped = await this.gzipBundleCode(compilation.code);
      compressedBundleBytes = gzipped.byteLength;
      html = this.renderCompressedHtmlDocument(title, this.encodeBytesToBase64(gzipped));
    } else {
      html = this.renderHtmlDocument(title, compilation.code);
    }

    return {
      html,
      runtimeBundleCode: compilation.code,
      entryScenePath: model.entryScenePath,
      sceneCount: model.scenePaths.length,
      assetCount: model.assetPaths.length,
      fileCount: prepared.files.size,
      sizeReport: this.buildBundleSizeReport(html, prepared.embeddedAssetsStats, {
        uncompressedBundleBytes: this.measureUtf8Bytes(compilation.code),
        compressedBundleBytes,
        strippedModulePaths: [...usage.strippedModulePaths].sort((left, right) =>
          left.localeCompare(right)
        ),
      }),
      reachability: model.reachability,
      warnings,
      bundleWarnings: compilation.warnings,
      externalModuleIds: compileOptions.externalModules ?? [],
    };
  }

  /**
   * What the project actually uses, from the build model's mention index — the one
   * place that decides every conditional part of the bundle. Deliberately
   * over-inclusive: a false positive costs kilobytes, a false negative ships a
   * broken game. See `.plans/playable-export-size.md` §2 Р4.
   */
  private resolveRuntimeUsage(model: RuntimeProjectBuildModel): RuntimeUsage {
    const mentions = (name: string): boolean => model.mentionedNames.has(name);
    const strippable = resolveStrippableRuntimeModules(mentions);

    return {
      mentions,
      strippedModulePaths: new Set(strippable.map(entry => entry.modulePath)),
      usesGltf: model.usesGltf,
      usesPostProcessing: model.usesPostProcessing,
      projectImportsYaml: [...model.projectScriptFiles.values()].some(source =>
        PROJECT_YAML_IMPORT_PATTERN.test(source)
      ),
    };
  }

  private createCompileOptions(
    usage: RuntimeUsage,
    scenesAreJson: boolean,
    compress = false
  ): Omit<VirtualBundleOptions, 'fileLoader'> {
    return {
      entryFiles: ['src/main.ts'],
      entryStrategy: 'import-only',
      externalModules: [],
      // Every export path minifies: the playable embeds the runtime and the vendored
      // three/rapier/yaml/spine sources verbatim, and ad networks measure the raw HTML (2–5 MB
      // budgets), where unminified vendor code is the single biggest line item.
      minify: true,
      // A compressed export is injected as a classic `<script>`'s textContent, which
      // cannot carry import/export statements — see VirtualBundleOptions.format.
      format: compress ? 'iife' : 'esm',
      moduleAliases: {
        '@pix3/runtime': 'pix3-runtime/src/index.ts',
        '@pix3/runtime/*': 'pix3-runtime/src/*',
        '@dimforge/rapier3d-compat': RAPIER_VENDOR_MODULE_PATH,
        three: `${THREE_VENDOR_PREFIX}build/three.module.js`,
        // Exact keys win over the `three/*` wildcard. Making the loader a dynamic
        // import would save nothing (esbuild inlines it into the single output file),
        // so glTF support is dropped by aliasing it to a stub — ~62 KiB for a project
        // that ships no models.
        ...(usage.usesGltf
          ? {}
          : {
              'three/examples/jsm/loaders/GLTFLoader.js': GENERATED_GLTF_LOADER_STUB_MODULE_PATH,
            }),
        'three/*': `${THREE_VENDOR_PREFIX}*`,
        // Scenes ship as JSON, so the 96 KiB YAML parser is replaced by `JSON.parse`.
        // A project script that imports `yaml` itself keeps the real parser.
        yaml: scenesAreJson
          ? GENERATED_YAML_SHIM_MODULE_PATH
          : `${YAML_VENDOR_PREFIX}browser/index.js`,
        // ~314 KiB: vendored only for projects that place a PostProcess node. Both
        // branches must resolve to *something*, or the bare specifier would survive
        // as an external import that a single-file HTML can never resolve.
        postprocessing: usage.usesPostProcessing
          ? POSTPROCESSING_VENDOR_MODULE_PATH
          : GENERATED_POSTPROCESSING_STUB_MODULE_PATH,
        'lit/decorators.js': GENERATED_LIT_DECORATORS_MODULE_PATH,
        'virtual:runtime-embedded-assets': GENERATED_EMBEDDED_ASSETS_MODULE_PATH,
        'virtual:runtime-spine': GENERATED_SPINE_RUNTIME_MODULE_PATH,
        'virtual:runtime-postprocessing': GENERATED_POSTPROCESSING_RUNTIME_PATH,
        'virtual:runtime-network': GENERATED_NETWORK_RUNTIME_PATH,
        '@esotericsoftware/spine-threejs': SPINE_VENDOR_MODULE_PATH,
        'reflect-metadata': GENERATED_REFLECT_METADATA_MODULE_PATH,
        'ios-haptics': GENERATED_IOS_HAPTICS_MODULE_PATH,
      },
    };
  }

  private async prepareBundlerFiles(
    model: RuntimeProjectBuildModel,
    usage: RuntimeUsage,
    options: { embedAssets?: boolean } = {}
  ): Promise<PreparedBundlerFiles> {
    const files = new Map(model.files);
    const warnings: string[] = [];
    const sceneConversion = usage.projectImportsYaml
      ? { texts: new Map<string, string>(), converted: false }
      : await this.convertScenesToJson(model.assetPaths, warnings);
    // The zip export ships assets as plain files next to index.html; the
    // ResourceManager then loads them over relative URLs instead of base64.
    const embeddedAssetsModule =
      options.embedAssets === false
        ? {
            moduleSource: 'export const embeddedAssets = {};\n',
            stats: {
              entries: [],
              rawTotalBytes: 0,
              base64TotalBytes: 0,
            } as EmbeddedAssetsBuildStats,
          }
        : await this.buildEmbeddedAssetsModule(model.assetPaths, sceneConversion.texts, warnings);

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
    // Registers the optional Spine runtime, but only for projects that use it —
    // the module is `export {}` otherwise, so esbuild never pulls the vendored
    // bundle in and Spine-free exports stay the same size as before.
    files.set(
      GENERATED_SPINE_RUNTIME_MODULE_PATH,
      model.files.get('src/generated/spine-runtime.ts') ?? 'export {};'
    );
    files.set(
      GENERATED_POSTPROCESSING_STUB_MODULE_PATH,
      [
        '// No PostProcess node in this project, so the effect stack is not vendored.',
        '// The module still has to resolve: an unresolved bare specifier would survive',
        '// as an external import that a single-file HTML can never load.',
        'export {};',
        '',
      ].join('\n')
    );
    files.set(
      GENERATED_GLTF_LOADER_STUB_MODULE_PATH,
      [
        '// No .glb/.gltf in this build and nothing names GLTFLoader — ~62 KiB dropped.',
        'export class GLTFLoader {',
        '  constructor() {',
        "    throw new Error('[Pix3] GLTFLoader was stripped from this build: the project ships no glTF assets.');",
        '  }',
        '}',
        '',
      ].join('\n')
    );
    files.set(
      GENERATED_YAML_SHIM_MODULE_PATH,
      [
        '// Scenes and prefabs were rewritten as JSON at export time, so the 96 KiB',
        '// YAML parser is replaced by JSON.parse. `stringify` is only reachable through',
        '// SceneSaver, which a player never constructs.',
        'export const parse = (text: string): unknown => JSON.parse(text);',
        'export const stringify = (): string => {',
        "  throw new Error('[Pix3] YAML serialization is not available in an exported build.');",
        '};',
        'export default { parse, stringify };',
        '',
      ].join('\n')
    );

    return {
      files,
      warnings,
      embeddedAssetsStats: embeddedAssetsModule.stats,
      scenesAreJson: sceneConversion.converted,
      convertedSceneTexts: sceneConversion.texts,
    };
  }

  /**
   * Rewrites every shipped scene/prefab as JSON so the bundle can drop the YAML
   * parser (JSON is a subset of YAML, and the loader only ever reads plain data
   * out of it).
   *
   * Conversion is all-or-nothing: if a single file carries something JSON cannot
   * hold (a YAML date, `NaN`/`Infinity`, an anchor that parses to a shared
   * object), the whole build keeps the real parser and ships the original YAML.
   * Silently rewriting such a file would change what the game loads.
   */
  private async convertScenesToJson(
    assetPaths: readonly string[],
    warnings: string[]
  ): Promise<{ texts: Map<string, string>; converted: boolean }> {
    const texts = new Map<string, string>();

    for (const assetPath of assetPaths) {
      if (!SCENE_LIKE_ASSET_PATTERN.test(assetPath)) {
        continue;
      }

      let sceneText: string;
      try {
        sceneText = await this.storage.readTextFile(assetPath);
      } catch {
        warnings.push(
          `Could not read ${assetPath} to convert it to JSON; keeping the YAML parser in the bundle.`
        );
        return { texts: new Map(), converted: false };
      }

      let parsed: unknown;
      try {
        parsed = parseYaml(sceneText);
      } catch (error) {
        warnings.push(
          `Could not parse ${assetPath} as YAML (${error instanceof Error ? error.message : String(error)}); ` +
            'keeping the YAML parser in the bundle.'
        );
        return { texts: new Map(), converted: false };
      }

      const unsafePath = this.findNonJsonSafeValue(parsed);
      if (unsafePath !== null) {
        warnings.push(
          `${assetPath} contains a value JSON cannot represent (${unsafePath}); ` +
            'keeping the YAML parser in the bundle.'
        );
        return { texts: new Map(), converted: false };
      }

      texts.set(assetPath, JSON.stringify(parsed));
    }

    return { texts, converted: true };
  }

  /**
   * Describes the first value that would not survive a JSON round-trip, or `null`
   * when the whole tree is JSON-safe. Plain objects, arrays, strings, booleans,
   * finite numbers and `null` are safe; everything else (Date, NaN/Infinity,
   * undefined, Map/Set, class instances from YAML tags) is not.
   */
  private findNonJsonSafeValue(value: unknown, path = '$'): string | null {
    if (value === null) {
      return null;
    }

    switch (typeof value) {
      case 'string':
      case 'boolean':
        return null;
      case 'number':
        return Number.isFinite(value) ? null : `${path} = ${String(value)}`;
      case 'object':
        break;
      default:
        return `${path} is ${typeof value}`;
    }

    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        const found = this.findNonJsonSafeValue(entry, `${path}[${index}]`);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return `${path} is a ${(value as object).constructor?.name ?? 'non-plain object'}`;
    }

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) {
        return `${path}.${key} is undefined`;
      }
      const found = this.findNonJsonSafeValue(entry, `${path}.${key}`);
      if (found !== null) {
        return found;
      }
    }

    return null;
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
    convertedSceneTexts: ReadonlyMap<string, string>,
    warnings: string[]
  ): Promise<{
    readonly moduleSource: string;
    readonly stats: EmbeddedAssetsBuildStats;
  }> {
    const embeddedAssets: Record<string, { base64: string; mimeType: string }> = {};
    const entries: PlayableHtmlAssetSizeEntry[] = [];

    for (const assetPath of assetPaths) {
      try {
        const converted = convertedSceneTexts.get(assetPath);
        const blob =
          converted === undefined
            ? await this.storage.readBlob(assetPath)
            : new Blob([converted], { type: 'text/plain;charset=utf-8' });
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
    embeddedAssetsStats: EmbeddedAssetsBuildStats,
    bundle: {
      readonly uncompressedBundleBytes: number;
      readonly compressedBundleBytes: number;
      readonly strippedModulePaths: readonly string[];
    }
  ): PlayableHtmlBundleSizeReport {
    const outputHtmlBytes = this.measureUtf8Bytes(html);
    const rawAssetsBytes = embeddedAssetsStats.rawTotalBytes;
    const base64AssetsBytes = embeddedAssetsStats.base64TotalBytes;
    const compressed = bundle.compressedBundleBytes > 0;
    // `codeAndWrapperBytes` keeps one meaning in both modes: how much of the code
    // (as authored, before any compression) is not embedded asset payload. In the
    // compressed mode the output file no longer contains that text, so it is
    // measured against the bundle plus the HTML wrapper instead of the file size.
    const uncompressedOutputBytes = compressed
      ? this.measureUtf8Bytes(this.renderHtmlDocument('', '')) + bundle.uncompressedBundleBytes
      : outputHtmlBytes;

    return {
      outputHtmlBytes,
      rawAssetsBytes,
      base64AssetsBytes,
      base64ExpansionBytes: Math.max(0, base64AssetsBytes - rawAssetsBytes),
      codeAndWrapperBytes: Math.max(0, uncompressedOutputBytes - base64AssetsBytes),
      uncompressedBundleBytes: bundle.uncompressedBundleBytes,
      compressedBundleBytes: bundle.compressedBundleBytes,
      compressionSavedBytes: compressed
        ? Math.max(0, uncompressedOutputBytes - outputHtmlBytes)
        : 0,
      strippedModulePaths: bundle.strippedModulePaths,
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
    context: VirtualFileLoadContext,
    usage: RuntimeUsage
  ): Promise<string | null> {
    if (context.namespace === 'virtual-css') {
      return '';
    }

    if (context.namespace === 'virtual-url') {
      return null;
    }

    const runtimeSource = await this.loadRuntimeModuleSource(filePath, usage);
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

  private async loadRuntimeModuleSource(
    filePath: string,
    usage: RuntimeUsage
  ): Promise<string | null> {
    if (!filePath.startsWith(RUNTIME_SOURCE_PREFIX)) {
      return null;
    }

    for (const candidatePath of this.getRuntimeSourceCandidates(filePath)) {
      const loader =
        RUNTIME_SOURCE_LOADERS[`../../../packages/pix3-runtime/src/${candidatePath}`] ?? null;

      if (!loader) {
        continue;
      }

      const source = await loader();
      // Node types and behaviours the project never mentions become throwing stubs
      // with the same export names. Stripping happens here rather than through
      // `moduleAliases` because these modules are reached by RELATIVE imports (from
      // SceneLoader's switch and register-behaviors), which the alias map never sees.
      const modulePath = candidatePath.replace(/\.(ts|js|json)$/, '');
      if (usage.strippedModulePaths.has(modulePath)) {
        return buildStrippedModuleSource(source, modulePath);
      }

      return source;
    }

    return null;
  }

  private async loadVendorModuleSource(filePath: string): Promise<string | null> {
    if (filePath === POSTPROCESSING_VENDOR_MODULE_PATH) {
      const loader =
        POSTPROCESSING_VENDOR_SOURCE_LOADERS[
          '../../../node_modules/postprocessing/build/index.js'
        ] ?? null;
      return loader ? await loader() : null;
    }

    if (filePath === SPINE_VENDOR_MODULE_PATH) {
      const loader =
        SPINE_VENDOR_SOURCE_LOADERS[
          '../../../node_modules/@esotericsoftware/spine-threejs/dist/esm/spine-threejs.mjs'
        ] ?? null;
      return loader ? await loader() : null;
    }

    if (filePath === RAPIER_VENDOR_MODULE_PATH) {
      return await this.loadRapierCompatModuleSource();
    }

    if (filePath.startsWith(YAML_VENDOR_PREFIX)) {
      const relativePath = filePath.slice(YAML_VENDOR_PREFIX.length);
      const loader =
        YAML_VENDOR_SOURCE_LOADERS[`../../../node_modules/yaml/${relativePath}`] ?? null;

      if (!loader) {
        return null;
      }

      return await loader();
    }

    if (!filePath.startsWith(THREE_VENDOR_PREFIX)) {
      return null;
    }

    const relativePath = filePath.slice(THREE_VENDOR_PREFIX.length);
    const loader =
      THREE_VENDOR_SOURCE_LOADERS[`../../../node_modules/three/${relativePath}`] ?? null;

    if (!loader) {
      return null;
    }

    return await loader();
  }

  private async loadRapierCompatModuleSource(): Promise<string | null> {
    const sourceLoader =
      RAPIER_VENDOR_SOURCE_LOADERS['../../../node_modules/@dimforge/rapier3d-compat/rapier.mjs'] ??
      null;
    const wasmUrlLoader =
      RAPIER_VENDOR_WASM_URL_LOADERS[
        '../../../node_modules/@dimforge/rapier3d-compat/rapier_wasm3d_bg.wasm'
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

  /**
   * The compressed variant: a gzip'd bundle as base64 plus a bootstrap that inflates
   * it and injects the result as a classic `<script>`'s `textContent`.
   *
   * Deliberately not a blob URL, a `data:` URL or `new Function`: playables run
   * inside sandboxed / opaque-origin iframes and MRAID webviews, where module and
   * blob fetches and `unsafe-eval` are the things that get refused. Injecting script
   * text needs nothing the surrounding inline bootstrap did not already need — and
   * it is the same conclusion the generated Vite project reached, which rewrites its
   * output to classic scripts (`src/templates/build/vite.config.ts.tpl`).
   *
   * The payload is safe to inline as a JS string: base64's alphabet cannot contain
   * `<`, so no `</script>` can appear inside it.
   */
  private renderCompressedHtmlDocument(title: string, base64GzipPayload: string): string {
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
      '    #pix3-boot-error { color: #eee; font: 14px/1.5 monospace; padding: 16px; white-space: pre-wrap; }',
      '  </style>',
      '</head>',
      '<body>',
      '  <div id="app"></div>',
      '  <script>',
      '(function () {',
      `  var payload = "${base64GzipPayload}";`,
      '  function fail(message) {',
      "    var box = document.createElement('pre');",
      "    box.id = 'pix3-boot-error';",
      '    box.textContent = message;',
      '    document.body.appendChild(box);',
      '  }',
      "  if (typeof DecompressionStream !== 'function') {",
      "    fail('This build is gzip-compressed and needs a browser with DecompressionStream ' +",
      "      '(Chrome 80+, Safari 16.4+, Firefox 113+). Re-export with compression disabled ' +",
      "      'to support older browsers.');",
      '    return;',
      '  }',
      '  try {',
      '    var binary = atob(payload);',
      '    var bytes = new Uint8Array(binary.length);',
      '    for (var i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }',
      "    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));",
      '    new Response(stream).text().then(function (code) {',
      "      var script = document.createElement('script');",
      '      script.textContent = code;',
      '      document.body.appendChild(script);',
      '    }).catch(function (error) {',
      "      fail('Failed to unpack the game bundle: ' + error);",
      '    });',
      '  } catch (error) {',
      "    fail('Failed to unpack the game bundle: ' + error);",
      '  }',
      '})();',
      '  </script>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  /** gzip in the browser — no library, `CompressionStream` is enough. */
  private async gzipBundleCode(code: string): Promise<Uint8Array> {
    const compressed = new Blob([code]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(compressed).arrayBuffer());
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
      // Only extension resolution here — NOT directory-index resolution.
      // The bundler resolver (ScriptCompilerService) owns `/index.ts` resolution via its
      // suffix list, and it records the resolved module at whatever path this loader accepts
      // content for. If we resolved `dir` -> `dir/index.ts` here, esbuild would record the
      // module at the bare directory path, so the index's sibling imports (`./x`) would then
      // resolve against the parent directory instead of `dir/` and fail to load.
      candidates.push(`${relativePath}.ts`, `${relativePath}.js`, `${relativePath}.json`);
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
