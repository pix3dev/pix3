/**
 * GameFlow — the playable's phase driver: intro → playing → ended.
 *
 * Attach to the UI root. While the intro overlay is visible, the first tap
 * hides it and starts the game (the tap also unlocks browser audio — the
 * engine's AudioService resumes its context on the first gesture). The end
 * screen is revealed either by calling `finish()` from game code or, as a
 * placeholder, after `autoWinAfterSec` seconds. Replace the timer with your
 * real win/lose condition.
 */
import { Script, type PropertySchema } from '@pix3/runtime';

export class GameFlow extends Script {
  private phase: 'intro' | 'playing' | 'ended' = 'intro';
  private elapsed = 0;

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

  onUpdate(dt: number): void {
    if (this.phase === 'intro') {
      const tapped = this.input?.pointerEvents.some(e => e.type === 'down') ?? false;
      if (tapped) {
        this.setNodeVisible(String(this.config.introNode ?? ''), false);
        this.phase = 'playing';
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

  /** Reveal the end screen. Call this from game code on win/lose. */
  finish(): void {
    if (this.phase === 'ended') {
      return;
    }
    this.phase = 'ended';
    this.setNodeVisible(String(this.config.endNode ?? ''), true);
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
}
