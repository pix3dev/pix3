import { describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/core/command';
import { AgentKitService } from '@/services/project/agent-kit/AgentKitService';
import { InstallAgentKitCommand } from './InstallAgentKitCommand';

const context = (backend: string, status = 'ready'): CommandContext =>
  ({
    state: { project: { backend, status } },
    snapshot: {},
    container: {},
    requestedAt: Date.now(),
  }) as unknown as CommandContext;

const createCommand = (confirm: boolean) => {
  const command = new InstallAgentKitCommand();
  const agentKitService = {
    availability: new AgentKitService().availability,
    installAndShow: vi.fn(async () => undefined),
  };
  const dialogService = { showConfirmation: vi.fn(async () => confirm) };
  Object.defineProperty(command, 'agentKitService', { value: agentKitService });
  Object.defineProperty(command, 'dialogService', { value: dialogService });
  return { command, agentKitService, dialogService };
};

describe('InstallAgentKitCommand', () => {
  it('is a File menu command that asks first', () => {
    const { command } = createCommand(true);
    expect(command.metadata.menuPath).toBe('file');
    expect(command.metadata.title).toBe('Install Agent Kit…');
  });

  it('runs for local folders and workspaces, not for in-browser or cloud projects', () => {
    const { command } = createCommand(true);
    expect(command.preconditions(context('local')).canExecute).toBe(true);
    expect(command.preconditions(context('workspace')).canExecute).toBe(true);
    expect(command.preconditions(context('browser')).canExecute).toBe(false);
    expect(command.preconditions(context('cloud')).canExecute).toBe(false);
    expect(command.preconditions(context('local', 'idle')).canExecute).toBe(false);
  });

  it('installs in update mode after confirmation', async () => {
    const { command, agentKitService } = createCommand(true);
    await command.execute();
    expect(agentKitService.installAndShow).toHaveBeenCalledWith({ update: true });
  });

  it('does nothing when cancelled', async () => {
    const { command, agentKitService } = createCommand(false);
    await command.execute();
    expect(agentKitService.installAndShow).not.toHaveBeenCalled();
  });
});
