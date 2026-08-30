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
// The scene view mounts the shared WebGL viewport; the shell's job is only to decide WHEN it is on
// screen, so it stays an inert tag here and is asserted on by tag.
vi.mock('./pix3-flow-scene-view', () => ({}));

type TestShell = HTMLElement & { updateComplete: Promise<unknown> };

class CommandDispatcherStub {
  // The command id is declared so tests can assert on WHICH command the shell dispatched.
  executeById = vi.fn(async (_commandId: string) => true);
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
  metadata: Record<string, unknown>,
  manifestOverrides: Partial<ProjectManifest> = {}
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
  // In Vibe a scene exists only after something loads one; most cases here want the Scene view
  // offered, so give them one. The "no scene yet" case clears it explicitly.
  appState.scenes.activeSceneId = 'main';
  appState.project.projectName = 'Ant Wars';
  appState.project.manifest = { ...manifestWith(metadata), ...manifestOverrides };

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

describe('Pix3FlowShell — the entry-scene run', () => {
  /**
   * The invariant phase 1 of the plan established, restated as a test now that a SECOND start
   * command is reachable from this shell: the automatic launch is the gameplay scene. Starting the
   * stage on the entry scene is what used to make the menu both what the user watched and — because
   * `appState.scenes.activeSceneId` is the editing surface — what every agent edit landed in.
   */
  it('auto-starts the stage on the active scene, never on the entry scene', async () => {
    await mountShell(
      { projectName: 'Ant Wars' },
      { defaultExportScenePath: 'scenes/menu.pix3scene' }
    );
    const dispatcher = ServiceContainer.getInstance().getService<CommandDispatcherStub>(
      ServiceContainer.getInstance().getOrCreateToken(CommandDispatcher)
    );

    const dispatched = dispatcher.executeById.mock.calls.map(call => call[0]);
    expect(dispatched).toContain('game.start');
    expect(dispatched).not.toContain('game.start-main');
  });

  it('offers the entry-scene run as a secondary action, and dispatches it on click', async () => {
    const { shell } = await mountShell(
      { projectName: 'Ant Wars' },
      { defaultExportScenePath: 'scenes/menu.pix3scene' }
    );
    const dispatcher = ServiceContainer.getInstance().getService<CommandDispatcherStub>(
      ServiceContainer.getInstance().getOrCreateToken(CommandDispatcher)
    );
    dispatcher.executeById.mockClear();

    const secondary = shell.querySelector<HTMLButtonElement>('.flow-stage__button--secondary');
    expect(secondary).not.toBeNull();
    secondary?.click();
    await settle(shell);

    expect(dispatcher.executeById).toHaveBeenCalledWith('game.start-main');
  });

  /**
   * The stage auto-starts on mount, so this button is clicked while a game is already running
   * almost every time — and both play commands refuse to start a second one. Gating the button on
   * `!isPlaying` therefore hid it exactly when it was wanted; stopping first is what the click
   * means.
   */
  it('stops the running game before starting from the entry scene', async () => {
    const { shell } = await mountShell(
      { projectName: 'Ant Wars' },
      { defaultExportScenePath: 'scenes/menu.pix3scene' }
    );
    const dispatcher = ServiceContainer.getInstance().getService<CommandDispatcherStub>(
      ServiceContainer.getInstance().getOrCreateToken(CommandDispatcher)
    );
    appState.ui.isPlaying = true;
    await settle(shell);
    dispatcher.executeById.mockClear();

    shell.querySelector<HTMLButtonElement>('.flow-stage__button--secondary')?.click();
    await settle(shell);

    expect(dispatcher.executeById.mock.calls.map(call => call[0])).toEqual([
      'game.stop',
      'game.start-main',
    ]);
  });

  /**
   * Without an entry scene `game.start-main` degrades to playing the active scene — the same run
   * the Play button already gives. A button that silently does nothing new is worse than no button.
   */
  it('hides the secondary action when the project declares no entry scene', async () => {
    const { shell } = await mountShell({ projectName: 'Ant Wars' });

    expect(shell.querySelector('.flow-stage__button--secondary')).toBeNull();
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

  /**
   * The controls sit ABOVE the game, in the corner the scene view puts its own Play in. Under the
   * game they read as a caption of something that just ended, and they moved across the column
   * every time the view changed — the button you press next must not be the one you hunt for.
   */
  it('puts the stage controls above the game frame', async () => {
    const { shell } = await mountShell({ projectName: 'Ant Wars' });
    const stage = shell.querySelector('.flow-stage');
    const bar = shell.querySelector('.flow-stage__bar');
    const frame = shell.querySelector('.flow-stage__frame');

    expect(bar).not.toBeNull();
    expect(frame).not.toBeNull();
    expect(stage?.firstElementChild).toBe(bar);
    expect(bar!.compareDocumentPosition(frame!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers the view switch, with the game showing', async () => {
    const { shell } = await mountShell({ projectName: 'Ant Wars' });
    const options = shell.querySelectorAll<HTMLButtonElement>('.flow-view__option');

    expect(options.length).toBe(3);
    expect(options[0].dataset.view).toBe('game');
    expect(options[0].dataset.current).toBe('true');
    // Both alternatives are lazy: nothing but the game is mounted until it is asked for.
    expect(shell.querySelector('pix3-idea-doc')).toBeNull();
    expect(shell.querySelector('pix3-flow-scene-view')).toBeNull();
  });

  /**
   * The third view. A stopped game leaves the stage with nothing on it and no way to point at an
   * object, which is the gap this closes: the scene is loaded the whole time, it just had no
   * surface in Vibe.
   */
  it('offers Scene between Game and Idea', async () => {
    const { shell } = await mountShell({ projectName: 'Ant Wars' });
    const options = shell.querySelectorAll<HTMLButtonElement>('.flow-view__option');

    expect([...options].map(option => option.dataset.view)).toEqual(['game', 'scene', 'idea']);
    expect(options[1].disabled).toBe(false);
  });

  it('disables Scene until a scene has actually been loaded', async () => {
    const { shell } = await mountShell({ projectName: 'Ant Wars' });
    appState.scenes.activeSceneId = null;
    await settle(shell);

    const scene = shell.querySelector<HTMLButtonElement>('.flow-view__option[data-view="scene"]');
    expect(scene?.disabled).toBe(true);
    // A greyed-out control that does not say why is a control the user retries.
    expect(scene?.title).toContain('Play the game once');
  });

  it('shows the scene view on Scene while KEEPING the runtime host mounted', async () => {
    const { shell, playSession } = await mountShell({ projectName: 'Ant Wars' });

    shell.querySelector<HTMLButtonElement>('.flow-view__option[data-view="scene"]')?.click();
    await settle(shell);

    expect(shell.querySelector('pix3-flow-scene-view')).not.toBeNull();
    expect(shell.querySelector<HTMLElement>('.flow-stage')?.hidden).toBe(true);
    // Same rule as the Idea half: the runtime host must survive the swap, or coming back to Game
    // would be a fresh game with the user's score gone.
    expect(shell.querySelector('.flow-stage__host')).not.toBeNull();
    expect(playSession.unregisterTabHost).not.toHaveBeenCalled();
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

/**
 * The Files column lists every design document, so clicking one has to put it where documents are
 * read — the Idea view — rather than leave the click looking like it did nothing.
 */
describe('Pix3FlowShell — opening a document from the sidebar', () => {
  const openDocument = async (shell: TestShell, path: string): Promise<void> => {
    shell
      .querySelector('pix3-flow-side-panel')
      ?.dispatchEvent(
        new CustomEvent('document-open', { detail: { path }, bubbles: true, composed: true })
      );
    await settle(shell);
  };

  it('shows the clicked document and brings the Idea view forward', async () => {
    const { shell } = await mountShell({ projectName: 'Ant Wars' });
    expect(shell.querySelector('pix3-idea-doc')).toBeNull();

    await openDocument(shell, 'design/decisions.md');

    expect(shell.querySelector('pix3-idea-doc')?.getAttribute('doc-path')).toBe(
      'design/decisions.md'
    );
    expect(shell.querySelector<HTMLElement>('.flow-doc')?.hidden).toBe(false);
    expect(
      shell.querySelector<HTMLButtonElement>('.flow-view__option[data-view="idea"]')?.dataset
        .current
    ).toBe('true');
    // The column is told which document is on screen, so its row is the one marked.
    const panel = shell.querySelector('pix3-flow-side-panel') as HTMLElement & {
      activeDoc?: string;
    };
    expect(panel.activeDoc).toBe('design/decisions.md');
  });

  it('swaps the document at the idea stage, where there is no view to switch', async () => {
    const { shell } = await mountShell({ flowStage: 'idea' });
    expect(shell.querySelector('pix3-idea-doc')?.getAttribute('doc-path')).toBe('design/gdd.md');

    await openDocument(shell, 'design/plan.md');

    expect(shell.querySelector('pix3-idea-doc')?.getAttribute('doc-path')).toBe('design/plan.md');
  });
});

/**
 * The view follows the play state, because the two answers to "what is worth looking at" are
 * exactly opposite: a running game is the thing, and a stopped one leaves an empty box where the
 * scene the user can navigate and click should be.
 */
describe('Pix3FlowShell — the view follows play state', () => {
  const currentView = (shell: TestShell): string | undefined =>
    shell.querySelector<HTMLButtonElement>('.flow-view__option[data-current="true"]')?.dataset.view;

  it('switches to Scene when the game stops', async () => {
    const { shell } = await mountShell({ projectName: 'Ant Wars' });
    appState.ui.isPlaying = true;
    await settle(shell);
    expect(currentView(shell)).toBe('game');

    appState.ui.isPlaying = false;
    await settle(shell);

    expect(currentView(shell)).toBe('scene');
  });

  it('switches back to Game when it starts again', async () => {
    const { shell } = await mountShell({ projectName: 'Ant Wars' });
    appState.ui.isPlaying = true;
    await settle(shell);
    appState.ui.isPlaying = false;
    await settle(shell);
    expect(currentView(shell)).toBe('scene');

    appState.ui.isPlaying = true;
    await settle(shell);

    expect(currentView(shell)).toBe('game');
  });

  /**
   * Reading the design document while the game is stopped is a place people deliberately go.
   * Yanking it out from under them the moment a background restart lands would be a bug.
   */
  it('never moves the user off the Idea view', async () => {
    const { shell } = await mountShell({ projectName: 'Ant Wars' });
    appState.ui.isPlaying = true;
    await settle(shell);
    shell.querySelector<HTMLButtonElement>('.flow-view__option[data-view="idea"]')?.click();
    await settle(shell);
    expect(currentView(shell)).toBe('idea');

    appState.ui.isPlaying = false;
    await settle(shell);
    expect(currentView(shell)).toBe('idea');

    appState.ui.isPlaying = true;
    await settle(shell);
    expect(currentView(shell)).toBe('idea');
  });

  it('stays on Game when no scene has been loaded to switch to', async () => {
    const { shell } = await mountShell({ projectName: 'Ant Wars' });
    appState.scenes.activeSceneId = null;
    appState.ui.isPlaying = true;
    await settle(shell);

    appState.ui.isPlaying = false;
    await settle(shell);

    expect(currentView(shell)).toBe('game');
  });

  /**
   * The entry-scene replay stops the game and immediately starts it again. Following play state
   * through that would flash the Scene view in the middle of a run the user asked for.
   */
  it('does not flash the Scene view during the entry-scene replay', async () => {
    const { shell } = await mountShell(
      { projectName: 'Ant Wars' },
      { defaultExportScenePath: 'scenes/menu.pix3scene' }
    );
    appState.ui.isPlaying = true;
    await settle(shell);

    const secondary = shell.querySelector<HTMLButtonElement>('.flow-stage__button--secondary');
    secondary?.click();
    // The stop half of the replay, observed exactly as the commands would produce it.
    appState.ui.isPlaying = false;
    await settle(shell);

    expect(currentView(shell)).toBe('game');
  });
});
