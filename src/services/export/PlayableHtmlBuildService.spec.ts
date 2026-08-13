import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@/core/command';
import type {
  ProjectBuildService,
  RuntimeProjectBuildModel,
} from '@/services/export/ProjectBuildService';
import type { ProjectStorageService } from '@/services/project/ProjectStorageService';
import type {
  ScriptCompilerService,
  VirtualBundleOptions,
} from '@/services/scripting/ScriptCompilerService';
import { PlayableHtmlBuildService } from '@/services/export/PlayableHtmlBuildService';

const createContext = (): CommandContext => {
  return {
    state: {
      project: {
        status: 'ready',
        projectName: 'Runtime Demo',
      },
      scenes: {
        activeSceneId: 'scene-1',
        descriptors: {},
      },
    } as unknown as CommandContext['state'],
    snapshot: {} as CommandContext['snapshot'],
    container: {} as CommandContext['container'],
    requestedAt: Date.now(),
  };
};

describe('PlayableHtmlBuildService', () => {
  it('builds playable html from the runtime project model and compiler output', async () => {
    const model: RuntimeProjectBuildModel = {
      projectName: 'Runtime Demo',
      scenePaths: ['scenes/main.pix3scene'],
      entryScenePath: 'scenes/main.pix3scene',
      assetPaths: ['assets/hero.png', 'scenes/main.pix3scene'],
      reachability: new Map([
        ['assets/hero.png', { reason: 'scene-reference' as const, via: 'scenes/main.pix3scene' }],
        ['scenes/main.pix3scene', { reason: 'project-scene' as const, via: '' }],
      ]),
      usesSpine: false,
      usesPostProcessing: false,
      usesNetwork: false,
      usesGltf: false,
      mentionedNames: new Set(['Sprite2D', 'Label2D']),
      projectScriptFiles: new Map([
        ['scripts/bootstrap.ts', 'export class Bootstrap {}\n'],
        ['src/scripts/player.ts', 'export class Player {}\n'],
      ]),
      files: new Map([
        ['src/main.ts', "import './register-project-scripts';\nconsole.log('boot');\n"],
        ['src/register-project-scripts.ts', 'placeholder\n'],
      ]),
      warnings: ['model warning'],
    };

    const projectBuildService = {
      buildRuntimeProjectModel: vi.fn(async () => model),
    } satisfies Pick<ProjectBuildService, 'buildRuntimeProjectModel'>;
    const storage = {
      readBlob: vi.fn(async (path: string) => {
        if (path === 'assets/hero.png') {
          return new Blob(['png-bytes'], { type: 'image/png' });
        }
        return new Blob(['scene: main'], { type: 'text/plain' });
      }),
      readTextFile: vi.fn(async () => null),
    } as unknown as Pick<ProjectStorageService, 'readBlob' | 'readTextFile'>;
    const scriptCompiler = {
      bundleVirtualProject: vi.fn(async () => ({
        code: 'console.log("playable");',
        warnings: ['bundle warning'],
      })),
    } satisfies Pick<ScriptCompilerService, 'bundleVirtualProject'>;

    const service = new PlayableHtmlBuildService();
    Object.defineProperty(service, 'projectBuildService', {
      value: projectBuildService,
      configurable: true,
    });
    Object.defineProperty(service, 'storage', {
      value: storage,
      configurable: true,
    });
    Object.defineProperty(service, 'scriptCompiler', {
      value: scriptCompiler,
      configurable: true,
    });

    const artifact = await service.buildPlayableHtml(createContext(), {
      title: 'Playable Build',
      entryScenePath: 'scenes/main.pix3scene',
    });

    expect(projectBuildService.buildRuntimeProjectModel).toHaveBeenCalledTimes(1);
    expect(projectBuildService.buildRuntimeProjectModel).toHaveBeenCalledWith(expect.any(Object), {
      title: 'Playable Build',
      entryScenePath: 'scenes/main.pix3scene',
    });

    const [bundlerFiles, bundleOptions] = scriptCompiler.bundleVirtualProject.mock
      .calls[0] as unknown as [Map<string, string>, Record<string, unknown>];
    expect(bundlerFiles.get('src/register-project-scripts.ts')).toContain(
      "import * as module_0 from '../scripts/bootstrap';"
    );
    expect(bundlerFiles.get('src/register-project-scripts.ts')).toContain(
      "import * as module_1 from './scripts/player';"
    );
    expect(bundlerFiles.get('virtual/generated/runtime-embedded-assets.ts')).toContain(
      'assets/hero.png'
    );
    expect(bundlerFiles.get('virtual/generated/reflect-metadata.ts')).toBe('export {};\n');
    expect(bundlerFiles.get('virtual/generated/ios-haptics.ts')).toContain('export const haptic');
    expect(bundlerFiles.get('virtual/generated/lit-decorators.ts')).toContain(
      'export const property'
    );
    const fileLoader = (bundleOptions as VirtualBundleOptions).fileLoader;
    expect(typeof fileLoader).toBe('function');
    await expect(
      fileLoader?.('pix3-runtime/src/index.ts', {
        importer: 'src/main.ts',
        requestedImportPath: '@pix3/runtime',
        namespace: 'virtual-fs',
      })
    ).resolves.toContain("export * from './core/ResourceManager';");
    expect(bundleOptions).toMatchObject({
      entryFiles: ['src/main.ts'],
      entryStrategy: 'import-only',
      externalModules: [],
      // Exports must minify — the runtime and the vendored libraries are embedded as source.
      minify: true,
      moduleAliases: {
        '@pix3/runtime': 'pix3-runtime/src/index.ts',
        '@pix3/runtime/*': 'pix3-runtime/src/*',
        '@dimforge/rapier3d-compat': 'vendor/rapier/rapier.mjs',
        three: 'vendor/three/build/three.module.js',
        'three/*': 'vendor/three/*',
        yaml: 'vendor/yaml/browser/index.js',
        'lit/decorators.js': 'virtual/generated/lit-decorators.ts',
        'virtual:runtime-embedded-assets': 'virtual/generated/runtime-embedded-assets.ts',
        'reflect-metadata': 'virtual/generated/reflect-metadata.ts',
        'ios-haptics': 'virtual/generated/ios-haptics.ts',
      },
    });

    expect(artifact.html).toContain('<title>Playable Build</title>');
    expect(artifact.html).toContain('console.log("playable");');
    expect(artifact.runtimeBundleCode).toBe('console.log("playable");');
    expect(artifact.entryScenePath).toBe('scenes/main.pix3scene');
    expect(artifact.sceneCount).toBe(1);
    expect(artifact.assetCount).toBe(2);
    expect(artifact.fileCount).toBeGreaterThan(model.files.size);
    expect(artifact.sizeReport.outputHtmlBytes).toBe(
      new TextEncoder().encode(artifact.html).length
    );
    expect(artifact.sizeReport.rawAssetsBytes).toBeGreaterThan(0);
    expect(artifact.sizeReport.base64AssetsBytes).toBeGreaterThan(
      artifact.sizeReport.rawAssetsBytes
    );
    expect(artifact.sizeReport.base64ExpansionBytes).toBe(
      artifact.sizeReport.base64AssetsBytes - artifact.sizeReport.rawAssetsBytes
    );
    expect(artifact.sizeReport.codeAndWrapperBytes).toBe(
      artifact.sizeReport.outputHtmlBytes - artifact.sizeReport.base64AssetsBytes
    );
    expect(artifact.sizeReport.assetEntries.map(entry => entry.path)).toEqual([
      'scenes/main.pix3scene',
      'assets/hero.png',
    ]);
    expect(artifact.bundleWarnings).toEqual(['bundle warning']);
    expect(artifact.warnings).toContain('model warning');
    expect(artifact.externalModuleIds).toEqual([]);
  });

  it('does not resolve a runtime directory to its index (leaves that to the bundler resolver)', async () => {
    // Regression: the runtime file loader used to resolve a bare directory path to
    // `<dir>/index.ts`. The bundler then recorded the module at the *directory* path, so the
    // index's sibling imports (e.g. shader-effects/index.ts -> './shader-effect-types')
    // resolved against the parent directory and failed with "File not found". The loader must
    // be a pure exact-file reader; `/index.ts` resolution is the bundler resolver's job.
    let capturedFileLoader: VirtualBundleOptions['fileLoader'] | undefined;
    const projectBuildService = {
      buildRuntimeProjectModel: vi.fn(
        async () =>
          ({
            projectName: 'Runtime Demo',
            scenePaths: ['scenes/main.pix3scene'],
            entryScenePath: 'scenes/main.pix3scene',
            assetPaths: [],
            reachability: new Map(),
            usesSpine: false,
            usesPostProcessing: false,
            usesNetwork: false,
            usesGltf: false,
            mentionedNames: new Set<string>(),
            projectScriptFiles: new Map(),
            files: new Map([['src/main.ts', "console.log('boot');\n"]]),
            warnings: [],
          }) as RuntimeProjectBuildModel
      ),
    } satisfies Pick<ProjectBuildService, 'buildRuntimeProjectModel'>;
    const storage = {
      readBlob: vi.fn(async () => new Blob([''], { type: 'text/plain' })),
      readTextFile: vi.fn(async () => null),
    } as unknown as Pick<ProjectStorageService, 'readBlob' | 'readTextFile'>;
    const scriptCompiler = {
      bundleVirtualProject: vi.fn(async (_files: Map<string, string>, options: unknown) => {
        capturedFileLoader = (options as VirtualBundleOptions).fileLoader;
        return { code: '', warnings: [] };
      }),
    } satisfies Pick<ScriptCompilerService, 'bundleVirtualProject'>;

    const service = new PlayableHtmlBuildService();
    Object.defineProperty(service, 'projectBuildService', {
      value: projectBuildService,
      configurable: true,
    });
    Object.defineProperty(service, 'storage', { value: storage, configurable: true });
    Object.defineProperty(service, 'scriptCompiler', {
      value: scriptCompiler,
      configurable: true,
    });

    await service.buildPlayableHtml(createContext(), {
      title: 'Playable Build',
      entryScenePath: 'scenes/main.pix3scene',
    });

    expect(typeof capturedFileLoader).toBe('function');
    const context = {
      importer: 'pix3-runtime/src/index.ts',
      requestedImportPath: './shader-effects',
      namespace: 'virtual-fs',
    } as const;

    // A bare directory path must NOT be resolved to its index by the loader.
    await expect(
      capturedFileLoader?.('pix3-runtime/src/shader-effects', context)
    ).resolves.toBeNull();
    // The bundler resolver then probes the `/index.ts` suffix, which the loader serves as an
    // exact file — recording the module at the correct directory-qualified path.
    await expect(
      capturedFileLoader?.('pix3-runtime/src/shader-effects/index.ts', context)
    ).resolves.toContain("export * from './shader-effect-types';");
  });
});
