import { gunzipSync } from 'node:zlib';
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

/**
 * Covers everything the size work added: gzip self-extraction, JSON scenes with the
 * `yaml` shim, the conditional glTF / postprocessing aliases, and stubbing runtime
 * modules the project never mentions. See `.plans/done/playable-export-size.md`.
 */

const BUNDLE_CODE = 'console.log("playable bundle");';
const SCENE_YAML = ['version: "1.0"', 'nodes:', '  - id: root', '    type: Node2D', ''].join('\n');

const createContext = (): CommandContext =>
  ({
    state: {
      project: { status: 'ready', projectName: 'Runtime Demo' },
      scenes: { activeSceneId: 'scene-1', descriptors: {} },
    } as unknown as CommandContext['state'],
    snapshot: {} as CommandContext['snapshot'],
    container: {} as CommandContext['container'],
    requestedAt: 0,
  }) as CommandContext;

const createModel = (overrides: Partial<RuntimeProjectBuildModel> = {}): RuntimeProjectBuildModel =>
  ({
    projectName: 'Runtime Demo',
    scenePaths: ['scenes/main.pix3scene'],
    entryScenePath: 'scenes/main.pix3scene',
    assetPaths: ['scenes/main.pix3scene'],
    reachability: new Map([
      ['scenes/main.pix3scene', { reason: 'project-scene' as const, via: '' }],
    ]),
    usesSpine: false,
    usesPostProcessing: false,
    usesNetwork: false,
    usesGltf: false,
    mentionedNames: new Set(['Node2D', 'Sprite2D']),
    projectScriptFiles: new Map<string, string>(),
    files: new Map([['src/main.ts', "console.log('boot');\n"]]),
    warnings: [],
    ...overrides,
  }) as RuntimeProjectBuildModel;

interface Harness {
  readonly service: PlayableHtmlBuildService;
  readonly bundleVirtualProject: ReturnType<typeof vi.fn>;
  readonly options: () => VirtualBundleOptions;
  readonly files: () => Map<string, string>;
  readonly loadFile: (filePath: string) => Promise<string | null>;
}

const createHarness = (
  model: RuntimeProjectBuildModel,
  sceneText: string = SCENE_YAML
): Harness => {
  const projectBuildService = {
    buildRuntimeProjectModel: vi.fn(async () => model),
  } satisfies Pick<ProjectBuildService, 'buildRuntimeProjectModel'>;

  const storage = {
    readBlob: vi.fn(async (path: string) =>
      path.endsWith('.png')
        ? new Blob(['png-bytes'], { type: 'image/png' })
        : new Blob([sceneText], { type: 'text/plain' })
    ),
    readTextFile: vi.fn(async () => sceneText),
  } as unknown as Pick<ProjectStorageService, 'readBlob' | 'readTextFile'>;

  const bundleVirtualProject = vi.fn(async () => ({ code: BUNDLE_CODE, warnings: [] }));
  const scriptCompiler = { bundleVirtualProject } as unknown as Pick<
    ScriptCompilerService,
    'bundleVirtualProject'
  >;

  const service = new PlayableHtmlBuildService();
  for (const [key, value] of Object.entries({ projectBuildService, storage, scriptCompiler })) {
    Object.defineProperty(service, key, { value, configurable: true });
  }

  const call = () =>
    bundleVirtualProject.mock.calls[0] as unknown as [Map<string, string>, VirtualBundleOptions];

  return {
    service,
    bundleVirtualProject,
    options: () => call()[1],
    files: () => call()[0],
    loadFile: async (filePath: string) =>
      (await call()[1].fileLoader?.(filePath, {
        importer: 'pix3-runtime/src/core/SceneLoader.ts',
        requestedImportPath: './x',
        namespace: 'virtual-fs',
      })) ?? null,
  };
};

