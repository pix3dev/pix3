import { describe, expect, it } from 'vitest';

import type { CommandContext } from '@/core/command';

import { ProjectBuildService } from '@/services/export/ProjectBuildService';

type InMemoryFs = {
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, contents: string) => Promise<void>;
  createDirectory: (path: string) => Promise<void>;
  listDirectory: (
    path: string
  ) => Promise<ReadonlyArray<{ name: string; kind: FileSystemHandleKind; path: string }>>;
  files: Map<string, string>;
  writes: string[];
};

const createInMemoryFs = (initialFiles: Record<string, string>): InMemoryFs => {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const writes: string[] = [];

  const normalizeDirectory = (path: string): string => {
    if (!path || path === '.') {
      return '';
    }

    return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  };

  return {
    files,
    writes,
    readTextFile: async (path: string): Promise<string> => {
      const value = files.get(path);
      if (typeof value !== 'string') {
        throw new Error(`File not found: ${path}`);
      }
      return value;
    },
    writeTextFile: async (path: string, contents: string): Promise<void> => {
      files.set(path, contents);
      writes.push(path);
    },
    createDirectory: async (_path: string): Promise<void> => {
      // Directory creation is tracked internally by the service result.
    },
    listDirectory: async (path: string) => {
      const normalizedDirectory = normalizeDirectory(path);
      const entries = new Map<string, { name: string; kind: FileSystemHandleKind; path: string }>();

      for (const filePath of files.keys()) {
        const normalizedFilePath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
        const prefix = normalizedDirectory ? `${normalizedDirectory}/` : '';
        if (!normalizedFilePath.startsWith(prefix)) {
          continue;
        }

        const relativePath = normalizedFilePath.slice(prefix.length);
        if (relativePath.length === 0) {
          continue;
        }

        const [head, ...rest] = relativePath.split('/');
        if (!head) {
          continue;
        }

        const entryPath = normalizedDirectory ? `${normalizedDirectory}/${head}` : head;
        entries.set(entryPath, {
          name: head,
          kind: rest.length > 0 ? 'directory' : 'file',
          path: entryPath,
        });
      }

      return Array.from(entries.values()).sort((left, right) =>
        left.path.localeCompare(right.path)
      );
    },
  };
};

const createContext = (): CommandContext => {
  const state = {
    project: {
      status: 'ready',
      projectName: 'Runtime Demo',
      manifest: null,
    },
    scenes: {
      activeSceneId: 'scene-1',
      descriptors: {
        'scene-1': {
          id: 'scene-1',
          filePath: 'scenes/main.pix3scene',
        },
      },
    },
  };

  return {
    state: state as unknown as CommandContext['state'],
    snapshot: {} as CommandContext['snapshot'],
    container: {} as CommandContext['container'],
    requestedAt: Date.now(),
  };
};

type RuntimeLocalization = { defaultLocale: string; fallbackLocale?: string; locales: string[] };

/**
 * Stub the injected collaborators on the instance. `@inject` installs a getter on
 * the prototype, so an own property shadows the container lookup.
 */
const attachStubs = (
  service: ProjectBuildService,
  fs: InMemoryFs,
  localization: RuntimeLocalization | null = null
): void => {
  Object.defineProperty(service, 'fs', { value: fs, configurable: true });
  Object.defineProperty(service, 'localizationEditor', {
    value: { getRuntimeConfig: () => localization },
    configurable: true,
  });
};

const withExportSettings = (
  context: CommandContext,
  settings: { includeGlobs?: string[]; excludeGlobs?: string[] }
): CommandContext => {
  context.state.project.manifest = {
    export: settings,
  } as unknown as CommandContext['state']['project']['manifest'];
  return context;
};

