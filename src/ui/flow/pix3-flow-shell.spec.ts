import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { appState, resetAppState } from '@/state';
import { createDefaultProjectManifest, type ProjectManifest } from '@/core/ProjectManifest';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { IconService } from '@/services/editor/IconService';
import { AgentChatService } from '@/services/agent/AgentChatService';
import { FlowPlanService } from '@/services/flow/FlowPlanService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { DialogService } from '@/services/editor/DialogService';
import { PrototypeBootstrapService } from '@/services/flow/PrototypeBootstrapService';

// The chat panel, the mode switch and the sidebar are whole features with their own service graphs;
// this file is about the shell's stage/document decision, so they stay undefined custom elements
// (inert tags) and are asserted on by tag rather than by their contents.
vi.mock('@/ui/agent-chat/pix3-agent-chat-panel', () => ({}));
vi.mock('@/ui/shared/pix3-mode-switch', () => ({}));
vi.mock('./pix3-flow-side-panel', () => ({}));

type TestShell = HTMLElement & { updateComplete: Promise<unknown> };

class CommandDispatcherStub {
  executeById = vi.fn(async () => true);
}

class GamePlaySessionServiceStub {
  registerTabHost = vi.fn();
  unregisterTabHost = vi.fn();
}

class IconServiceStub {
  getIcon = vi.fn(() => '');
}

class AgentChatServiceStub {
  subscribe = vi.fn((listener: (state: unknown) => void) => {
    listener({ status: 'idle', activeTool: null, messages: [] });
    return () => undefined;
  });
}

class FlowPlanServiceStub {
  load = vi.fn(async () => ({ pitch: null, title: 'Ant Wars', steps: [] }));
}

class DialogServiceStub {
  showConfirmation = vi.fn(async () => true);
}

class PrototypeBootstrapServiceStub {
  startPrototype = vi.fn(async () => undefined);
  reset = vi.fn();
  subscribe = vi.fn((listener: (status: unknown) => void) => {
    listener({ phase: 'idle', message: '', brief: null, error: null });
    return () => undefined;
  });
}

class ProjectStorageServiceStub {
  readTextFile = vi.fn(async () => '# Ant Wars\n\n**Pitch:** _to be filled_\n');
  readBlob = vi.fn(async () => new Blob());
  writeTextFile = vi.fn(async () => undefined);
}

const manifestWith = (metadata: Record<string, unknown>): ProjectManifest => ({
  ...createDefaultProjectManifest(),
  metadata,
});

/** Register the stubs and mount the shell over a ready project with the given manifest metadata. */
const mountShell = async (
  metadata: Record<string, unknown>
): Promise<{
  shell: TestShell;
  playSession: GamePlaySessionServiceStub;
  dialogs: DialogServiceStub;
  bootstrap: PrototypeBootstrapServiceStub;
}> => {
  resetAppState();
  const container = ServiceContainer.getInstance();
  const register = (
    type: Parameters<typeof container.getOrCreateToken>[0],
    stub: unknown
  ): void => {
    container.addService(
      container.getOrCreateToken(type),
      stub as Parameters<typeof container.addService>[1],
      'singleton'
    );
  };
  register(CommandDispatcher, CommandDispatcherStub);
  register(GamePlaySessionService, GamePlaySessionServiceStub);
  register(IconService, IconServiceStub);
  register(AgentChatService, AgentChatServiceStub);
  register(FlowPlanService, FlowPlanServiceStub);
  register(ProjectStorageService, ProjectStorageServiceStub);
  register(DialogService, DialogServiceStub);
  register(PrototypeBootstrapService, PrototypeBootstrapServiceStub);

  const playSession = container.getService<GamePlaySessionServiceStub>(
    container.getOrCreateToken(GamePlaySessionService)
  );
  // The container keeps one singleton per class and re-registering the same class is a no-op, so
  // the instance is shared across the tests in this file — reset it rather than assume a fresh one.
  playSession.registerTabHost.mockClear();
  playSession.unregisterTabHost.mockClear();
  const dialogs = container.getService<DialogServiceStub>(
    container.getOrCreateToken(DialogService)
  );
  dialogs.showConfirmation.mockClear();
  dialogs.showConfirmation.mockResolvedValue(true);
  const bootstrap = container.getService<PrototypeBootstrapServiceStub>(
    container.getOrCreateToken(PrototypeBootstrapService)
  );
  bootstrap.startPrototype.mockClear();

  appState.project.status = 'ready';
  appState.project.id = 'project-1';
  appState.project.projectName = 'Ant Wars';
  appState.project.manifest = manifestWith(metadata);

  const shell = document.createElement('pix3-flow-shell') as TestShell;
  document.body.appendChild(shell);
  await shell.updateComplete;
  // The stage/doc decision is taken in firstUpdated → onProjectChanged, which is async.
  await new Promise(resolve => setTimeout(resolve, 0));
  await shell.updateComplete;
  return { shell, playSession, dialogs, bootstrap };
};

/** Let the click's confirmation promise and the transition it awaits settle before asserting. */
const settle = async (shell: TestShell): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  await shell.updateComplete;
};

beforeAll(async () => {
  await import('./pix3-flow-shell');
});

afterEach(() => {
  document.body.innerHTML = '';
  resetAppState();
  vi.restoreAllMocks();
});

