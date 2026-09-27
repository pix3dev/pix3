import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ServiceContainer } from '@/fw/di';
import { appState, resetAppState, type MergeBannerState } from '@/state';
import { ExternalMergeService } from '@/services/project/coauthoring/ExternalMergeService';
import { ProjectOwnershipService } from '@/services/project/coauthoring/ProjectOwnershipService';
import { WorkspaceSessionService } from '@/services/project/workspace/WorkspaceSessionService';
import { WorkspaceConnectDialogService } from '@/services/project/workspace/WorkspaceConnectDialogService';

type Lit = HTMLElement & { updateComplete: Promise<unknown> };

const mergeStub = {
  acceptConflicts: vi.fn(async () => true),
  acceptRejected: vi.fn(async () => true),
  keepMine: vi.fn(async () => true),
  restoreBeforeMerge: vi.fn(async () => true),
  dismiss: vi.fn(),
};
const ownershipStub = { requestTakeOver: vi.fn(async () => true) };

beforeAll(async () => {
  vi.mock('golden-layout', () => ({}));
  const container = ServiceContainer.getInstance();
  container.addService(
    container.getOrCreateToken(ExternalMergeService),
    class {
      constructor() {
        return mergeStub;
      }
    },
    'singleton'
  );
  container.addService(
    container.getOrCreateToken(ProjectOwnershipService),
    class {
      constructor() {
        return ownershipStub;
      }
    },
    'singleton'
  );
  container.addService(container.getOrCreateToken(WorkspaceSessionService), class {}, 'singleton');
  container.addService(
    container.getOrCreateToken(WorkspaceConnectDialogService),
    class {},
    'singleton'
  );
  await import('./pix3-merge-banner');
  await import('./pix3-workspace-banner');
});

afterEach(() => {
  document.body.innerHTML = '';
  resetAppState();
  vi.clearAllMocks();
});

const conflictBanner = (): MergeBannerState => ({
  path: 'scenes/main.pix3scene',
  sceneId: 's1',
  status: 'conflicts',
  conflicts: [
    {
      id: 'property:["a","properties","transform","position"]',
      kind: 'property',
      nodeId: 'a',
      path: ['properties', 'transform', 'position'],
      message: 'Agent changed "A" transform.position, which you edited; your value was kept.',
      humanValue: [100, 20],
      agentValue: [20, 20],
      agentPresent: true,
      nodeIds: ['a'],
      entries: [],
    },
  ],
  reason: null,
  externalHash: 'h',
  restoreRef: '.pix3/recovery/x/1.pix3scene',
  at: 1,
});

async function mount(tag: string): Promise<Lit> {
  const element = document.createElement(tag) as Lit;
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

const click = async (element: Lit, selector: string) => {
  element.querySelector<HTMLButtonElement>(selector)!.click();
  await element.updateComplete;
  await new Promise(resolve => setTimeout(resolve, 0));
};

describe('pix3-merge-banner', () => {
  it('shows the conflict count and wires accept-all, details with per-item accept, restore', async () => {
    appState.project.coauthoring.merges['scenes/main.pix3scene'] = conflictBanner();
    const banner = await mount('pix3-merge-banner');
    expect(banner.textContent).toContain('Agent changed 1 property you edited');
    expect(banner.textContent).toContain('yours were kept');
    expect(banner.querySelector('svg')).not.toBeNull(); // vector icons, no glyphs

    await click(banner, '[data-action="accept-all"]');
    expect(mergeStub.acceptConflicts).toHaveBeenCalledWith('scenes/main.pix3scene');

    await click(banner, '[data-action="details"]');
    const row = banner.querySelector('[data-conflict]')!;
    expect(row.textContent).toContain('[100,20]');
    expect(row.textContent).toContain('[20,20]');
    await click(banner, '[data-action="accept-one"]');
    expect(mergeStub.acceptConflicts).toHaveBeenLastCalledWith('scenes/main.pix3scene', [
      conflictBanner().conflicts[0].id,
    ]);

    await click(banner, '[data-action="restore"]');
    expect(mergeStub.restoreBeforeMerge).toHaveBeenCalledWith('scenes/main.pix3scene');
  });

  it('rejected: whole-scene message with Accept agent’s version / Keep mine', async () => {
    appState.project.coauthoring.merges['scenes/main.pix3scene'] = {
      ...conflictBanner(),
      status: 'rejected',
      conflicts: [],
      reason: 'duplicate node id(s): a',
    };
    const banner = await mount('pix3-merge-banner');
    expect(banner.textContent).toContain('could not be merged');
    expect(banner.textContent).toContain('duplicate node id(s): a');
    await click(banner, '[data-action="accept-rejected"]');
    expect(mergeStub.acceptRejected).toHaveBeenCalled();
    await click(banner, '[data-action="keep-mine"]');
    expect(mergeStub.keepMine).toHaveBeenCalled();
  });

  it('renders nothing without merges', async () => {
    const banner = await mount('pix3-merge-banner');
    expect(banner.querySelector('.merge-banner')).toBeNull();
  });
});

describe('pix3-workspace-banner — local non-owner window', () => {
  it('says the project is edited elsewhere and runs the take-over', async () => {
    appState.project.status = 'ready';
    appState.project.backend = 'local';
    appState.project.coauthoring.isOwner = false;
    const banner = await mount('pix3-workspace-banner');
    expect(banner.textContent).toContain('Project is being edited in another window');
    await click(banner, '.workspace-banner__action');
    expect(ownershipStub.requestTakeOver).toHaveBeenCalled();

    appState.project.coauthoring.editBlockedAt = Date.now();
    await banner.updateComplete;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(banner.textContent).toContain('Editing is disabled here');
  });
});
