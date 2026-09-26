import type { TickWorkerCommand, TickWorkerLike } from '@/services/core/background-ticker';

/**
 * Spec helper: a tick worker whose timers fire only when the test says so. Install it with
 * `setTickWorkerFactory(() => worker)`.
 */
export class FakeTickWorker implements TickWorkerLike {
  onmessage: ((event: MessageEvent<{ id: number }>) => void) | null = null;
  /** Armed timers: id → delay in ms. */
  readonly timers = new Map<number, number>();
  readonly commands: TickWorkerCommand[] = [];
  terminated = false;

  postMessage(message: TickWorkerCommand): void {
    this.commands.push(message);
    if (message.op === 'set') this.timers.set(message.id, message.ms);
    else this.timers.delete(message.id);
  }

  /** Fire every armed timer once (what the worker does when their delays have passed). */
  fireAll(): number {
    const ids = Array.from(this.timers.keys());
    for (const id of ids) {
      this.timers.delete(id);
      this.onmessage?.({ data: { id } } as MessageEvent<{ id: number }>);
    }
    return ids.length;
  }

  terminate(): void {
    this.terminated = true;
    this.timers.clear();
  }
}

export const setVisibility = (state: 'visible' | 'hidden', focused = state === 'visible'): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
  document.dispatchEvent(new Event('visibilitychange'));
};
