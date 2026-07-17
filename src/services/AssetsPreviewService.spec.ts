import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import type { AssetsPreviewSnapshot } from './AssetsPreviewService';

const mockProjectService = {
  listDirectory: vi.fn(),
};

const mockProjectStorageService = {
  readBlob: vi.fn(),
};

const mockThumbnailCacheService = {
  get: vi.fn(),
  set: vi.fn(),
};

const mockThumbnailGenerator = {
  generate: vi.fn(),
};

const mockSceneThumbnailGenerator = {
  generate: vi.fn(),
};

const mockDecodeAudioData = vi.fn();

class MockAudioContext {
  decodeAudioData = mockDecodeAudioData;
}

vi.mock('./ProjectService', () => ({
  ProjectService: class ProjectService {},
  resolveProjectService: () => mockProjectService,
}));

vi.mock('./ProjectStorageService', () => ({
  ProjectStorageService: class ProjectStorageService {},
  resolveProjectStorageService: () => mockProjectStorageService,
}));

vi.mock('./ThumbnailCacheService', () => ({
  ThumbnailCacheService: class ThumbnailCacheService {},
  resolveThumbnailCacheService: () => mockThumbnailCacheService,
}));

vi.mock('./ThumbnailGenerator', () => ({
  ThumbnailGenerator: class ThumbnailGenerator {},
  resolveThumbnailGenerator: () => mockThumbnailGenerator,
}));

vi.mock('./SceneThumbnailGenerator', () => ({
  SceneThumbnailGenerator: class SceneThumbnailGenerator {},
  resolveSceneThumbnailGenerator: () => mockSceneThumbnailGenerator,
}));

const { AssetsPreviewService } = await import('./AssetsPreviewService');

