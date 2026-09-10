import { ServiceContainer } from '@/fw/di';
import { PeekService } from '@/services/viewport/PeekService';

/**
 * The line an export dialog owes the author when their Peek mask is active.
 *
 * Peek is a per-user view mask that deliberately never reaches a file — which means the moment of
 * handing the build to someone else is the exact moment the author's screen and the artefact
 * disagree, with nothing on either to say so. None of the tools this feature was modelled on warn
 * here, and "I shipped it with the end card missing / present" is the failure mode a
 * non-serializable mask introduces. Empty string when nothing is masked, so it costs a normal
 * export nothing.
 */
export const buildPeekExportWarning = (): string => {
  let hidden: readonly string[];
  try {
    const container = ServiceContainer.getInstance();
    hidden = container
      .getService<PeekService>(container.getOrCreateToken(PeekService))
      .getSnapshot()
      .branches.filter(branch => branch.hidden)
      .map(branch => branch.label);
  } catch {
    // An export must never fail because a view service could not be resolved (e.g. a headless
    // build path or a test container without the viewport registered).
    return '';
  }
  if (hidden.length === 0) {
    return '';
  }
  return (
    `\n\nHeads up — ${hidden.length} branch${hidden.length === 1 ? '' : 'es'} ` +
    `hidden only in YOUR editor: ${hidden.join(', ')}.\n` +
    `Peek is a personal view mask, so this build SHOWS them. If they should be hidden in the game, ` +
    `set the node's "visible" (or "initiallyVisible") property instead and export again.`
  );
};
