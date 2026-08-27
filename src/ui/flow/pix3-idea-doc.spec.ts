import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { AgentChatService, type AgentChatState } from '@/services/agent/AgentChatService';
import { DialogService } from '@/services/editor/DialogService';
import { IconService } from '@/services/editor/IconService';
import { LightboxService } from '@/services/editor/LightboxService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';

const DOC_PATH = 'design/gdd.md';

interface IdeaDocElement extends HTMLElement {
  updateComplete: Promise<unknown>;
  reload(): Promise<void>;
}

class StorageStub {
  readonly files = new Map<string, string>();
  readonly blobs = new Map<string, Blob>();

  readTextFile = vi.fn(async (path: string): Promise<string> => {
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error(`missing ${path}`);
    }
    return value;
  });

  readBlob = vi.fn(async (path: string): Promise<Blob> => {
    const blob = this.blobs.get(path);
    if (!blob) {
      throw new Error(`missing ${path}`);
    }
    return blob;
  });

  writeTextFile = vi.fn(async (path: string, contents: string): Promise<void> => {
    this.files.set(path, contents);
  });
}

const idleState: AgentChatState = {
  status: 'idle',
  activeTool: null,
} as AgentChatState;

class AgentChatStub {
  private listener: ((state: AgentChatState) => void) | null = null;
  private state: AgentChatState = idleState;
  readonly contextRequests: {
    attachment: { name: string; content: string } | null;
    replaceKey?: string;
  }[] = [];

  composeContext = vi.fn(
    (request: { attachment: { name: string; content: string } | null; replaceKey?: string }) => {
      this.contextRequests.push(request);
    }
  );

  clearComposeContext = vi.fn((replaceKey: string) => {
    this.contextRequests.push({ attachment: null, replaceKey });
  });

  subscribe(listener: (state: AgentChatState) => void): () => void {
    this.listener = listener;
    listener(this.state);
    return () => {
      this.listener = null;
    };
  }

  isRunning(): boolean {
    return this.state.status === 'running';
  }

  emit(patch: Partial<AgentChatState>): void {
    this.state = { ...this.state, ...patch } as AgentChatState;
    this.listener?.(this.state);
  }
}

class DialogServiceStub {
  showConfirmation = vi.fn(async () => true);
}

let createdUrls: string[] = [];
let revokedUrls: string[] = [];
let originalCreate: typeof URL.createObjectURL;
let originalRevoke: typeof URL.revokeObjectURL;

const container = (): ServiceContainer => ServiceContainer.getInstance();

const storage = (): StorageStub =>
  container().getService<StorageStub>(container().getOrCreateToken(ProjectStorageService));
const agentChat = (): AgentChatStub =>
  container().getService<AgentChatStub>(container().getOrCreateToken(AgentChatService));
const dialogs = (): DialogServiceStub =>
  container().getService<DialogServiceStub>(container().getOrCreateToken(DialogService));
const lightbox = (): LightboxService =>
  container().getService<LightboxService>(container().getOrCreateToken(LightboxService));

/** Let the component's async reads, blob resolution and render settle. */
const settle = async (element: IdeaDocElement): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await element.updateComplete;
  }
};

const mount = async (): Promise<IdeaDocElement> => {
  const element = document.createElement('pix3-idea-doc') as IdeaDocElement;
  document.body.appendChild(element);
  await settle(element);
  return element;
};

beforeAll(async () => {
  await import('./pix3-idea-doc');
});

