import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appState } from '@/state';
import { GamePlaySessionService } from './GamePlaySessionService';

/**
 * The pause decision, and only it (§ "focus-pause rule"). Two independent inputs
 * can hold the running game — the editor's focus rule and an explicit host
 * request — and the bug this file exists for was that only the first one was
 * remembered: `handleFocusPause` re-derives the whole decision on every focus
 * event and on every suppression toggle, and its "should not pause" branch calls
 * `resume()`, so a `runner.pause()` from outside survived exactly until the next
 * event. `game_run` produced that event itself (dropping its focus-pause
 * suppression in the same `finally` that paused the game), so the promised
 * "left paused on the outcome frame" lasted microseconds.
 *
 * The service is driven directly rather than through DI: the decision needs a
 * runner, a host window and `appState`, and nothing else.
 */

interface FakeRunner {
  paused: boolean;
  pauses: number;
  resumes: number;
  stopped: boolean;
  running: boolean;
  pause(): void;
  resume(): void;
  stop(): void;
}

function makeRunner(): FakeRunner {
  return {
    paused: false,
    pauses: 0,
    resumes: 0,
    stopped: false,
    running: true,
    pause() {
      this.paused = true;
      this.pauses += 1;
    },
    resume() {
      this.paused = false;
      this.resumes += 1;
    },
    stop() {
      this.stopped = true;
      this.running = false;
    },
  };
}

function makeSession(options: { focused?: boolean } = {}): {
  service: GamePlaySessionService;
  runner: FakeRunner;
  setFocused: (focused: boolean) => void;
  /** What a focus/blur/visibilitychange listener does: re-run the decision. */
  fireFocusEvent: () => void;
} {
  let focused = options.focused ?? true;
  const runner = makeRunner();
  const service = new GamePlaySessionService();
  const host = {
    kind: 'tab' as const,
    mount: {} as HTMLElement,
    windowRef: {
      document: {
        visibilityState: 'visible',
        hasFocus: () => focused,
      } as unknown as Document,
    } as unknown as Window,
  };
  const internals = service as unknown as Record<string, unknown>;
  internals.runner = runner;
  internals.tabHost = host;
  internals.activeHostKind = 'tab';
  return {
    service,
    runner,
    setFocused: value => {
      focused = value;
    },
    fireFocusEvent: () => {
      (service as unknown as { handleFocusPause(): void }).handleFocusPause();
    },
  };
}

describe('GamePlaySessionService — pause decision', () => {
  beforeEach(() => {
    appState.ui.pauseRenderingOnUnfocus = true;
  });

  it('pauses on focus loss and resumes on focus return', () => {
    const { runner, setFocused, fireFocusEvent } = makeSession();

    setFocused(false);
    fireFocusEvent();
    expect(runner.paused).toBe(true);

    setFocused(true);
    fireFocusEvent();
    expect(runner.paused).toBe(false);
  });

  it('holds a host-requested pause across a focus-pause suppression toggle', () => {
    // The exact sequence game_run runs: suppress → work → pause → un-suppress.
    const { service, runner } = makeSession();
    service.setFocusPauseSuppressed(true);
    expect(runner.paused).toBe(false);

    service.setPauseRequested(true);
    expect(runner.paused).toBe(true);

    service.setFocusPauseSuppressed(false);
    expect(runner.paused).toBe(true);
    expect(service.pauseRequested).toBe(true);
    expect(service.runnerPaused).toBe(true);
  });

  it('holds a host-requested pause across focus loss and focus return', () => {
    const { service, runner, setFocused, fireFocusEvent } = makeSession();
    service.setPauseRequested(true);

    setFocused(false);
    fireFocusEvent();
    expect(runner.paused).toBe(true);

    setFocused(true);
    fireFocusEvent();
    expect(runner.paused).toBe(true);
  });

  it('releases the game when the host request is dropped', () => {
    const { service, runner } = makeSession();
    service.setPauseRequested(true);
    expect(runner.paused).toBe(true);

    service.setPauseRequested(false);
    expect(runner.paused).toBe(false);
    expect(service.pauseRequested).toBe(false);
  });

  it('keeps the game paused when the request is dropped but the window is not focused', () => {
    const { service, runner, setFocused, fireFocusEvent } = makeSession();
    service.setPauseRequested(true);
    setFocused(false);
    fireFocusEvent();

    service.setPauseRequested(false);
    expect(runner.paused).toBe(true);
  });
});

/**
 * The seat swap between Studio's Game tab and the Vibe stage.
 *
 * Both register as the same host kind, so `syncRuntimeToUiState` sees no kind change and would
 * happily leave the running game attached to the element that is going away. The contract here:
 * a same-document swap MOVES the live session (canvas, WebGL context, score, audio) to the new
 * mount; a swap that cannot be moved detaches; and because the two stages can mount/unmount in
 * either order, releasing the seat is deferred by a turn so an incoming stage can still claim it.
 */
