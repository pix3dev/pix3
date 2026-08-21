import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { CloudProjectService } from '@/services/cloud/CloudProjectService';
import { DialogService } from '@/services/editor/DialogService';
import { IconService } from '@/services/editor/IconService';
import { ProjectLifecycleService } from '@/services/project/ProjectLifecycleService';
import { ProjectService } from '@/services/project/ProjectService';
import { type ApiProject } from '@/services/cloud/ApiClient';
import { appState, resetAppState } from '@/state';
import { WorkspaceModeService } from '@/services/editor/WorkspaceModeService';
import { PrototypeBootstrapService } from '@/services/flow/PrototypeBootstrapService';
import { EditorSettingsService } from '@/services/editor/EditorSettingsService';
import { BridgeConnectionService } from '@/services/llm/BridgeConnectionService';
import { AgentSettingsService } from '@/services/agent/AgentSettingsService';
import { LlmProviderRegistry } from '@/services/llm/LlmProviderRegistry';

type TestWelcomeElement = HTMLElement & { updateComplete: Promise<unknown> };

class ProjectServiceStub {
  getRecentProjects = vi.fn(() => []);
  openProjectViaPicker = vi.fn(async () => undefined);
  openRecentProject = vi.fn(async () => undefined);
  removeRecentProject = vi.fn();
}

class IconServiceStub {
  getIcon = vi.fn(() => '');
}

class DialogServiceStub {
  showConfirmation = vi.fn(async () => true);
}

class ProjectLifecycleServiceStub {
  showCreateDialog = vi.fn(async () => undefined);
}

class CloudProjectServiceStub {
  public loadProjects = vi.fn(async () => undefined);
  public openProject = vi.fn(async () => undefined);
  public deleteProject = vi.fn(async () => undefined);

  private state = {
    projects: [] as ApiProject[],
    isLoading: false,
  };

  private listeners = new Set<(state: { projects: ApiProject[]; isLoading: boolean }) => void>();