describe('Pix3FlowShell — idea stage', () => {
  it('renders the design document and never mounts the runtime', async () => {
    const { shell, playSession } = await mountShell({ flowStage: 'idea' });

    // The load-bearing half: `registerTabHost` is what mounts the game runtime, and at the idea
    // stage nothing may mount it — no scene is loaded and nothing ticks (design §3.2).
    expect(playSession.registerTabHost).not.toHaveBeenCalled();
    expect(shell.querySelector('pix3-idea-doc')).not.toBeNull();
    expect(shell.querySelector('.flow-stage__host')).toBeNull();
    expect(shell.querySelector('.flow-stage__bar')).toBeNull();
  });

  it('shows no game start commands, and hands the sidebar the idea stage', async () => {
    const { shell } = await mountShell({ flowStage: 'idea' });
    const dispatcher = ServiceContainer.getInstance().getService<CommandDispatcherStub>(
      ServiceContainer.getInstance().getOrCreateToken(CommandDispatcher)
    );

    expect(dispatcher.executeById).not.toHaveBeenCalled();
    // The sidebar IS rendered at the idea stage (V3) — it is the panel that hides the Plan tab,
    // because `design/progress.md` only exists once the expander has written it.
    const panel = shell.querySelector('pix3-flow-side-panel') as
      | (HTMLElement & { stage?: string })
      | null;
    expect(panel).not.toBeNull();
    expect(panel?.stage).toBe('idea');
  });

  it('replaces Device / Download with the live transition CTA', async () => {
    const { shell } = await mountShell({ flowStage: 'idea' });
    const cta = shell.querySelector<HTMLButtonElement>('.flow-action--cta');

    expect(cta).not.toBeNull();
    expect(cta?.disabled).toBe(false);
    expect(shell.textContent).not.toContain('Download HTML');
    expect(shell.textContent).not.toContain('Device');
  });

  it('confirms first, then runs the transition', async () => {
    const { shell, dialogs, bootstrap } = await mountShell({ flowStage: 'idea' });

    shell.querySelector<HTMLButtonElement>('.flow-action--cta')?.click();
    await settle(shell);

    expect(dialogs.showConfirmation).toHaveBeenCalledTimes(1);
    expect(bootstrap.startPrototype).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the confirmation is declined', async () => {
    const { shell, dialogs, bootstrap } = await mountShell({ flowStage: 'idea' });
    dialogs.showConfirmation.mockResolvedValue(false);

    shell.querySelector<HTMLButtonElement>('.flow-action--cta')?.click();
    await settle(shell);

    expect(dialogs.showConfirmation).toHaveBeenCalledTimes(1);
    expect(bootstrap.startPrototype).not.toHaveBeenCalled();
  });

  it('has no Game / Idea switch — there is no game to switch to', async () => {
    const { shell } = await mountShell({ flowStage: 'idea' });

    expect(shell.querySelector('.flow-view__switch')).toBeNull();
  });
});

describe('Pix3FlowShell — prototype stage', () => {
  it('mounts the runtime host and starts the stage as before', async () => {
    const { shell, playSession } = await mountShell({ projectName: 'Ant Wars' });

    expect(shell.querySelector('.flow-stage__host')).not.toBeNull();
    expect(shell.querySelector('pix3-idea-doc')).toBeNull();
    expect(playSession.registerTabHost).toHaveBeenCalledTimes(1);
    const panel = shell.querySelector('pix3-flow-side-panel') as
      | (HTMLElement & { stage?: string })
      | null;
    expect(panel?.stage).toBe('prototype');
  });

  it('offers the Game / Idea switch, with the game showing', async () => {
    const { shell } = await mountShell({ projectName: 'Ant Wars' });
    const options = shell.querySelectorAll<HTMLButtonElement>('.flow-view__option');

    expect(options.length).toBe(2);
    expect(options[0].dataset.view).toBe('game');
    expect(options[0].dataset.current).toBe('true');
    expect(shell.querySelector('pix3-idea-doc')).toBeNull();
  });

  it('shows the document on Idea while KEEPING the runtime host mounted', async () => {
    const { shell, playSession } = await mountShell({ projectName: 'Ant Wars' });

    shell.querySelector<HTMLButtonElement>('.flow-view__option[data-view="idea"]')?.click();
    await settle(shell);

    expect(shell.querySelector('pix3-idea-doc')).not.toBeNull();
    // The load-bearing assertion of the switch: `.flow-stage__host` is the element the runtime is
    // registered against, so it staying in the DOM (hidden, never unregistered) is what makes
    // coming back to Game the SAME running game rather than a restarted one.
    expect(shell.querySelector('.flow-stage__host')).not.toBeNull();
    expect(playSession.unregisterTabHost).not.toHaveBeenCalled();
    expect(playSession.registerTabHost).toHaveBeenCalledTimes(1);
    expect(shell.querySelector<HTMLElement>('.flow-stage')?.hidden).toBe(true);

    shell.querySelector<HTMLButtonElement>('.flow-view__option[data-view="game"]')?.click();
    await settle(shell);

    expect(shell.querySelector<HTMLElement>('.flow-stage')?.hidden).toBe(false);
    expect(shell.querySelector<HTMLElement>('.flow-doc')?.hidden).toBe(true);
    expect(playSession.registerTabHost).toHaveBeenCalledTimes(1);
  });
});