describe('ProjectBuildService', () => {
  it('builds an in-memory runtime project model without writing files', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene': 'root:\n  node:\n    texture: res://assets/hero.png\n',
      'scripts/bootstrap.ts': 'export class Bootstrap {}\n',
      'scripts/bootstrap.spec.ts': "import { describe } from 'vitest';\n",
      'src/scripts/player.ts': 'export class Player {}\n',
      'src/scripts/player.test.ts': "import { it } from 'vitest';\n",
      'src/scripts/env.d.ts': 'declare const TEST: boolean;\n',
    });

    const service = new ProjectBuildService();
    Object.defineProperty(service, 'fs', {
      value: fs,
      configurable: true,
    });

    const model = await service.buildRuntimeProjectModel(createContext());

    expect(model.projectName).toBe('Runtime Demo');
    expect(model.entryScenePath).toBe('scenes/main.pix3scene');
    expect(model.scenePaths).toEqual(['scenes/main.pix3scene']);
    expect(model.assetPaths).toEqual(['assets/hero.png', 'scenes/main.pix3scene']);
    expect(Array.from(model.projectScriptFiles.keys())).toEqual([
      'scripts/bootstrap.ts',
      'src/scripts/player.ts',
    ]);
    expect(model.projectScriptFiles.get('scripts/bootstrap.ts')).toBe(
      'export class Bootstrap {}\n'
    );
    expect(model.files.get('index.html')).toContain('<!DOCTYPE html>');
    expect(model.files.get('src/generated/scene-manifest.ts')).toContain(
      'export const activeScenePath = "scenes/main.pix3scene";'
    );
    expect(fs.writes).toEqual([]);
  });

  it('collects asset references from project script dependencies', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene': 'root:\n  node:\n',
      'scripts/bootstrap.ts':
        "import { resources } from '../src/scripts/config/resources';\nexport const boot = resources.models.blockDirt;\n",
      'src/scripts/config/resources.ts':
        "import { generatedResourceCatalog } from '../../generated/resource-catalog';\nexport const resources = generatedResourceCatalog;\n",
      'src/generated/resource-catalog.ts':
        "export const generatedResourceCatalog = {\n  models: { blockDirt: 'res://src/assets/models/blockdirt.glb' },\n  textures: { colormap: 'res://src/assets/models/colormap.png' }\n};\n",
    });

    const service = new ProjectBuildService();
    Object.defineProperty(service, 'fs', {
      value: fs,
      configurable: true,
    });

    const model = await service.buildRuntimeProjectModel(createContext());

    expect(model.assetPaths).toEqual([
      'scenes/main.pix3scene',
      'src/assets/models/blockdirt.glb',
      'src/assets/models/colormap.png',
    ]);
  });

  it('expands directory resource references into their contained files', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene': 'root:\n  node:\n',
      // Script references an asset base *directory* and builds frame paths dynamically.
      'scripts/enemy.ts':
        "const BASE = 'res://src/assets/textures/enemy/air';\nexport const frame = (i: number) => `${BASE}/transporter/${String(i).padStart(5, '0')}.png`;\n",
      'src/assets/textures/enemy/air/transporter/00000.png': 'frame-0',
      'src/assets/textures/enemy/air/transporter/00001.png': 'frame-1',
      'src/assets/textures/enemy/air/idle.png': 'idle',
    });

    const service = new ProjectBuildService();
    Object.defineProperty(service, 'fs', {
      value: fs,
      configurable: true,
    });

    const model = await service.buildRuntimeProjectModel(createContext());

    // The bare directory path must not appear; its files are embedded instead.
    expect(model.assetPaths).toEqual([
      'scenes/main.pix3scene',
      'src/assets/textures/enemy/air/idle.png',
      'src/assets/textures/enemy/air/transporter/00000.png',
      'src/assets/textures/enemy/air/transporter/00001.png',
    ]);
    expect(model.assetPaths).not.toContain('src/assets/textures/enemy/air');
  });

  it('scans prefab files transitively for their nested texture references', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      // Scene references a prefab; the prefab (only) declares the textures.
      'scenes/main.pix3scene':
        'root:\n  node:\n    prefab: res://src/assets/prefabs/explosion.pix3scene\n',
      'src/assets/prefabs/explosion.pix3scene':
        "root:\n  - type: Sprite2D\n    properties:\n      texture: { url: 'res://src/assets/textures/sfx/blowglow.png' }\n  - type: Sprite2D\n    properties:\n      nested: res://src/assets/prefabs/wave.pix3scene\n",
      'src/assets/prefabs/wave.pix3scene':
        "root:\n  - type: Sprite2D\n    properties:\n      texture: { url: 'res://src/assets/textures/sfx/wave.png' }\n",
      'src/assets/textures/sfx/blowglow.png': 'glow-bytes',
      'src/assets/textures/sfx/wave.png': 'wave-bytes',
    });

    const service = new ProjectBuildService();
    Object.defineProperty(service, 'fs', { value: fs, configurable: true });

    const model = await service.buildRuntimeProjectModel(createContext());

    // Nested prefab textures (one level deep AND transitively via wave.pix3scene)
    // must be embedded — otherwise the prefab sprites render as white squares.
    expect(model.assetPaths).toContain('src/assets/textures/sfx/blowglow.png');
    expect(model.assetPaths).toContain('src/assets/textures/sfx/wave.png');
    expect(model.assetPaths).toContain('src/assets/prefabs/explosion.pix3scene');
    expect(model.assetPaths).toContain('src/assets/prefabs/wave.pix3scene');
    // Prefabs are embedded as assets but excluded from the navigable manifest.
    expect(model.scenePaths).toEqual(['scenes/main.pix3scene']);
  });

  it('scans .pix3anim flipbooks referenced by AnimatedSprite2D for their frame textures', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene':
        'root:\n  node:\n    prefab: res://src/assets/prefabs/fire-burst.pix3scene\n',
      'src/assets/prefabs/fire-burst.pix3scene':
        'root:\n  - type: AnimatedSprite2D\n    properties:\n      animationResourcePath: res://src/assets/textures/sfx/fireb/fireb.pix3anim\n      freeOnFinish: true\n',
      'src/assets/textures/sfx/fireb/fireb.pix3anim': JSON.stringify({
        clips: [
          {
            name: 'burst',
            fps: 30,
            loop: false,
            frames: [
              { texturePath: 'res://src/assets/textures/sfx/fireb/fireb0001.png' },
              { texturePath: 'res://src/assets/textures/sfx/fireb/fireb0002.png' },
            ],
          },
        ],
      }),
      'src/assets/textures/sfx/fireb/fireb0001.png': 'f1',
      'src/assets/textures/sfx/fireb/fireb0002.png': 'f2',
    });

    const service = new ProjectBuildService();
    Object.defineProperty(service, 'fs', { value: fs, configurable: true });

    const model = await service.buildRuntimeProjectModel(createContext());

    expect(model.assetPaths).toContain('src/assets/textures/sfx/fireb/fireb.pix3anim');
    expect(model.assetPaths).toContain('src/assets/textures/sfx/fireb/fireb0001.png');
    expect(model.assetPaths).toContain('src/assets/textures/sfx/fireb/fireb0002.png');
  });

  it('embeds programmatic frame sequences via the static directory prefix', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene': 'root:\n  node:\n',
      // Fully programmatic animation: the frame directory is never referenced
      // literally, only as the static prefix of an interpolated path.
      'scripts/explosion.ts':
        'const FRAME = (i: number) => `res://src/assets/textures/sfx/boom1/ex${String(59 + i).padStart(4, "0")}.png`;\nexport const first = FRAME(0);\n',
      'src/assets/textures/sfx/boom1/ex0059.png': 'f0',
      'src/assets/textures/sfx/boom1/ex0060.png': 'f1',
      'src/assets/textures/sfx/boom1/ex0061.png': 'f2',
    });

    const service = new ProjectBuildService();
    Object.defineProperty(service, 'fs', { value: fs, configurable: true });

    const model = await service.buildRuntimeProjectModel(createContext());

    expect(model.assetPaths).toEqual([
      'scenes/main.pix3scene',
      'src/assets/textures/sfx/boom1/ex0059.png',
      'src/assets/textures/sfx/boom1/ex0060.png',
      'src/assets/textures/sfx/boom1/ex0061.png',
    ]);
  });

  it('ignores template literal resource placeholders during script asset discovery', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene': 'root:\n  node:\n',
      'scripts/bootstrap.ts':
        'export async function loadScene(resourceManager: { readText(path: string): Promise<string> }, scenePath: string) {\n  return resourceManager.readText(`res://${scenePath}`);\n}\n',
      'src/scripts/runtime.ts':
        "export const activeScenePath = 'src/assets/scenes/main-scene.pix3scene';\nexport const currentScene = `res://${activeScenePath}`;\n",
    });

    const service = new ProjectBuildService();
    Object.defineProperty(service, 'fs', {
      value: fs,
      configurable: true,
    });

    const model = await service.buildRuntimeProjectModel(createContext());

    expect(model.assetPaths).toEqual(['scenes/main.pix3scene']);
  });

  it('bundles the Spine runtime only for projects that place a SpineSkeleton2D', async () => {
    const spineFs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene':
        'root:\n  - type: SpineSkeleton2D\n    properties:\n      skeletonPath: res://spine/hero.json\n      atlasPath: res://spine/hero.atlas\n',
      'spine/hero.json': '{}',
      'spine/hero.atlas': 'hero.png\n	size: 64, 64\nhead\n	bounds: 0, 0, 8, 8\n',
      'spine/hero.png': 'page-bytes',
    });
    const spineService = new ProjectBuildService();
    Object.defineProperty(spineService, 'fs', { value: spineFs, configurable: true });

    const spineModel = await spineService.buildRuntimeProjectModel(createContext());

    expect(spineModel.usesSpine).toBe(true);
    // The page image is named inside the .atlas text, invisible to the res:// scan.
    expect(spineModel.assetPaths).toContain('spine/hero.png');
    expect(spineModel.assetPaths).toContain('spine/hero.atlas');
    const spineModule = spineModel.files.get('src/generated/spine-runtime.ts') ?? '';
    expect(spineModule).toContain("import * as spine from '@esotericsoftware/spine-threejs'");
    expect(spineModule).toContain('setSpineModuleLoader');

    const plainFs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene': 'root:\n  - type: Sprite2D\n',
    });
    const plainService = new ProjectBuildService();
    Object.defineProperty(plainService, 'fs', { value: plainFs, configurable: true });

    const plainModel = await plainService.buildRuntimeProjectModel(createContext());

    // A Spine-free project must not pull in the (separately licensed, ~500 KB)
    // runtime: the generated module stays empty so the bundler never reaches it.
    expect(plainModel.usesSpine).toBe(false);
    expect(plainModel.files.get('src/generated/spine-runtime.ts') ?? '').not.toContain(
      '@esotericsoftware/spine-threejs'
    );
  });

  it('detects Spine through a trailing YAML comment and through project scripts', async () => {
    // A trailing comment used to read as "no Spine": the export then shipped the
    // skeleton's assets without the runtime that draws them.
    const commentedFs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene':
        'root:\n  - type: SpineSkeleton2D # hero rig\n    properties:\n      skeletonPath: res://spine/hero.json\n',
      'spine/hero.json': '{}',
    });
    const commentedService = new ProjectBuildService();
    Object.defineProperty(commentedService, 'fs', { value: commentedFs, configurable: true });
    expect((await commentedService.buildRuntimeProjectModel(createContext())).usesSpine).toBe(true);

    // A project whose scenes have no skeleton yet but whose scripts spawn one.
    const scriptedFs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene': 'root:\n  - type: Sprite2D\n',
      'scripts/spawner.ts':
        "import { SpineSkeleton2D } from '@pix3/runtime';\nexport const make = () => new SpineSkeleton2D({ id: 'x', name: 'x' });\n",
    });
    const scriptedService = new ProjectBuildService();
    Object.defineProperty(scriptedService, 'fs', { value: scriptedFs, configurable: true });
    expect((await scriptedService.buildRuntimeProjectModel(createContext())).usesSpine).toBe(true);
  });

  it('ships only the locale tables the exported runtime can reach', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene': 'root:\n  node:\n',
      'locales/en.json': JSON.stringify({ strings: { play: 'Play' }, sprites: {} }),
      'locales/ru.json': JSON.stringify({
        strings: { play: 'Играть' },
        sprites: { logo: 'res://src/assets/textures/logo-ru.png' },
      }),
      // Authored but never declared in the project's localization settings.
      'locales/de.json': JSON.stringify({
        strings: {},
        sprites: { logo: 'res://src/assets/textures/logo-de.png' },
      }),
      'src/assets/textures/logo-ru.png': 'ru-bytes',
      'src/assets/textures/logo-de.png': 'de-bytes',
    });

    const service = new ProjectBuildService();
    attachStubs(service, fs, { defaultLocale: 'en', locales: ['en', 'ru'] });

    const model = await service.buildRuntimeProjectModel(createContext());

    expect(model.assetPaths).toContain('locales/en.json');
    expect(model.assetPaths).toContain('locales/ru.json');
    // The runtime only ever fetches `res://locales/<declared>.json`, so the
    // undeclared table and its sprite variant are dead weight.
    expect(model.assetPaths).not.toContain('locales/de.json');
    expect(model.assetPaths).not.toContain('src/assets/textures/logo-de.png');
    expect(model.assetPaths).toContain('src/assets/textures/logo-ru.png');
    expect(model.warnings).toContain(
      'Excluded 1 locale table(s) not declared in the project localization settings: locales/de.json'
    );
  });

  it('ships no locale tables when the project has no localization config', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene': 'root:\n  node:\n',
      'locales/en.json': JSON.stringify({ strings: {}, sprites: {} }),
    });

    const service = new ProjectBuildService();
    attachStubs(service, fs, null);

    const model = await service.buildRuntimeProjectModel(createContext());

    expect(model.assetPaths).toEqual(['scenes/main.pix3scene']);
    expect(model.warnings.join('\n')).toContain('Localization is not configured');
  });

  it('keeps the fallback locale even when it is not in the declared list', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene': 'root:\n  node:\n',
      'locales/en.json': JSON.stringify({ strings: {}, sprites: {} }),
      'locales/ru.json': JSON.stringify({ strings: {}, sprites: {} }),
    });

    const service = new ProjectBuildService();
    attachStubs(service, fs, { defaultLocale: 'ru', fallbackLocale: 'en', locales: ['ru'] });

    const model = await service.buildRuntimeProjectModel(createContext());

    expect(model.assetPaths).toContain('locales/ru.json');
    expect(model.assetPaths).toContain('locales/en.json');
  });

  it('drops files matching the export excludeGlobs, along with what only they referenced', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene': 'root:\n  node:\n    texture: res://src/assets/textures/hero.png\n',
      'scenes/scratch.pix3scene':
        'root:\n  node:\n    texture: res://src/assets/textures/wip.png\n',
      'src/assets/textures/hero.png': 'hero',
      'src/assets/textures/wip.png': 'wip',
    });

    const service = new ProjectBuildService();
    attachStubs(service, fs);

    const model = await service.buildRuntimeProjectModel(
      withExportSettings(createContext(), { excludeGlobs: ['scenes/scratch.pix3scene'] })
    );

    expect(model.assetPaths).toEqual(['scenes/main.pix3scene', 'src/assets/textures/hero.png']);
    // An excluded scene is never scanned, so the texture only it referenced goes too.
    expect(model.assetPaths).not.toContain('src/assets/textures/wip.png');
    // ...and it must not remain navigable, or the export could name an entry
    // scene whose file it never ships.
    expect(model.scenePaths).toEqual(['scenes/main.pix3scene']);
    expect(model.warnings.join('\n')).toContain('excludeGlobs');
  });

  it('force-ships files matching the export includeGlobs and scans included scenes', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene': 'root:\n  node:\n',
      // Referenced by nothing a static scan can see (path built from save data).
      'src/assets/audio/theme.mp3': 'audio-bytes',
      'src/assets/audio/notes.txt': 'not audio',
    });

    const service = new ProjectBuildService();
    attachStubs(service, fs);

    const model = await service.buildRuntimeProjectModel(
      withExportSettings(createContext(), { includeGlobs: ['src/assets/audio/**/*.mp3'] })
    );

    expect(model.assetPaths).toContain('src/assets/audio/theme.mp3');
    expect(model.assetPaths).not.toContain('src/assets/audio/notes.txt');
    expect(model.reachability.get('src/assets/audio/theme.mp3')).toEqual({
      reason: 'include-glob',
      via: '',
    });
  });

  it('records why each shipped asset is in the build', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene':
        'root:\n  node:\n    prefab: res://src/assets/prefabs/hud.pix3scene\n',
      'src/assets/prefabs/hud.pix3scene':
        "root:\n  - type: Sprite2D\n    properties:\n      texture: { url: 'res://src/assets/textures/hud.png' }\n",
      'src/assets/textures/hud.png': 'hud',
      'scripts/boot.ts': "export const icon = 'res://src/assets/textures/icon.png';\n",
      'src/assets/textures/icon.png': 'icon',
    });

    const service = new ProjectBuildService();
    attachStubs(service, fs);

    const model = await service.buildRuntimeProjectModel(createContext());

    expect(model.reachability.get('scenes/main.pix3scene')?.reason).toBe('project-scene');
    expect(model.reachability.get('src/assets/textures/hud.png')).toEqual({
      reason: 'scene-reference',
      via: 'src/assets/prefabs/hud.pix3scene',
    });
    expect(model.reachability.get('src/assets/textures/icon.png')).toEqual({
      reason: 'script-reference',
      via: 'scripts/boot.ts',
    });
    // The graph mirrors the output exactly — no directory placeholders linger.
    expect([...model.reachability.keys()].sort()).toEqual([...model.assetPaths]);
  });

  it('attributes directory-expanded frames to the directory that pulled them in', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'scenes/main.pix3scene': 'root:\n  node:\n',
      'scripts/explosion.ts':
        'const FRAME = (i: number) => `res://src/assets/textures/sfx/boom1/ex${i}.png`;\nexport const first = FRAME(0);\n',
      'src/assets/textures/sfx/boom1/ex0.png': 'f0',
    });

    const service = new ProjectBuildService();
    attachStubs(service, fs);

    const model = await service.buildRuntimeProjectModel(createContext());

    expect(model.reachability.get('src/assets/textures/sfx/boom1/ex0.png')).toEqual({
      reason: 'directory-expansion',
      via: 'src/assets/textures/sfx/boom1',
    });
    expect(model.reachability.has('src/assets/textures/sfx/boom1')).toBe(false);
  });

  it('generates runtime project files and copies runtime sources', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify(
        {
          name: 'project-demo',
          scripts: {
            test: 'vitest',
          },
        },
        null,
        2
      ),
      'scenes/main.pix3scene': 'root:\n  node:\n    texture: res://assets/hero.png\n',
    });

    const service = new ProjectBuildService();
    Object.defineProperty(service, 'fs', {
      value: fs,
      configurable: true,
    });

    const result = await service.buildFromTemplates(createContext());

    // Templates land at project root.
    expect(fs.files.has('index.html')).toBe(true);
    expect(fs.files.has('tsconfig.json')).toBe(true);
    expect(fs.files.has('vite.config.ts')).toBe(true);
    // App entry files land in src/.
    expect(fs.files.has('src/main.ts')).toBe(true);
    expect(fs.files.has('src/generated/scene-manifest.ts')).toBe(true);
    expect(fs.files.get('src/register-project-scripts.ts')).toContain(
      '!../src/scripts/**/*.spec.ts'
    );
    expect(fs.files.get('src/register-project-scripts.ts')).toContain(
      '!../src/scripts/**/*.test.ts'
    );
    expect(fs.files.get('src/register-project-scripts.ts')).toContain('!../src/scripts/**/*.d.ts');
    // Asset manifest at project root.
    expect(fs.files.has('asset-manifest.json')).toBe(true);
    // Runtime entry points are generated locally, but the engine resolves from @pix3/runtime via yalc.
    expect(fs.files.has('pix3-runtime/src/index.ts')).toBe(false);

    // Root package.json receives build/dev scripts and preserves existing ones.
    const packageJsonRaw = fs.files.get('package.json');
    expect(typeof packageJsonRaw).toBe('string');
    const packageJson = JSON.parse(packageJsonRaw ?? '{}') as {
      sideEffects?: boolean;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.sideEffects).toBe(false);
    expect(packageJson.scripts?.build).toBe('vite build');
    expect(packageJson.scripts?.dev).toBe('vite');
    expect(packageJson.scripts?.test).toBe('vitest');
    expect(packageJson.dependencies?.['@pix3/runtime']).toBe('file:.yalc/@pix3/runtime');
    expect(packageJson.dependencies?.three).toBe('^0.183.2');
    expect(packageJson.devDependencies?.['@types/node']).toBe('^25.5.0');

    const viteConfig = fs.files.get('vite.config.ts');
    expect(viteConfig).toContain('classicScriptCompatibilityPlugin');
    expect(viteConfig).toContain('modulePreload: false');
    expect(viteConfig).toContain('find: /^three$/');
    expect(viteConfig).toContain("dedupe: ['three']");

    const tsconfigJson = fs.files.get('tsconfig.json');
    expect(tsconfigJson).not.toContain('pix3-runtime/src');

    expect(result.sceneCount).toBe(1);
    expect(result.assetCount).toBe(2);
    expect(result.packageJsonUpdated).toBe(true);
    expect(result.writtenFiles).toBeGreaterThanOrEqual(7);
  });

  it('merges runtime scripts into root package.json while preserving unrelated scripts', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify(
        {
          name: 'project-demo',
          scripts: {
            test: 'vitest',
          },
        },
        null,
        2
      ),
      'scenes/main.pix3scene': 'root:\n  node:\n',
    });

    const service = new ProjectBuildService();
    Object.defineProperty(service, 'fs', {
      value: fs,
      configurable: true,
    });

    await service.buildFromTemplates(createContext());

    const packageJson = JSON.parse(fs.files.get('package.json') ?? '{}') as {
      scripts?: Record<string, string>;
    };

    // Service sets build/dev scripts; existing test script is preserved.
    expect(packageJson.scripts?.build).toBe('vite build');
    expect(packageJson.scripts?.dev).toBe('vite');
    expect(packageJson.scripts?.test).toBe('vitest');
  });

  it('refreshes managed dependency versions from the current build template', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify(
        {
          name: 'project-demo',
          dependencies: {
            '@pix3/runtime': '^0.0.1',
            three: '^0.150.0',
            yaml: '^2.0.0',
            zustand: '^5.0.10',
          },
          devDependencies: {
            typescript: '^5.6.3',
            vite: '^6.1.5',
          },
        },
        null,
        2
      ),
      'scenes/main.pix3scene': 'root:\n  node:\n',
    });

    const service = new ProjectBuildService();
    Object.defineProperty(service, 'fs', {
      value: fs,
      configurable: true,
    });

    await service.buildFromTemplates(createContext());

    const packageJson = JSON.parse(fs.files.get('package.json') ?? '{}') as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.['@pix3/runtime']).toBe('file:.yalc/@pix3/runtime');
    expect(packageJson.dependencies?.three).toBe('^0.183.2');
    expect(packageJson.dependencies?.yaml).toBe('^2.6.0');
    expect(packageJson.dependencies?.zustand).toBe('^5.0.10');
    expect(packageJson.devDependencies?.typescript).toBe('~5.8.3');
    expect(packageJson.devDependencies?.vite).toBe('^7.1.7');
  });

  it('uses project default export scene when active scene is unavailable', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'src/assets/scenes/intro.pix3scene': 'root:\n  node:\n',
      'src/assets/scenes/main.pix3scene': 'root:\n  node:\n',
    });

    const service = new ProjectBuildService();
    Object.defineProperty(service, 'fs', {
      value: fs,
      configurable: true,
    });

    const context = createContext();
    context.state.project.manifest = {
      defaultExportScenePath: 'src/assets/scenes/intro.pix3scene',
    } as CommandContext['state']['project']['manifest'];
    context.state.scenes.activeSceneId = 'missing-scene';
    context.state.scenes.descriptors = {
      intro: {
        id: 'intro',
        filePath: 'src/assets/scenes/intro.pix3scene',
      },
      main: {
        id: 'main',
        filePath: 'src/assets/scenes/main.pix3scene',
      },
    } as unknown as CommandContext['state']['scenes']['descriptors'];

    await service.buildFromTemplates(context);

    expect(fs.files.get('src/generated/scene-manifest.ts')).toContain(
      'export const activeScenePath = "src/assets/scenes/intro.pix3scene";'
    );
  });

  it('prefers explicit entry scene override over active and default scenes', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
      'src/assets/scenes/intro.pix3scene': 'root:\n  node:\n',
      'src/assets/scenes/main.pix3scene': 'root:\n  node:\n',
    });

    const service = new ProjectBuildService();
    Object.defineProperty(service, 'fs', {
      value: fs,
      configurable: true,
    });

    const context = createContext();
    context.state.project.manifest = {
      defaultExportScenePath: 'src/assets/scenes/intro.pix3scene',
    } as CommandContext['state']['project']['manifest'];
    context.state.scenes.activeSceneId = 'main';
    context.state.scenes.descriptors = {
      intro: {
        id: 'intro',
        filePath: 'src/assets/scenes/intro.pix3scene',
      },
      main: {
        id: 'main',
        filePath: 'src/assets/scenes/main.pix3scene',
      },
    } as unknown as CommandContext['state']['scenes']['descriptors'];

    await service.buildFromTemplates(context, {
      entryScenePath: 'res://src/assets/scenes/intro.pix3scene',
    });

    expect(fs.files.get('src/generated/scene-manifest.ts')).toContain(
      'export const activeScenePath = "src/assets/scenes/intro.pix3scene";'
    );
  });

  it('surfaces warnings for invalid requested scenes and failed scene scans', async () => {
    const fs = createInMemoryFs({
      'package.json': JSON.stringify({ name: 'project-demo' }, null, 2),
    });

    const service = new ProjectBuildService();
    Object.defineProperty(service, 'fs', {
      value: fs,
      configurable: true,
    });

    const context = createContext();
    context.state.project.manifest = {
      defaultExportScenePath: 'scenes/default.pix3scene',
    } as CommandContext['state']['project']['manifest'];
    context.state.scenes.descriptors = {
      scene1: {
        id: 'scene1',
        filePath: 'scenes/main.pix3scene',
      },
    } as unknown as CommandContext['state']['scenes']['descriptors'];

    const model = await service.buildRuntimeProjectModel(context, {
      entryScenePath: 'scenes/missing.pix3scene',
    });

    expect(model.warnings).toContain(
      'Requested entry scene was not found in build inputs: scenes/missing.pix3scene'
    );
    expect(model.warnings).toContain(
      'Configured default export scene was not found in build inputs: scenes/default.pix3scene'
    );
    expect(model.warnings).toContain(
      'Failed to scan resource for asset references: scenes/main.pix3scene'
    );
    expect(model.entryScenePath).toBe('scenes/main.pix3scene');
  });
});
