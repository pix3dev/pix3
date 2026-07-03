import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileSystemAPIError, FileSystemAPIService } from './FileSystemAPIService';

describe('FileSystemAPIService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats VS Code integrated browser picker aborts as unsupported', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.121.0 Chrome/142.0.7444.265 Electron/39.8.8 Safari/537.36'
    );

    const service = new FileSystemAPIService({
      directoryPicker: vi
        .fn<() => Promise<FileSystemDirectoryHandle>>()
        .mockRejectedValue(
          new DOMException(
            "Failed to execute 'showDirectoryPicker' on 'Window': The user aborted a request.",
            'AbortError'
          )
        ),
    });

    await expect(service.requestProjectDirectory('readwrite')).rejects.toBeInstanceOf(
      FileSystemAPIError
    );
    await expect(service.requestProjectDirectory('readwrite')).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(service.requestProjectDirectory('readwrite')).rejects.toThrow(
      /VS Code integrated browser/
    );
  });
});
