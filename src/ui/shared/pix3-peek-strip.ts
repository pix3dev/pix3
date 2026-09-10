import { nothing } from 'lit';
import { subscribe } from 'valtio/vanilla';

import { ComponentBase, customElement, html, inject, property, state } from '@/fw';
import { appState } from '@/state';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { IconService, IconSize } from '@/services/editor/IconService';
import {
  PeekService,
  PEEK_VISIBLE_CHIP_LIMIT,
  type PeekBranch,
} from '@/services/viewport/PeekService';
import {
  PeekHideCommand,
  PeekShowAllCommand,
  PeekShowCommand,
  PeekSoloCommand,
} from '@/features/peek/PeekCommands';
import { DropdownPortal } from './dropdown-portal';

import './pix3-peek-strip.ts.css';

/**
 * The Peek strip: one labelled chip per branch of the scene, plus the way back out.
 *
 * Every interaction choice here is a reaction to a shipped mistake in another tool:
 *
 * - **Chips carry labels.** Blender 2.7x had exactly this control as 20 unlabelled squares in the
 *   viewport header, and 2.80 removed it — nobody could tell which square was which, and it did not
 *   scale past its fixed count.
 * - **Click toggles, ⌥/Alt-click solos.** The other way round is what Blender shipped, and "I
 *   pressed 1 and everything disappeared" outlived five major versions before the binding was
 *   dropped. There is deliberately no unmodified hotkey at all.
 * - **A repeat ⌥-click returns the PREVIOUS set**, not "show all" — alt-clicking an eye in
 *   Photoshop, so a solo never silently discards the mask the author built.
 * - **The "N hidden · Show all" pill is always present while anything is hidden**, and is itself
 *   the exit. Illustrator's isolation-mode breadcrumb: an indicator alone still leaves people
 *   stuck, because it says *that* they are in a mode and not how to leave.
 * - **The strip never collapses into a closed menu.** Unity's Layers dropdown did, and hidden state
 *   behind a closed control is state people forget they set.
 */
@customElement('pix3-peek-strip')
export class Pix3PeekStrip extends ComponentBase {
  @inject(PeekService)
  private readonly peek!: PeekService;

  @inject(IconService)
  private readonly icons!: IconService;

  @inject(CommandDispatcher)
  private readonly commandDispatcher!: CommandDispatcher;

  /**
   * Whether ⌥-click offers solo here.
   *
   * False on Flow's game-stage bar. Solo FADES the branches it pushes back, and that fade is an
   * editor-viewport effect — the running game's own materials are not touched, so on the stage bar
   * the gesture would report "Solo" on a chip and change nothing on screen. Hiding works in both
   * places (the mask is pushed into the play clone), so the stage bar keeps the useful half and
   * does not advertise the half it cannot deliver.
   *
   * Property-only (`attribute: false`): Lit's Boolean converter reads any PRESENT attribute as
   * true, so a `solo-enabled="false"` written in good faith would turn solo on.
   */
  @property({ type: Boolean, attribute: false })
  soloEnabled = true;

  @state()
  private branches: readonly PeekBranch[] = [];

  @state()
  private hiddenCount = 0;

  @state()
  private soloActive = false;

  @state()
  private overflowOpen = false;

  private readonly portal = new DropdownPortal({ minWidth: '11rem' });
  private disposePeek?: () => void;
  private disposeScenes?: () => void;

  connectedCallback(): void {
    super.connectedCallback();
    // Two sources, because they answer different questions: the service fires when the MASK
    // changes, `appState.scenes` when the scene or its structure does (which changes the chips).
    this.disposePeek = this.peek.subscribe(() => this.sync());
    this.disposeScenes = subscribe(appState.scenes, () => this.sync());
    this.sync();
  }

  disconnectedCallback(): void {
    this.disposePeek?.();
    this.disposeScenes?.();
    this.closeOverflow();
    super.disconnectedCallback();
  }

