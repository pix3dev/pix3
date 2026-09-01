import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { appState, resetAppState } from '@/state';
import { AgentChatService } from '@/services/agent/AgentChatService';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import { IconService } from '@/services/editor/IconService';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { SceneManager, type SceneGraph } from '@pix3/runtime';

// The editor tab is a whole feature with its own service graph and a WebGL renderer behind it; this
// file is about the wrapper's two jobs (the visibility flag and the selection chip), so the tab
// stays an undefined custom element — an inert tag in the tree.
vi.mock('@/ui/viewport/editor-tab', () => ({}));

interface SceneViewElement extends HTMLElement {
  updateComplete: Promise<unknown>;
  active: boolean;
}

class AgentChatStub {
  readonly requests: {
    attachment: { name: string; content: string } | null;
    replaceKey?: string;
  }[] = [];

  composeContext = vi.fn(
    (request: { attachment: { name: string; content: string } | null; replaceKey?: string }) => {
      this.requests.push(request);
    }
  );

  clearComposeContext = vi.fn((replaceKey: string) => {
    this.requests.push({ attachment: null, replaceKey });
  });
}

class ViewportRendererStub {
  requestRender = vi.fn();
}

class CommandDispatcherStub {
  executeById = vi.fn(async () => true);
}

class OperationServiceStub {
  /** Operation ids handed to `invoke`, in order. */
  readonly invoked: string[] = [];
  /** Resolved when the test lets the in-flight save finish; null = resolve immediately. */
  gate: (() => void) | null = null;

  invoke = vi.fn(async (operation: { metadata: { id: string } }) => {
    this.invoked.push(operation.metadata.id);
    if (this.gate) {
      await new Promise<void>(resolve => {
        this.gate = resolve;
      });
    }
    // What the real SaveSceneOperation does, and the only part this component reads back.
    const sceneId = appState.scenes.activeSceneId;
    const descriptor = sceneId ? appState.scenes.descriptors[sceneId] : undefined;
    if (descriptor) {
      descriptor.isDirty = false;
      descriptor.lastSavedAt = Date.now();
    }
    return { didMutate: true };
  });
}

class SceneManagerStub {
  graph: SceneGraph | null = null;
  getActiveSceneGraph = vi.fn((): SceneGraph | null => this.graph);
}

const container = (): ServiceContainer => ServiceContainer.getInstance();
const agentChat = (): AgentChatStub =>
  container().getService<AgentChatStub>(container().getOrCreateToken(AgentChatService));
const renderer = (): ViewportRendererStub =>
  container().getService<ViewportRendererStub>(
    container().getOrCreateToken(ViewportRendererService)
  );
const commands = (): CommandDispatcherStub =>
  container().getService<CommandDispatcherStub>(container().getOrCreateToken(CommandDispatcher));
const scenes = (): SceneManagerStub =>
  container().getService<SceneManagerStub>(container().getOrCreateToken(SceneManager));
const operations = (): OperationServiceStub =>
  container().getService<OperationServiceStub>(container().getOrCreateToken(OperationService));

const graphOf = (entries: { id: string; name: string; type: string }[]): SceneGraph =>
  ({
    rootNodes: [],
    nodeMap: new Map(entries.map(entry => [entry.id, entry])),
  }) as unknown as SceneGraph;

/** Let the valtio notification (a microtask) and the render that follows it land. */
const settle = async (element: SceneViewElement): Promise<void> => {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await element.updateComplete;
  }
};

const mount = async (): Promise<SceneViewElement> => {
  const element = document.createElement('pix3-flow-scene-view') as SceneViewElement;
  document.body.appendChild(element);
  await settle(element);
  return element;
};

let AUTOSAVE_DEBOUNCE_MS = 0;
let SAVED_RECEIPT_MS = 0;

beforeAll(async () => {
  const module = await import('./pix3-flow-scene-view');
  ({ AUTOSAVE_DEBOUNCE_MS, SAVED_RECEIPT_MS } = module);
});

beforeEach(() => {
  resetAppState();
  const c = container();
  c.addService(c.getOrCreateToken(AgentChatService), AgentChatStub, 'singleton');
  c.addService(c.getOrCreateToken(IconService), IconService, 'singleton');
  c.addService(c.getOrCreateToken(ViewportRendererService), ViewportRendererStub, 'singleton');
  c.addService(c.getOrCreateToken(SceneManager), SceneManagerStub, 'singleton');
  c.addService(c.getOrCreateToken(CommandDispatcher), CommandDispatcherStub, 'singleton');
  c.addService(c.getOrCreateToken(OperationService), OperationServiceStub, 'singleton');
  // The container hands out the SAME stub instance for every test in this file.
  agentChat().requests.length = 0;
  agentChat().composeContext.mockClear();
  agentChat().clearComposeContext.mockClear();
  renderer().requestRender.mockClear();
  commands().executeById.mockClear();
  operations().invoke.mockClear();
  operations().invoked.length = 0;
  operations().gate = null;
  scenes().graph = null;
  vi.useRealTimers();
});

