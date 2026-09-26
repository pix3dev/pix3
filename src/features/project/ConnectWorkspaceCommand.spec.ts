import { describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/core/command';
import { createInitialWorkspaceConnectionState } from '@/state';

import { ConnectWorkspaceCommand } from './ConnectWorkspaceCommand';

const createContext = (overrides: {
  isPlaying?: boolean;
  backend?: string;
  workspace?: Partial<ReturnType<typeof createInitialWorkspaceConnectionState>>;
}): CommandContext =>
  ({
    state: {
      ui: { isPlaying: overrides.isPlaying ?? false },
      project: {
        backend: overrides.backend ?? 'local',
        workspace: { ...createInitialWorkspaceConnectionState(), ...overrides.workspace },
      },
    },
    snapshot: {},
    container: {},
    requestedAt: Date.now(),
  }) as unknown as CommandContext;

describe('ConnectWorkspaceCommand', () => {
  it('is a File menu command with an ellipsis (it asks before acting)', () => {
    const command = new ConnectWorkspaceCommand();
    expect(command.metadata.menuPath).toBe('file');
    expect(command.metadata.title.endsWith('…')).toBe(true);
    expect(command.metadata.menuOrder).toBe(120);
  });

  it('can run with no project open', () => {
    expect(new ConnectWorkspaceCommand().preconditions(createContext({})).canExecute).toBe(true);
  });

  it('refuses while the game is playing', () => {
    const result = new ConnectWorkspaceCommand().preconditions(createContext({ isPlaying: true }));
    expect(result.canExecute).toBe(false);
    if (!result.canExecute) {
      expect(result.reason).toMatch(/Stop the game/);
    }
  });

  it('refuses while a connection attempt is in flight', () => {
    const result = new ConnectWorkspaceCommand().preconditions(
      createContext({ workspace: { status: 'connecting' } })
    );
    expect(result.canExecute).toBe(false);
  });

  it('opens the dialog prefilled with the current workspace address', async () => {
    const command = new ConnectWorkspaceCommand();
    const dialogService = { open: vi.fn() };
    Object.defineProperty(command, 'dialogService', { value: dialogService });

    const result = await command.execute(
      createContext({
        backend: 'workspace',
        workspace: { status: 'disconnected', endpoint: 'http://localhost:9000' },
      })
    );

    expect(dialogService.open).toHaveBeenCalledWith({ endpoint: 'http://localhost:9000' });
    expect(result.didMutate).toBe(false);
  });
});