describe('AssetsPreviewService', () => {
  beforeEach(() => {
    resetAppState();
    appState.project.status = 'ready';

    mockProjectService.listDirectory.mockReset();
    mockProjectStorageService.readBlob.mockReset();
    mockThumbnailCacheService.get.mockReset();
    mockThumbnailCacheService.set.mockReset();
    mockThumbnailGenerator.generate.mockReset();
    mockSceneThumbnailGenerator.generate.mockReset();
    mockDecodeAudioData.mockReset();

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('AudioContext', MockAudioContext as unknown as typeof AudioContext);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:audio-preview'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAppState();
  });

  it('hydrates cached model thumbnails without invoking the generator', async () => {
    mockProjectService.listDirectory.mockResolvedValue([
      { name: 'crate.glb', path: 'models/crate.glb', kind: 'file' },
    ]);
    mockProjectStorageService.readBlob.mockResolvedValue(
      createFile('crate.glb', 'cached-model', 'model/gltf-binary', 42)
    );
    mockThumbnailCacheService.get.mockResolvedValue('data:image/webp;base64,cached');

    const service = new AssetsPreviewService();
    try {
      await vi.waitFor(() => expect(service.getSnapshot().items).toHaveLength(1));

      const [item] = service.getSnapshot().items;
      expect(item.previewType).toBe('model');
      expect(item.thumbnailStatus).toBe('ready');
      expect(item.thumbnailUrl).toBe('data:image/webp;base64,cached');
      expect(mockThumbnailGenerator.generate).not.toHaveBeenCalled();
    } finally {
      service.dispose();
    }
  });

  it('generates and caches missing model thumbnails in the background', async () => {
    mockProjectService.listDirectory.mockResolvedValue([
      { name: 'crate.glb', path: 'models/crate.glb', kind: 'file' },
    ]);

    const file = createFile('crate.glb', 'uncached-model', 'model/gltf-binary', 77);
    mockProjectStorageService.readBlob.mockResolvedValue(file);
    mockThumbnailCacheService.get.mockResolvedValue(null);
    mockThumbnailGenerator.generate.mockResolvedValue('data:image/webp;base64,generated');

    const service = new AssetsPreviewService();
    const snapshots: AssetsPreviewSnapshot[] = [];
    const unsubscribe = service.subscribe(snapshot => {
      snapshots.push(snapshot);
    });

    try {
      await vi.waitFor(() => {
        const currentItem = service.getSnapshot().items[0];
        expect(currentItem?.thumbnailStatus).toBe('ready');
      });

      const [item] = service.getSnapshot().items;
      expect(item.thumbnailUrl).toBe('data:image/webp;base64,generated');
      expect(mockThumbnailGenerator.generate).toHaveBeenCalledWith(file, 'models/crate.glb');
      expect(mockThumbnailCacheService.set).toHaveBeenCalledWith(
        expect.stringContaining('models/crate.glb'),
        'data:image/webp;base64,generated'
      );
      expect(snapshots.some(snapshot => snapshot.items[0]?.thumbnailStatus === 'loading')).toBe(
        true
      );
    } finally {
      unsubscribe();
      service.dispose();
    }
  });

  it('generates and caches missing scene thumbnails via the scene generator', async () => {
    mockProjectService.listDirectory.mockResolvedValue([
      { name: 'main.pix3scene', path: 'scenes/main.pix3scene', kind: 'file' },
    ]);

    const file = createFile('main.pix3scene', 'version: "1"\nroot: []', 'text/yaml', 512);
    mockProjectStorageService.readBlob.mockResolvedValue(file);
    mockThumbnailCacheService.get.mockResolvedValue(null);
    mockSceneThumbnailGenerator.generate.mockResolvedValue('data:image/webp;base64,scene');

    const service = new AssetsPreviewService();
    try {
      await vi.waitFor(() => {
        const currentItem = service.getSnapshot().items[0];
        expect(currentItem?.thumbnailStatus).toBe('ready');
      });

      const [item] = service.getSnapshot().items;
      expect(item.previewType).toBe('scene');
      expect(item.thumbnailUrl).toBe('data:image/webp;base64,scene');
      expect(mockSceneThumbnailGenerator.generate).toHaveBeenCalledWith(
        file,
        'scenes/main.pix3scene'
      );
      expect(mockThumbnailGenerator.generate).not.toHaveBeenCalled();
      expect(mockThumbnailCacheService.set).toHaveBeenCalledWith(
        expect.stringContaining('scenes/main.pix3scene'),
        'data:image/webp;base64,scene'
      );
    } finally {
      service.dispose();
    }
  });

  it('builds waveform previews and metadata for audio assets', async () => {
    mockProjectService.listDirectory.mockResolvedValue([
      { name: 'click.wav', path: 'audio/click.wav', kind: 'file' },
    ]);
    mockProjectStorageService.readBlob.mockResolvedValue(
      createFile('click.wav', 'audio-data', 'audio/wav', 88)
    );
    mockDecodeAudioData.mockResolvedValue(createAudioBufferMock());

    const service = new AssetsPreviewService();
    try {
      await vi.waitFor(() => expect(service.getSnapshot().items).toHaveLength(1));

      const [item] = service.getSnapshot().items;
      expect(item.previewType).toBe('audio');
      expect(item.thumbnailStatus).toBe('ready');
      expect(item.thumbnailUrl).toContain('data:image/svg+xml');
      expect(item.previewUrl).toBe('blob:audio-preview');
      expect(item.durationSeconds).toBe(1.75);
      expect(item.channelCount).toBe(2);
      expect(item.sampleRate).toBe(44100);
      expect(mockDecodeAudioData).toHaveBeenCalledOnce();
    } finally {
      service.dispose();
    }
  });

  it('selects files in the current folder without reloading the preview folder', async () => {
    mockProjectService.listDirectory.mockResolvedValue([
      { name: 'config.json', path: 'config.json', kind: 'file' },
      { name: 'notes.md', path: 'notes.md', kind: 'file' },
    ]);
    mockProjectStorageService.readBlob.mockImplementation(async (path: string) => {
      if (path === 'config.json') {
        return createFile('config.json', '{"name":"pix3"}', 'application/json', 11);
      }
      return createFile('notes.md', '# Notes', 'text/markdown', 12);
    });

    const service = new AssetsPreviewService();
    try {
      await vi.waitFor(() => expect(service.getSnapshot().items).toHaveLength(2));
      expect(mockProjectService.listDirectory).toHaveBeenCalledTimes(1);

      await service.syncFromAssetSelection('notes.md', 'file');

      expect(mockProjectService.listDirectory).toHaveBeenCalledTimes(1);
      expect(service.getSnapshot().selectedItemPath).toBe('notes.md');
      expect(service.getSnapshot().selectedItem?.path).toBe('notes.md');
    } finally {
      service.dispose();
    }
  });

  it('builds text previews for code and content files', async () => {
    mockProjectService.listDirectory.mockResolvedValue([
      { name: 'scene.yaml', path: 'configs/scene.yaml', kind: 'file' },
    ]);
    mockProjectStorageService.readBlob.mockResolvedValue(
      createFile(
        'scene.yaml',
        'name: Example\ncomponents:\n  - camera\n  - light\n  - mesh',
        'application/yaml',
        90
      )
    );

    const service = new AssetsPreviewService();
    try {
      await vi.waitFor(() => expect(service.getSnapshot().items).toHaveLength(1));

      const [item] = service.getSnapshot().items;
      expect(item.previewType).toBe('text');
      expect(item.previewText).toContain('name: Example');
      expect(item.previewText).toContain('components:');
      expect(item.thumbnailStatus).toBe('ready');
    } finally {
      service.dispose();
    }
  });

  it('shows a code icon instead of a code preview for script files', async () => {
    mockProjectService.listDirectory.mockResolvedValue([
      { name: 'GameManager.ts', path: 'scripts/GameManager.ts', kind: 'file' },
    ]);
    mockProjectStorageService.readBlob.mockResolvedValue(
      createFile('GameManager.ts', 'export class GameManager {}', 'text/plain', 27)
    );

    const service = new AssetsPreviewService();
    try {
      await vi.waitFor(() => expect(service.getSnapshot().items).toHaveLength(1));

      const [item] = service.getSnapshot().items;
      expect(item.previewType).toBe('icon');
      expect(item.iconName).toBe('code');
      expect(item.previewText).toBeNull();
    } finally {
      service.dispose();
    }
  });
});

function createFile(name: string, content: string, type: string, lastModified: number): File {
  return new File([content], name, { type, lastModified });
}

function createAudioBufferMock(): AudioBuffer {
  const channelA = new Float32Array([0, 0.2, -0.4, 0.8, -0.6, 0.1]);
  const channelB = new Float32Array([0.1, -0.3, 0.5, -0.7, 0.4, -0.2]);

  return {
    duration: 1.75,
    numberOfChannels: 2,
    sampleRate: 44100,
    getChannelData(index: number) {
      return index === 0 ? channelA : channelB;
    },
  } as unknown as AudioBuffer;
}