  private sync(): void {
    const snapshot = this.peek.getSnapshot();
    this.branches = snapshot.branches;
    this.hiddenCount = snapshot.hiddenCount;
    this.soloActive = snapshot.soloActive;
    if (this.branches.length <= PEEK_VISIBLE_CHIP_LIMIT) {
      this.closeOverflow();
    }
  }

  protected render() {
    // A scene with one branch has nothing to hide *relative to*, so the strip stays out of the way
    // entirely rather than offering a chip that blanks the view.
    if (this.branches.length < 2) {
      return nothing;
    }
    // SCENE-TREE order, top to bottom — deliberately NOT inverted the way Photoshop's layer panel
    // is. Inverting would break two things at once. The scene tree sits on the same screen in
    // Studio and reads in this order, and Pix3's paint order is the opposite of Photoshop's to
    // begin with (`assign2DRenderOrder` walks DFS, so a node LOWER in the tree draws on top) — so
    // "like Photoshop" would put the topmost chip on top of the z-stack while the tree beside it
    // said the reverse. And the chips are branches, not layers: there is no guaranteed z-relation
    // between them at all (`Post FX` is a PostProcess, not a 2D band), so an order that hinted at
    // draw order would be claiming something Peek never reports. Peek changes paint order never.
    const inline = this.branches.slice(0, PEEK_VISIBLE_CHIP_LIMIT);
    const overflow = this.branches.slice(PEEK_VISIBLE_CHIP_LIMIT);
    return html`
      <div class="peek" role="group" aria-label="Peek visibility">
        ${inline.map(branch => this.renderChip(branch))}
        ${overflow.length > 0 ? this.renderOverflow(overflow) : nothing} ${this.renderPill()}
      </div>
    `;
  }

  private renderChip(branch: PeekBranch) {
    const soloHint = this.soloEnabled ? ' (⌥-click to solo)' : '';
    const title = branch.hidden
      ? `Show ${branch.label} — hidden in your editor only`
      : `Hide ${branch.label} in your editor only${soloHint}`;
    return html`
      <button
        class="peek__chip"
        type="button"
        data-hidden=${branch.hidden ? 'true' : 'false'}
        data-dimmed=${branch.dimmed && this.soloEnabled ? 'true' : 'false'}
        data-soloed=${branch.soloed && this.soloEnabled ? 'true' : 'false'}
        aria-pressed=${branch.hidden ? 'false' : 'true'}
        title=${title}
        @click=${(event: MouseEvent) => this.onChipClick(event, branch)}
      >
        ${this.icons.getIcon(branch.hidden ? 'eye-off' : 'eye', IconSize.SMALL)}
        <span class="peek__chip-label">${branch.label}</span>
      </button>
    `;
  }

  /**
   * The tail, in a popover rather than in a scroller.
   *
   * The trigger stays labelled with the count, so state parked in here is still announced on the
   * strip — the chips move, the fact that there are more of them does not.
   */
  private renderOverflow(overflow: readonly PeekBranch[]) {
    const hiddenInTail = overflow.filter(branch => branch.hidden).length;
    return html`
      <div class="peek__overflow">
        <button
          class="peek__chip peek__chip--overflow"
          type="button"
          aria-expanded=${this.overflowOpen ? 'true' : 'false'}
          title="More branches"
          @click=${(event: MouseEvent) => this.toggleOverflow(event)}
        >
          <span class="peek__chip-label"
            >+${overflow.length}${hiddenInTail > 0 ? ` · ${hiddenInTail} hidden` : ''}</span
          >
          ${this.icons.getIcon('chevron-down', IconSize.SMALL)}
        </button>
        ${this.overflowOpen
          ? html`<div class="peek__menu" role="group" aria-label="More branches">
              ${overflow.map(branch => this.renderChip(branch))}
            </div>`
          : nothing}
      </div>
    `;
  }