afterEach(() => {
  document.body.innerHTML = '';
  resetAppState();
});

describe('pix3-flow-scene-view — the renderer permission slip', () => {
  /**
   * `ViewportRendererService` suppresses every frame while the workspace is `flow`. This flag is
   * the only thing that lifts it, so a view that forgets to raise it renders black.
   */
  it('raises the flag on mount and asks for the first frame', async () => {
    const element = await mount();

    expect(appState.ui.flowSceneViewVisible).toBe(true);
    // Raising the flag lifts the suppression but marks nothing dirty — the frame has to be asked
    // for, or the viewport waits for the idle heartbeat.
    expect(renderer().requestRender).toHaveBeenCalled();
    expect(element.isConnected).toBe(true);
  });

  it('drops the flag when the shell hides it, and raises it again on the way back', async () => {
    const element = await mount();
    renderer().requestRender.mockClear();

    element.active = false;
    await settle(element);
    expect(appState.ui.flowSceneViewVisible).toBe(false);
    expect(renderer().requestRender).not.toHaveBeenCalled();

    element.active = true;
    await settle(element);
    expect(appState.ui.flowSceneViewVisible).toBe(true);
    expect(renderer().requestRender).toHaveBeenCalledTimes(1);
  });

  it('drops the flag on disconnect', async () => {
    const element = await mount();

    element.remove();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(appState.ui.flowSceneViewVisible).toBe(false);
  });
});

describe('pix3-flow-scene-view — the selection chip', () => {
  it('raises a chip naming the selected nodes and their ids', async () => {
    scenes().graph = graphOf([{ id: 'node-3', name: 'Player', type: 'Sprite2D' }]);
    const element = await mount();

    appState.selection.nodeIds = ['node-3'];
    await settle(element);

    expect(agentChat().composeContext).toHaveBeenCalledTimes(1);
    const request = agentChat().requests.at(-1);
    expect(request?.replaceKey).toBe('vibe-selection');
    expect(request?.attachment?.name).toBe('Player (Sprite2D)');
    expect(request?.attachment?.content).toContain('Player (Sprite2D) [node-3]');
    // The strip is the user-facing half: it has to say what the chip says.
    expect(element.textContent).toContain('Player (Sprite2D)');
  });

  it('retracts the chip when the selection is cleared', async () => {
    scenes().graph = graphOf([{ id: 'node-3', name: 'Player', type: 'Sprite2D' }]);
    const element = await mount();

    appState.selection.nodeIds = ['node-3'];
    await settle(element);
    appState.selection.nodeIds = [];
    await settle(element);

    expect(agentChat().clearComposeContext).toHaveBeenCalledWith('vibe-selection');
  });

  /**
   * `appState.selection` also carries the hovered node, which changes on every pointer move. A chip
   * re-raised dozens of times a second would churn the composer for a selection nobody changed.
   */
  it('does not re-raise the chip when only the hover changes', async () => {
    scenes().graph = graphOf([{ id: 'node-3', name: 'Player', type: 'Sprite2D' }]);
    const element = await mount();

    appState.selection.nodeIds = ['node-3'];
    await settle(element);
    agentChat().composeContext.mockClear();

    appState.selection.hoveredNodeId = 'node-9';
    await settle(element);
    appState.selection.hoveredNodeId = null;
    await settle(element);

    expect(agentChat().composeContext).not.toHaveBeenCalled();
  });

  it('caps the list and says how many more there are', async () => {
    scenes().graph = graphOf(
      ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, name: id.toUpperCase(), type: 'Sprite2D' }))
    );
    const element = await mount();

    appState.selection.nodeIds = ['a', 'b', 'c', 'd', 'e', 'f'];
    await settle(element);

    expect(element.textContent).toContain('+2 more');
    expect(agentChat().requests.at(-1)?.attachment?.name).toBe('6 nodes selected');
  });
});

/**
 * The stage's own Play/Restart bar lives inside `.flow-stage`, which is hidden while this view is
 * up — and a stop is what drops the user here in the first place. Without this button the way back
 * to a running game is off screen exactly when the game is stopped.
 */
