import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetLoader } from './AssetLoader';
import type { ResourceManager } from './ResourceManager';

/**
 * A failed asset load must reject exactly once — into the caller's `await` — and nowhere else.
 *
 * The in-flight maps used to be cleared with `promise.finally(clear)`, which builds a *second*
 * promise that re-raises the rejection and which nothing held. So every failed load produced an
 * `unhandledrejection` alongside the error the caller already handled; `agent-introspection.ts` and
 * `player-main.ts` both listen for that event and surface it, so one missing texture reported
 * itself twice. It is also why `AssetLoader.atlas.spec.ts` carries a header explaining that it
 * deliberately avoids the loader-miss path.
 *
 * These tests fail if the leak comes back: the rejection listener is asserted on directly.
 */

function failingResources(error: Error): ResourceManager {
  return {
    readBlob: vi.fn(() => Promise.reject(error)),
    normalize: (path: string) => path,
    setAudioBuffer: vi.fn(),
  } as unknown as ResourceManager;
}

let unhandled: unknown[] = [];
let onUnhandled: (reason: unknown) => void;

beforeEach(() => {
  unhandled = [];
  onUnhandled = reason => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

/**
 * Lets Node decide a promise is unhandled. The check runs at the end of a macrotask turn, so a
 * microtask flush alone would report clean either way.
 */
async function settleUnhandledRejections(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

describe('AssetLoader in-flight tracking', () => {
  it('rejects a failed texture load only into the caller', async () => {
    const error = new Error('no such file');
    const loader = new AssetLoader(failingResources(error));

    await expect(loader.loadTexture('res://missing.png')).rejects.toThrow('no such file');
    await settleUnhandledRejections();

    expect(unhandled).toEqual([]);
  });

  it('rejects a failed audio load only into the caller', async () => {
    const error = new Error('no such audio');
    const loader = new AssetLoader(failingResources(error));

    await expect(loader.loadAudio('res://missing.mp3')).rejects.toBeTruthy();
    await settleUnhandledRejections();

    expect(unhandled).toEqual([]);
  });

  it('leaks nothing when several callers await the same failing load', async () => {
    // De-duplication hands every caller the same promise; each `await` must observe it once.
    const loader = new AssetLoader(failingResources(new Error('no such file')));

    const results = await Promise.allSettled([
      loader.loadTexture('res://missing.png'),
      loader.loadTexture('res://missing.png'),
      loader.loadTexture('res://missing.png'),
    ]);
    await settleUnhandledRejections();

    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(unhandled).toEqual([]);
  });

  it('clears the in-flight entry so a later attempt retries rather than replaying the failure', async () => {
    const error = new Error('transient');
    const resources = failingResources(error);
    const loader = new AssetLoader(resources);

    await expect(loader.loadTexture('res://flaky.png')).rejects.toThrow('transient');
    await expect(loader.loadTexture('res://flaky.png')).rejects.toThrow('transient');
    await settleUnhandledRejections();

    // Two real attempts, not one cached rejection served twice.
    expect(resources.readBlob).toHaveBeenCalledTimes(2);
    expect(unhandled).toEqual([]);
  });
});
