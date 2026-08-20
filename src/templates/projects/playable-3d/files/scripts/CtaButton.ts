/**
 * CtaButton — the playable's call-to-action. Attach to a Button2D; on press it
 * reports game end and logs the click. It deliberately does NOT open a store
 * page: which URL a playable opens (and whether it opens one at all) is decided
 * by the ad network at delivery time via `mraid.open` / `dapi.openStoreUrl`, so
 * a hardcoded store URL in a template is a wrong default that ships a real
 * navigation out of the game on every tap. Wire the network SDK here when you
 * package the ad; until then the log is the whole contract.
 *
 * The press handler does nothing itself: it dispatches the named command
 * `cta-click`, whose handler is the intent method `ctaClick()`. Keep that shape
 * as you add buttons — a game whose reactions are named intents can be driven
 * and tested by `scene.commands.dispatch(...)` rather than by simulated taps,
 * the wiring survives any relayout of the UI, and one real tap is enough to
 * prove the button still raises the intent it claims.
 */
import { Script, playable } from '@pix3/runtime';
import type { NodeBase } from '@pix3/runtime';

export class CtaButton extends Script {
  private disposeCommands: (() => void)[] = [];

  onAttach(node: NodeBase): void {
    node.connect('pressed', this, this.handlePressed);
  }

  onStart(): void {
    // Registered here rather than in onAttach: `scene` is injected once the
    // graph is built, which is after components are attached during load.
    const commands = this.scene?.commands;
    this.disposeCommands = [
      commands?.register('cta-click', () => this.ctaClick(), {
        description: 'Accept the call to action: end the session and report the CTA click.',
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

  /** Intent: the player accepted the call to action — end the session and report the click. */
  ctaClick(): void {
    playable.gameEnd();
    console.info(`[CtaButton] CTA clicked (${this.node?.name ?? this.node?.id ?? 'unknown node'})`);
  }

  private handlePressed = (): void => {
    this.scene?.commands.dispatch('cta-click');
  };
}
