import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { AgentChatService } from '@/services/agent/AgentChatService';
import { IconService } from '@/services/editor/IconService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { annotationPaths, parseAnnotation } from './annotation-doc';

const IMAGE_PATH = 'references/mood-1.png';

interface AnnotatorElement extends HTMLElement {
  updateComplete: Promise<unknown>;
  imageUrl: string;
  imagePath: string;
}

class StorageStub {
  readonly texts = new Map<string, string>();
  readonly binaries = new Map<string, ArrayBuffer>();

  readTextFile = vi.fn(async (path: string) => {
    const text = this.texts.get(path);
    if (text === undefined) {
      throw new Error(`missing ${path}`);
    }
    return text;
  });

  writeTextFile = vi.fn(async (path: string, contents: string) => {
    this.texts.set(path, contents);
  });

  writeBinaryFile = vi.fn(async (path: string, data: ArrayBuffer) => {
    this.binaries.set(path, data);
  });
}

class AgentChatStub {
  readonly sent: { text: string; images: number }[] = [];
  send = vi.fn(async (text: string, attachments?: { images?: readonly unknown[] }) => {
    this.sent.push({ text, images: attachments?.images?.length ?? 0 });
  });
  subscribe = vi.fn(() => () => {});
}

const container = (): ServiceContainer => ServiceContainer.getInstance();
const storage = (): StorageStub =>
  container().getService<StorageStub>(container().getOrCreateToken(ProjectStorageService));
const agentChat = (): AgentChatStub =>
  container().getService<AgentChatStub>(container().getOrCreateToken(AgentChatService));

const settle = async (element: AnnotatorElement): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await element.updateComplete;
  }
};

const mount = async (path = IMAGE_PATH): Promise<AnnotatorElement> => {
  const element = document.createElement('pix3-image-annotator') as AnnotatorElement;
  element.imageUrl = 'blob:image';
  element.imagePath = path;
  document.body.appendChild(element);
  await settle(element);
  return element;
};

/** Draw one committed stroke, the way a drag does. Bypasses canvas, which happy-dom lacks. */
const addStroke = async (element: AnnotatorElement): Promise<void> => {
  const target = element as unknown as {
    strokes: readonly unknown[];
    requestUpdate(): void;
  };
  target.strokes = [
    ...target.strokes,
    {
      tool: 'arrow',
      color: '#f5ae39',
      width: 4,
      points: [
        { x: 10, y: 10, pressure: 0.5 },
        { x: 90, y: 90, pressure: 0.5 },
      ],
    },
  ];
  await settle(element);
};

const button = (element: AnnotatorElement, label: string): HTMLButtonElement | null =>
  element.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
  [...element.querySelectorAll('button')].find(b => b.textContent?.trim() === label) ??
  null;

beforeAll(async () => {
  await import('./pix3-image-annotator');
});

beforeEach(() => {
  const c = container();
  c.addService(c.getOrCreateToken(ProjectStorageService), StorageStub, 'singleton');
  c.addService(c.getOrCreateToken(AgentChatService), AgentChatStub, 'singleton');
  c.addService(c.getOrCreateToken(IconService), IconService, 'singleton');
  // The container hands out the SAME stub instance for every test in this file, so both the files
  // it holds and its mocks' CALL HISTORY survive into the next one — and a test asserting "nothing
  // was written" would otherwise read the previous test's save.
  storage().texts.clear();
  storage().binaries.clear();
  storage().readTextFile.mockClear();
  storage().writeTextFile.mockClear();
  storage().writeBinaryFile.mockClear();
  agentChat().sent.length = 0;
  agentChat().send.mockClear();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('pix3-image-annotator', () => {
  it('continues a previous annotation instead of starting a new one', async () => {
    storage().texts.set(
      annotationPaths(IMAGE_PATH).json,
      JSON.stringify({
        version: 1,
        source: IMAGE_PATH,
        width: 800,
        height: 600,
        strokes: [
          { tool: 'pen', color: '#fff', width: 3, points: [{ x: 1, y: 1, pressure: 0.5 }] },
          { tool: 'pen', color: '#fff', width: 3, points: [{ x: 2, y: 2, pressure: 0.5 }] },
        ],
      })
    );

    const element = await mount();

    // Undo is enabled only when there is something to undo — the readable proof strokes loaded.
    expect(button(element, 'Undo')?.disabled).toBe(false);
  });

  it('offers nothing to save until something is drawn', async () => {
    const element = await mount();

    expect(button(element, 'Undo')?.disabled).toBe(true);
    expect(button(element, 'Save')?.disabled).toBe(true);
    expect(button(element, 'Send to agent')?.disabled).toBe(true);
  });

  it('writes only the editable layer on Save — the composite is for sending', async () => {
    const element = await mount();
    await addStroke(element);

    button(element, 'Save')?.click();
    await settle(element);

    const paths = annotationPaths(IMAGE_PATH);
    const written = storage().texts.get(paths.json) ?? '';
    expect(parseAnnotation(written, IMAGE_PATH)?.strokes).toHaveLength(1);
    expect(storage().binaries.has(paths.png)).toBe(false);
  });

  /** Local stack, never HistoryManager: until Save this is draft input like text in the composer. */
  it('undo pops the last stroke without touching the project', async () => {
    const element = await mount();
    await addStroke(element);
    await addStroke(element);

    button(element, 'Undo')?.click();
    await settle(element);
    button(element, 'Undo')?.click();
    await settle(element);

    expect(button(element, 'Undo')?.disabled).toBe(true);
    expect(storage().writeTextFile).not.toHaveBeenCalled();
  });

  it('clear drops every stroke at once', async () => {
    const element = await mount();
    await addStroke(element);
    await addStroke(element);

    button(element, 'Clear')?.click();
    await settle(element);

    expect(button(element, 'Undo')?.disabled).toBe(true);
  });

  it('starts over when it is pointed at another picture', async () => {
    const element = await mount();
    await addStroke(element);
    expect(button(element, 'Undo')?.disabled).toBe(false);

    element.imagePath = 'references/mood-2.png';
    element.imageUrl = 'blob:other';
    await settle(element);

    expect(button(element, 'Undo')?.disabled).toBe(true);
  });

  /**
   * The message has to carry the PATHS as well as the picture: the model sees the drawing now, and
   * has to be able to reach the same file with `analyze_image` after a compaction (parent §5.7).
   */
  it('reports honestly when the composite cannot be rendered', async () => {
    // happy-dom has no 2d context, so flattening fails — the user must be told, not left guessing.
    const element = await mount();
    await addStroke(element);

    button(element, 'Send to agent')?.click();
    await settle(element);

    expect(agentChat().sent).toHaveLength(0);
    expect(element.querySelector('.annotator__status')?.textContent).toContain('Could not render');
  });

  it('surfaces a failed save instead of silently losing the drawing', async () => {
    const element = await mount();
    await addStroke(element);
    storage().writeTextFile.mockRejectedValueOnce(new Error('disk is full'));

    button(element, 'Save')?.click();
    await settle(element);

    expect(element.querySelector('.annotator__status')?.textContent).toContain('disk is full');
  });
});
