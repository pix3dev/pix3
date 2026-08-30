import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { appState, resetAppState } from '@/state';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { AgentChatService } from '@/services/agent/AgentChatService';
import { IconService } from '@/services/editor/IconService';
import { LightboxService, type LightboxItem } from '@/services/editor/LightboxService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import {
  FlowReferencesService,
  type FlowReferenceItem,
  type FlowReferenceList,
} from '@/services/flow/FlowReferencesService';
import type { FlowPlan } from '@/services/flow/FlowPlanService';

// The overlay is a whole component with its own service graph; this file is about the panel.
vi.mock('@/ui/shared/pix3-lightbox', () => ({ ensureLightboxHost: () => null }));

interface SidePanel extends HTMLElement {
  updateComplete: Promise<unknown>;
  refresh(): Promise<void>;
  stage: 'idea' | 'prototype';
  plan: FlowPlan;
  agentRunning: boolean;
  activeTool: string | null;
  activeDoc: string | null;
}

const item = (over: Partial<FlowReferenceItem> & { name: string }): FlowReferenceItem => ({
  path: `references/${over.name}`,
  group: 'references',
  kind: 'image',
  origin: 'user',
  role: null,
  caption: null,
  previewLine: null,
  sizeBytes: 2048,
  modifiedAt: 1000,
  readOnly: false,
  pinned: false,
  missing: false,
  ...over,
});

const listWith = (over: Partial<FlowReferenceList> = {}): FlowReferenceList => ({
  document: {
    path: 'design/gdd.md',
    name: 'gdd.md',
    group: 'document',
    kind: 'markdown',
    origin: 'agent',
    role: null,
    caption: null,
    previewLine: 'Ant Wars',
    sizeBytes: 512,
    modifiedAt: 2000,
    readOnly: false,
    pinned: true,
    missing: false,
  },
  design: [],
  references: [],
  sources: [],
  ...over,
});

class IconServiceStub {
  getIcon = vi.fn(() => '');
}

/** Named parameters throughout, so `mock.calls[n][i]` stays typed (a bare `vi.fn()` infers `[]`). */
class CommandDispatcherStub {
  execute = vi.fn(async (_command: { metadata: { id: string } }) => true);
  executeById = vi.fn(async (_id: string) => true);
}

interface AddResult {
  added: string[];
  warnings: string[];
}

class ReferencesStub {
  list = vi.fn(async (): Promise<FlowReferenceList> => listWith());
  addFiles = vi.fn(
    async (_files: readonly File[]): Promise<AddResult> => ({
      added: ['references/dropped.png'],
      warnings: [],
    })
  );
  setRole = vi.fn(async (_name: string, _role: string) => undefined);
}

class StorageStub {
  readBlob = vi.fn(async () => new Blob(['pixels']));
  readTextFile = vi.fn(async () => '# doc');
}

class LightboxStub {
  open = vi.fn((_items: readonly LightboxItem[], _index?: number) => undefined);
  subscribe = vi.fn(() => () => undefined);
}

class AgentChatStub {
  composePrefill = vi.fn((_text: string) => undefined);
}

const register = (type: Parameters<ServiceContainer['getOrCreateToken']>[0], instance: object) => {
  const container = ServiceContainer.getInstance();
  // A fresh wrapper class per call: a changed implementation is what clears the cached singleton.
  const wrapper = class {
    constructor() {
      return instance;
    }
  };
  container.addService(
    container.getOrCreateToken(type),
    wrapper as Parameters<ServiceContainer['addService']>[1],
    'singleton'
  );
};

let references: ReferencesStub;
let dispatcher: CommandDispatcherStub;
let storage: StorageStub;
let lightbox: LightboxStub;
let chat: AgentChatStub;

/** Mount the panel over a ready project and let its first (debounced) listing land. */
const mountPanel = async (
  stage: 'idea' | 'prototype' = 'idea',
  plan: FlowPlan = { pitch: null, title: null, steps: [] }
): Promise<SidePanel> => {
  const panel = document.createElement('pix3-flow-side-panel') as SidePanel;
  panel.stage = stage;
  panel.plan = plan;
  document.body.appendChild(panel);
  await panel.updateComplete;
  await panel.refresh();
  await panel.updateComplete;
  return panel;
};

beforeAll(async () => {
  if (typeof URL.createObjectURL !== 'function') {
    // happy-dom does not always provide it, and the thumbnail cache is built on it.
    URL.createObjectURL = () => 'blob:stub';
    URL.revokeObjectURL = () => undefined;
  }
  await import('./pix3-flow-side-panel');
});

beforeEach(() => {
  resetAppState();
  appState.project.status = 'ready';
  appState.project.id = 'project-1';
  references = new ReferencesStub();
  dispatcher = new CommandDispatcherStub();
  storage = new StorageStub();
  lightbox = new LightboxStub();
  chat = new AgentChatStub();
  register(IconService, new IconServiceStub());
  register(CommandDispatcher, dispatcher);
  register(FlowReferencesService, references);
  register(ProjectStorageService, storage);
  register(LightboxService, lightbox);
  register(AgentChatService, chat);
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
  resetAppState();
});

