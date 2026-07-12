/**
 * CtaButton — the playable's call-to-action. Attach to a Button2D; on press it
 * reports game end and opens the store page via the engine Playable SDK
 * (`mraid.open` when an ad network provides it, `window.open` otherwise).
 * Set your real store URL in the component config.
 */
import { Script, playable, type PropertySchema } from '@pix3/runtime';
import type { NodeBase } from '@pix3/runtime';

export class CtaButton extends Script {
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

  private handlePressed = (): void => {
    playable.gameEnd();
    playable.openStore(String(this.config.storeUrl ?? ''));
  };
}
