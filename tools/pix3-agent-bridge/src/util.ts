/**
 * Primitives shared by every lane of the bridge (Agent-SDK, Antigravity CLI, …).
 *
 * These moved out of `sessions.ts` verbatim when the second lane arrived: both lanes need a promise
 * they can settle from elsewhere and a push-based async iterable, and neither is specific to the
 * Claude Agent SDK.
 */

export type Logger = (line: string) => void;

/** A promise whose settlement is driven from outside the executor. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** Push-based async iterable — the streaming input of a long-lived session. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}
