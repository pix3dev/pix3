/**
 * CtaButton — the playable's call-to-action. Attach to a Button2D; on press it
 * reports game end and opens the store page via the engine Playable SDK
 * (`mraid.open` when an ad network provides it, `window.open` otherwise).
 * Set your real store URL in the component config.
 *
 * The press handler does nothing itself: it dispatches the named command
 * `cta-click`, whose handler is the intent method `ctaClick()`. Keep that shape
 * as you add buttons — a game whose reactions are named intents can be driven
 * and tested by `scene.commands.dispatch(...)` rather than by simulated taps,
 * the wiring survives any relayout of the UI, and one real tap is enough to
 * prove the button still raises the intent it claims.
 */
import { Script, playable, type PropertySchema } from '@pix3/runtime';
import type { NodeBase } from '@pix3/runtime';

export class CtaButton extends Script {
  private disposeCommands: (() => void)[] = [];

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      storeUrl: 'https://play.google.com/store/apps',
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'CtaButton',
      properties: [
        {
          name: 'storeUrl',
          type: 'string',
          ui: {
            label: 'Store URL',
            description: 'App store page opened when the button is pressed',
            group: 'CTA',
          },
          getValue: s => (s as CtaButton).config.storeUrl,
          setValue: (s, v) => {
            (s as CtaButton).config.storeUrl = typeof v === 'string' ? v : '';
          },
        },
      ],
      groups: { CTA: { label: 'Call To Action', expanded: true } },
    };
  }

  onAttach(node: NodeBase): void {
    node.connect('pressed', this, this.handlePressed);
  }

  onStart(): void {
    // Registered here rather than in onAttach: `scene` is injected once the
    // graph is built, which is after components are attached during load.
    const commands = this.scene?.commands;
    this.disposeCommands = [
      commands?.register('cta-click', () => this.ctaClick(), {
        description: 'Accept the call to action: end the session and open the store page.',
      }),
    ].filter((dispose): dispose is () => void => dispose !== undefined);
  }

  onDetach(): void {
    for (const dispose of this.disposeCommands) {
      dispose();
    }
    this.disposeCommands = [];
    super.onDetach();
  }

  /** Intent: the player accepted the call to action — end the session and go to the store. */
  ctaClick(): void {
    playable.gameEnd();
    this.openStore();
  }

  /** Intent: open the configured store page through the Playable SDK. */
  openStore(): void {
    playable.openStore(String(this.config.storeUrl ?? ''));
  }

  private handlePressed = (): void => {
    this.scene?.commands.dispatch('cta-click');
  };
}
