import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileWatchService } from '@/services/project/FileWatchService';

describe('FileWatchService background polling', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not start polling while the page is hidden', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const setIntervalSpy = vi.spyOn(window, 'setInterval');

    const service = new FileWatchService();
    const fileHandle = {
      getFile: vi.fn(),
    } as unknown as FileSystemFileHandle;

    service.watch('res://scene.pix3scene', fileHandle, 10, vi.fn());

    expect(setIntervalSpy).not.toHaveBeenCalled();

    service.dispose();
  });

  it('resumes polling and performs an immediate check when focus returns', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const getFile = vi.fn().mockResolvedValue({ lastModified: 10 });

    const service = new FileWatchService();
    const fileHandle = {
      getFile,
    } as unknown as FileSystemFileHandle;

    service.watch('res://scene.pix3scene', fileHandle, 10, vi.fn());
    expect(setIntervalSpy).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    hasFocusSpy.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(getFile).toHaveBeenCalledTimes(1);

    service.dispose();
  });
});
