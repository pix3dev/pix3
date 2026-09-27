import { describe, expect, it, vi } from 'vitest';
import { CloudProjectCacheService } from '@/services/cloud/CloudProjectCacheService';

/**
 * Cached reads must announce a media type the browser can decode by. An SVG renders on Sprite2D
 * only when its Blob is `image/svg+xml`; `.svg` is cached as text, and used to come back as
 * `text/plain`, so a cloud project's SVG sprites drew nothing.
 */
type RecordShape = {
  storage: 'text' | 'idb-blob' | 'opfs';
  textContent?: string;
  blobContent?: Blob;
  opfsPath?: string | null;
  path: string;
};

const withRecord = (record: RecordShape, opfsBlob: Blob | null = null) => {
  const service = new CloudProjectCacheService();
  const internals = service as unknown as {
    getRecord: (projectId: string, path: string) => Promise<RecordShape | null>;
    readBlobFromOpfs: (projectId: string, path: string) => Promise<Blob | null>;
  };
  vi.spyOn(internals, 'getRecord').mockResolvedValue(record);
  vi.spyOn(internals, 'readBlobFromOpfs').mockResolvedValue(opfsBlob);
  return service;
};

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>';

describe('CloudProjectCacheService.readBlob media types', () => {
  it('returns a text-cached .svg as image/svg+xml', async () => {
    const service = withRecord({ storage: 'text', textContent: SVG, path: 'sprites/a.svg' });
    const blob = await service.readBlob('p1', 'res://sprites/a.svg');
    expect(blob?.type).toBe('image/svg+xml');
    expect(await blob?.text()).toBe(SVG);
  });

  it('keeps text/plain for ordinary text files', async () => {
    const service = withRecord({
      storage: 'text',
      textContent: 'a: 1',
      path: 'scenes/a.pix3scene',
    });
    const blob = await service.readBlob('p1', 'scenes/a.pix3scene');
    expect(blob?.type).toBe('text/plain');
  });

  it('re-types an untyped OPFS image by extension', async () => {
    const service = withRecord(
      { storage: 'opfs', path: 'sprites/a.png', opfsPath: 'sprites/a.png' },
      new Blob(['png'])
    );
    const blob = await service.readBlob('p1', 'sprites/a.png');
    expect(blob?.type).toBe('image/png');
    expect(await blob?.text()).toBe('png');
  });

  it('re-types an octet-stream audio blob by extension', async () => {
    const service = withRecord({
      storage: 'idb-blob',
      path: 'audio/hit.wav',
      blobContent: new Blob(['wav'], { type: 'application/octet-stream' }),
    });
    expect((await service.readBlob('p1', 'audio/hit.wav'))?.type).toBe('audio/wav');
  });

  it('leaves a specific stored type alone (WebP bytes under a .png key stay image/webp)', async () => {
    const service = withRecord({
      storage: 'idb-blob',
      path: 'sprites/a.png',
      blobContent: new Blob(['webp'], { type: 'image/webp' }),
    });
    expect((await service.readBlob('p1', 'sprites/a.png'))?.type).toBe('image/webp');
  });
});
