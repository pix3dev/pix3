import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer, ServiceLifetime } from '@/fw/di';
import { AgentKitService } from '@/services/project/agent-kit/AgentKitService';
import { buildAgentHandoff } from '@/services/project/agent-kit/agent-handoff';
import './pix3-agent-handoff-dialog';

const handoff = (backend: 'local' | 'workspace', pinned: string | null) =>
  buildAgentHandoff({
    id: 'spec',
    folderName: 'my-game',
    backend,
    kit: {
      version: '1.6.0',
      files: [{ path: 'AGENTS.md', action: 'written' }],
      instructions: [],
      notes: [],
      types: 'kit-tsconfig',
      mcpCliVersion: pinned,
      agentKitMetadata: { version: '1.6.0', files: ['AGENTS.md'] },
    },
    cli: pinned
      ? { kind: 'lockstep', version: pinned }
      : { kind: 'unavailable', reason: 'not-published' },
    editorVersion: '1.6.0',
    recipeTitle: 'Tapper 2D',
    hasRecipeDoc: true,
  });

const mount = async (value: ReturnType<typeof handoff>) => {
  const element = document.createElement('pix3-agent-handoff-dialog');
  element.handoff = value;
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
};

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('pix3-agent-handoff-dialog', () => {
  const container = ServiceContainer.getInstance();
  container.addService(
    container.getOrCreateToken(AgentKitService),
    AgentKitService,
    ServiceLifetime.Singleton
  );

  it('shows the start commands, the prompt and the local-folder live-channel note', async () => {
    const element = await mount(handoff('local', '1.6.0'));
    const text = element.textContent ?? '';
    expect(text).toContain('cd my-game && claude');
    expect(text).toContain('cd my-game && codex');
    expect(text).toContain('"Tapper 2D" recipe');
    expect(text).toContain('npx -y @pix3/cli@1.6.0 serve');
    expect(text).toContain('Connect to Workspace');
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('says the matching CLI is not published when .mcp.json was left out', async () => {
    const element = await mount(handoff('local', null));
    expect(element.textContent).toContain(
      'The CLI version matching this editor (1.6.0) is not published yet'
    );
    expect(element.textContent).toContain('setup claude');
  });

  it('copies a command and flips the button to Copied', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const element = await mount(handoff('workspace', '1.6.0'));
    const button = element.querySelector<HTMLButtonElement>('.agent-handoff-copy-btn');
    button?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('cd my-game && claude'));
    await element.updateComplete;
    expect(element.querySelector('.agent-handoff-copy-btn--copied')?.textContent).toContain(
      'Copied'
    );
    expect(element.textContent).toContain('Waiting for the agent');
  });
});
