import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appState, resetAppState } from '@/state';
import { CommandDispatcher, isBlockedForNonOwner } from '@/services/core/CommandDispatcher';
import type { Command } from '@/core/command';
import {
  ProjectOwnershipService,
  type BroadcastChannelLike,
  type WebLockManagerLike,
} from './ProjectOwnershipService';
import { wire } from './memory-storage.spec-helper';

/** Web Locks with a FIFO queue, `ifAvailable`, abort signals and `steal`. */
class FakeLocks implements WebLockManagerLike {
  private holder: { name: string; reject: (error: Error) => void } | null = null;
  private readonly queue: Array<() => void> = [];

  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal; steal?: boolean },
    callback: (lock: unknown) => Promise<void> | void
  ): Promise<unknown> {
    return new Promise<void>((resolve, reject) => {
      const run = () => {
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          if (this.holder?.reject === onSteal) this.holder = null;
          this.queue.shift()?.();
        };
        const onSteal = (error: Error) => {
          released = true; // the stealer holds it now
          reject(error);
        };
        this.holder = { name, reject: onSteal };
        Promise.resolve(callback({ name })).then(
          () => {
            release();
            resolve();
          },
          error => {
            release();
            reject(error);
          }
        );
      };
      if (options.steal) {
        const previous = this.holder;
        this.holder = null;
        const error = new Error('stolen');
        error.name = 'AbortError';
        previous?.reject(error);
        run();
        return;
      }
      if (!this.holder) {
        run();
        return;
      }
      if (options.ifAvailable) {
        Promise.resolve(callback(null)).then(() => resolve(), reject);
        return;
      }
      const start = () => run();
      this.queue.push(start);
      options.signal?.addEventListener('abort', () => {
        const at = this.queue.indexOf(start);
        if (at >= 0) this.queue.splice(at, 1);
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  }
}

/** One in-process BroadcastChannel bus; `deaf` channels never deliver (a hung window). */
class ChannelBus {
  private readonly channels = new Set<BroadcastChannelLike & { deaf: boolean }>();
  factory(deaf = false) {
    return (): BroadcastChannelLike => {
      const channel: BroadcastChannelLike & { deaf: boolean } = {
        deaf,
        onmessage: null,
        postMessage: message => {
          for (const other of this.channels) {
            if (other !== channel && !other.deaf) {
              queueMicrotask(() => other.onmessage?.({ data: message }));
            }
          }
        },
        close: () => {
          this.channels.delete(channel);
        },
      };
      this.channels.add(channel);
      return channel;
    };
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

function openProject(): void {
  appState.project.status = 'ready';
  appState.project.id = 'p1';
  appState.project.backend = 'local';
}

beforeEach(() => {
  resetAppState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProjectOwnershipService — take-over hand-off (BroadcastChannel)', () => {
  it('the owner flushes, goes view-only and releases; the requester becomes the owner', async () => {
    openProject();
    const locks = new FakeLocks();
    const bus = new ChannelBus();
    const owner = new ProjectOwnershipService();
    owner.setLockManager(locks);
    owner.setChannelFactory(bus.factory(), 200);
    const flushed: string[] = [];
    owner.registerReleaseHook(async () => {
      expect(owner.isOwner()).toBe(true); // hooks run while still the owner
      flushed.push('autosave');
    });
    owner.sync();
    await flush();

    const viewer = new ProjectOwnershipService();
    viewer.setLockManager(locks);
    viewer.setChannelFactory(bus.factory(), 200);
    viewer.sync();
    await flush();
    expect(owner.isOwner()).toBe(true);
    expect(viewer.isOwner()).toBe(false);

    expect(await viewer.requestTakeOver()).toBe(true);
    await flush();
    expect(flushed).toEqual(['autosave']);
    expect(viewer.isOwner()).toBe(true);
    expect(owner.isOwner()).toBe(false);

    // The old owner queued again: it gets the project back when the new owner closes.
    viewer.dispose();
    await flush();
    expect(owner.isOwner()).toBe(true);
    owner.dispose();
  });

  it('no answer within the timeout (hung window): the requester steals the lock', async () => {
    openProject();
    const locks = new FakeLocks();
    const bus = new ChannelBus();
    const hung = new ProjectOwnershipService();
    hung.setLockManager(locks);
    hung.setChannelFactory(bus.factory(true), 30);
    const hook = vi.fn();
    hung.registerReleaseHook(hook);
    hung.sync();
    await flush();

    const viewer = new ProjectOwnershipService();
    viewer.setLockManager(locks);
    viewer.setChannelFactory(bus.factory(), 30);
    viewer.sync();
    await flush();
    expect(viewer.isOwner()).toBe(false);

    expect(await viewer.requestTakeOver()).toBe(true);
    await flush();
    expect(viewer.isOwner()).toBe(true);
    expect(hook).not.toHaveBeenCalled();
    // The stolen-from window learns it through the rejected lock request: view-only.
    expect(hung.isOwner()).toBe(false);
    viewer.dispose();
    hung.dispose();
  });
});

describe('CommandDispatcher — a non-owner window is view-only', () => {
  const command = (id: string): Command<void, void> => ({
    metadata: { id, title: id },
    execute: vi.fn(async () => ({ didMutate: true, payload: undefined })),
  });

  it('refuses scene-mutating commands (and undo) with a notice; navigation stays', async () => {
    openProject();
    appState.project.coauthoring.isOwner = false;
    const dispatcher = wire(new CommandDispatcher(), { commandRegistry: {} });

    const edit = command('scene.update-object-property');
    expect(await dispatcher.execute(edit)).toBe(false);
    expect(edit.execute).not.toHaveBeenCalled();
    expect(appState.project.coauthoring.editBlockedAt).not.toBeNull();
    expect(isBlockedForNonOwner('history.undo')).toBe(true);
    expect(isBlockedForNonOwner('scene.accept-agent-version')).toBe(true);
    expect(isBlockedForNonOwner('editor.save-active-resource')).toBe(true);

    const select = command('scene.select-object');
    expect(await dispatcher.execute(select)).toBe(true);
    expect(isBlockedForNonOwner('scene.reload')).toBe(false);
    expect(isBlockedForNonOwner('viewport.frame-selected')).toBe(false);

    appState.project.coauthoring.isOwner = true;
    expect(await dispatcher.execute(command('scene.update-object-property'))).toBe(true);
  });

  it('never blocks cloud projects (collaboration has its own read-only mode)', () => {
    openProject();
    appState.project.backend = 'cloud';
    appState.project.coauthoring.isOwner = false;
    expect(isBlockedForNonOwner('scene.update-object-property')).toBe(false);
  });
});
