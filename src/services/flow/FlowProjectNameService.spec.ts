import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultProjectManifest, type ProjectManifest } from '@/core/ProjectManifest';
import { appState, resetAppState } from '@/state';

import { FlowProjectNameService } from './FlowProjectNameService';
import { FLOW_TITLE_SOURCE_METADATA_KEY, FlowStageService } from './FlowStageService';

const manifestWith = (metadata: Record<string, unknown>): ProjectManifest => ({
  ...createDefaultProjectManifest(),
  metadata,
});

/** An idea-stage project the editor named "Флапи птица" on the way in. */
const openIdeaProject = (name = 'Флапи птица') => {
  appState.project.status = 'ready';
  appState.project.projectName = name;
  appState.project.manifest = manifestWith({
    flowStage: 'idea',
    projectName: name,
    [FLOW_TITLE_SOURCE_METADATA_KEY]: name,
  });
};

describe('FlowProjectNameService', () => {
  let service: FlowProjectNameService;
  let saveProjectManifest: ReturnType<typeof vi.fn>;
  let syncProjectMetadata: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetAppState();
    saveProjectManifest = vi.fn(async (manifest: ProjectManifest) => {
      appState.project.manifest = manifest;
    });
    syncProjectMetadata = vi.fn();
    service = new FlowProjectNameService();
    // `@inject` installs a getter, so the dependencies are defined over rather than assigned.
    Object.defineProperty(service, 'projectService', {
      value: { saveProjectManifest, syncProjectMetadata },
      configurable: true,
    });
    Object.defineProperty(service, 'stageService', {
      value: new FlowStageService(),
      configurable: true,
    });
  });

  afterEach(() => {
    resetAppState();
  });

  it('renames the project to the title the agent gave the document', async () => {
    openIdeaProject();

    await expect(service.syncFromDocumentTitle('Флапи')).resolves.toBe(true);

    expect(appState.project.projectName).toBe('Флапи');
    // The recents entry is where a browser project reads its name back from on reopen.
    expect(syncProjectMetadata).toHaveBeenCalled();
    const metadata = saveProjectManifest.mock.calls[0][0].metadata;
    expect(metadata[FLOW_TITLE_SOURCE_METADATA_KEY]).toBe('Флапи');
    expect(metadata.flowStage).toBe('idea');
  });

  it('leaves a name the user typed themselves alone, forever', async () => {
    openIdeaProject();
    appState.project.projectName = 'My Game';

    await expect(service.syncFromDocumentTitle('Флапи')).resolves.toBe(false);

    expect(appState.project.projectName).toBe('My Game');
    expect(saveProjectManifest).not.toHaveBeenCalled();
  });

  it('does not touch a project that was never named by this path', async () => {
    appState.project.status = 'ready';
    appState.project.projectName = 'Imported';
    appState.project.manifest = manifestWith({ flowStage: 'idea' });

    await expect(service.syncFromDocumentTitle('Флапи')).resolves.toBe(false);
    expect(appState.project.projectName).toBe('Imported');
  });

  it('stops at the prototype stage: a real game keeps the name it shipped under', async () => {
    openIdeaProject();
    appState.project.manifest = manifestWith({
      flowStage: 'prototype',
      [FLOW_TITLE_SOURCE_METADATA_KEY]: 'Флапи птица',
    });

    await expect(service.syncFromDocumentTitle('Флапи')).resolves.toBe(false);
  });

  it('ignores an empty title, an unchanged one, and a sentence', async () => {
    openIdeaProject();

    await expect(service.syncFromDocumentTitle(null)).resolves.toBe(false);
    await expect(service.syncFromDocumentTitle('  ')).resolves.toBe(false);
    await expect(service.syncFromDocumentTitle('Флапи птица')).resolves.toBe(false);
    await expect(
      service.syncFromDocumentTitle('Игра про птицу, которая летит между зелёных труб и падает')
    ).resolves.toBe(false);
    expect(saveProjectManifest).not.toHaveBeenCalled();
  });

  it('keeps the name on screen when the manifest write fails', async () => {
    openIdeaProject();
    saveProjectManifest.mockRejectedValueOnce(new Error('disk full'));

    await expect(service.syncFromDocumentTitle('Флапи')).resolves.toBe(true);
    expect(appState.project.projectName).toBe('Флапи');
  });
});