describe('playable export size levers', () => {
  describe('gzip self-extraction', () => {
    it('embeds the bundle as gzip that inflates back to the exact code', async () => {
      const harness = createHarness(createModel());

      const artifact = await harness.service.buildPlayableHtml(createContext(), {
        compress: true,
      });

      // The bundle must NOT appear as text — that is the whole point.
      expect(artifact.html).not.toContain(BUNDLE_CODE);
      expect(artifact.html).toContain('DecompressionStream');

      const payload = /var payload = "([A-Za-z0-9+/=]*)";/.exec(artifact.html)?.[1] ?? '';
      expect(payload.length).toBeGreaterThan(0);
      const inflated = gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
      expect(inflated).toBe(BUNDLE_CODE);
    });

    it('asks the bundler for iife, because the code is injected as a classic script', async () => {
      const harness = createHarness(createModel());

      await harness.service.buildPlayableHtml(createContext(), { compress: true });

      expect(harness.options().format).toBe('iife');
    });

    it('stays an es module — and keeps the code inline — when not compressing', async () => {
      const harness = createHarness(createModel());

      const artifact = await harness.service.buildPlayableHtml(createContext(), {});

      expect(harness.options().format).toBe('esm');
      expect(artifact.html).toContain(BUNDLE_CODE);
      expect(artifact.html).toContain('<script type="module">');
      expect(artifact.sizeReport.compressedBundleBytes).toBe(0);
      expect(artifact.sizeReport.compressionSavedBytes).toBe(0);
    });

    it('reports what compression cost and saved', async () => {
      const harness = createHarness(createModel());

      const artifact = await harness.service.buildPlayableHtml(createContext(), {
        compress: true,
      });
      const report = artifact.sizeReport;

      expect(report.uncompressedBundleBytes).toBe(new TextEncoder().encode(BUNDLE_CODE).length);
      expect(report.compressedBundleBytes).toBeGreaterThan(0);
      // A 30-byte bundle is too small for gzip to win, so only the direction of the
      // accounting is asserted here; real bundles are measured in the plan doc.
      expect(report.compressionSavedBytes).toBeGreaterThanOrEqual(0);
      expect(report.outputHtmlBytes).toBe(new TextEncoder().encode(artifact.html).length);
    });
  });

  describe('JSON scenes instead of the YAML parser', () => {
    it('rewrites scenes as JSON and points `yaml` at the JSON shim', async () => {
      const harness = createHarness(createModel());

      await harness.service.buildPlayableHtml(createContext(), {});

      const aliases = harness.options().moduleAliases ?? {};
      expect(aliases.yaml).toBe('virtual/generated/yaml-json-shim.ts');
      expect(harness.files().get('virtual/generated/yaml-json-shim.ts')).toContain('JSON.parse');

      const embedded = harness.files().get('virtual/generated/runtime-embedded-assets.ts') ?? '';
      const base64 = /"base64":"([^"]+)"/.exec(embedded)?.[1] ?? '';
      const sceneText = Buffer.from(base64, 'base64').toString('utf8');
      expect(JSON.parse(sceneText)).toEqual({
        version: '1.0',
        nodes: [{ id: 'root', type: 'Node2D' }],
      });
    });

    it('keeps the real parser when a scene holds something JSON cannot represent', async () => {
      // `.inf` parses to Infinity, which `JSON.stringify` writes as `null` — a silent
      // value change, so the whole conversion is abandoned rather than risked.
      // (A plain `2026-08-13` is a *string* under YAML 1.2's core schema, so dates only
      // become Date objects behind an explicit `!!timestamp` tag; that is caught by the
      // same non-plain-object check.)
      const harness = createHarness(createModel(), 'version: "1.0"\nfalloff: .inf\n');

      const artifact = await harness.service.buildPlayableHtml(createContext(), {});

      expect(harness.options().moduleAliases?.yaml).toBe('vendor/yaml/browser/index.js');
      expect(artifact.warnings.join('\n')).toContain('keeping the YAML parser');
    });

    it('keeps the real parser when a project script imports yaml itself', async () => {
      const harness = createHarness(
        createModel({
          projectScriptFiles: new Map([['scripts/loader.ts', "import { parse } from 'yaml';\n"]]),
        })
      );

      await harness.service.buildPlayableHtml(createContext(), {});

      expect(harness.options().moduleAliases?.yaml).toBe('vendor/yaml/browser/index.js');
    });
  });

  describe('conditional vendored libraries', () => {
    it('stubs GLTFLoader when the project ships no models', async () => {
      const harness = createHarness(createModel({ usesGltf: false }));

      await harness.service.buildPlayableHtml(createContext(), {});

      const aliases = harness.options().moduleAliases ?? {};
      expect(aliases['three/examples/jsm/loaders/GLTFLoader.js']).toBe(
        'virtual/generated/gltf-loader-stub.ts'
      );
      expect(harness.files().get('virtual/generated/gltf-loader-stub.ts')).toContain('GLTFLoader');
    });

    it('keeps the real GLTFLoader when a model ships', async () => {
      const harness = createHarness(createModel({ usesGltf: true }));

      await harness.service.buildPlayableHtml(createContext(), {});

      expect(
        harness.options().moduleAliases?.['three/examples/jsm/loaders/GLTFLoader.js']
      ).toBeUndefined();
    });

    it('vendors postprocessing only for a project that uses PostProcess', async () => {
      const without = createHarness(createModel({ usesPostProcessing: false }));
      await without.service.buildPlayableHtml(createContext(), {});
      expect(without.options().moduleAliases?.postprocessing).toBe(
        'virtual/generated/postprocessing-stub.ts'
      );

      const withEffects = createHarness(createModel({ usesPostProcessing: true }));
      await withEffects.service.buildPlayableHtml(createContext(), {});
      expect(withEffects.options().moduleAliases?.postprocessing).toBe(
        'vendor/postprocessing/index.js'
      );
    });

    it('always resolves postprocessing to something, so no bare import survives', async () => {
      // Regression: an unaliased bare specifier is marked external by the compiler, and
      // a single-file HTML can never resolve it — PostProcess nodes silently did nothing.
      const harness = createHarness(createModel());

      const artifact = await harness.service.buildPlayableHtml(createContext(), {});

      expect(harness.options().moduleAliases?.postprocessing).toBeDefined();
      expect(artifact.externalModuleIds).toEqual([]);
    });

    it('wires the generated network and postprocessing modules to the virtual specifiers', async () => {
      const harness = createHarness(createModel());

      await harness.service.buildPlayableHtml(createContext(), {});

      const aliases = harness.options().moduleAliases ?? {};
      expect(aliases['virtual:runtime-network']).toBe('src/generated/network-runtime.ts');
      expect(aliases['virtual:runtime-postprocessing']).toBe(
        'src/generated/postprocessing-runtime.ts'
      );
    });
  });

  describe('stripping unmentioned runtime modules', () => {
    it('serves a throwing stub for a node type no scene mentions', async () => {
      const harness = createHarness(createModel());

      const artifact = await harness.service.buildPlayableHtml(createContext(), {});
      const stub = await harness.loadFile('pix3-runtime/src/nodes/2D/UI/Slider2D.ts');

      expect(stub).toContain('export class Slider2D');
      expect(stub).toContain('was stripped from this build');
      expect(artifact.sizeReport.strippedModulePaths).toContain('nodes/2D/UI/Slider2D');
    });

    it('serves the real source for a node type a scene mentions', async () => {
      const harness = createHarness(
        createModel({ mentionedNames: new Set(['Node2D', 'Slider2D']) })
      );

      const artifact = await harness.service.buildPlayableHtml(createContext(), {});
      const source = await harness.loadFile('pix3-runtime/src/nodes/2D/UI/Slider2D.ts');

      expect(source).not.toContain('was stripped from this build');
      expect(source).toContain('class Slider2D');
      expect(artifact.sizeReport.strippedModulePaths).not.toContain('nodes/2D/UI/Slider2D');
    });

    it('never stubs a module the project mentions through a component id', async () => {
      const harness = createHarness(
        createModel({ mentionedNames: new Set(['Node2D', 'core:Follow']) })
      );

      await harness.service.buildPlayableHtml(createContext(), {});
      const source = await harness.loadFile('pix3-runtime/src/behaviors/FollowBehavior.ts');

      expect(source).not.toContain('was stripped from this build');
    });
  });
});
