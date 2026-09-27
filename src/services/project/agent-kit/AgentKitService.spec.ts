import { afterEach, describe, expect, it, vi } from 'vitest';

import { appState, resetAppState } from '@/state';
import { createDefaultProjectManifest } from '@/core/ProjectManifest';
import { FileSystemAPIError } from '@/services/project/FileSystemAPIService';
import { AgentKitService } from './AgentKitService';
import type { AgentHandoff } from './agent-handoff';

const kit = {
  version: '1.6.0',
  files: new Map([
    ['.claude/skills/pix3-verify/SKILL.md', '# verify\n'],
    ['AGENTS.md', '<!-- kit -->\n# AGENTS\n'],
    ['CLAUDE.md', '@AGENTS.md\n'],
  ]),
};

const createService = (options: { files?: Record<string, string> } = {}) => {
  const files = new Map(Object.entries(options.files ?? {}));
  const storage = {
    readTextFile: vi.fn(async (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw new FileSystemAPIError('not-found', `missing ${path}`);
      return text;
    }),
    writeTextFile: vi.fn(async (path: string, contents: string) => {
      files.set(path, contents);
    }),
    createDirectory: vi.fn(async () => undefined),
    fileExists: vi.fn(async (path: string) => files.has(path)),
  };
  const projectService = { saveProjectManifest: vi.fn(async () => undefined) };
  const templates = {
    getTemplate: vi.fn((id: string) => (id === 'recipe-tapper-2d' ? { title: 'Tapper 2D' } : null)),
  };
  const service = new AgentKitService();
  Object.defineProperty(service, 'storage', { value: storage });
  Object.defineProperty(service, 'projectService', { value: projectService });
  Object.defineProperty(service, 'templates', { value: templates });
  service.loadKit = async () => kit;
  return { service, files, storage, projectService };
};

const openProject = (backend: 'local' | 'workspace' | 'browser' | 'cloud') => {
  appState.project.status = 'ready';
  appState.project.backend = backend;
  appState.project.projectName = 'Tapper';
  appState.project.manifest = {
    ...createDefaultProjectManifest(),
    metadata: { projectName: 'Tapper', templateId: 'recipe-tapper-2d' },
  };
};

afterEach(() => resetAppState());

describe('AgentKitService', () => {
  it('is available for local folders and workspaces only', () => {
    const { service } = createService();
    expect(service.availability({ status: 'ready', backend: 'local' }).ok).toBe(true);
    expect(service.availability({ status: 'ready', backend: 'workspace' }).ok).toBe(true);
    const browser = service.availability({ status: 'ready', backend: 'browser' });
    expect(browser.ok).toBe(false);
    if (!browser.ok) expect(browser.reason).toMatch(/Move Project to Folder/);
    expect(service.availability({ status: 'ready', backend: 'cloud' }).ok).toBe(false);
    expect(service.availability({ status: 'idle', backend: 'local' }).ok).toBe(false);
  });

  it('writes the kit without .mcp.json when no CLI version is confirmed, records metadata, opens the screen', async () => {
    openProject('local');
    const { service, files, projectService } = createService({
      files: { 'design/recipe.md': '# Recipe\n' },
    });
    service.resolveCliVersion = async () => ({ kind: 'unavailable', reason: 'not-published' });
    const seen: Array<AgentHandoff | null> = [];
    service.subscribe(handoff => seen.push(handoff));

    const handoff = await service.installAndShow({ update: false });

    expect(files.get('AGENTS.md')).toBe(kit.files.get('AGENTS.md'));
    expect(files.has('.claude/skills/pix3-verify/SKILL.md')).toBe(true);
    expect(files.has('.mcp.json')).toBe(false);
    expect(files.get('.gitignore')).toContain('.pix3/');
    expect(files.has('.pix3/kit-manifest.json')).toBe(true);
    expect(projectService.saveProjectManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          templateId: 'recipe-tapper-2d',
          agentKit: expect.objectContaining({ version: '1.6.0' }),
        }),
      })
    );
    expect(handoff.firstPrompt).toContain('"Tapper 2D" recipe');
    expect(handoff.mcpMissingReason).toMatch(/not published yet/);
    expect(seen.at(-1)).toBe(handoff);

    service.close();
    expect(seen.at(-1)).toBeNull();
  });

  it('pins the confirmed CLI version in .mcp.json', async () => {
    openProject('workspace');
    const { service, files } = createService();
    service.resolveCliVersion = async () => ({ kind: 'lockstep', version: '1.6.0' });
    const handoff = await service.installAndShow();
    expect(JSON.parse(files.get('.mcp.json') ?? '{}')).toEqual({
      mcpServers: {
        pix3: { command: 'npx', args: ['-y', '@pix3/cli@1.6.0', 'mcp', '--workspace'] },
      },
    });
    expect(handoff.backend).toBe('workspace');
    expect(handoff.serveCommand).toBeNull();
  });

  it('refuses an in-browser project', async () => {
    openProject('browser');
    const { service } = createService();
    await expect(service.installAndShow()).rejects.toThrow(/in-browser project/);
  });
});
