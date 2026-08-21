import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appState, resetAppState } from '@/state';
import { createDefaultProjectManifest, type ProjectManifest } from '@/core/ProjectManifest';
import { FlowStageService } from './FlowStageService';

const manifestWith = (metadata: Record<string, unknown>): ProjectManifest => ({
  ...createDefaultProjectManifest(),
  metadata,
});

describe('FlowStageService', () => {
  let service: FlowStageService;

  beforeEach(() => {
    resetAppState();
    service = new FlowStageService();
  });

  afterEach(() => {
    resetAppState();
  });

  it('reads the stage out of the manifest metadata', () => {
    appState.project.manifest = manifestWith({ flowStage: 'idea' });
    expect(service.getStage()).toBe('idea');
    expect(service.isIdeaStage()).toBe(true);
  });

  it('falls back to prototype for every existing project (no flowStage field)', () => {
    // The compatibility guarantee of design §3.2: projects that predate the stage must not change.
    appState.project.manifest = manifestWith({ projectName: 'Old game' });
    expect(service.getStage()).toBe('prototype');
    expect(service.isIdeaStage()).toBe(false);
  });

  it('falls back to prototype with no manifest at all and for an unknown value', () => {
    expect(service.getStage()).toBe('prototype');
    appState.project.manifest = manifestWith({ flowStage: 'moodboard' });
    expect(service.getStage()).toBe('prototype');
  });
});
