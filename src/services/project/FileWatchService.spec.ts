import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileWatchService } from '@/services/project/FileWatchService';
import { appState } from '@/state';

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

describe('FileWatchService co-authoring poll rule', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    appState.ui.isPlaying = false;
  });

  it('polls a visible window that does not have focus (an editor beside the agent terminal)', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    let lastModified = 10;
    const getFile = vi.fn(async () => ({ lastModified }));
    const onChange = vi.fn();

    const service = new FileWatchService();
    service.watch(
      'res://scene.pix3scene',
      { getFile } as unknown as FileSystemFileHandle,
      10,
      onChange
    );

    lastModified = 20; // the agent wrote the file
    await vi.advanceTimersByTimeAsync(1100);
    expect(getFile).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('blur'));
    lastModified = 30;
    await vi.advanceTimersByTimeAsync(1100);
    expect(onChange).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('keeps detecting changes during play (ExternalChangeService turns them into "stale")', async () => {
    vi.useFakeTimers();
    appState.ui.isPlaying = true;
    let lastModified = 10;
    const onChange = vi.fn();
    const service = new FileWatchService();
    service.watch(
      'res://scene.pix3scene',
      { getFile: async () => ({ lastModified }) } as unknown as FileSystemFileHandle,
      10,
      onChange
    );
    lastModified = 11;
    await vi.advanceTimersByTimeAsync(1100);
    expect(onChange).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('checkAllNow polls every watched file immediately', async () => {
    const getFile = vi.fn(async () => ({ lastModified: 99 }));
    const onChange = vi.fn();
    const service = new FileWatchService();
    service.watch(
      'res://scene.pix3scene',
      { getFile } as unknown as FileSystemFileHandle,
      10,
      onChange
    );
    await service.checkAllNow();
    expect(onChange).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('never reports .pix3/ bookkeeping pushed by a workspace', () => {
    const service = new FileWatchService();
    service.setPushMode(true);
    const listener = vi.fn();
    service.watch('.pix3/protected.json', null, null, listener);
    expect(service.notifyExternalChange('.pix3/protected.json', { sha256: 'x' })).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    service.dispose();
  });
});

describe('FileWatchService push mode (workspace)', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a handle-less watch unless push mode is on', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new FileWatchService();
    const onChange = vi.fn();

    service.watch('res://scenes/main.pix3scene', null, null, onChange);
    expect(service.isWatching('scenes/main.pix3scene')).toBe(false);

    service.setPushMode(true);
    service.watch('res://scenes/main.pix3scene', null, null, onChange);
    expect(service.isWatching('scenes/main.pix3scene')).toBe(true);

    service.dispose();
  });

  it('delivers a pushed change to listeners of any spelling of the path, without polling', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const service = new FileWatchService();
    service.setPushMode(true);
    const sceneListener = vi.fn();
    const scriptListener = vi.fn();
    service.watch('res://scenes/main.pix3scene', null, null, sceneListener);
    service.watch('scripts/Player.ts', null, undefined, scriptListener);

    expect(service.notifyExternalChange('scenes/main.pix3scene', { sha256: 'a' })).toBe(true);
    expect(sceneListener).toHaveBeenCalledTimes(1);
    expect(scriptListener).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    service.dispose();
  });

  it('ignores a change carrying the hash already known for the path', () => {
    const service = new FileWatchService();
    service.setPushMode(true);
    const listener = vi.fn();
    service.watch('res://scenes/main.pix3scene', null, null, listener);

    service.setLastKnownHash('res://scenes/main.pix3scene', 'mine');
    expect(service.notifyExternalChange('scenes/main.pix3scene', { sha256: 'mine' })).toBe(false);
    expect(service.notifyExternalChange('scenes/main.pix3scene', { sha256: 'theirs' })).toBe(true);
    expect(service.notifyExternalChange('scenes/main.pix3scene', { sha256: 'theirs' })).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it('stops notifying after unwatch', () => {
    const service = new FileWatchService();
    service.setPushMode(true);
    const listener = vi.fn();
    service.watch('res://a.pix3scene', null, null, listener);

    service.unwatch('res://a.pix3scene', listener);
    service.notifyExternalChange('a.pix3scene', { sha256: 'x' });

    expect(listener).not.toHaveBeenCalled();
    service.dispose();
  });
});