  /**
   * Non-dismissable while anything is masked, and its own exit.
   *
   * **Always in the layout, even with nothing masked.** The column is anchored to the BOTTOM of the
   * viewport and grows upward, so a pill that appeared and disappeared would shove every chip up
   * and down by its own height — and the chip you just clicked would slide out from under the
   * cursor, right when you are most likely to click a second one. Reserving the row keeps the chips
   * still. It is reserved by rendering the real pill and hiding it with `visibility`, rather than by
   * a spacer with a guessed height, so the reserved space is exactly the pill's own.
   */
  private renderPill() {
    // A solo raised elsewhere still counts as a masked state worth an exit — but only where solo is
    // a thing the user can see, or the pill would announce a mode with no visible effect.
    const active = this.hiddenCount > 0 || (this.soloActive && this.soloEnabled);
    const label =
      this.soloActive && this.soloEnabled
        ? this.hiddenCount > 0
          ? `Solo · ${this.hiddenCount} hidden`
          : 'Solo'
        : `${this.hiddenCount} hidden`;
    return html`
      <button
        class="peek__pill"
        type="button"
        data-idle=${active ? 'false' : 'true'}
        ?disabled=${!active}
        aria-hidden=${active ? 'false' : 'true'}
        title="These branches are hidden only in your editor — the game and the export show them"
        @click=${() => void this.commandDispatcher.execute(new PeekShowAllCommand())}
      >
        <span>${label}</span>
        <span class="peek__pill-action">Show all</span>
      </button>
    `;
  }

  private onChipClick(event: MouseEvent, branch: PeekBranch): void {
    // `altKey` is ⌥ on macOS and Alt elsewhere — the modifier the plan settled on, and the only
    // gesture that reaches solo. Where solo is off it falls back to a plain toggle rather than
    // doing nothing, so a stray modifier never swallows the click.
    if (event.altKey && this.soloEnabled) {
      void this.commandDispatcher.execute(new PeekSoloCommand([branch.nodeId]));
      return;
    }
    void this.commandDispatcher.execute(
      branch.hidden ? new PeekShowCommand([branch.nodeId]) : new PeekHideCommand([branch.nodeId])
    );
  }

  private toggleOverflow(event: MouseEvent): void {
    if (this.overflowOpen) {
      this.closeOverflow();
      return;
    }
    this.overflowOpen = true;
    const trigger = event.currentTarget as HTMLElement;
    // Portalled: the strip lives inside letterboxed, `overflow: hidden` stage columns, which would
    // otherwise clip the popover (AGENTS.md rule 5).
    void this.updateComplete.then(() => {
      const menu = this.querySelector<HTMLElement>('.peek__menu');
      if (menu) {
        this.portal.open(trigger, menu);
      }
      document.addEventListener('pointerdown', this.onDocumentPointerDown, { capture: true });
      document.addEventListener('keydown', this.onDocumentKeyDown, { capture: true });
    });
  }

  private closeOverflow(): void {
    if (!this.overflowOpen) {
      return;
    }
    this.overflowOpen = false;
    this.portal.close();
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, { capture: true });
    document.removeEventListener('keydown', this.onDocumentKeyDown, { capture: true });
  }

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.closeOverflow();
    }
  };

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (target && (this.contains(target) || this.portalContains(target))) {
      return;
    }
    this.closeOverflow();
  };

  /**
   * The popover is reparented into a `.pix3-dropdown-portal` div on `document.body`, so
   * `this.contains` no longer covers it — a click on a chip inside the popover would otherwise read
   * as an outside click and dismiss the popover before the chip's own handler ran.
   *
   * Asked of THIS strip's own portal rather than by document-wide selector: Flow mounts two strips
   * (the stage bar and the scene view), and a selector would let one strip treat the other's open
   * popover as its own.
   */
  private portalContains(target: Node): boolean {
    return this.portal.contains(target);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-peek-strip': Pix3PeekStrip;
  }
}
