import { beforeEach, describe, expect, it } from 'vitest';
import { appState } from '@/state';
import { WorkspaceModeService } from './WorkspaceModeService';

describe('WorkspaceModeService', () => {
  beforeEach(() => {
    localStorage.clear();
    appState.ui.workspaceMode = 'studio';
    appState.project.id = null;
  });

  it('defaults an unknown project to Studio', () => {
    const service = new WorkspaceModeService();
    expect(service.resolveForOpenedProject('proj-1')).toBe('studio');
  });

  it('reopens a project in the shell it was last used in', () => {
    const service = new WorkspaceModeService();
    appState.project.id = 'proj-1';
    service.set('flow');
    expect(new WorkspaceModeService().resolveForOpenedProject('proj-1')).toBe('flow');
    expect(new WorkspaceModeService().resolveForOpenedProject('proj-2')).toBe('studio');
  });

  it('hands a mode chosen before the project existed to the project that opens next', () => {
    // The prompt-hero path: Flow is picked, THEN the project is generated. Without the pending
    // hand-off the new project resolves to its default and kicks the user back to Studio.
    const service = new WorkspaceModeService();
    service.set('flow');
    expect(service.resolveForOpenedProject('fresh-project')).toBe('flow');
    // …and it is remembered, so a reload lands in Flow too.
    expect(new WorkspaceModeService().resolveForOpenedProject('fresh-project')).toBe('flow');
  });

  it('claims the next project without persisting the mode onto the open one', () => {
    // The prompt hero can be reached with a project still open. Flow belongs to the project that is
    // about to be generated, not to the one the user is leaving.
    const service = new WorkspaceModeService();
    appState.project.id = 'the-open-one';
    service.claimNextProject('flow');
    expect(appState.ui.workspaceMode).toBe('flow');
    expect(service.resolveForOpenedProject('the-generated-one')).toBe('flow');
    expect(new WorkspaceModeService().resolveForOpenedProject('the-open-one')).toBe('studio');
  });

  it('drops a claim whose project was never created', () => {
    const service = new WorkspaceModeService();
    service.claimNextProject('flow');
    service.clearPendingMode();
    expect(service.resolveForOpenedProject('unrelated')).toBe('studio');
  });

  it('consumes the pending mode only once', () => {
    const service = new WorkspaceModeService();
    service.set('flow');
    expect(service.resolveForOpenedProject('first')).toBe('flow');
    expect(service.resolveForOpenedProject('second')).toBe('studio');
  });

  it('notifies subscribers on a real change only', () => {
    const service = new WorkspaceModeService();
    const seen: string[] = [];
    service.subscribe(mode => seen.push(mode));
    service.set('flow');
    service.set('flow');
    service.set('studio');
    expect(seen).toEqual(['studio', 'flow', 'studio']);
  });
});
