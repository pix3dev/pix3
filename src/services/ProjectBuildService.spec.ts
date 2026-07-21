import { describe, expect, it } from 'vitest';

import type { CommandContext } from '@/core/command';

import { ProjectBuildService } from './ProjectBuildService';

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
      'Failed to scan scene for asset references: scenes/main.pix3scene'
    );
    expect(model.entryScenePath).toBe('scenes/main.pix3scene');
  });
});
