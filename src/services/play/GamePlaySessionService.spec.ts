import { beforeEach, describe, expect, it } from 'vitest';

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
 * The Studio Game tab and the Flow stage both register as the *same* host kind, so a mode switch
 * hands the runtime from one mount to another without `syncRuntimeToUiState` seeing a kind change
 * — it would leave the running game attached to the element that is going away, and Studio would
 * come back to a black Game tab. Registering a different mount has to detach like a tab ⇄ popout
 * swap does; registering the same mount again (a resync) must not disturb the running game.
 */
describe('GamePlaySessionService — tab host swap', () => {
  function makeHostSwapSession(): { service: GamePlaySessionService; runner: FakeRunner } {
    const runner = makeRunner();
    const service = new GamePlaySessionService();
    const internals = service as unknown as Record<string, unknown>;
    // Bypass DI-dependent wiring: this decision is made before any of it runs.
    internals.initialized = true;
    internals.queueSync = () => {};
    // `@inject` installs getter-only properties on the prototype; shadow them on the instance.
    Object.defineProperty(service, 'profilerSessionService', { value: { endSession: () => {} } });
    Object.defineProperty(service, 'assetLoader', { value: { setAtlasResolver: () => {} } });
    internals.runner = runner;
    internals.activeHostKind = 'tab';
    return { service, runner };
  }

  const mountA = {} as HTMLElement;
  const mountB = {} as HTMLElement;

  it('detaches the runtime when a different mount claims the tab host', () => {
    const { service, runner } = makeHostSwapSession();
    service.registerTabHost(mountA, window);
    expect(runner.stopped).toBe(false);

    service.registerTabHost(mountB, window);
    expect(runner.stopped).toBe(true);
    expect((service as unknown as { activeHostKind: string | null }).activeHostKind).toBeNull();
  });

  it('leaves the runtime alone when the same mount re-registers', () => {
    const { service, runner } = makeHostSwapSession();
    service.registerTabHost(mountA, window);
    service.registerTabHost(mountA, window);

    expect(runner.stopped).toBe(false);
    expect((service as unknown as { activeHostKind: string | null }).activeHostKind).toBe('tab');
  });
});