describe('pix3-flow-scene-view — the way back to the game', () => {
  it('starts the game from the strip', async () => {
    const element = await mount();

    element.querySelector<HTMLButtonElement>('.flow-scene__play')?.click();
    await settle(element);

    expect(commands().executeById).toHaveBeenCalledWith('game.start');
  });
});

/**
 * Vibe has no Ctrl+S, no tab and no dirty marker, and Download HTML builds from the FILES — so a
 * gizmo edit made here used to live in memory only and die on the next reload. This is the write-back
 * that closes it, and the invariants are: it happens, it is debounced, and it never loses an edit at
 * a hand-off (the stage switching to Game, or Vibe unmounting).
 */
describe('pix3-flow-scene-view — the write-back', () => {
  /** A project + scene in the state a user edit leaves behind. */
  const dirtyScene = (): void => {
    appState.project.status = 'ready';
    appState.project.backend = 'local';
    appState.scenes.activeSceneId = 'main';
    appState.scenes.descriptors.main = {
      id: 'main',
      filePath: 'res://scenes/main.pix3scene',
      name: 'main',
      version: '1.0',
      isDirty: true,
      lastSavedAt: null,
    };
  };

  it('writes the dirty scene back after the edit settles', async () => {
    await mount();
    vi.useFakeTimers();

    dirtyScene();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);

    // `invoke`, never `invokeAndPush`: the save must not land on the undo stack, or every gizmo edit
    // in Vibe would cost two Ctrl+Z — the second undoing a save the user cannot see.
    expect(operations().invoked).toEqual(['scene.save']);
    expect(appState.scenes.descriptors.main?.isDirty).toBe(false);
  });

  it('waits for the burst to settle instead of saving per change', async () => {
    await mount();
    vi.useFakeTimers();

    dirtyScene();
    await vi.advanceTimersByTimeAsync(400);
    appState.scenes.nodeDataChangeSignal += 1;
    await vi.advanceTimersByTimeAsync(400);
    appState.scenes.nodeDataChangeSignal += 1;
    await vi.advanceTimersByTimeAsync(400);
    expect(operations().invoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(operations().invoke).toHaveBeenCalledTimes(1);
  });

  /**
   * The hand-off is where an edit gets lost: Play hides this view, and the game — plus Download HTML
   * — reads from the file. A pending debounce has to go out before the stage changes hands.
   */
  it('flushes the pending write when the stage switches to the game', async () => {
    const element = await mount();
    vi.useFakeTimers();

    dirtyScene();
    await vi.advanceTimersByTimeAsync(200);
    expect(operations().invoke).not.toHaveBeenCalled();

    element.active = false;
    await vi.advanceTimersByTimeAsync(0);
    await element.updateComplete;
    await vi.advanceTimersByTimeAsync(0);

    expect(operations().invoked).toEqual(['scene.save']);
  });

  it('flushes the pending write when Vibe unmounts', async () => {
    const element = await mount();
    vi.useFakeTimers();

    dirtyScene();
    await vi.advanceTimersByTimeAsync(200);
    element.remove();
    await vi.advanceTimersByTimeAsync(0);

    expect(operations().invoked).toEqual(['scene.save']);
  });

  /** A collab project synchronizes through Yjs — writing its file from here fights the sync. */
  it('leaves a cloud project to its own synchronization', async () => {
    await mount();
    vi.useFakeTimers();

    dirtyScene();
    appState.project.backend = 'cloud';
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);

    expect(operations().invoke).not.toHaveBeenCalled();
  });

  /**
   * The agent saves after its own mutations. A hidden view arming as well would race it for the same
   * file for no gain — only the view a person can actually edit through is responsible.
   */
  it('does not arm while the view is hidden', async () => {
    const element = await mount();
    element.active = false;
    await settle(element);
    vi.useFakeTimers();

    dirtyScene();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);

    expect(operations().invoke).not.toHaveBeenCalled();
  });

  it('says nothing about saving until there is something to say', async () => {
    const element = await mount();
    expect(element.textContent).not.toContain('Saved');

    vi.useFakeTimers();
    dirtyScene();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);
    await element.updateComplete;
    expect(element.textContent).toContain('Saved');

    // The receipt is transient: it answers "is my change in the file yet", once.
    await vi.advanceTimersByTimeAsync(SAVED_RECEIPT_MS + 50);
    await element.updateComplete;
    expect(element.textContent).not.toContain('Saved');
  });
});