  subscribe(listener: (state: { projects: ApiProject[]; isLoading: boolean }) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  setState(projects: ApiProject[], isLoading = false): void {
    this.state = { projects, isLoading };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

beforeAll(async () => {
  await import('./pix3-welcome');
});

afterEach(() => {
  document.body.innerHTML = '';
  resetAppState();
  vi.restoreAllMocks();
});

describe('Pix3Welcome', () => {
  it('shows delete only for projects owned by the current user', async () => {
    resetAppState();
    appState.auth.user = {
      id: 'owner-1',
      email: 'owner@example.com',
      username: 'owner',
      is_admin: false,
    };
    appState.auth.isAuthenticated = true;

    const container = ServiceContainer.getInstance();
    container.addService(
      container.getOrCreateToken(ProjectService),
      ProjectServiceStub,
      'singleton'
    );
    container.addService(container.getOrCreateToken(IconService), IconServiceStub, 'singleton');
    container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
    container.addService(
      container.getOrCreateToken(ProjectLifecycleService),
      ProjectLifecycleServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(CloudProjectService),
      CloudProjectServiceStub,
      'singleton'
    );

    const cloudProjectService = container.getService<CloudProjectServiceStub>(
      container.getOrCreateToken(CloudProjectService)
    );
    cloudProjectService.setState([
      {
        id: 'project-owned',
        owner_id: 'owner-1',
        name: 'Owned Project',
        share_token: null,
        created_at: '2026-04-25T10:00:00.000Z',
        updated_at: '2026-04-25T10:00:00.000Z',
      },
      {
        id: 'project-shared',
        owner_id: 'owner-2',
        name: 'Shared Project',
        share_token: null,
        created_at: '2026-04-25T11:00:00.000Z',
        updated_at: '2026-04-25T11:00:00.000Z',
      },
    ]);

    const welcome = document.createElement('pix3-welcome') as TestWelcomeElement;
    document.body.appendChild(welcome);
    await welcome.updateComplete;

    const deleteButtons = Array.from(
      welcome.querySelectorAll('.cloud-project-delete')
    ) as HTMLButtonElement[];

    expect(deleteButtons).toHaveLength(1);
    expect(deleteButtons[0]?.getAttribute('data-cloud-delete-id')).toBe('project-owned');
  });

  it('requests project-name confirmation before deleting an owned cloud project', async () => {
    resetAppState();
    appState.auth.user = {
      id: 'owner-1',
      email: 'owner@example.com',
      username: 'owner',
      is_admin: false,
    };
    appState.auth.isAuthenticated = true;

    const container = ServiceContainer.getInstance();
    container.addService(
      container.getOrCreateToken(ProjectService),
      ProjectServiceStub,
      'singleton'
    );
    container.addService(container.getOrCreateToken(IconService), IconServiceStub, 'singleton');
    container.addService(
      container.getOrCreateToken(ProjectLifecycleService),
      ProjectLifecycleServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(CloudProjectService),
      CloudProjectServiceStub,
      'singleton'
    );

    const showConfirmation = vi.fn(async () => true);
    container.addService(
      container.getOrCreateToken(DialogService),
      class extends DialogServiceStub {
        showConfirmation = showConfirmation;
      },
      'singleton'
    );

    const cloudProjectService = container.getService<CloudProjectServiceStub>(
      container.getOrCreateToken(CloudProjectService)
    );
    cloudProjectService.setState([
      {
        id: 'project-owned',
        owner_id: 'owner-1',
        name: 'Owned Project',
        share_token: null,
        created_at: '2026-04-25T10:00:00.000Z',
        updated_at: '2026-04-25T10:00:00.000Z',
      },
    ]);

    const welcome = document.createElement('pix3-welcome') as TestWelcomeElement;
    document.body.appendChild(welcome);
    await welcome.updateComplete;

    const deleteButton = welcome.querySelector('.cloud-project-delete') as HTMLButtonElement;
    expect(deleteButton).toBeTruthy();

    deleteButton.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(showConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Delete Cloud Project',
        confirmLabel: 'Delete Project',
        cancelLabel: 'Keep Project',
        isDangerous: true,
        requiredInputValue: 'Owned Project',
        requiredInputPlaceholder: 'Owned Project',
        disclaimer: 'Deleted cloud projects cannot be restored.',
      })
    );
    expect(cloudProjectService.deleteProject).toHaveBeenCalledWith('project-owned');
  });

  it('renders project open errors from app state', async () => {
    resetAppState();

    const container = ServiceContainer.getInstance();
    container.addService(
      container.getOrCreateToken(ProjectService),
      ProjectServiceStub,
      'singleton'
    );
    container.addService(container.getOrCreateToken(IconService), IconServiceStub, 'singleton');
    container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
    container.addService(
      container.getOrCreateToken(ProjectLifecycleService),
      ProjectLifecycleServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(CloudProjectService),
      CloudProjectServiceStub,
      'singleton'
    );

    const welcome = document.createElement('pix3-welcome') as TestWelcomeElement;
    document.body.appendChild(welcome);
    await welcome.updateComplete;

    appState.project.status = 'error';
    appState.project.errorMessage =
      'Opening local folders is not supported in the VS Code integrated browser.';
    await Promise.resolve();
    await welcome.updateComplete;

    const errorMessage = welcome.querySelector('.welcome-error');
    expect(errorMessage?.textContent).toContain('VS Code integrated browser');
  });

  it('renders picker failures from the open button without leaking the rejection', async () => {
    resetAppState();

    const pickerFailure = new Error('Directory picker failed');
    const container = ServiceContainer.getInstance();
    container.addService(
      container.getOrCreateToken(ProjectService),
      class extends ProjectServiceStub {
        openProjectViaPicker = vi.fn(async () => {
          throw pickerFailure;
        });
      },
      'singleton'
    );
    container.addService(container.getOrCreateToken(IconService), IconServiceStub, 'singleton');
    container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
    container.addService(
      container.getOrCreateToken(ProjectLifecycleService),
      ProjectLifecycleServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(CloudProjectService),
      CloudProjectServiceStub,
      'singleton'
    );

    const welcome = document.createElement('pix3-welcome') as TestWelcomeElement;
    document.body.appendChild(welcome);
    await welcome.updateComplete;

    const openButton = welcome.querySelector('.action-btn') as HTMLButtonElement;
    openButton.click();
    await Promise.resolve();
    await Promise.resolve();
    await welcome.updateComplete;

    const errorMessage = welcome.querySelector('.welcome-error');
    expect(errorMessage?.textContent).toContain('Directory picker failed');
  });
});

/**
 * The prompt hero. The load-bearing behaviour is the ORDER of two calls — the workspace mode has to
 * flip to Flow before the project is created, or the user watches the full Studio shell mount and
 * then get replaced, which is precisely the impression this mode exists to avoid (design §3.6).
 */
describe('Pix3Welcome prompt hero', () => {
  class WorkspaceModeServiceStub {
    mode = 'studio';
    calls: string[] = [];
    /** The mode the project that is about to be generated will inherit. */
    pendingMode: string | null = null;
    set = vi.fn((mode: string) => {
      this.mode = mode;
      this.calls.push(mode);
    });
    get = () => this.mode;
    remember = vi.fn();
    claimNextProject = vi.fn((mode: string) => {
      this.pendingMode = mode;
      this.set(mode);
    });
    clearPendingMode = vi.fn(() => {
      this.pendingMode = null;
    });
  }

  class PrototypeBootstrapServiceStub {
    modeWhenRun: string | null = null;
    lastRequest: unknown = null;
    startIdea = vi.fn(async (request: unknown) => {
      this.lastRequest = request;
      this.modeWhenRun = workspaceStub?.mode ?? null;
      return { title: 'Ants', templateId: 'idea-blank', references: [], notes: [] };
    });
    reset = vi.fn();
    subscribe(listener: (status: unknown) => void): () => void {
      listener({ phase: 'idle', message: '', brief: null, error: null });
      return () => undefined;
    }
  }

  let workspaceStub: WorkspaceModeServiceStub | undefined;

  const mountHero = async (): Promise<{
    welcome: TestWelcomeElement;
    bootstrap: PrototypeBootstrapServiceStub;
  }> => {
    resetAppState();
    const container = ServiceContainer.getInstance();
    container.addService(
      container.getOrCreateToken(ProjectService),
      ProjectServiceStub,
      'singleton'
    );
    container.addService(container.getOrCreateToken(IconService), IconServiceStub, 'singleton');
    container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
    container.addService(
      container.getOrCreateToken(ProjectLifecycleService),
      ProjectLifecycleServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(CloudProjectService),
      CloudProjectServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(WorkspaceModeService),
      WorkspaceModeServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(PrototypeBootstrapService),
      PrototypeBootstrapServiceStub,
      'singleton'
    );

    workspaceStub = container.getService<WorkspaceModeServiceStub>(
      container.getOrCreateToken(WorkspaceModeService)
    );
    const bootstrap = container.getService<PrototypeBootstrapServiceStub>(
      container.getOrCreateToken(PrototypeBootstrapService)
    );
    // The container keeps a singleton per class, and re-registering the SAME class is a no-op, so
    // the instance is shared across the tests in this file — reset it rather than assume a fresh one.
    workspaceStub.mode = 'studio';
    workspaceStub.calls = [];
    workspaceStub.pendingMode = null;
    workspaceStub.set.mockClear();
    workspaceStub.claimNextProject.mockClear();
    workspaceStub.clearPendingMode.mockClear();
    bootstrap.startIdea.mockClear();
    bootstrap.modeWhenRun = null;
    bootstrap.lastRequest = null;

    const welcome = document.createElement('pix3-welcome') as TestWelcomeElement;
    document.body.appendChild(welcome);
    await welcome.updateComplete;
    return { welcome, bootstrap };
  };

  const typePrompt = async (welcome: TestWelcomeElement, text: string): Promise<void> => {
    const textarea = welcome.querySelector('.hero-input') as HTMLTextAreaElement;
    textarea.value = text;
    textarea.dispatchEvent(new Event('input'));
    await welcome.updateComplete;
  };

  afterEach(() => {
    workspaceStub = undefined;
  });

  it('switches the workspace to Flow BEFORE the project is built', async () => {
    const { welcome, bootstrap } = await mountHero();
    await typePrompt(welcome, 'a coin tapper');

    (welcome.querySelector('.hero-make') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(bootstrap.startIdea).toHaveBeenCalledTimes(1);
    expect(bootstrap.modeWhenRun).toBe('flow');
    expect(workspaceStub?.calls[0]).toBe('flow');
    // Flipping the shell is only half of it: the project the bootstrap is about to create has to
    // inherit Flow, or it resolves to Studio the instant it becomes ready — mid-generation.
    expect(workspaceStub?.pendingMode).toBe('flow');
  });

  it('opens the idea stage, never the retired straight-to-prototype path', async () => {
    const { welcome, bootstrap } = await mountHero();
    await typePrompt(welcome, 'a strategy about ants');

    (welcome.querySelector('.hero-make') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await welcome.updateComplete;

    expect(bootstrap.startIdea).toHaveBeenCalledTimes(1);
    // Everything around the call is unchanged: Flow is claimed before the project exists, so the
    // shell that appears when it becomes ready is the Flow one.
    expect(bootstrap.modeWhenRun).toBe('flow');
    expect(workspaceStub?.pendingMode).toBe('flow');
    // No planner and no expander run on this path, so the hero never enters its spinner phases.
    expect(welcome.querySelector('.hero-spinner')).toBeNull();
    expect(welcome.querySelector('.welcome-error')).toBeNull();
  });

  it('rolls the shell back when the idea stage fails to start', async () => {
    const { welcome, bootstrap } = await mountHero();
    bootstrap.startIdea.mockRejectedValueOnce(new Error('storage is full'));
    await typePrompt(welcome, 'ants');

    (welcome.querySelector('.hero-make') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await welcome.updateComplete;

    expect(workspaceStub?.calls).toEqual(['flow', 'studio']);
    expect(workspaceStub?.pendingMode).toBeNull();
    expect(welcome.querySelector('.welcome-error')?.textContent).toContain('storage is full');
  });

  it('sends the typed prompt and the pinned recipe together', async () => {
    const { welcome, bootstrap } = await mountHero();
    await typePrompt(welcome, 'dodge the rocks');

    const card = welcome.querySelector('.hero-recipe') as HTMLButtonElement | null;
    const expectedRecipe = card?.getAttribute('title');
    card?.click();
    await welcome.updateComplete;

    (welcome.querySelector('.hero-make') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    const request = bootstrap.lastRequest as { prompt: string; recipeId?: string };
    expect(request.prompt).toBe('dodge the rocks');
    if (card) {
      // A card pins a recipe id; the typed prompt still describes the game.
      expect(request.recipeId).toBeTruthy();
      expect(expectedRecipe).toBeTruthy();
    }
  });

  it('submits on Ctrl+Enter and refuses an empty prompt', async () => {
    const { welcome, bootstrap } = await mountHero();
    const textarea = welcome.querySelector('.hero-input') as HTMLTextAreaElement;

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    await Promise.resolve();
    expect(bootstrap.startIdea).not.toHaveBeenCalled();
    expect(workspaceStub?.calls).toEqual([]);

    await typePrompt(welcome, 'pop the balloons');
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(bootstrap.startIdea).toHaveBeenCalledTimes(1);
  });

  it('returns to the previous shell when the build fails, instead of stranding an empty stage', async () => {
    const { welcome, bootstrap } = await mountHero();
    bootstrap.startIdea.mockRejectedValueOnce(new Error('planner exploded'));
    await typePrompt(welcome, 'a coin tapper');

    (welcome.querySelector('.hero-make') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await welcome.updateComplete;

    expect(workspaceStub?.calls).toEqual(['flow', 'studio']);
    // …and the claim goes with it, so the next project the user opens keeps its own shell.
    expect(workspaceStub?.pendingMode).toBeNull();
    expect(welcome.querySelector('.welcome-error')?.textContent).toContain('planner exploded');
  });

  it('keeps opening an existing project available below the hero', async () => {
    const { welcome } = await mountHero();

    // The prompt is first in the DOM, and the old actions still exist under it.
    const hero = welcome.querySelector('.welcome-hero');
    const openButton = welcome.querySelector('.action-btn');
    if (!hero || !openButton) {
      throw new Error('the hero and the existing-project actions must both be rendered');
    }
    expect(
      hero.compareDocumentPosition(openButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});

/**
 * The setup strip. Its whole job is to answer "can the prompt above actually reach a model?" before
 * the user types anything — so the assertions are about what it REPORTS, and that every control
 * lands in the existing Editor Settings dialog rather than duplicating key storage here.
 */
describe('Pix3Welcome setup status', () => {
  class EditorSettingsServiceStub {
    showSettings = vi.fn(async (_tab?: string) => undefined);
  }

  class BridgeConnectionServiceStub {
    available = false;
    entries: Array<{ id: string; label: string; kind: string }> = [];
    probe = vi.fn(async () => undefined);
    getBridgeUrl = () => 'http://127.0.0.1:8484';
    isAvailable = () => this.available;
    getEntries = () => [...this.entries];
    private listeners = new Set<() => void>();
    subscribe(listener: () => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    emit(): void {
      this.listeners.forEach(listener => listener());
    }
  }

  class AgentSettingsServiceStub {
    keyedProviders = new Set<string>();
    hasApiKey = vi.fn(async (providerId: string) => this.keyedProviders.has(providerId));
    getPreferences = vi.fn(() => ({ selectedProviderId: '', providerPinned: false }));
    /** The strip names whoever would actually answer, so the stub answers the same question. */
    selectedProvider: { id: string } | undefined = { id: 'gemini' };
    getSelectedProvider = vi.fn(() => this.selectedProvider);
    private listeners = new Set<(prefs: unknown) => void>();
    subscribe(listener: (prefs: unknown) => void): () => void {
      this.listeners.add(listener);
      listener(this.getPreferences());
      return () => this.listeners.delete(listener);
    }
  }

  class LlmProviderRegistryStub {
    providers = [{ id: 'gemini', label: 'Google Gemini' }];
    list = () => this.providers;
  }

  const mountStatus = async (): Promise<{
    welcome: TestWelcomeElement;
    settings: EditorSettingsServiceStub;
    bridge: BridgeConnectionServiceStub;
    agent: AgentSettingsServiceStub;
  }> => {
    resetAppState();
    const container = ServiceContainer.getInstance();
    container.addService(
      container.getOrCreateToken(ProjectService),
      ProjectServiceStub,
      'singleton'
    );
    container.addService(container.getOrCreateToken(IconService), IconServiceStub, 'singleton');
    container.addService(container.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
    container.addService(
      container.getOrCreateToken(ProjectLifecycleService),
      ProjectLifecycleServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(CloudProjectService),
      CloudProjectServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(EditorSettingsService),
      EditorSettingsServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(BridgeConnectionService),
      BridgeConnectionServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(AgentSettingsService),
      AgentSettingsServiceStub,
      'singleton'
    );
    container.addService(
      container.getOrCreateToken(LlmProviderRegistry),
      LlmProviderRegistryStub,
      'singleton'
    );

    const settings = container.getService<EditorSettingsServiceStub>(
      container.getOrCreateToken(EditorSettingsService)
    );
    const bridge = container.getService<BridgeConnectionServiceStub>(
      container.getOrCreateToken(BridgeConnectionService)
    );
    const agent = container.getService<AgentSettingsServiceStub>(
      container.getOrCreateToken(AgentSettingsService)
    );
    // Singletons persist across the tests in this file — reset rather than assume a fresh instance.
    settings.showSettings.mockClear();
    bridge.probe.mockClear();
    bridge.available = false;
    bridge.entries = [];
    agent.keyedProviders.clear();

    const welcome = document.createElement('pix3-welcome') as TestWelcomeElement;
    document.body.appendChild(welcome);
    await welcome.updateComplete;
    return { welcome, settings, bridge, agent };
  };

  /** The key check is async; let its promise chain settle before reading the rendered chips. */
  const settle = async (welcome: TestWelcomeElement): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
    await welcome.updateComplete;
  };

  it('warns that no key is configured and opens the agent settings tab', async () => {
    const { welcome, settings } = await mountStatus();
    await settle(welcome);

    const chip = welcome.querySelector('.welcome-chip--warn') as HTMLButtonElement;
    expect(chip?.textContent).toContain('No AI key');

    chip.click();
    expect(settings.showSettings).toHaveBeenCalledWith('agent');
  });

  it('names the provider once a key exists, without a reload', async () => {
    const { welcome, bridge, agent } = await mountStatus();
    await settle(welcome);
    expect(welcome.querySelector('.welcome-chip--warn')).toBeTruthy();

    agent.keyedProviders.add('gemini');
    bridge.emit(); // Any settings/bridge change re-runs the key check.
    await settle(welcome);

    const chip = welcome.querySelector('.welcome-chip--ok') as HTMLButtonElement;
    expect(chip?.textContent).toContain('Google Gemini');
    expect(welcome.querySelector('.welcome-chip--warn')).toBeNull();
  });

  it('reports the bridge and re-probes it on demand', async () => {
    const { welcome, bridge } = await mountStatus();
    await settle(welcome);

    // Mounting probes once on its own: the bridge is usually started after the editor tab.
    expect(bridge.probe).toHaveBeenCalled();
    expect(welcome.textContent).toContain('Bridge offline');

    bridge.available = true;
    bridge.entries = [
      { id: 'openai', label: 'OpenAI', kind: 'openai' },
      { id: 'anthropic', label: 'Anthropic', kind: 'anthropic' },
    ];
    bridge.emit();
    await settle(welcome);
    expect(welcome.textContent).toContain('Bridge · 2 providers');

    const before = bridge.probe.mock.calls.length;
    (welcome.querySelectorAll('.welcome-tool')[0] as HTMLButtonElement).click();
    await settle(welcome);
    expect(bridge.probe.mock.calls.length).toBeGreaterThan(before);
  });

  it('opens the full editor settings from the gear button', async () => {
    const { welcome, settings } = await mountStatus();
    await settle(welcome);

    const tools = welcome.querySelectorAll('.welcome-tool');
    (tools[tools.length - 1] as HTMLButtonElement).click();
    expect(settings.showSettings).toHaveBeenCalledWith('general');
  });
});