describe('Pix3FlowSidePanel — tabs', () => {
  it('shows only the Files tab at the idea stage', async () => {
    const panel = await mountPanel('idea');
    const tabs = [...panel.querySelectorAll('.side-panel__tab')].map(tab =>
      tab.textContent?.trim()
    );

    expect(tabs).toEqual(['Files']);
    expect(panel.querySelector('.ref-list')).not.toBeNull();
    expect(panel.querySelector('.flow-plan')).toBeNull();
    // The "+" upload affordance belongs to the Files tab.
    expect(panel.querySelector('.side-panel__add')).not.toBeNull();
  });

  it('shows both tabs at the prototype stage and defaults to the plan', async () => {
    const panel = await mountPanel('prototype', {
      pitch: null,
      title: null,
      steps: [
        { title: 'Field and paddle', status: 'done' },
        { title: 'Scoring', status: 'active' },
      ],
    });

    expect([...panel.querySelectorAll('.side-panel__tab')]).toHaveLength(2);
    expect(panel.querySelectorAll('.flow-plan__step')).toHaveLength(2);
    expect(panel.querySelector('.ref-list')).toBeNull();

    panel.querySelectorAll<HTMLButtonElement>('.side-panel__tab')[1].click();
    await panel.updateComplete;

    expect(panel.querySelector('.ref-list')).not.toBeNull();
    expect(localStorage.getItem('pix3.flow.sidePanelTab:v1')).toBe('files');
  });
});

describe('Pix3FlowSidePanel — files tab', () => {
  it('pins the document first and gives it no delete action', async () => {
    references.list = vi.fn(async () => listWith({ references: [item({ name: 'mood-1.png' })] }));
    const panel = await mountPanel('idea');
    const cards = [...panel.querySelectorAll('.ref-card')];

    expect(cards[0].classList.contains('ref-card--pinned')).toBe(true);
    expect(cards[0].textContent).toContain('gdd.md');
    expect(cards[0].querySelector('.ref-card__action--danger')).toBeNull();
    // A thumbnail is a real image element, from the blob the panel read itself.
    expect(cards[1].querySelector('.ref-card__image')).not.toBeNull();
    expect(cards[1].querySelector('.ref-card__action--danger')).not.toBeNull();
  });

  it('lists non-image files with an icon, and never a role chip on them', async () => {
    references.list = vi.fn(async () =>
      listWith({
        references: [
          item({ name: 'pitch.pdf', kind: 'other', role: null }),
          item({ name: 'balance.csv', kind: 'text', role: null, previewLine: 'wave,count' }),
        ],
      })
    );
    const panel = await mountPanel('idea');

    expect(panel.textContent).toContain('pitch.pdf');
    expect(panel.textContent).toContain('wave,count');
    expect(panel.querySelectorAll('.ref-card__image')).toHaveLength(0);
    expect(panel.querySelectorAll('.ref-card__chip')).toHaveLength(0);
  });

  it('offers regenerate only on files the agent made, and never on read-only sources', async () => {
    references.list = vi.fn(async () =>
      listWith({
        references: [
          item({ name: 'mine.png', origin: 'user' }),
          item({ name: 'generated.png', origin: 'agent', caption: 'flat vector city' }),
        ],
        sources: [
          item({
            name: 'brief.md',
            path: 'design/source/brief.md',
            group: 'sources',
            kind: 'markdown',
            role: null,
            readOnly: true,
          }),
        ],
      })
    );
    const panel = await mountPanel('idea');
    const cards = [...panel.querySelectorAll('.ref-card')];
    const byName = (name: string) => cards.find(card => card.textContent?.includes(name));

    expect(byName('mine.png')?.querySelectorAll('button[aria-label="Regenerate"]')).toHaveLength(0);
    expect(
      byName('generated.png')?.querySelectorAll('button[aria-label="Regenerate"]')
    ).toHaveLength(1);
    // Read-only group: neither delete nor regenerate.
    expect(byName('brief.md')?.querySelector('.ref-card__action--danger')).toBeNull();

    byName('generated.png')
      ?.querySelector<HTMLButtonElement>('button[aria-label="Regenerate"]')
      ?.click();

    expect(chat.composePrefill).toHaveBeenCalledTimes(1);
    expect(chat.composePrefill.mock.calls[0][0]).toContain('references/generated.png');
    expect(chat.composePrefill.mock.calls[0][0]).toContain('flat vector city');
  });

  it('cycles a picture role through the three intake roles', async () => {
    references.list = vi.fn(async () =>
      listWith({ references: [item({ name: 'mood-1.png', role: 'style' })] })
    );
    const panel = await mountPanel('idea');

    panel.querySelector<HTMLButtonElement>('.ref-card__chip')?.click();
    await panel.updateComplete;

    expect(references.setRole).toHaveBeenCalledWith('mood-1.png', 'content');
  });

  it('deletes through the command gateway, never through storage directly', async () => {
    references.list = vi.fn(async () => listWith({ references: [item({ name: 'mood-1.png' })] }));
    const panel = await mountPanel('idea');

    panel.querySelector<HTMLButtonElement>('.ref-card__action--danger')?.click();
    await panel.updateComplete;

    expect(dispatcher.execute).toHaveBeenCalledTimes(1);
    expect(dispatcher.execute.mock.calls[0][0].metadata.id).toBe('flow.delete-reference');
  });

  /**
   * A document is read and edited in the Idea view, so the click has to land there — the lightbox
   * is a look at a file, not a place to work in it.
   */
  it('reports a document click to the shell instead of opening the lightbox', async () => {
    references.list = vi.fn(async () =>
      listWith({
        design: [
          item({
            name: 'decisions.md',
            path: 'design/decisions.md',
            group: 'design',
            kind: 'markdown',
            role: null,
            origin: 'agent',
          }),
        ],
      })
    );
    const panel = await mountPanel('idea');
    const opened: string[] = [];
    panel.addEventListener('document-open', event => {
      opened.push((event as CustomEvent<{ path: string }>).detail.path);
    });

    const decisions = [...panel.querySelectorAll('.ref-card')].find(card =>
      card.textContent?.includes('decisions.md')
    );
    decisions?.querySelector<HTMLButtonElement>('.ref-card__body')?.click();
    // The lightbox path is async; give it the task it would have needed to open.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(opened).toEqual(['design/decisions.md']);
    expect(lightbox.open).not.toHaveBeenCalled();
  });

  it('marks the document the stage is showing, and only that one', async () => {
    references.list = vi.fn(async () =>
      listWith({
        design: [
          item({
            name: 'decisions.md',
            path: 'design/decisions.md',
            group: 'design',
            kind: 'markdown',
            role: null,
          }),
        ],
      })
    );
    const panel = await mountPanel('idea');
    panel.activeDoc = 'design/decisions.md';
    await panel.updateComplete;

    const byName = (name: string) =>
      [...panel.querySelectorAll('.ref-card')].find(card => card.textContent?.includes(name));

    expect(byName('decisions.md')?.classList.contains('ref-card--active')).toBe(true);
    // The pinned document is still pinned — it is just not what is on screen.
    expect(byName('gdd.md')?.classList.contains('ref-card--active')).toBe(false);
    expect(byName('gdd.md')?.classList.contains('ref-card--pinned')).toBe(true);
  });

  it('expands into the lightbox with the same-kind siblings behind it', async () => {
    references.list = vi.fn(async () =>
      listWith({
        references: [item({ name: 'a.png' }), item({ name: 'b.png' })],
      })
    );
    const panel = await mountPanel('idea');
    const cards = [...panel.querySelectorAll('.ref-card')];

    // Index 1 is the first picture; index 0 is the pinned markdown document.
    cards[1].querySelector<HTMLButtonElement>('.ref-card__body')?.click();
    // Opening reads each sibling (blob URL / text), so the call lands a task later.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(lightbox.open).toHaveBeenCalledTimes(1);
    const [items, index] = lightbox.open.mock.calls[0];
    // Pictures next to pictures: the markdown document is not in this list.
    expect(items.map(entry => entry.title)).toEqual(['a.png', 'b.png']);
    expect(items.every(entry => entry.kind === 'image')).toBe(true);
    expect(index).toBe(0);
  });
});

