import { injectable } from '@/fw/di';
import { subscribe } from 'valtio/vanilla';
import { appState } from '@/state';

/** Structural subset of the Web Locks API this service uses (`navigator.locks`). */
export interface WebLockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal; steal?: boolean },
    callback: (lock: unknown) => Promise<void> | void
  ): Promise<unknown>;
}

/** Structural subset of `BroadcastChannel`. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type BroadcastChannelFactory = (name: string) => BroadcastChannelLike | null;

/** Web Lock name of a local project: one editing window per project per browser profile. */
export const projectLockName = (projectId: string): string => `pix3-project:${projectId}`;
/** The hand-over channel uses the same name as the lock. */
export const projectChannelName = projectLockName;

/** How long a take-over request waits for the owner to let go before it steals the lock. */
export const TAKE_OVER_TIMEOUT_MS = 3000;

type HandOverMessage =
  | { type: 'take-over-request'; from: string }
  | { type: 'released'; from: string }
  | { type: 'stolen'; from: string };

function isHandOverMessage(value: unknown): value is HandOverMessage {
  if (typeof value !== 'object' || value === null) return false;
  const { type, from } = value as { type?: unknown; from?: unknown };
  return (
    (type === 'take-over-request' || type === 'released' || type === 'stolen') &&
    typeof from === 'string'
  );
}

/**
 * Which window OWNS editing of the open project — the only one that autosaves and persists
 * `.pix3/protected.json` (plan §4.3 "Несколько окон", §5 C4):
 *
 * - `workspace` backend: the holder of the `pix3 serve` edit lease (`appState.project.workspace.lease
 *   === 'held'`);
 * - local folder / browser project: the holder of the Web Lock `pix3-project:<projectId>`, taken
 *   when the project opens and held until it closes. A second window of the same project waits in
 *   the lock queue (it becomes owner when the first one closes) and meanwhile does not autosave.
 *   Where `navigator.locks` does not exist, the window assumes it is the owner;
 * - cloud: always owner (cloud scenes sync through collaboration, autosave is off there anyway).
 *
 * **Hand-over** (local folders, §4.3 "Несколько окон"): a non-owner window's "Take over"
 * ({@link requestTakeOver}) posts `take-over-request` on the `BroadcastChannel`
 * `pix3-project:<id>`. The owner runs its release hooks (autosave flushes pending writes, the
 * protected set persists, dirty scenes are journaled), goes view-only, releases the lock (the
 * requester is first in the lock queue, so it becomes owner) and queues again itself. No answer
 * within {@link TAKE_OVER_TIMEOUT_MS} (hung or closed window) → the requester takes the lock with
 * `steal: true`, and whatever that window had not saved is only in its journal. A workspace uses
 * the server's lease instead (`WorkspaceSessionService.takeOverLease`).
 */
