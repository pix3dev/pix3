import { beforeEach, describe, expect, it } from 'vitest';
import { appState, resetAppState } from '@/state';
import {
  ProjectOwnershipService,
  projectLockName,
  type WebLockManagerLike,
} from './ProjectOwnershipService';

/** Minimal Web Locks: one holder per name, a FIFO queue, `ifAvailable`, abort signals. */
class FakeLocks implements WebLockManagerLike {
  private readonly held = new Set<string>();
  private readonly queues = new Map<string, Array<() => void>>();

  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void> | void
  ): Promise<unknown> {
    const run = async (): Promise<void> => {
      this.held.add(name);
      try {
        await callback({ name });
      } finally {
        this.held.delete(name);
        this.queues.get(name)?.shift()?.();
      }
    };
    if (!this.held.has(name)) return run();
    if (options.ifAvailable) return Promise.resolve(callback(null));
    return new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(name) ?? [];
      const start = () => void run().then(resolve, reject);
      queue.push(start);
      this.queues.set(name, queue);
      options.signal?.addEventListener('abort', () => {
        const at = queue.indexOf(start);
        if (at >= 0) queue.splice(at, 1);
        reject(new Error('aborted'));
      });
    });
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  resetAppState();
});

describe('ProjectOwnershipService', () => {
  it('local project: the first window owns it, a second waits and takes over when it closes', async () => {
    appState.project.status = 'ready';
    appState.project.id = 'p1';
    appState.project.backend = 'local';
    const locks = new FakeLocks();
    const first = new ProjectOwnershipService();
    first.setLockManager(locks);
    first.sync();
    await flush();
    expect(first.isOwner()).toBe(true);

    const second = new ProjectOwnershipService();
    second.setLockManager(locks);
    second.sync();
    await flush();
    expect(second.isOwner()).toBe(false);

    first.dispose(); // window closed: the lock is released
    await flush();
    expect(second.isOwner()).toBe(true);
    expect(projectLockName('p1')).toBe('pix3-project:p1');
    second.dispose();
  });

  it('reload whose new page asks before the unloading page let go of the lock: queues, owns it once released', async () => {
    appState.project.status = 'ready';
    appState.project.id = 'p1';
    appState.project.backend = 'local';
    const locks = new FakeLocks();
    const unloading = new ProjectOwnershipService();
    unloading.setLockManager(locks);
    unloading.sync();
    await flush();
    expect(unloading.isOwner()).toBe(true);

    // The reloaded page opens the project while the old document still holds the lock.
    const reloaded = new ProjectOwnershipService();
    reloaded.setLockManager(locks);
    reloaded.sync();
    await flush();
    // `ifAvailable` misses, but the request is queued (not a final view-only state)…
    expect(reloaded.isOwner()).toBe(false);
    expect(appState.project.coauthoring.takeOverPending).toBe(false);

    // …and the browser releasing the old document's lock hands it over with no take-over.
    unloading.dispose();
    await flush();
    expect(reloaded.isOwner()).toBe(true);
    expect(appState.project.coauthoring.isOwner).toBe(true);
    reloaded.dispose();
  });

  it('assumes ownership without the Web Locks API', () => {
    appState.project.status = 'ready';
    appState.project.id = 'p1';
    const service = new ProjectOwnershipService();
    service.setLockManager(null);
    service.sync();
    expect(service.isOwner()).toBe(true);
  });

  it('workspace project: owner iff this window holds the lease', () => {
    appState.project.status = 'ready';
    appState.project.id = 'w1';
    appState.project.backend = 'workspace';
    const service = new ProjectOwnershipService();
    service.setLockManager(new FakeLocks());
    appState.project.workspace.lease = 'busy';
    service.sync();
    expect(service.isOwner()).toBe(false);
    expect(appState.project.coauthoring.isOwner).toBe(false);
    appState.project.workspace.lease = 'held';
    service.sync();
    expect(service.isOwner()).toBe(true);
  });
});