describe('Pix3FlowSidePanel — adding files', () => {
  it('writes any dropped file into references/, whatever its type', async () => {
    const panel = await mountPanel('idea');
    const files = [
      new File(['%PDF'], 'deck.pdf', { type: 'application/pdf' }),
      new File(['png'], 'hero.png', { type: 'image/png' }),
    ];
    const dataTransfer = {
      types: ['Files'],
      files,
      dropEffect: 'none',
    };

    const dropZone = panel.querySelector('.side-panel');
    const event = new Event('drop', { bubbles: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    dropZone?.dispatchEvent(event);
    await panel.updateComplete;

    expect(references.addFiles).toHaveBeenCalledTimes(1);
    expect(references.addFiles.mock.calls[0][0].map(file => file.name)).toEqual([
      'deck.pdf',
      'hero.png',
    ]);
  });

  it('highlights the whole column while a file is dragged over it', async () => {
    const panel = await mountPanel('idea');
    const dropZone = panel.querySelector('.side-panel');
    const event = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], dropEffect: '' } });

    dropZone?.dispatchEvent(event);
    await panel.updateComplete;

    expect(panel.querySelector('.side-panel--drag')).not.toBeNull();
  });

  it('shows why a file was skipped instead of failing silently', async () => {
    references.addFiles = vi.fn(
      async (): Promise<AddResult> => ({
        added: [],
        warnings: ['huge.psd is too large for the references column.'],
      })
    );
    const panel = await mountPanel('idea');
    const input = panel.querySelector<HTMLInputElement>('.side-panel__file-input');
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'huge.psd')],
      configurable: true,
    });

    input?.dispatchEvent(new Event('change'));
    await panel.updateComplete;
    await panel.refresh();
    await panel.updateComplete;

    expect(panel.querySelector('.ref-list__warnings')?.textContent).toContain('too large');
  });
});
