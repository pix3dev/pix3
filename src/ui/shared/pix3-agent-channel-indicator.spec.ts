import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { appState, resetAppState } from '@/state';
import {
  WorkspaceAgentToolBridge,
  type AgentChannelState,
} from '@/services/project/workspace/WorkspaceAgentToolBridge';

type Element = HTMLElement & { updateComplete: Promise<unknown> };

class BridgeStub {
  state: AgentChannelState = {
    enabled: true,
    seen: true,
    agentName: 'claude-code',
    activity: 'running',
    activeTool: 'game_run',
    lastCallAt: 1,
    permission: 'allowed',
    generationsUsed: 3,
    prompt: { id: 1, agentName: 'claude-code', root: '/work/game', tool: 'generate_asset' },
  };
  private listener: (() => void) | null = null;
  decide = vi.fn();
  setEnabled = vi.fn();
  revokeGeneration = vi.fn();
  getState(): AgentChannelState {
    return this.state;
  }
  subscribe(listener: () => void): () => void {
    this.listener = listener;
    return () => undefined;
  }
  emit(): void {
    this.listener?.();
  }
}

beforeAll(async () => {
  await import('./pix3-agent-channel-indicator');
});

afterEach(() => {
  document.body.innerHTML = '';
  resetAppState();
});

describe('pix3-agent-channel-indicator', () => {
  it('shows the activity, the revoke button and the generation prompt for a workspace', async () => {
    const container = ServiceContainer.getInstance();
    const stub = new BridgeStub();
    container.addService(
      container.getOrCreateToken(WorkspaceAgentToolBridge),
      class {
        constructor() {
          return stub;
        }
      },
      'singleton'
    );
    appState.project.backend = 'workspace';
    appState.project.status = 'ready';

    const el = document.createElement('pix3-agent-channel-indicator') as Element;
    document.body.appendChild(el);
    await el.updateComplete;

    const pill = el.querySelector<HTMLButtonElement>('.status-agent-channel');
    expect(pill?.textContent).toContain('Agent: game_run');
    expect(pill?.querySelector('svg')).not.toBeNull();
    const revoke = el.querySelector<HTMLButtonElement>('.agent-channel-revoke');
    expect(revoke?.getAttribute('aria-label')).toBe('Revoke asset generation permission');
    const prompt = el.querySelector('.agent-permission');
    expect(prompt?.textContent).toContain('claude-code');
    expect(prompt?.textContent).toContain('not verified');
    expect(prompt?.textContent).toContain('/work/game');

    const [allow, deny] = Array.from(
      el.querySelectorAll<HTMLButtonElement>('.agent-permission__btn')
    );
    allow.click();
    expect(stub.decide).toHaveBeenCalledWith('allow');
    deny.click();
    expect(stub.decide).toHaveBeenCalledWith('deny');
    revoke?.click();
    expect(stub.revokeGeneration).toHaveBeenCalled();
    pill?.click();
    expect(stub.setEnabled).toHaveBeenCalledWith(false);

    stub.state = { ...stub.state, seen: false, prompt: null };
    stub.emit();
    await el.updateComplete;
    expect(el.querySelector('.status-agent-channel')).toBeNull();
  });
});
