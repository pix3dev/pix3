import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/core/command';

import { ExportPlayableHtmlCommand } from './ExportPlayableHtmlCommand';

const createContext = (state: unknown): CommandContext => {
  return {
    state: state as CommandContext['state'],
    snapshot: {} as CommandContext['snapshot'],
    container: {
      getOrCreateToken: <T>(token: T): T => token,
      getService: <T>(): T => {
        throw new Error('Unexpected getService call in this test');
      },
    } as unknown as CommandContext['container'],
    requestedAt: Date.now(),
  };
};

describe('ExportPlayableHtmlCommand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  it('fails precondition when project is not ready', () => {
    const command = new ExportPlayableHtmlCommand();

    const context = createContext({
      project: { status: 'idle', projectName: '' },
      scenes: { descriptors: {}, activeSceneId: null },
    });

    const result = command.preconditions(context);

    expect(result.canExecute).toBe(false);
    if (!result.canExecute) {
      expect(result.reason).toBe('Project must be opened');
      expect(result.scope).toBe('project');
    }
  });

  it('fails precondition when there are no loaded scenes', () => {
    const command = new ExportPlayableHtmlCommand();

    const context = createContext({
      project: { status: 'ready', projectName: 'Demo' },
      scenes: { descriptors: {}, activeSceneId: null },
    });

    const result = command.preconditions(context);

    expect(result.canExecute).toBe(false);
    if (!result.canExecute) {
      expect(result.reason).toBe('At least one loaded scene is required');
      expect(result.scope).toBe('scene');
    }
  });

  it('exports playable html through the save picker when available', async () => {
    const command = new ExportPlayableHtmlCommand();
    const buildService = {
      buildPlayableHtml: vi.fn(async () => ({
        html: '<!doctype html><title>Demo</title>',
        runtimeBundleCode: 'console.log("demo");',
        entryScenePath: 'scenes/main.pix3scene',
        sceneCount: 1,
        assetCount: 2,
        fileCount: 5,
        warnings: [],
        bundleWarnings: [],
        externalModuleIds: [],
      })),
    };
    const dialogService = {
      showConfirmation: vi.fn(async () => true),
    };
    const playableExportDialogService = {
      showDialog: vi.fn(async () => 'scenes/main.pix3scene'),
    };
    const loggingService = {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const createWritable = vi.fn(async () => ({ write, close }));
    const showSaveFilePicker = vi.fn(async () => ({
      name: 'Demo.html',
      createWritable,
    }));

    Object.defineProperty(window, 'showSaveFilePicker', {
      value: showSaveFilePicker,
      configurable: true,
    });

    Object.defineProperty(command, 'playableHtmlBuildService', {
      value: buildService,
      configurable: true,
    });
    Object.defineProperty(command, 'dialogService', {
      value: dialogService,
      configurable: true,
    });
    Object.defineProperty(command, 'playableExportDialogService', {
      value: playableExportDialogService,
      configurable: true,
    });
    Object.defineProperty(command, 'loggingService', {
      value: loggingService,
      configurable: true,
    });

    const context = createContext({
      project: { status: 'ready', projectName: 'Demo Project' },
      scenes: {
        descriptors: {
          scene1: { filePath: 'scenes/main.pix3scene' },
        },
        activeSceneId: 'scene1',
      },
    });

    const result = await command.execute(context);

    expect(playableExportDialogService.showDialog).toHaveBeenCalledWith({
      scenePaths: ['scenes/main.pix3scene'],
      selectedScenePath: 'scenes/main.pix3scene',
    });
    expect(buildService.buildPlayableHtml).toHaveBeenCalledWith(context, {
      title: 'Demo Project',
      entryScenePath: 'scenes/main.pix3scene',
    });
    expect(showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: 'Demo-Project.html',
      })
    );
    expect(createWritable).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(close).toHaveBeenCalledTimes(1);
    expect(dialogService.showConfirmation).toHaveBeenCalledTimes(1);
    expect(result.didMutate).toBe(false);
  });

  it('falls back to browser download when save picker is unavailable', async () => {
    const command = new ExportPlayableHtmlCommand();
    const buildService = {
      buildPlayableHtml: vi.fn(async () => ({
        html: '<!doctype html><title>Demo</title>',
        runtimeBundleCode: 'console.log("demo");',
        entryScenePath: 'scenes/main.pix3scene',
        sceneCount: 1,
        assetCount: 2,
        fileCount: 5,
        warnings: ['warning'],
        bundleWarnings: [],
        externalModuleIds: [],
      })),
    };
    const dialogService = {
      showConfirmation: vi.fn(async () => true),
    };
    const playableExportDialogService = {
      showDialog: vi.fn(async () => 'scenes/main.pix3scene'),
    };
    const loggingService = {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:demo');
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    Object.defineProperty(command, 'playableHtmlBuildService', {
      value: buildService,
      configurable: true,
    });
    Object.defineProperty(command, 'dialogService', {
      value: dialogService,
      configurable: true,
    });
    Object.defineProperty(command, 'playableExportDialogService', {
      value: playableExportDialogService,
      configurable: true,
    });
    Object.defineProperty(command, 'loggingService', {
      value: loggingService,
      configurable: true,
    });

    const context = createContext({
      project: { status: 'ready', projectName: 'Demo Project' },
      scenes: {
        descriptors: {
          scene1: { filePath: 'scenes/main.pix3scene' },
        },
        activeSceneId: 'scene1',
      },
    });

    await command.execute(context);

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:demo');
    expect(loggingService.warn).toHaveBeenCalledWith('[Playable Export] warning');
    expect(dialogService.showConfirmation).toHaveBeenCalledTimes(1);
  });

  it('treats save picker abort as a cancelled export', async () => {
    const command = new ExportPlayableHtmlCommand();
    const buildService = {
      buildPlayableHtml: vi.fn(async () => ({
        html: '<!doctype html><title>Demo</title>',
        runtimeBundleCode: 'console.log("demo");',
        entryScenePath: 'scenes/main.pix3scene',
        sceneCount: 1,
        assetCount: 2,
        fileCount: 5,
        warnings: [],
        bundleWarnings: [],
        externalModuleIds: [],
      })),
    };
    const dialogService = {
      showConfirmation: vi.fn(async () => true),
    };
    const playableExportDialogService = {
      showDialog: vi.fn(async () => 'scenes/main.pix3scene'),
    };
    const loggingService = {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };
    const abortError = new DOMException('Aborted', 'AbortError');
    const showSaveFilePicker = vi.fn(async () => {
      throw abortError;
    });

    Object.defineProperty(window, 'showSaveFilePicker', {
      value: showSaveFilePicker,
      configurable: true,
    });

    Object.defineProperty(command, 'playableHtmlBuildService', {
      value: buildService,
      configurable: true,
    });
    Object.defineProperty(command, 'dialogService', {
      value: dialogService,
      configurable: true,
    });
    Object.defineProperty(command, 'playableExportDialogService', {
      value: playableExportDialogService,
      configurable: true,
    });
    Object.defineProperty(command, 'loggingService', {
      value: loggingService,
      configurable: true,
    });

    const context = createContext({
      project: { status: 'ready', projectName: 'Demo Project' },
      scenes: {
        descriptors: {
          scene1: { filePath: 'scenes/main.pix3scene' },
        },
        activeSceneId: 'scene1',
      },
    });

    const result = await command.execute(context);

    expect(result.didMutate).toBe(false);
    expect(dialogService.showConfirmation).not.toHaveBeenCalled();
    expect(loggingService.info).toHaveBeenCalledWith(
      '[Playable Export] Export cancelled during file selection'
    );
  });

  it('cancels before build when the scene picker is dismissed', async () => {
    const command = new ExportPlayableHtmlCommand();
    const buildService = {
      buildPlayableHtml: vi.fn(),
    };
    const dialogService = {
      showConfirmation: vi.fn(async () => true),
    };
    const playableExportDialogService = {
      showDialog: vi.fn(async () => null),
    };
    const loggingService = {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };

    Object.defineProperty(command, 'playableHtmlBuildService', {
      value: buildService,
      configurable: true,
    });
    Object.defineProperty(command, 'dialogService', {
      value: dialogService,
      configurable: true,
    });
    Object.defineProperty(command, 'playableExportDialogService', {
      value: playableExportDialogService,
      configurable: true,
    });
    Object.defineProperty(command, 'loggingService', {
      value: loggingService,
      configurable: true,
    });

    const context = createContext({
      project: {
        status: 'ready',
        projectName: 'Demo Project',
        manifest: { defaultExportScenePath: 'scenes/default.pix3scene' },
      },
      scenes: {
        descriptors: {
          scene2: { filePath: 'scenes/default.pix3scene' },
          scene1: { filePath: 'scenes/main.pix3scene' },
        },
        activeSceneId: 'scene1',
      },
    });

    const result = await command.execute(context);

    expect(playableExportDialogService.showDialog).toHaveBeenCalledWith({
      scenePaths: ['scenes/default.pix3scene', 'scenes/main.pix3scene'],
      selectedScenePath: 'scenes/default.pix3scene',
    });
    expect(buildService.buildPlayableHtml).not.toHaveBeenCalled();
    expect(dialogService.showConfirmation).not.toHaveBeenCalled();
    expect(result.didMutate).toBe(false);
    expect(loggingService.info).toHaveBeenCalledWith(
      '[Playable Export] Export cancelled during scene selection'
    );
  });
});