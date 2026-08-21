import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { ServiceContainer, ServiceLifetime } from '@/fw/di';
import { createDefaultProjectManifest } from '@/core/ProjectManifest';

/** Minimal directory handle: identity is `isSameEntry`, exactly as the real picker gives it. */
class FakeDirectoryHandle {
  readonly kind = 'directory' as const;

  constructor(public readonly name: string) {}

  async isSameEntry(other: FileSystemDirectoryHandle): Promise<boolean> {
    return (other as unknown as FakeDirectoryHandle) === this;
  }
}

const fsStub = {
  requestProjectDirectory: vi.fn(),
  setProjectDirectory: vi.fn(),
  ensurePermission: vi.fn(async () => true),
  createDirectory: vi.fn(async () => undefined),
};

vi.mock('@/services/project/FileSystemAPIService', () => ({
  resolveFileSystemAPIService: () => fsStub,
}));

/** Every write `applyTemplateFiles` performs, so the assertions can be about files, not calls. */
const textWrites = new Map<string, string>();
const binaryWrites = new Map<string, number>();

vi.mock('@/services/project/ProjectStorageService', () => ({
  ProjectStorageService: class {
    readTextFile = vi.fn(async () => {
      throw new Error('no manifest');
    });
    writeTextFile = vi.fn(async (path: string, contents: string) => {
      textWrites.set(path, contents);
    });
    writeBinaryFile = vi.fn(async (path: string, data: ArrayBuffer) => {
      binaryWrites.set(path, data.byteLength);
    });
  },
}));

/**
 * A recipe-shaped template: files under every folder the transition's skip list mentions, so a
 * regression that ignores `skip` shows up as an overwritten design document rather than as nothing.
 */
const templateTextFiles = new Map<string, string>([
  ['scenes/main.pix3scene', 'name: {{PROJECT_NAME}}'],
  ['scripts/Player.ts', 'export class Player {}'],
  ['design/recipe.md', '# Recipe'],
  ['design/gdd.md', 'TEMPLATE DOCUMENT'],
  ['design/decisions.md', 'TEMPLATE DECISIONS'],
  ['design/source/notes.md', 'TEMPLATE SOURCE'],
]);

const templateStub = {
  id: 'recipe-arena-2d',
  directories: ['sprites'],
  binaryFiles: new Map([
    ['sprites/ph-player.png', 'blob:player'],
    ['references/mood.png', 'blob:mood'],
  ]),
};

vi.mock('@/services/project/ProjectTemplateService', () => ({
  ProjectTemplateService: class {
    getTemplate = () => templateStub;
    getDefaultTemplate = () => templateStub;
    getTemplateTextFiles = async () => templateTextFiles;
    getAgentOverlayFiles = async () =>
      new Map([
        ['AGENTS.md', '# Agents for {{PROJECT_NAME}}'],
        ['design/README.md', '# Design'],
      ]);
  },
}));

/** Recorded by the mocked collaborators reactivation reaches through dynamic imports. */
const scriptBuilds: string[] = [];
const scenesOpened: string[] = [];

vi.mock('@/services/scripting/ProjectScriptLoaderService', () => ({
  ProjectScriptLoaderService: class {
    syncAndBuild = vi.fn(async (options?: { force?: boolean }) => {
      scriptBuilds.push(options?.force ? 'build:forced' : 'build');
    });
    ensureReady = vi.fn(async () => {
      scriptBuilds.push('ready');
    });
  },
}));

vi.mock('@/features/scripts/play-workspace', () => ({
  ensureSceneActive: vi.fn(async (_container: unknown, resourcePath: string) => {
    scenesOpened.push(resourcePath);
  }),
}));

vi.mock('@/services/project/BrowserProjectStorageService', () => ({
  BrowserProjectStorageService: class {},
}));