@injectable()
export class ProjectOwnershipService {
  private locks: WebLockManagerLike | null = resolveLocks();
  private heldProjectId: string | null = null;
  private releaseHeld: (() => void) | null = null;
  private abortWaiting: AbortController | null = null;
  private owner = true;
  private disposeSubscription: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private channel: BroadcastChannelLike | null = null;
  private channelFactory: BroadcastChannelFactory = defaultChannelFactory;
  private readonly releaseHooks = new Set<() => Promise<void> | void>();
  private readonly windowId = `w-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  private takeOverTimeoutMs = TAKE_OVER_TIMEOUT_MS;

  initialize(): void {
    if (this.disposeSubscription) {
      return;
    }
    this.disposeSubscription = subscribe(appState.project, () => this.sync());
    this.sync();
  }

  /** Tests: a fake lock manager (null = the API is unavailable). */
  setLockManager(locks: WebLockManagerLike | null): void {
    this.locks = locks;
  }

  /** Tests: a fake channel factory, and a shorter take-over timeout. */
  setChannelFactory(factory: BroadcastChannelFactory, takeOverTimeoutMs?: number): void {
    this.channelFactory = factory;
    if (takeOverTimeoutMs !== undefined) this.takeOverTimeoutMs = takeOverTimeoutMs;
  }

  /**
   * Work the owner does before it hands the project over (flush autosave, persist `P`, journal
   * what cannot be saved). Runs while this window is still the owner.
   */
  registerReleaseHook(hook: () => Promise<void> | void): () => void {
    this.releaseHooks.add(hook);
    return () => this.releaseHooks.delete(hook);
  }

  /**
   * This (non-owner) window asks for editing: the owner flushes and lets go; after
   * {@link TAKE_OVER_TIMEOUT_MS} without an answer the lock is stolen. Resolves true when this
   * window owns the project.
   */
  async requestTakeOver(): Promise<boolean> {
    const projectId = this.heldProjectId;
    if (this.owner || !projectId || !this.locks) {
      return this.owner;
    }
    this.setTakeOverPending(true);
    try {
      const becameOwner = new Promise<boolean>(resolve => {
        const timer = setTimeout(() => {
          dispose();
          resolve(false);
        }, this.takeOverTimeoutMs);
        const dispose = this.subscribe(() => {
          if (this.owner) {
            clearTimeout(timer);
            dispose();
            resolve(true);
          }
        });
      });
      this.post({ type: 'take-over-request', from: this.windowId });
      if (await becameOwner) {
        return true;
      }
      if (this.heldProjectId !== projectId || this.owner) {
        return this.owner;
      }
      this.steal(projectId);
      return this.owner;
    } finally {
      this.setTakeOverPending(false);
    }
  }

  isOwner(): boolean {
    return this.owner;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-evaluate ownership from `appState.project` (idempotent). */
  sync(): void {
    const project = appState.project;
    if (project.status !== 'ready' || !project.id) {
      this.releaseLock();
      this.setOwner(true);
      return;
    }
    if (project.backend === 'workspace') {
      this.releaseLock();
      this.setOwner(project.workspace.lease === 'held');
      return;
    }
    if (project.backend === 'cloud') {
      this.releaseLock();
      this.setOwner(true);
      return;
    }
    if (this.heldProjectId !== project.id) {
      this.acquireLock(project.id);
    }
  }

  dispose(): void {
    this.disposeSubscription?.();
    this.disposeSubscription = null;
    this.releaseLock();
    this.listeners.clear();
  }

  private acquireLock(projectId: string): void {
    this.releaseLock();
    this.heldProjectId = projectId;
    const locks = this.locks;
    if (!locks) {
      this.setOwner(true);
      return;
    }
    this.openChannel(projectId);
    void locks
      .request(projectLockName(projectId), { ifAvailable: true }, async lock => {
        if (this.heldProjectId !== projectId) {
          return;
        }
        if (lock) {
          await this.holdLock();
          return;
        }
        // Another window owns the project: wait in the queue, own it once that window lets go.
        this.queueForLock(projectId);
      })
      .catch(error => this.onLockLost(projectId, error));
  }

  /** Called inside a granted lock callback: owner until {@link releaseHeld} runs. */
  private holdLock(): Promise<void> {
    this.setOwner(true);
    return new Promise<void>(resolve => {
      this.releaseHeld = resolve;
    });
  }

  private queueForLock(projectId: string): void {
    const locks = this.locks;
    if (!locks) return;
    this.setOwner(false);
    this.abortWaiting?.abort();
    const abort = new AbortController();
    this.abortWaiting = abort;
    void locks
      .request(projectLockName(projectId), { signal: abort.signal }, async () => {
        if (this.heldProjectId !== projectId) {
          return;
        }
        if (this.abortWaiting === abort) this.abortWaiting = null;
        await this.holdLock();
      })
      .catch(error => {
        if (abort.signal.aborted) return; // we gave up waiting (steal / project closed)
        this.onLockLost(projectId, error);
      });
  }

  private steal(projectId: string): void {
    const locks = this.locks;
    if (!locks) return;
    this.abortWaiting?.abort();
    this.abortWaiting = null;
    void locks
      .request(projectLockName(projectId), { steal: true }, async () => {
        if (this.heldProjectId !== projectId) return;
        this.post({ type: 'stolen', from: this.windowId });
        await this.holdLock();
      })
      .catch(error => this.onLockLost(projectId, error));
  }

  /**
   * A lock request rejected: an `AbortError` means another window stole the lock we held — we are
   * a viewer now and queue again. Anything else: Web Locks is broken here; assume owner (v1).
   */
  private onLockLost(projectId: string, error: unknown): void {
    if (this.heldProjectId !== projectId) return;
    if (error instanceof Error && error.name === 'AbortError') {
      this.releaseHeld = null;
      this.queueForLock(projectId);
      return;
    }
    console.warn('[ProjectOwnershipService] Web Lock request failed; assuming owner', error);
    this.setOwner(true);
  }

  private openChannel(projectId: string): void {
    this.channel?.close();
    this.channel = this.channelFactory(projectChannelName(projectId));
    if (this.channel) {
      this.channel.onmessage = event => {
        if (isHandOverMessage(event.data) && event.data.from !== this.windowId) {
          void this.onHandOverMessage(projectId, event.data);
        }
      };
    }
  }

  private async onHandOverMessage(projectId: string, message: HandOverMessage): Promise<void> {
    if (this.heldProjectId !== projectId) return;
    if (message.type === 'take-over-request') {
      if (!this.owner || !this.releaseHeld) return;
      await this.runReleaseHooks();
      if (this.heldProjectId !== projectId || !this.releaseHeld) return;
      // View-only first, then let go: the requester is first in the lock queue.
      this.setOwner(false);
      const release = this.releaseHeld;
      this.releaseHeld = null;
      release();
      this.post({ type: 'released', from: this.windowId });
      this.queueForLock(projectId);
      return;
    }
    if (message.type === 'stolen' && this.releaseHeld) {
      // Our lock is gone (the request promise rejects with AbortError as well): viewer now.
      this.releaseHeld = null;
      this.queueForLock(projectId);
    }
  }

  private async runReleaseHooks(): Promise<void> {
    for (const hook of Array.from(this.releaseHooks)) {
      try {
        await hook();
      } catch (error) {
        console.warn('[ProjectOwnershipService] A release hook failed', error);
      }
    }
  }

  private post(message: HandOverMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch (error) {
      console.warn('[ProjectOwnershipService] Could not post on the hand-over channel', error);
    }
  }

  private setTakeOverPending(pending: boolean): void {
    if (appState.project.coauthoring.takeOverPending !== pending) {
      appState.project.coauthoring.takeOverPending = pending;
    }
  }

  private releaseLock(): void {
    this.heldProjectId = null;
    this.channel?.close();
    this.channel = null;
    this.abortWaiting?.abort();
    this.abortWaiting = null;
    const release = this.releaseHeld;
    this.releaseHeld = null;
    release?.();
  }

  private setOwner(owner: boolean): void {
    const changed = this.owner !== owner;
    this.owner = owner;
    if (appState.project.coauthoring.isOwner !== owner) {
      appState.project.coauthoring.isOwner = owner;
    }
    if (!changed) {
      return;
    }
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch (error) {
        console.error('[ProjectOwnershipService] Listener error', error);
      }
    }
  }
}

function defaultChannelFactory(name: string): BroadcastChannelLike | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(name) as unknown as BroadcastChannelLike;
  } catch {
    return null;
  }
}

function resolveLocks(): WebLockManagerLike | null {
  if (typeof navigator === 'undefined') {
    return null;
  }
  const locks = (navigator as Navigator & { locks?: WebLockManagerLike }).locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}
