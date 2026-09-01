import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@/core/command';
import type {
  ProjectBuildService,
  RuntimeProjectBuildModel,
} from '@/services/export/ProjectBuildService';
import type { ProjectStorageService } from '@/services/project/ProjectStorageService';
import type { ScriptCompilerService } from '@/services/scripting/ScriptCompilerService';
import { PlayableHtmlBuildService } from '@/services/export/PlayableHtmlBuildService';
import { compressImageBlob } from '@/services/image-gen/image-ops';

vi.mock('@/services/image-gen/image-ops', () => ({
  compressImageBlob: vi.fn(),
}));

const compressMock = vi.mocked(compressImageBlob);

/**
 * Export-time PNG→WebP re-encode. The point of the option is bytes: a playable's art is base64'd
 * into the very file an ad network budgets, and `sprites/ph-bg.png` at 52.9 KiB re-encodes to
 * ~12–15 KiB. What is asserted here is the part that makes it safe to leave on — the original is
 * kept whenever the re-encode does not actually win — and the design choice that keeps it cheap:
 * the stored key keeps its `.png` name, because the runtime's embedded-asset map is an exact-string
 * lookup and the image decoder sniffs bytes rather than extensions.
 */
const createContext = (): CommandContext =>
  ({
    state: {
      project: { status: 'ready', projectName: 'Demo' },
      scenes: { activeSceneId: 'scene-1', descriptors: {} },
    } as unknown as CommandContext['state'],
    snapshot: {} as CommandContext['snapshot'],
    container: {} as CommandContext['container'],
    requestedAt: Date.now(),
  }) as CommandContext;

const PNG_BYTES = 'x'.repeat(400);

const buildService = () => {
  const model: RuntimeProjectBuildModel = {
    projectName: 'Demo',
    scenePaths: ['scenes/main.pix3scene'],
    entryScenePath: 'scenes/main.pix3scene',
    assetPaths: ['sprites/hero.png', 'audio/hit.wav', 'scenes/main.pix3scene'],
    reachability: new Map(),
    usesSpine: false,
    usesPostProcessing: false,
    usesNetwork: false,
    usesGltf: false,
    mentionedNames: new Set(['Sprite2D']),
    projectScriptFiles: new Map(),
    files: new Map([['src/main.ts', "console.log('boot');\n"]]),
    warnings: [],
  };

  const storage = {
    readBlob: vi.fn(async (path: string) => {
      if (path.endsWith('.png')) return new Blob([PNG_BYTES], { type: 'image/png' });
      if (path.endsWith('.wav')) return new Blob(['wav'], { type: 'audio/wav' });
      return new Blob(['scene: main'], { type: 'text/plain' });
    }),
    readTextFile: vi.fn(async () => null),
  } as unknown as Pick<ProjectStorageService, 'readBlob' | 'readTextFile'>;

  const scriptCompiler = {
    bundleVirtualProject: vi.fn(async () => ({ code: 'void 0;', warnings: [] })),
  } satisfies Pick<ScriptCompilerService, 'bundleVirtualProject'>;

  const service = new PlayableHtmlBuildService();
  Object.defineProperty(service, 'projectBuildService', {
    value: { buildRuntimeProjectModel: vi.fn(async () => model) } satisfies Pick<
      ProjectBuildService,
      'buildRuntimeProjectModel'
    >,
    configurable: true,
  });
  Object.defineProperty(service, 'storage', { value: storage, configurable: true });
  Object.defineProperty(service, 'scriptCompiler', { value: scriptCompiler, configurable: true });
  return { service, scriptCompiler };
};

describe('PlayableHtmlBuildService — export-time image compression', () => {
  beforeEach(() => {
    compressMock.mockReset();
  });

  it('does not touch images unless the option is set', async () => {
    const { service } = buildService();

    const artifact = await service.buildPlayableHtml(createContext(), {
      entryScenePath: 'scenes/main.pix3scene',
    });

    expect(compressMock).not.toHaveBeenCalled();
    expect(artifact.sizeReport.imagesRecompressed).toBe(0);
    expect(artifact.sizeReport.imageCompressionSavedBytes).toBe(0);
  });

  it('replaces an image when WebP wins, keeping the original path as the key', async () => {
    compressMock.mockResolvedValue({
      blob: new Blob(['tiny'], { type: 'image/webp' }),
      width: 8,
      height: 8,
    });
    const { service, scriptCompiler } = buildService();

    const artifact = await service.buildPlayableHtml(createContext(), {
      entryScenePath: 'scenes/main.pix3scene',
      compressImages: true,
    });

    expect(artifact.sizeReport.imagesRecompressed).toBe(1);
    expect(artifact.sizeReport.imageCompressionSavedBytes).toBe(PNG_BYTES.length - 4);

    const [files] = scriptCompiler.bundleVirtualProject.mock.calls[0] as unknown as [
      Map<string, string>,
    ];
    const embedded = files.get('virtual/generated/runtime-embedded-assets.ts') ?? '';
    // The key keeps its .png name; only the bytes and the announced mime type changed.
    expect(embedded).toContain('sprites/hero.png');
    expect(embedded).not.toContain('sprites/hero.webp');
    expect(embedded).toContain('image/webp');
  });

  it('keeps the original when the re-encode comes out bigger', async () => {
    // Common for small flat images. An unconditional swap would grow the export AND degrade it.
    compressMock.mockResolvedValue({
      blob: new Blob(['y'.repeat(900)], { type: 'image/webp' }),
      width: 8,
      height: 8,
    });
    const { service, scriptCompiler } = buildService();

    const artifact = await service.buildPlayableHtml(createContext(), {
      entryScenePath: 'scenes/main.pix3scene',
      compressImages: true,
    });

    expect(artifact.sizeReport.imagesRecompressed).toBe(0);
    expect(artifact.sizeReport.imageCompressionSavedBytes).toBe(0);
    const [files] = scriptCompiler.bundleVirtualProject.mock.calls[0] as unknown as [
      Map<string, string>,
    ];
    expect(files.get('virtual/generated/runtime-embedded-assets.ts') ?? '').toContain('image/png');
  });

  it('offers only images to the encoder — audio and scenes are skipped', async () => {
    compressMock.mockResolvedValue({
      blob: new Blob(['tiny'], { type: 'image/webp' }),
      width: 8,
      height: 8,
    });
    const { service } = buildService();

    await service.buildPlayableHtml(createContext(), {
      entryScenePath: 'scenes/main.pix3scene',
      compressImages: true,
    });

    expect(compressMock).toHaveBeenCalledTimes(1);
    const [blob] = compressMock.mock.calls[0];
    expect(blob.type).toBe('image/png');
  });

  it('ships the source bytes when the encoder throws — a failed encode is not a failed export', async () => {
    compressMock.mockRejectedValue(new Error('no canvas here'));
    const { service } = buildService();

    const artifact = await service.buildPlayableHtml(createContext(), {
      entryScenePath: 'scenes/main.pix3scene',
      compressImages: true,
    });

    expect(artifact.sizeReport.imagesRecompressed).toBe(0);
    expect(artifact.warnings).not.toContain(
      'Failed to embed asset for playable export: sprites/hero.png'
    );
  });
});
