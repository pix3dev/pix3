import { appState } from '@/state';
import { collectRenderabilityIssues, type NodeBase, type RenderabilityIssue } from '@pix3/runtime';

/**
 * The renderability lint, shaped for an agent tool result.
 *
 * It rides along with the tools the agent already calls (`scene_tree`, `game_observe`, the play
 * tools) instead of living behind a tool of its own: a check you have to think to run is a check
 * that gets skipped precisely when it matters. `sceneIssues` is absent — not empty — when the scene
 * is fine, so a clean result costs nothing to read.
 */
export interface RenderabilityNote {
  sceneIssues?: Array<{
    code: string;
    severity: string;
    message: string;
    nodeIds: readonly string[];
  }>;
}

export interface RenderabilityNoteOptions {
  /**
   * Include `advice`-severity findings (performance, not correctness). On for authoring surfaces
   * like `scene_tree`; off for `game_observe`, which an agent calls in a loop — repeating a
   * cost warning on every poll is how the blocking findings next to it lose their weight.
   */
  readonly includeAdvice?: boolean;
}

export const renderabilityNote = (
  roots: readonly NodeBase[],
  options: RenderabilityNoteOptions = {}
): RenderabilityNote => {
  const issues = collectRenderabilityIssues(roots, {
    targetPlatform: appState.project.manifest?.targetPlatform,
  }).filter(issue => options.includeAdvice === true || issue.severity !== 'advice');

  return issues.length === 0 ? {} : { sceneIssues: issues.map(toEntry) };
};

const toEntry = (
  issue: RenderabilityIssue
): NonNullable<RenderabilityNote['sceneIssues']>[number] => ({
  code: issue.code,
  severity: issue.severity,
  message: issue.message,
  nodeIds: issue.nodeIds,
});
