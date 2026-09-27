import {
  isDocumentHidden,
  isEditorKeepAlive,
  onEditorKeepAliveChange,
} from '@/services/core/page-activity';

/**
 * Timers that keep firing in a hidden tab while an agent keeps the editor alive.
 *
 * A hidden tab gets no `requestAnimationFrame` at all, and its timers are throttled — to one
 * wake-up per second, and after a few minutes (Chrome's intensive throttling) to one per minute.
 * Timers inside a dedicated Web Worker are not throttled that way. So while keepalive is on
 * ({@link isEditorKeepAlive}) the loops and timers here run off a tiny inline worker (Blob URL)
 * that `postMessage`s back at the requested delay; otherwise they are plain rAF / `setTimeout`,
 * exactly as before — an idle background editor still pauses and sleeps.
 *
 * - {@link BackgroundTicker}: a `requestAnimationFrame` replacement for a frame loop (the play
 *   loop, the viewport loop). rAF while the tab is visible; worker ticks at `intervalMs` while it
 *   is hidden and keepalive is on. A pending frame moves between the two when visibility or
 *   keepalive changes, so a loop never stalls on a rAF that will not come. The callback gets a
 *   `performance.now()`-style timestamp either way, so `dt` means the same thing.
 * - {@link keepaliveTimer} / {@link keepaliveInterval}: `setTimeout` / `setInterval` that use the
 *   worker while keepalive is on (reconnect backoff, pings, autosave debounce, file polling).
 */

/** What the worker understands and answers. */
export type TickWorkerCommand =
  | { readonly op: 'set'; readonly id: number; readonly ms: number }
  | { readonly op: 'clear'; readonly id: number };

/** The part of `Worker` used here — a fake in tests. */
export interface TickWorkerLike {
  onmessage: ((event: MessageEvent<{ id: number }>) => void) | null;
  postMessage(message: TickWorkerCommand): void;
  terminate(): void;
}

export type TickWorkerFactory = () => TickWorkerLike | null;

const WORKER_SOURCE = `const timers = new Map();
self.onmessage = event => {
  const message = event.data;
  if (!message) return;
  if (message.op === 'set') {
    clearTimeout(timers.get(message.id));
    timers.set(message.id, setTimeout(() => {
      timers.delete(message.id);
      self.postMessage({ id: message.id });
    }, Math.max(0, message.ms)));
  } else if (message.op === 'clear') {
    clearTimeout(timers.get(message.id));
    timers.delete(message.id);
  }
};`;

const createInlineWorker: TickWorkerFactory = () => {
  if (
    typeof Worker === 'undefined' ||
    typeof Blob === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return null;
  }
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    return new Worker(url) as unknown as TickWorkerLike;
  } catch (error) {
    // CSP without `worker-src blob:`, or no worker support: fall back to main-thread timers.
    console.warn('[background-ticker] No worker timers; background ticks stay throttled', error);
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
};

/** One worker for the whole page, created on first use. */
class WorkerClock {
  private worker: TickWorkerLike | null | undefined;
  private readonly callbacks = new Map<number, () => void>();
  private nextId = 1;
  private readonly factory: TickWorkerFactory;

  constructor(factory: TickWorkerFactory) {
    this.factory = factory;
  }

  /** Arm a one-shot worker timer; null when no worker is available. */
  set(callback: () => void, ms: number): number | null {
    const worker = this.ensure();
    if (!worker) return null;
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    worker.postMessage({ op: 'set', id, ms });
    return id;
  }

  clear(id: number): void {
    if (!this.callbacks.delete(id)) return;
    this.worker?.postMessage({ op: 'clear', id });
  }

  terminate(): void {
    this.callbacks.clear();
    this.worker?.terminate();
    this.worker = undefined;
  }

  private ensure(): TickWorkerLike | null {
    if (this.worker !== undefined) return this.worker;
    const worker = this.factory();
    this.worker = worker;
    if (worker) {
      worker.onmessage = event => {
        const id = event.data?.id;
        if (typeof id !== 'number') return;
        const callback = this.callbacks.get(id);
        if (!callback) return;
        this.callbacks.delete(id);
        try {
          callback();
        } catch (error) {
          console.error('[background-ticker] timer callback failed', error);
        }
      };
    }
    return worker;
  }
}

let clock = new WorkerClock(createInlineWorker);

/** Tests: swap the worker (a fake), or `null` to restore the inline one. Drops pending timers. */
export const setTickWorkerFactory = (factory: TickWorkerFactory | null): void => {
  clock.terminate();
  clock = new WorkerClock(factory ?? createInlineWorker);
};

/**
 * `setTimeout` that is not throttled in a hidden tab while keepalive is on. Returns the cancel
 * function.
 *
 * The clock follows keepalive while the timer is pending: a timer armed on the main thread while
 * keepalive was off moves to the worker (with the time it has left) when keepalive turns on, and
 * back when it turns off. Deciding only when the timer is armed left a delay armed in a gap of
 * keepalive — say a 15 s reconnect — on a throttled main-thread timer that Chrome's intensive
 * throttling stretches to a minute, even after keepalive was back.
 */