describe('GamePlaySessionService — tab host swap', () => {
  interface HostSwapSession {
    service: GamePlaySessionService;
    runner: FakeRunner;
    canvas: HTMLCanvasElement;
    /** Every mount the canvas was (re-)parented into, in order. */
    attaches: HTMLElement[];
  }

  function makeHostSwapSession(canvasDocument: Document = document): HostSwapSession {
    const runner = makeRunner();
    const service = new GamePlaySessionService();
    const internals = service as unknown as Record<string, unknown>;
    // Bypass DI-dependent wiring: this decision is made before any of it runs.
    internals.initialized = true;
    internals.queueSync = () => {};
    // `@inject` installs getter-only properties on the prototype; shadow them on the instance.
    Object.defineProperty(service, 'profilerSessionService', { value: { endSession: () => {} } });
    Object.defineProperty(service, 'assetLoader', { value: { setAtlasResolver: () => {} } });

    const canvas = canvasDocument.createElement('canvas');
    const attaches: HTMLElement[] = [];
    internals.renderer = {
      domElement: canvas,
      attach: (container: HTMLElement) => {
        attaches.push(container);
      },
      dispose: () => {},
    };
    internals.runner = runner;
    internals.activeHostKind = 'tab';
    return { service, runner, canvas, attaches };
  }

  const fakeWindow = {
    document: { visibilityState: 'visible', hasFocus: () => true } as unknown as Document,
  } as unknown as Window;

  let mountA: HTMLElement;
  let mountB: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    mountA = document.createElement('div');
    mountB = document.createElement('div');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves the live game to the new mount instead of restarting it', () => {
    const { service, runner, attaches } = makeHostSwapSession();
    service.registerTabHost(mountA, fakeWindow);
    service.registerTabHost(mountB, fakeWindow);

    expect(runner.stopped).toBe(false);
    expect(attaches).toEqual([mountA, mountB]);
    expect((service as unknown as { activeHostKind: string | null }).activeHostKind).toBe('tab');
  });

  it('keeps the game when the outgoing stage unmounts before the incoming one mounts', () => {
    const { service, runner, attaches } = makeHostSwapSession();
    service.registerTabHost(mountA, fakeWindow);

    // The order a Lit component swap can produce: old stage gone, new stage not mounted yet.
    service.unregisterTabHost(mountA);
    expect(runner.stopped).toBe(false);

    service.registerTabHost(mountB, fakeWindow);
    vi.advanceTimersByTime(10);

    expect(runner.stopped).toBe(false);
    expect(attaches.at(-1)).toBe(mountB);
  });

  it('stops the game when nothing claims the seat', () => {
    const { service, runner } = makeHostSwapSession();
    service.registerTabHost(mountA, fakeWindow);

    service.unregisterTabHost(mountA);
    vi.advanceTimersByTime(10);

    expect(runner.stopped).toBe(true);
    expect((service as unknown as { activeHostKind: string | null }).activeHostKind).toBeNull();
  });

  it('detaches instead of moving when the canvas would have to cross documents', () => {
    // What a popout-owned runtime looks like: its canvas belongs to another document, and a WebGL
    // context cannot be carried across one.
    const otherDocument = document.implementation.createHTMLDocument('popout');
    const { service, runner } = makeHostSwapSession(otherDocument);
    service.registerTabHost(mountA, fakeWindow);

    service.registerTabHost(mountB, fakeWindow);

    expect(runner.stopped).toBe(true);
    expect((service as unknown as { activeHostKind: string | null }).activeHostKind).toBeNull();
  });

  it('leaves the runtime alone when the same mount re-registers', () => {
    const { service, runner, attaches } = makeHostSwapSession();
    service.registerTabHost(mountA, fakeWindow);
    service.registerTabHost(mountA, fakeWindow);

    expect(runner.stopped).toBe(false);
    expect(attaches).toEqual([mountA]);
    expect((service as unknown as { activeHostKind: string | null }).activeHostKind).toBe('tab');
  });
});

/**
 * Every launch has to go through one queue. The Vibe stage registers its host (which queues a
 * launch) and then asks for a restart of its own; when those two ran concurrently, the loser was
 * dropped from `this.runner` without ever being stopped and kept ticking — a second, invisible game
 * playing sounds behind the visible one.
 */
describe('GamePlaySessionService — launch serialization', () => {
  it('runs queued launches one after another, never overlapping', async () => {
    const service = new GamePlaySessionService();
    const internals = service as unknown as Record<string, unknown>;
    internals.initialized = true;

    let inFlight = 0;
    let overlapped = false;
    const order: string[] = [];
    const task = (label: string) => async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await Promise.resolve();
      order.push(label);
      inFlight -= 1;
    };

    const enqueue = (service as unknown as { enqueue<T>(t: () => Promise<T>): Promise<T> }).enqueue;
    const first = enqueue.call(service, task('first'));
    const second = enqueue.call(service, task('second'));
    await Promise.all([first, second]);

    expect(overlapped).toBe(false);
    expect(order).toEqual(['first', 'second']);
  });

  it('keeps draining the queue after a launch fails, and still reports the failure', async () => {
    const service = new GamePlaySessionService();
    const enqueue = (service as unknown as { enqueue<T>(t: () => Promise<T>): Promise<T> }).enqueue;

    const failing = enqueue.call(service, async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(enqueue.call(service, async () => 'ok')).resolves.toBe('ok');
  });
});