const { ProjectStorageService } = await import('@/services/project/ProjectStorageService');
const { ProjectTemplateService } = await import('@/services/project/ProjectTemplateService');
const { ProjectScriptLoaderService } = await import(
  '@/services/scripting/ProjectScriptLoaderService'
);
const { BrowserProjectStorageService } = await import(
  '@/services/project/BrowserProjectStorageService'
);
const { ProjectService } = await import('@/services/project/ProjectService');

// `ProjectService` resolves its storage collaborators at field-init time, so they must be in the
// container before the first `new ProjectService()`.
const container = ServiceContainer.getInstance();
container.addService(
  container.getOrCreateToken(ProjectStorageService),
  ProjectStorageService,
  ServiceLifetime.Singleton
);
container.addService(
  container.getOrCreateToken(BrowserProjectStorageService),
  BrowserProjectStorageService,
  ServiceLifetime.Singleton
);
container.addService(
  container.getOrCreateToken(ProjectTemplateService),
  ProjectTemplateService,
  ServiceLifetime.Singleton
);
container.addService(
  container.getOrCreateToken(ProjectScriptLoaderService),
  ProjectScriptLoaderService,
  ServiceLifetime.Singleton
);

describe('ProjectService — local project identity', () => {
  let service: InstanceType<typeof ProjectService>;
  /** Stands in for the IndexedDB handle store, so the spec needs no real IndexedDB. */
  let handleStore: Map<string, FileSystemDirectoryHandle>;

  beforeEach(() => {
    resetAppState();
    localStorage.clear();
    vi.clearAllMocks();

    handleStore = new Map();
    service = new ProjectService();
    vi.spyOn(service, 'persistProjectDirectoryHandle').mockImplementation(async (id, handle) => {
      handleStore.set(id, handle);
    });
    vi.spyOn(service, 'getPersistedProjectDirectoryHandle').mockImplementation(
      async id => handleStore.get(id) ?? null
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses the session id when the same folder is picked again', async () => {
    const handle = new FakeDirectoryHandle('my-game') as unknown as FileSystemDirectoryHandle;
    fsStub.requestProjectDirectory.mockResolvedValue(handle);

    await service.openProjectViaPicker();
    const firstId = appState.project.id;
    expect(firstId).toBeTruthy();

    await service.openProjectViaPicker();

    // Same id → the workspace mode, tabs and asset-browser state keyed by it survive the reopen.
    expect(appState.project.id).toBe(firstId);
    expect(service.getRecentProjects()).toHaveLength(1);
  });

  it('mints a fresh session id for a folder it has never seen', async () => {
    const first = new FakeDirectoryHandle('game-a') as unknown as FileSystemDirectoryHandle;
    fsStub.requestProjectDirectory.mockResolvedValue(first);
    await service.openProjectViaPicker();
    const firstId = appState.project.id;

    const second = new FakeDirectoryHandle('game-b') as unknown as FileSystemDirectoryHandle;
    fsStub.requestProjectDirectory.mockResolvedValue(second);
    await service.openProjectViaPicker();

    expect(appState.project.id).not.toBe(firstId);
    expect(service.getRecentProjects()).toHaveLength(2);
  });

  it('ignores a recents entry whose persisted handle is gone', async () => {
    service.addRecentProject({
      id: 'stale-id',
      name: 'stale',
      backend: 'local',
      lastOpenedAt: Date.now(),
    });

    const handle = new FakeDirectoryHandle('fresh') as unknown as FileSystemDirectoryHandle;
    fsStub.requestProjectDirectory.mockResolvedValue(handle);
    await service.openProjectViaPicker();

    expect(appState.project.id).not.toBe('stale-id');
  });
});

/**
 * The transition's half of `applyTemplateFiles` (`.plans/vibe-idea-stage.md` §3.1, the phase's main
 * risk): a recipe is laid over a project that already has the user's design document, decisions and
 * references in it. What is asserted here is the pair of properties that makes that survivable —
 * the recipe DOES arrive, and the user's files are NOT touched.
 */
describe('ProjectService.applyTemplateFiles', () => {
  let service: InstanceType<typeof ProjectService>;

  const manifest = createDefaultProjectManifest();

  beforeEach(() => {
    resetAppState();
    localStorage.clear();
    vi.clearAllMocks();
    textWrites.clear();
    binaryWrites.clear();
    service = new ProjectService();
    // The template's binary assets are fetched from bundled URLs; only which ones are requested
    // matters here, never their bytes.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('writes the whole template, the overlay and the manifest when nothing is skipped', async () => {
    await service.applyTemplateFiles('My Game', manifest, 'recipe-arena-2d');

    expect([...textWrites.keys()].sort()).toEqual([
      '.pix3/template.json',
      'AGENTS.md',
      'design/README.md',
      'design/decisions.md',
      'design/gdd.md',
      'design/recipe.md',
      'design/source/notes.md',
      'pix3project.yaml',
      'scenes/main.pix3scene',
      'scripts/Player.ts',
    ]);
    // Placeholders are substituted in template files and in the overlay alike.
    expect(textWrites.get('scenes/main.pix3scene')).toBe('name: My Game');
    expect(textWrites.get('AGENTS.md')).toBe('# Agents for My Game');
    expect([...binaryWrites.keys()].sort()).toEqual([
      'references/mood.png',
      'sprites/ph-player.png',
    ]);
  });

  it('leaves every skipped path alone while still bringing the recipe', async () => {
    await service.applyTemplateFiles('My Game', manifest, 'recipe-arena-2d', {
      skip: ['design/gdd.md', 'design/decisions.md', 'design/source/', 'references/'],
    });

    // The user's own work: untouched, including the whole subtree behind a directory entry.
    expect(textWrites.has('design/gdd.md')).toBe(false);
    expect(textWrites.has('design/decisions.md')).toBe(false);
    expect(textWrites.has('design/source/notes.md')).toBe(false);
    expect(binaryWrites.has('references/mood.png')).toBe(false);

    // The recipe: all of it. A skip list that also swallowed the game would be the worse bug.
    expect(textWrites.get('scenes/main.pix3scene')).toBe('name: My Game');
    expect(textWrites.get('scripts/Player.ts')).toBe('export class Player {}');
    expect(textWrites.get('design/recipe.md')).toBe('# Recipe');
    expect(textWrites.has('pix3project.yaml')).toBe(true);
    expect(binaryWrites.has('sprites/ph-player.png')).toBe(true);
  });

  it('matches a skipped directory only on a path boundary', async () => {
    // `design/sourcemap.md` starts with `design/source` as a STRING but is not inside it.
    templateTextFiles.set('design/sourcemap.md', 'keep me');
    try {
      await service.applyTemplateFiles('My Game', manifest, 'recipe-arena-2d', {
        skip: ['design/source'],
      });
      expect(textWrites.has('design/sourcemap.md')).toBe(true);
      expect(textWrites.has('design/source/notes.md')).toBe(false);
    } finally {
      templateTextFiles.delete('design/sourcemap.md');
    }
  });

  it('puts the manifest it was handed into the project state', async () => {
    await service.applyTemplateFiles(
      'My Game',
      { ...manifest, metadata: { flowStage: 'prototype', recipeHint: 'recipe-tapper-2d' } },
      'recipe-arena-2d'
    );

    expect(appState.project.manifest?.metadata).toEqual({
      flowStage: 'prototype',
      recipeHint: 'recipe-tapper-2d',
    });
    expect(textWrites.get('pix3project.yaml')).toContain('flowStage: prototype');
  });
});

/**
 * Reactivation after the Flow transition (`.plans/vibe-idea-stage.md` §3.1).
 *
 * The riskiest sequence of the phase: the project id, the handle and the recents entry stay, while
 * every document the session was holding has to be dropped and re-read. Each assertion below is a
 * bug this order prevents — a stale scene graph under a new scene file, a manifest nobody re-read,
 * and a script build skipped because the project id never changed.
 */
describe('ProjectService.reactivateCurrentProject', () => {
  let service: InstanceType<typeof ProjectService>;
  let storage: InstanceType<typeof ProjectStorageService>;

  const MANIFEST_YAML = [
    'version: 1.0.0',
    'defaultExportScenePath: scenes/level.pix3scene',
    'viewportBaseSize:',
    '  width: 1080',
    '  height: 1920',
    'metadata:',
    '  flowStage: prototype',
    '  recipeHint: recipe-tapper-2d',
  ].join('\n');

  beforeEach(() => {
    resetAppState();
    vi.clearAllMocks();
    scriptBuilds.length = 0;
    scenesOpened.length = 0;
    service = new ProjectService();
    storage = container.getService(
      container.getOrCreateToken(ProjectStorageService)
    ) as InstanceType<typeof ProjectStorageService>;
    vi.spyOn(storage, 'readTextFile').mockResolvedValue(MANIFEST_YAML);

    appState.project.status = 'ready';
    appState.project.id = 'same-project';
    // State the idea stage left behind: a game that was never running, a scene descriptor whose id
    // the recipe's own `scenes/main.pix3scene` would collide with, and a stale manifest.
    appState.scenes.descriptors = {
      'scenes-main': {
        id: 'scenes-main',
        name: 'main',
        filePath: 'res://scenes/main.pix3scene',
      } as unknown as (typeof appState.scenes.descriptors)[string],
    };
    appState.scenes.activeSceneId = 'scenes-main';
    appState.ui.isPlaying = true;
    appState.project.manifest = createDefaultProjectManifest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops the open documents, re-reads the manifest and opens the entry scene', async () => {
    await service.reactivateCurrentProject({ entryScenePath: 'scenes/level.pix3scene' });

    // Scene ids come from the path, so the previous descriptor had to go or the recipe's scene
    // would have reused the empty idea-stage graph.
    expect(appState.scenes.descriptors).toEqual({});
    expect(appState.ui.isPlaying).toBe(false);
    expect(appState.project.manifest?.metadata?.flowStage).toBe('prototype');
    expect(appState.project.lastOpenedScenePath).toBe('res://scenes/level.pix3scene');
    expect(appState.scenes.pendingScenePaths).toEqual(['res://scenes/level.pix3scene']);
    expect(scenesOpened).toEqual(['res://scenes/level.pix3scene']);
    // The project itself is the SAME project — that is the whole point of reactivating.
    expect(appState.project.id).toBe('same-project');
  });

  it('forces the script build and waits for it before the scene loads', async () => {
    await service.reactivateCurrentProject({ entryScenePath: 'scenes/level.pix3scene' });

    // Unforced, the loader skips a project id it has already built — and the recipe's `user:*`
    // classes would be missing from the registry while its scenes parse.
    expect(scriptBuilds).toEqual(['build:forced', 'ready']);
  });

  it('signals the file listing so the new files are visible', async () => {
    const before = appState.project.fileRefreshSignal;

    await service.reactivateCurrentProject();

    expect(appState.project.fileRefreshSignal).toBe(before + 1);
  });

  it('falls back to the startup scene and tolerates a res:// prefix', async () => {
    await service.reactivateCurrentProject();
    expect(scenesOpened).toEqual(['res://scenes/main.pix3scene']);

    scenesOpened.length = 0;
    await service.reactivateCurrentProject({ entryScenePath: 'res://scenes/level.pix3scene' });
    expect(scenesOpened).toEqual(['res://scenes/level.pix3scene']);
  });

  it('refuses when no project is open', async () => {
    appState.project.status = 'idle';

    await expect(service.reactivateCurrentProject()).rejects.toThrow(/No project is open/);
    expect(scenesOpened).toEqual([]);
  });
});