export const keepaliveTimer = (callback: () => void, ms: number): (() => void) => {
  const deadline = now() + ms;
  let settled = false;
  let onWorker = false;
  let cancelInner: () => void = () => undefined;
  const fire = (): void => {
    if (settled) return;
    settled = true;
    unsubscribe();
    callback();
  };
  const arm = (delay: number): void => {
    if (isEditorKeepAlive()) {
      const id = clock.set(fire, delay);
      if (id !== null) {
        onWorker = true;
        cancelInner = () => clock.clear(id);
        return;
      }
    }
    onWorker = false;
    const handle = setTimeout(fire, delay);
    cancelInner = () => clearTimeout(handle);
  };
  const unsubscribe = onEditorKeepAliveChange(() => {
    if (settled || isEditorKeepAlive() === onWorker) return;
    cancelInner();
    arm(Math.max(0, deadline - now()));
  });
  arm(ms);
  return () => {
    if (settled) return;
    settled = true;
    unsubscribe();
    cancelInner();
  };
};

/** `setInterval` built on {@link keepaliveTimer}: each period re-decides worker vs. timer. */
export const keepaliveInterval = (callback: () => void, ms: number): (() => void) => {
  let cancel: (() => void) | null = null;
  let stopped = false;
  const arm = (): void => {
    cancel = keepaliveTimer(() => {
      if (stopped) return;
      arm();
      callback();
    }, ms);
  };
  arm();
  return () => {
    stopped = true;
    cancel?.();
  };
};

/** A `requestAnimationFrame` / `cancelAnimationFrame` pair (SceneRunner's frame scheduler). */
export interface FrameScheduler {
  request(callback: (timestampMs: number) => void): number;
  cancel(handle: number): void;
}

export interface BackgroundTickerOptions {
  /** Whose visibility decides rAF vs. worker (default: `document`). */
  readonly documentRef?: Document;
  /** Worker tick period while hidden (default ~60 Hz). */
  readonly intervalMs?: number;
}

type PendingFrame =
  | { callback: (timestampMs: number) => void; kind: 'raf'; inner: number }
  | { callback: (timestampMs: number) => void; kind: 'worker'; inner: number }
  | {
      callback: (timestampMs: number) => void;
      kind: 'timeout';
      inner: ReturnType<typeof setTimeout>;
    };

export const DEFAULT_BACKGROUND_TICK_MS = 16;

export class BackgroundTicker implements FrameScheduler {
  private readonly documentRef: Document;
  private readonly intervalMs: number;
  private readonly pending = new Map<number, PendingFrame>();
  private nextHandle = 1;
  private readonly disposeKeepAlive: () => void;
  private readonly onVisibility = (): void => this.migrate();

  constructor(options: BackgroundTickerOptions = {}) {
    this.documentRef = options.documentRef ?? document;
    this.intervalMs = options.intervalMs ?? DEFAULT_BACKGROUND_TICK_MS;
    this.documentRef.addEventListener('visibilitychange', this.onVisibility);
    this.disposeKeepAlive = onEditorKeepAliveChange(() => this.migrate());
  }

  /** Worker ticks are used right now (hidden tab + keepalive). */
  isBackgroundMode(): boolean {
    return isDocumentHidden(this.documentRef) && isEditorKeepAlive();
  }

  request(callback: (timestampMs: number) => void): number {
    const handle = this.nextHandle++;
    this.pending.set(handle, this.arm(handle, callback));
    return handle;
  }

  cancel(handle: number): void {
    const entry = this.pending.get(handle);
    if (!entry) return;
    this.pending.delete(handle);
    this.disarm(entry);
  }

  dispose(): void {
    for (const handle of Array.from(this.pending.keys())) this.cancel(handle);
    this.documentRef.removeEventListener('visibilitychange', this.onVisibility);
    this.disposeKeepAlive();
  }

  private arm(handle: number, callback: (timestampMs: number) => void): PendingFrame {
    if (this.isBackgroundMode()) {
      const id = clock.set(() => this.fire(handle, now()), this.intervalMs);
      if (id !== null) return { callback, kind: 'worker', inner: id };
      return {
        callback,
        kind: 'timeout',
        inner: setTimeout(() => this.fire(handle, now()), this.intervalMs),
      };
    }
    return {
      callback,
      kind: 'raf',
      inner: requestAnimationFrame(timestamp => this.fire(handle, timestamp)),
    };
  }

  private disarm(entry: PendingFrame): void {
    if (entry.kind === 'raf') cancelAnimationFrame(entry.inner);
    else if (entry.kind === 'worker') clock.clear(entry.inner);
    else clearTimeout(entry.inner);
  }

  private fire(handle: number, timestampMs: number): void {
    const entry = this.pending.get(handle);
    if (!entry) return;
    this.pending.delete(handle);
    entry.callback(timestampMs);
  }

  /** Move pending frames to the driver that will actually fire now. */
  private migrate(): void {
    const wantRaf = !this.isBackgroundMode();
    for (const [handle, entry] of Array.from(this.pending.entries())) {
      if ((entry.kind === 'raf') === wantRaf) continue;
      this.disarm(entry);
      this.pending.set(handle, this.arm(handle, entry.callback));
    }
  }
}

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
