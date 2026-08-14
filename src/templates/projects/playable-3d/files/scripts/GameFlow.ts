/**
 * GameFlow — the playable's phase driver: intro → playing → ended.
 *
 * Attach to `hud-root` (the 2D overlay layer above the 3D `game-root`). While
 * the intro overlay is visible, the first tap
 * hides it and starts the game (the tap also unlocks browser audio — the
 * engine's AudioService resumes its context on the first gesture). The end
 * screen is revealed either by calling `finish()` from game code or, as a
 * placeholder, after `autoWinAfterSec` seconds. Replace the timer with your
 * real win/lose condition.
 *
 * Two conventions here are worth keeping as you replace the placeholder:
 *
 * - **Intent-first handlers.** Every reaction to the player lives in a named
 *   public method marked `Intent:` (`start`, `finish`, `restart`), and the ones
 *   a test drives are registered as commands (`scene.commands`) that the event
 *   handler dispatches. Game code and automated tests then drive the game by
 *   intent instead of by simulated pixels — `scene.commands.dispatch('restart')`
 *   — the flow survives any relayout of the UI, and every raised intent is
 *   journalled with the frame it happened on.
 * - **A debug provider.** `registerGameDebug` publishes a JSON snapshot of the
 *   run so external tooling (the editor's debug bridge, DevTools, an agent) can
 *   read the phase instead of guessing it from the screen. Add your own fields
 *   as you add state — keep everything JSON-serialisable.
 */
import { Script, playable, registerGameDebug, type PropertySchema } from '@pix3/runtime';

