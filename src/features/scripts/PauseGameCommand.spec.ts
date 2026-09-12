import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/core/command';
import { appState, getAppStateSnapshot } from '@/state';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';

import { PauseGameCommand } from './PauseGameCommand';
import { SetPlayPausedOperation } from './SetPlayPausedOperation';

const context = (): CommandContext =>
  ({
    state: appState,
    snapshot: getAppStateSnapshot(),
    container: {} as CommandContext['container'],
    requestedAt: 0,
  }) as CommandContext;

afterEach(() => {
  appState.ui.isPlaying = false;
  appState.ui.playModeStatus = 'stopped';
});

describe('PauseGameCommand', () => {
  const makeCommand = (togglePaused = vi.fn(async () => {})) => ({
    command: new PauseGameCommand({ togglePaused } as unknown as GamePlaySessionService),
    togglePaused,
  });

  it('refuses to run while nothing is playing', () => {
    appState.ui.isPlaying = false;
    const { command, togglePaused } = makeCommand();

    expect(command.preconditions(context()).canExecute).toBe(false);
    expect(togglePaused).not.toHaveBeenCalled();
  });

  it('hands the toggle to the play session', async () => {
    appState.ui.isPlaying = true;
    const { command, togglePaused } = makeCommand();

    expect(command.preconditions(context()).canExecute).toBe(true);
    await command.execute();
    expect(togglePaused).toHaveBeenCalledTimes(1);
  });
});

/**
 * A pause is a view onto the running game, not an edit to the project. The operation therefore
 * returns no `commit` — an undo entry for it would be one that silently resumed (or re-froze) the
 * game with nothing on screen to explain why.
 */
describe('SetPlayPausedOperation', () => {
  it('moves the status without pushing anything undoable', async () => {
    appState.ui.isPlaying = true;
    appState.ui.playModeStatus = 'playing';

    const result = await new SetPlayPausedOperation({ paused: true }).perform(context());

    expect(result.didMutate).toBe(true);
    expect(result.commit).toBeUndefined();
    expect(appState.ui.playModeStatus).toBe('paused');
  });

  it('does nothing while the game is stopped', async () => {
    appState.ui.isPlaying = false;
    appState.ui.playModeStatus = 'stopped';

    const result = await new SetPlayPausedOperation({ paused: true }).perform(context());

    expect(result.didMutate).toBe(false);
    expect(appState.ui.playModeStatus).toBe('stopped');
  });
});
