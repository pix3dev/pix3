import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A source scan over the Flow shell, guarding the one thing a behavioural test cannot state as
 * cheaply: which command the stage's **automatic** launch is allowed to name.
 *
 * The bug this exists for shipped once. Dispatching `game.start-main` from `startStage()` put every
 * recipe project's MENU on the stage, and — because `appState.scenes.activeSceneId` is
 * simultaneously what plays, what the viewport shows and what the agent edits — silently redirected
 * every subsequent agent edit into the menu scene. The fix is one identifier, so the regression is
 * one identifier away, and it is invisible in review: both commands read like "start the game".
 *
 * The entry-scene run itself is legitimate (the menu→game transition is a real thing to check), so
 * the scan does not ban the command from the file. It bans it from the automatic path, and pins the
 * one place allowed to name it: the `ENTRY_SCENE_PLAY_COMMAND` constant that the person-initiated
 * secondary action dispatches.
 */
const SHELL_SOURCE = readFileSync(path.resolve(__dirname, 'pix3-flow-shell.ts'), 'utf-8');

const ENTRY_SCENE_LITERAL = "'game.start-main'";

/**
 * The body of a private method, from its signature to the start of the next member. Prose in the
 * doc comment ABOVE the method is deliberately outside the slice — the comments explain the fork,
 * and a scan that forbade explaining it would be the wrong incentive.
 */
const methodBody = (source: string, signature: string): string => {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found — the guard is scanning nothing`).toBeGreaterThan(-1);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:private|public|protected|async|render|\/\*\*)/);
  return end === -1 ? rest : rest.slice(0, end);
};

describe('Flow stage launch', () => {
  it('auto-launches on gameplay, and never names the entry-scene command to do it', () => {
    const body = methodBody(SHELL_SOURCE, 'private async startStage(');

    expect(body).toContain("'game.start'");
    expect(body).not.toContain(ENTRY_SCENE_LITERAL);
    expect(body).not.toContain('ENTRY_SCENE_PLAY_COMMAND');
  });

  it('names the entry-scene command exactly once, at its declared constant', () => {
    const occurrences = SHELL_SOURCE.split(ENTRY_SCENE_LITERAL).length - 1;

    expect(occurrences).toBe(1);
    expect(SHELL_SOURCE).toContain(`const ENTRY_SCENE_PLAY_COMMAND = ${ENTRY_SCENE_LITERAL};`);
  });

  it('keeps the primary stage button on the active-scene run', () => {
    const body = methodBody(SHELL_SOURCE, 'private renderStageBar(');

    expect(body).toContain("this.isPlaying ? 'game.stop' : 'game.start'");
  });
});
