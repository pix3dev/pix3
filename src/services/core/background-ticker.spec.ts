import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BackgroundTicker,
  keepaliveInterval,
  keepaliveTimer,
  setTickWorkerFactory,
} from '@/services/core/background-ticker';
import { FakeTickWorker, setVisibility } from '@/services/core/background-ticker.test-helpers';
import { setEditorKeepAlive } from '@/services/core/page-activity';

let worker: FakeTickWorker;
let rafCallbacks: Array<(timestamp: number) => void>;

beforeEach(() => {
  worker = new FakeTickWorker();
  setTickWorkerFactory(() => worker);
  rafCallbacks = [];
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: (timestamp: number) => void) => rafCallbacks.push(callback))
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  setVisibility('visible');
});

afterEach(() => {
  setEditorKeepAlive(false);
  setTickWorkerFactory(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setVisibility('visible');
});

/** A frame loop like the play / viewport loops: re-arms itself on every frame. */
const startLoop = (ticker: BackgroundTicker): { frames: number[] } => {
  const frames: number[] = [];
  const frame = (timestamp: number): void => {
    frames.push(timestamp);
    ticker.request(frame);
  };
  ticker.request(frame);
  return { frames };
};

describe('BackgroundTicker', () => {
  it('uses rAF while the tab is visible, keepalive or not', () => {
    setEditorKeepAlive(true);
    const ticker = new BackgroundTicker();
    const { frames } = startLoop(ticker);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    rafCallbacks.shift()?.(16);
    expect(frames).toEqual([16]);
    expect(worker.timers.size).toBe(0);
    ticker.dispose();
  });

  it('keeps a loop ticking from the worker while hidden and keepalive is on', () => {
    setVisibility('hidden');
    setEditorKeepAlive(true);
    const ticker = new BackgroundTicker({ intervalMs: 16 });
    const { frames } = startLoop(ticker);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect([...worker.timers.values()]).toEqual([16]);
    for (let i = 0; i < 5; i++) worker.fireAll();
    expect(frames).toHaveLength(5);
    expect(frames.every(timestamp => typeof timestamp === 'number')).toBe(true);
    ticker.dispose();
    expect(worker.timers.size).toBe(0);
  });

  it('stops when keepalive goes off in a hidden tab (back to a rAF that does not fire)', () => {
    setVisibility('hidden');
    setEditorKeepAlive(true);
    const ticker = new BackgroundTicker();
    const { frames } = startLoop(ticker);
    worker.fireAll();
    expect(frames).toHaveLength(1);

    setEditorKeepAlive(false);
    // The pending frame moved to rAF — which a hidden tab never calls.
    expect(worker.timers.size).toBe(0);
    expect(worker.fireAll()).toBe(0);
    expect(frames).toHaveLength(1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    ticker.dispose();
  });

  it('moves a pending rAF frame to the worker when the tab is hidden under keepalive', () => {
    setEditorKeepAlive(true);
    const ticker = new BackgroundTicker();
    const { frames } = startLoop(ticker);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(worker.timers.size).toBe(1);
    worker.fireAll();
    worker.fireAll();
    expect(frames).toHaveLength(2);

    setVisibility('visible');
    expect(worker.timers.size).toBe(0);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    ticker.dispose();
  });

  it('with keepalive off a hidden tab gets no worker ticks at all (idle battery case)', () => {
    setVisibility('hidden');
    const ticker = new BackgroundTicker();
    const { frames } = startLoop(ticker);
    expect(worker.timers.size).toBe(0);
    expect(worker.commands).toEqual([]);
    expect(frames).toEqual([]);
    ticker.dispose();
  });

  it('cancel withdraws a worker frame', () => {
    setVisibility('hidden');
    setEditorKeepAlive(true);
    const ticker = new BackgroundTicker();
    const callback = vi.fn();
    const handle = ticker.request(callback);
    ticker.cancel(handle);
    expect(worker.fireAll()).toBe(0);
    expect(callback).not.toHaveBeenCalled();
    ticker.dispose();
  });
});

describe('keepaliveTimer / keepaliveInterval', () => {
  it('is a plain setTimeout while keepalive is off', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    keepaliveTimer(callback, 500);
    expect(worker.commands).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('runs on the worker while keepalive is on, and cancels there', () => {
    vi.useFakeTimers();
    setEditorKeepAlive(true);
    const callback = vi.fn();
    keepaliveTimer(callback, 15_000);
    expect([...worker.timers.values()]).toEqual([15_000]);
    // Main-thread time passing does nothing: only the worker fires it.
    vi.advanceTimersByTime(60_000);
    expect(callback).not.toHaveBeenCalled();
    worker.fireAll();
    expect(callback).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    const cancel = keepaliveTimer(cancelled, 100);
    cancel();
    worker.fireAll();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('moves a pending timer to the worker when keepalive turns on, with the time it has left', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    keepaliveTimer(callback, 15_000);
    expect(worker.commands).toEqual([]);
    vi.advanceTimersByTime(5_000);
    // Keepalive comes back while the (throttleable) main-thread timer is pending.
    setEditorKeepAlive(true);
    expect([...worker.timers.values()]).toEqual([10_000]);
    expect(vi.getTimerCount()).toBe(0);
    worker.fireAll();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('moves back to a plain timer when keepalive turns off, and fires once', () => {
    vi.useFakeTimers();
    setEditorKeepAlive(true);
    const callback = vi.fn();
    const cancel = keepaliveTimer(callback, 1_000);
    setEditorKeepAlive(false);
    expect(worker.timers.size).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(callback).toHaveBeenCalledTimes(1);
    setEditorKeepAlive(true);
    expect(worker.timers.size).toBe(0);
    cancel();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('falls back to setTimeout when no worker can be created', () => {
    vi.useFakeTimers();
    setTickWorkerFactory(() => null);
    setEditorKeepAlive(true);
    const callback = vi.fn();
    keepaliveTimer(callback, 100);
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('keepaliveInterval repeats until cancelled', () => {
    setEditorKeepAlive(true);
    const callback = vi.fn();
    const cancel = keepaliveInterval(callback, 1_000);
    worker.fireAll();
    worker.fireAll();
    worker.fireAll();
    expect(callback).toHaveBeenCalledTimes(3);
    cancel();
    expect(worker.fireAll()).toBe(0);
  });
});