export class GameFlow extends Script {
  private phase: 'intro' | 'playing' | 'ended' = 'intro';
  private elapsed = 0;
  private disposeDebug: (() => void) | null = null;
  private disposeCommands: (() => void)[] = [];

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // Node id/name of the tap-to-start overlay.
      introNode: 'intro-overlay',
      // Node id/name of the end screen with the CTA button.
      endNode: 'end-screen',
      // Placeholder auto-win timer in seconds (0 = never; call finish() instead).
      autoWinAfterSec: 15,
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'GameFlow',
      properties: [
        {
          name: 'introNode',
          type: 'string',
          ui: { label: 'Intro Overlay', group: 'Flow' },
          getValue: s => (s as GameFlow).config.introNode,
          setValue: (s, v) => {
            (s as GameFlow).config.introNode = typeof v === 'string' ? v : '';
          },
        },
        {
          name: 'endNode',
          type: 'string',
          ui: { label: 'End Screen', group: 'Flow' },
          getValue: s => (s as GameFlow).config.endNode,
          setValue: (s, v) => {
            (s as GameFlow).config.endNode = typeof v === 'string' ? v : '';
          },
        },
        {
          name: 'autoWinAfterSec',
          type: 'number',
          ui: {
            label: 'Auto Win After (s)',
            description: 'Placeholder timer that reveals the end screen (0 = disabled)',
            group: 'Flow',
            min: 0,
            step: 1,
          },
          getValue: s => (s as GameFlow).config.autoWinAfterSec,
          setValue: (s, v) => {
            (s as GameFlow).config.autoWinAfterSec = Math.max(0, Number(v) || 0);
          },
        },
      ],
      groups: { Flow: { label: 'Game Flow', expanded: true } },
    };
  }

  onStart(): void {
    const commands = this.scene?.commands;
    this.disposeCommands = [
      commands?.register('start-game', () => this.start(), {
        description: 'Leave the intro overlay and begin play.',
      }),
      // `finish` is registered for the same reason `start-game` is: a test (and the
      // rest of the game) must be able to END the run by intent instead of waiting
      // out the placeholder timer — and a routine that reached in and called
      // `finish()` directly would prove the method works while skipping the wire
      // from the player to it. Replace the timer with your win/lose condition and
      // dispatch this from there.
      commands?.register('finish', () => this.finish(), {
        description: 'End the run and reveal the end screen.',
      }),
      commands?.register('restart', () => this.restart(), {
        description: 'Return to the tap-to-start gate and arm a fresh run.',
      }),
    ].filter((dispose): dispose is () => void => dispose !== undefined);

    this.disposeDebug = registerGameDebug({
      name: 'playable-3d',
      version: 1,
      // The registry IS the action list — never a second, hand-kept copy.
      actions: () => this.scene?.commands.list().map(command => command.name) ?? [],
      // What "the start" means for this playable, so a test can put the game back
      // without restarting the scene (a restart keeps whatever a script parked in
      // module state; this does not). It is `restart()` plus the one thing that
      // lives OUTSIDE the scene and would otherwise leak into the next run: the
      // SDK's session `gameEnded` flag, which `playable.gameEnd()` latched.
      // `seed` is accepted and ignored — the placeholder flow has no randomness,
      // so this restores the same starting state, not the same sequence. Seed
      // your own RNG here once you add one.
      reset: () => {
        this.restart();
        playable.reset();
      },
      snapshot: () => ({
        phase: this.phase,
        elapsedSec: Math.round(this.elapsed * 100) / 100,
        autoWinAfterSec: Number(this.config.autoWinAfterSec) || 0,
        introVisible: this.isNodeVisible(String(this.config.introNode ?? '')),
        endVisible: this.isNodeVisible(String(this.config.endNode ?? '')),
        // Set by playable.gameEnd() — the CTA button reports the session as over.
        gameEnded: playable.hasGameEnded(),
      }),
    });
  }

  onDetach(): void {
    this.disposeDebug?.();
    this.disposeDebug = null;
    // The scene's registry is cleared on stop anyway; this covers the other
    // case — this script being detached while the scene keeps running.
    for (const dispose of this.disposeCommands) {
      dispose();
    }
    this.disposeCommands = [];
    super.onDetach();
  }

  onUpdate(dt: number): void {
    if (this.phase === 'intro') {
      const tapped = this.input?.pointerEvents.some(e => e.type === 'down') ?? false;
      if (tapped) {
        // Raised through the registry, so the tap-to-start gate shows up in the
        // command journal exactly like a dispatched `start-game` would.
        this.scene?.commands.dispatch('start-game');
      }
      return;
    }

    if (this.phase === 'playing') {
      const autoWin = Number(this.config.autoWinAfterSec) || 0;
      if (autoWin > 0) {
        this.elapsed += dt;
        if (this.elapsed >= autoWin) {
          this.finish();
        }
      }
    }
  }

  /** Intent: leave the intro overlay and begin play. Raised by the first tap. */
  start(): void {
    if (this.phase !== 'intro') {
      return;
    }
    this.setNodeVisible(String(this.config.introNode ?? ''), false);
    this.phase = 'playing';
  }

  /** Intent: end the run and reveal the end screen. Call this from game code on win/lose. */
  finish(): void {
    if (this.phase === 'ended') {
      return;
    }
    this.phase = 'ended';
    this.setNodeVisible(String(this.config.endNode ?? ''), true);
  }

  /** Intent: return to the tap-to-start gate and arm a fresh run. */
  restart(): void {
    this.phase = 'intro';
    this.elapsed = 0;
    this.setNodeVisible(String(this.config.endNode ?? ''), false);
    this.setNodeVisible(String(this.config.introNode ?? ''), true);
  }

  private setNodeVisible(query: string, visible: boolean): void {
    if (!query) {
      return;
    }
    const node = this.findNode(query);
    if (node) {
      node.visible = visible;
    } else {
      console.warn(`[GameFlow] Node "${query}" not found.`);
    }
  }

  /** Own `visible` flag of a configured node, or null when it is not in the scene. */
  private isNodeVisible(query: string): boolean | null {
    if (!query) {
      return null;
    }
    return this.findNode(query)?.visible ?? null;
  }
}
