import {
  OperationBase,
  type OperationContext,
  type OperationInvokeResult,
  type OperationMetadata,
} from '@/core/Operation';
import { PeekService } from '@/services/viewport/PeekService';

/**
 * What the operation should do to the Peek mask.
 *
 * - `hide` / `show` — add or remove branches from the mask. A chip click picks one of these from
 *   the branch's current state, so there is deliberately no `toggle`: the strip already knows.
 * - `solo` — fade everything except the given branch (and un-solo on a repeat, restoring the
 *   previous set rather than "show all").
 * - `show_all` — the single exit from every masked state.
 */
export type PeekAction = 'hide' | 'show' | 'solo' | 'show_all';

export interface SetPeekVisibilityArgs {
  readonly action: PeekAction;
  readonly nodeIds?: readonly string[];
}

/**
 * The mutation gateway entry for the Peek mask — and deliberately the one operation that does NOT
 * commit.
 *
 * `perform` returns `didMutate: true` with no `commit`, which `OperationService` does not push to
 * history. That is a product decision, not an omission: in Flow the author hides the HUD, presses
 * Ctrl+Z and means "undo what the agent just did to my game", not "give me the HUD back". A chip is
 * its own undo — one click puts it back — and the "N hidden · Show all" pill is the bulk exit.
 * (`ToggleUIFlagOperation`, which puts the grid toggle into history, is the anti-pattern here.)
 *
 * It also touches no node property and no file: `PeekService` writes `hiddenByEditor`, which is
 * never serialized. Routing it through an Operation anyway keeps one write path for the mask, so
 * the strip, the commands and the agent tool cannot drift apart.
 */
export class SetPeekVisibilityOperation extends OperationBase {
  readonly metadata: OperationMetadata = {
    id: 'viewport.set-peek-visibility',
    title: 'Peek Visibility',
    description: 'Hide or reveal branches of the scene in this editor session only',
  };

  constructor(private readonly args: SetPeekVisibilityArgs) {
    super();
  }

  perform(context: OperationContext): OperationInvokeResult {
    const peek = context.container.getService<PeekService>(
      context.container.getOrCreateToken(PeekService)
    );
    const targets = this.args.nodeIds ?? [];

    // The real answer, not a constant `true`. `OperationService` bumps `scenes.nodeDataChangeSignal`
    // for any `didMutate`, which wakes IntelliSense, the scene tree rebuild and the viewport
    // resync — work a no-op chip click has no business triggering, and a signal a view mask has no
    // business sending at all if it changed nothing.
    let didMutate = false;
    switch (this.args.action) {
      case 'show_all':
        didMutate = peek.showAll();
        break;
      case 'solo':
        // One branch at a time: solo is a modifier-click on a single chip, and a multi-solo would
        // need a second gesture nobody asked for in phase 0.
        didMutate = targets[0] !== undefined && peek.toggleSolo(targets[0]);
        break;
      case 'hide':
        didMutate = peek.setHiddenNodeIds([...peek.getHiddenNodeIds(), ...targets]);
        break;
      case 'show': {
        const drop = new Set(targets);
        didMutate = peek.setHiddenNodeIds(peek.getHiddenNodeIds().filter(id => !drop.has(id)));
        break;
      }
    }

    // No `commit` — see the class comment.
    return { didMutate };
  }
}
