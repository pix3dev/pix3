import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetAppState } from '@/state';
import { ProjectLifecycleService } from '@/services/project/ProjectLifecycleService';
import { EXTERNAL_AGENT_TEMPLATE_SKIP } from '@/services/project/agent-kit/AgentKitService';

/** "Work with your own agent" on project creation (plan §1.1). */

const createLifecycle = (options: { kitFails?: boolean } = {}) => {
  const lifecycle = new ProjectLifecycleService();
  const projectService = {
    createNewProjectWithOptions: vi.fn(async () => undefined),
    openStartupScene: vi.fn(async () => undefined),
  };
  const agentKitService = {
    installAndShow: vi.fn(async () => {
      if (options.kitFails) throw new Error('disk full');
    }),
  };
  const dialogService = { showConfirmation: vi.fn(async () => true) };
  const templates = { getTemplate: vi.fn(() => null) };
  const editorTabService = { closeAllTabs: vi.fn(async () => undefined) };
  for (const [key, value] of Object.entries({
    projectService,
    agentKitService,
    dialogService,
    projectTemplateService: templates,
    editorTabService,
  })) {
    Object.defineProperty(lifecycle, key, { value });
  }
  return { lifecycle, projectService, agentKitService, dialogService };
};

const params = {
  name: 'Game',
  viewportBaseWidth: 1080,
  viewportBaseHeight: 1920,
  templateId: 'recipe-tapper-2d',
};

afterEach(() => resetAppState());

describe('ProjectLifecycleService — work with your own agent', () => {
  it('skips the in-editor agent overlay and writes the kit after the project opened', async () => {
    const { lifecycle, projectService, agentKitService } = createLifecycle();
    await lifecycle.createProject({ ...params, backend: 'local', withAgentKit: true });
    expect(projectService.createNewProjectWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ skipTemplatePaths: EXTERNAL_AGENT_TEMPLATE_SKIP }),
      expect.anything()
    );
    expect(agentKitService.installAndShow).toHaveBeenCalledWith({ update: false });
    expect(projectService.openStartupScene.mock.invocationCallOrder[0]).toBeLessThan(
      agentKitService.installAndShow.mock.invocationCallOrder[0]
    );
  });

  it('leaves a normal project alone', async () => {
    const { lifecycle, projectService, agentKitService } = createLifecycle();
    await lifecycle.createProject({ ...params, backend: 'local' });
    expect(projectService.createNewProjectWithOptions).toHaveBeenCalledWith(
      expect.not.objectContaining({ skipTemplatePaths: expect.anything() }),
      expect.anything()
    );
    expect(agentKitService.installAndShow).not.toHaveBeenCalled();
  });

  it('refuses storage an agent cannot open', async () => {
    const { lifecycle } = createLifecycle();
    await expect(
      lifecycle.createProject({ ...params, backend: 'browser', withAgentKit: true })
    ).rejects.toThrow(/folder on disk/);
  });

  it('keeps the created project when the kit fails, and says how to retry', async () => {
    const { lifecycle, dialogService } = createLifecycle({ kitFails: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await lifecycle.createProject({ ...params, backend: 'local', withAgentKit: true });
    expect(dialogService.showConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/Install Agent Kit/) })
    );
  });
});
