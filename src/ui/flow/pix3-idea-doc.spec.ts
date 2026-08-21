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
});