beforeEach(() => {
  const c = container();
  c.addService(c.getOrCreateToken(ProjectStorageService), StorageStub, 'singleton');
  c.addService(c.getOrCreateToken(AgentChatService), AgentChatStub, 'singleton');
  c.addService(c.getOrCreateToken(DialogService), DialogServiceStub, 'singleton');
  c.addService(c.getOrCreateToken(IconService), IconService, 'singleton');
  c.addService(c.getOrCreateToken(LightboxService), LightboxService, 'singleton');
  lightbox().close();
  // The container hands out the SAME stub for every test in this file, so a file one case wrote
  // (a decision log, say) is still there for the next one — which then asserts about a project it
  // never set up.
  storage().files.clear();
  storage().blobs.clear();
  storage().files.set(DOC_PATH, '# Ant Strategy\n\nColony versus colony.');

  createdUrls = [];
  revokedUrls = [];
  originalCreate = URL.createObjectURL;
  originalRevoke = URL.revokeObjectURL;
  let next = 0;
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test-${++next}`;
    createdUrls.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revokedUrls.push(url);
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.restoreAllMocks();
});

describe('pix3-idea-doc', () => {
  it('renders the document in doc mode', async () => {
    storage().files.set(
      DOC_PATH,
      ['# Ant Strategy', '', '| Unit | Cost |', '| --- | ---: |', '| Worker | 5 |'].join('\n')
    );
    const element = await mount();

    expect(element.querySelector('h1')?.textContent?.trim()).toBe('Ant Strategy');
    expect(element.querySelector('table.md-table')).toBeTruthy();
    // Line anchors are what the selection phase reads — they must reach the DOM.
    expect(element.querySelector('h1')?.getAttribute('data-md-lines')).toBe('0-0');
  });

  it('shows a plaque when the document does not exist', async () => {
    storage().files.delete(DOC_PATH);
    const element = await mount();

    expect(element.querySelector('.idea-doc__empty')).toBeTruthy();
    expect(element.querySelector('.idea-doc__body')).toBeNull();
  });

  it('re-reads when a document-touching tool runs and when the turn ends', async () => {
    const element = await mount();
    expect(element.textContent).toContain('Colony versus colony.');

    storage().files.set(DOC_PATH, '# Ant Strategy\n\nTermites, actually.');
    agentChat().emit({ status: 'running', activeTool: 'str_replace' });
    await settle(element);
    expect(element.textContent).toContain('Termites, actually.');

    storage().files.set(DOC_PATH, '# Ant Strategy\n\nFinal wording.');
    agentChat().emit({ status: 'idle', activeTool: null });
    await settle(element);
    expect(element.textContent).toContain('Final wording.');
  });

  it('blocks source editing while the agent is running', async () => {
    const element = await mount();
    const editButton = (): HTMLButtonElement | null =>
      element.querySelector<HTMLButtonElement>('.idea-doc__action');

    expect(editButton()?.disabled).toBe(false);

    agentChat().emit({ status: 'running', activeTool: null });
    await settle(element);
    expect(editButton()?.disabled).toBe(true);
    expect(editButton()?.title).toContain('agent');

    agentChat().emit({ status: 'idle', activeTool: null });
    await settle(element);
    expect(editButton()?.disabled).toBe(false);
  });

  it('saves the edited source back to the file and returns to the preview', async () => {
    const element = await mount();
    element.querySelector<HTMLButtonElement>('.idea-doc__action')?.click();
    await settle(element);

    const textarea = element.querySelector<HTMLTextAreaElement>('.idea-doc__source');
    expect(textarea?.value).toBe('# Ant Strategy\n\nColony versus colony.');

    textarea!.value = '# Termite Strategy\n\nMounds.';
    textarea!.dispatchEvent(new Event('input'));
    await settle(element);

    element.querySelector<HTMLButtonElement>('.idea-doc__action--primary')?.click();
    await settle(element);

    expect(storage().writeTextFile).toHaveBeenCalledWith(DOC_PATH, '# Termite Strategy\n\nMounds.');
    expect(element.querySelector('.idea-doc__source')).toBeNull();
    expect(element.querySelector('h1')?.textContent?.trim()).toBe('Termite Strategy');
  });

  it('confirms before discarding an unsaved draft', async () => {
    dialogs().showConfirmation.mockResolvedValue(false);
    const element = await mount();
    element.querySelector<HTMLButtonElement>('.idea-doc__action')?.click();
    await settle(element);

    const textarea = element.querySelector<HTMLTextAreaElement>('.idea-doc__source');
    textarea!.value = 'half-typed';
    textarea!.dispatchEvent(new Event('input'));
    await settle(element);

    const buttons = element.querySelectorAll<HTMLButtonElement>('.idea-doc__action');
    buttons[buttons.length - 1].click();
    await settle(element);

    expect(dialogs().showConfirmation).toHaveBeenCalled();
    // The dialog was declined — the draft must survive.
    expect(element.querySelector<HTMLTextAreaElement>('.idea-doc__source')?.value).toBe(
      'half-typed'
    );
  });

  it('mints blob URLs for res:// images, diff-revokes them, and releases all on disconnect', async () => {
    storage().files.set(
      DOC_PATH,
      '![a](res://references/a.png)\n\n![b](res://references/b.png)\n\n[doc](res://design/brief.md)'
    );
    storage().blobs.set('references/a.png', new Blob(['a']));
    storage().blobs.set('references/b.png', new Blob(['b']));
    const element = await mount();

    // Only the two images are read — a non-image res:// link must not become an object URL.
    expect(createdUrls).toHaveLength(2);
    expect(storage().readBlob).not.toHaveBeenCalledWith('design/brief.md');
    expect(element.querySelectorAll('img.md-img')).toHaveLength(2);

    const [urlA, urlB] = createdUrls;
    storage().files.set(DOC_PATH, '![a](res://references/a.png)');
    await element.reload();
    await settle(element);

    expect(revokedUrls).toEqual([urlB]);
    expect(element.querySelectorAll('img.md-img')).toHaveLength(1);

    element.remove();
    expect(revokedUrls).toEqual([urlB, urlA]);
  });

  it('renders a plaque for a reference whose file is missing', async () => {
    storage().files.set(DOC_PATH, '![hero](res://references/hero.png)');
    const element = await mount();

    expect(createdUrls).toHaveLength(0);
    expect(element.querySelector('.md-img-missing')?.textContent?.trim()).toBe('hero.png');
  });

  it('expands the whole document into the lightbox as markdown', async () => {
    storage().files.set(DOC_PATH, '# Ant Strategy\n\nColony versus colony.');
    const element = await mount();

    const expand = Array.from(
      element.querySelectorAll<HTMLButtonElement>('.idea-doc__action')
    ).find(button => button.textContent?.includes('Expand'));
    expand?.click();
    await settle(element);

    const state = lightbox().current;
    expect(state?.items).toHaveLength(1);
    expect(state?.items[0]).toMatchObject({
      kind: 'markdown',
      // The H1 names the brief; the file name is only the fallback.
      title: 'Ant Strategy',
      path: DOC_PATH,
    });
    expect(state?.items[0].text).toContain('Colony versus colony.');
  });

  it('opens a clicked document image in the lightbox, with the whole document as the list', async () => {
    storage().files.set(
      DOC_PATH,
      '![first](res://references/a.png)\n\n![second](res://references/b.png)'
    );
    storage().blobs.set('references/a.png', new Blob(['a']));
    storage().blobs.set('references/b.png', new Blob(['b']));
    const element = await mount();

    const images = Array.from(element.querySelectorAll<HTMLImageElement>('img.md-img'));
    expect(images).toHaveLength(2);
    // The affordance has to be keyboard-reachable, not just clickable.
    expect(images[1].getAttribute('role')).toBe('button');
    expect(images[1].getAttribute('tabindex')).toBe('0');

    images[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(element);

    const state = lightbox().current;
    expect(state?.index).toBe(1);
    expect(state?.items.map(item => item.path)).toEqual(['references/a.png', 'references/b.png']);
    expect(state?.items[1]).toMatchObject({ kind: 'image', title: 'second' });
    expect(state?.items[1].url).toBe(images[1].getAttribute('src'));
  });
  describe('selection → agent context', () => {
    // The DI container hands out the same stub across the tests of this file.
    beforeEach(() => {
      agentChat().contextRequests.length = 0;
      agentChat().composeContext.mockClear();
      agentChat().clearComposeContext.mockClear();
    });

    const SOURCE = [
      '# Ant Strategy', // 0
      '', // 1
      'Colonies fight over **sugar**.', // 2
      '', // 3
      'A second paragraph nobody selected.', // 4
    ].join('\n');

    /** Select a rendered block the way finishing a drag over it would leave the DOM. */
    const select = (element: IdeaDocElement, selector: string): void => {
      const block = element.querySelector(selector)!;
      const range = document.createRange();
      range.selectNodeContents(block);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element
        .querySelector('.idea-doc__body')!
        .dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, shiftKey: true }));
    };

    it('stages the source slice — not the rendered text — the moment a fragment is selected', async () => {
      storage().files.set(DOC_PATH, SOURCE);
      const element = await mount();

      select(element, '.md-p');
      await settle(element);

      const [request] = agentChat().contextRequests;
      expect(request.attachment?.name).toBe(`${DOC_PATH}:3–3`);
      // Selecting is the whole gesture — no toolbar, no confirmation step.
      expect(element.querySelector('.idea-doc__selection-menu')).toBeNull();
      // The markdown syntax has to survive — `str_replace` matches the file, not the rendering.
      expect(request.attachment?.content).toContain('Colonies fight over **sugar**.');
      expect(request.attachment?.content).toContain(DOC_PATH);
      expect(request.attachment?.content).toContain('str_replace');
      // Only the selected block travels.
      expect(request.attachment?.content).not.toContain('A second paragraph');
    });

    it('swaps the chip on the next selection instead of stacking, and ignores a re-select', async () => {
      storage().files.set(DOC_PATH, SOURCE);
      const element = await mount();

      select(element, '.md-p');
      await settle(element);
      select(element, '.md-p'); // same fragment again — nothing new to say
      await settle(element);
      select(element, 'h1');
      await settle(element);

      const requests = agentChat().contextRequests;
      expect(requests.map(r => r.attachment?.name)).toEqual([`${DOC_PATH}:3–3`, `${DOC_PATH}:1–1`]);
      // Both went to the same slot, so the panel keeps exactly one document chip.
      expect(new Set(requests.map(r => r.replaceKey))).toEqual(new Set([`idea-doc:${DOC_PATH}`]));
      expect(requests[1].attachment?.content).toContain('# Ant Strategy');
    });

    /** Collapse the page selection at a point, the way a click does. */
    const collapseAt = (node: Node): void => {
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      const range = document.createRange();
      range.setStart(node, 0);
      range.collapse(true);
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    };

    it('takes the chip back when the selection is dropped inside the document', async () => {
      storage().files.set(DOC_PATH, SOURCE);
      const element = await mount();

      select(element, '.md-p');
      await settle(element);
      collapseAt(element.querySelector('h1')!);
      await settle(element);

      const requests = agentChat().contextRequests;
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual({ attachment: null, replaceKey: `idea-doc:${DOC_PATH}` });
      expect(agentChat().clearComposeContext).toHaveBeenCalledWith(`idea-doc:${DOC_PATH}`);
    });

    it('keeps the chip when the caret leaves for the composer', async () => {
      storage().files.set(DOC_PATH, SOURCE);
      const element = await mount();

      select(element, '.md-p');
      await settle(element);
      // Clicking into the chat's textarea collapses the page selection too — retracting there would
      // delete the context exactly when the user starts typing the question about it.
      const outside = document.createElement('textarea');
      document.body.appendChild(outside);
      collapseAt(outside);
      await settle(element);

      expect(agentChat().contextRequests).toHaveLength(1);
      expect(agentChat().clearComposeContext).not.toHaveBeenCalled();
      outside.remove();
    });

    it('re-stages after the document was re-read under the selection', async () => {
      storage().files.set(DOC_PATH, SOURCE);
      const element = await mount();

      select(element, '.md-p');
      await settle(element);
      expect(agentChat().contextRequests).toHaveLength(1);

      storage().files.set(DOC_PATH, '# Ant Strategy\n\nTermites, actually.');
      agentChat().emit({ status: 'running', activeTool: 'str_replace' });
      await settle(element);

      // Same line range, different text — the stale anchor must not suppress the new chip.
      select(element, '.md-p');
      await settle(element);
      expect(agentChat().contextRequests).toHaveLength(2);
      expect(agentChat().contextRequests[1].attachment?.content).toContain('Termites, actually.');
    });
  });

  describe('decisions', () => {
    const DECISIONS_PATH = 'design/decisions.md';

    it('shows nothing at all until a fork has been settled', async () => {
      storage().files.set(DECISIONS_PATH, '# Decisions\n\nOne line per decision.\n');
      const element = await mount();

      expect(element.querySelector('.idea-doc__decisions')).toBeNull();
    });

    it('lists the settled forks with their reason and date', async () => {
      storage().files.set(
        DECISIONS_PATH,
        [
          '# Decisions',
          '',
          '- **Coop?** → Solo first. Networking can wait. _(rejected: online)_ — 2026-08-28',
          '- **Portrait or landscape?** → Landscape. — 2026-08-28',
        ].join('\n')
      );
      const element = await mount();

      const rows = element.querySelectorAll('.idea-doc__decision');
      expect(rows).toHaveLength(2);
      expect(rows[0].querySelector('.idea-doc__decision-q')?.textContent).toBe('Coop?');
      expect(rows[0].querySelector('.idea-doc__decision-a')?.textContent).toBe('Solo first');
      expect(rows[0].querySelector('.idea-doc__decision-why')?.textContent).toBe(
        'Networking can wait'
      );
      expect(rows[0].querySelector('.idea-doc__decision-rejected')?.textContent).toContain(
        'online'
      );
      // Nothing to say about a decision nobody gave a reason for — no empty row of chrome.
      expect(rows[1].querySelector('.idea-doc__decision-why')).toBeNull();
    });

    /**
     * The section sits OUTSIDE `.idea-doc__body` on purpose: the selection resolver maps
     * `data-md-lines` back into `gdd.md`, so a decision inside that element would stage a chip
     * pointing at another file's line numbers.
     */
    it('keeps the decisions out of the selectable document body', async () => {
      storage().files.set(DECISIONS_PATH, '# Decisions\n\n- **Coop?** → Solo first. — 2026-08-28');
      const element = await mount();

      expect(element.querySelector('.idea-doc__body .idea-doc__decisions')).toBeNull();
      expect(element.querySelector('.idea-doc__decisions')).not.toBeNull();
    });

    it('picks up a decision the agent recorded mid-turn', async () => {
      const element = await mount();
      expect(element.querySelector('.idea-doc__decisions')).toBeNull();

      storage().files.set(DECISIONS_PATH, '# Decisions\n\n- **Coop?** → Solo first. — 2026-08-28');
      agentChat().emit({ status: 'running', activeTool: 'record_decision' });
      await settle(element);

      expect(element.querySelectorAll('.idea-doc__decision')).toHaveLength(1);
    });

    it('collapses and expands the list', async () => {
      storage().files.set(DECISIONS_PATH, '# Decisions\n\n- **Coop?** → Solo first. — 2026-08-28');
      const element = await mount();

      const header = element.querySelector<HTMLButtonElement>('.idea-doc__decisions-header');
      expect(header?.getAttribute('aria-expanded')).toBe('true');

      header?.click();
      await settle(element);
      expect(header?.getAttribute('aria-expanded')).toBe('false');
      expect(element.querySelector('.idea-doc__decisions-list')).toBeNull();
    });

    it('still shows the document when there is no decision log to read', async () => {
      const element = await mount();

      expect(element.querySelector('.idea-doc__body')).not.toBeNull();
      expect(element.querySelector('.idea-doc__decisions')).toBeNull();
    });
  });
});
